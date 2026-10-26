// Offline PDF, Word or HTML evidence report from a reviewed manifest, an optional saved
// case and local PNG/JPEG screenshots. It makes no provider, price, label or network
// request. PDF rendering uses a local Chromium with JavaScript off and requests aborted.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, createInflate } from "node:zlib";
import { parseArgs } from "node:util";
import { z } from "zod";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import {
  filterTransfers,
  formatUnits,
  normalizeAddress,
  parseInvestigation,
} from "../src/domain/engine.ts";
import { walletFlows } from "../src/domain/wallet-flows.ts";
import type { Investigation, Transfer } from "../src/domain/types.ts";
import { writeReportFile } from "./report-investigation.ts";
import { isCredentialParameterName } from "../src/domain/source-url.ts";

export const LIMITS = {
  manifestBytes: 1_000_000,
  caseBytes: 5_000_000,
  imageBytes: 8_000_000,
  imageSide: 12_000,
  imagePixels: 40_000_000,
  /** Decoded pixels across all screenshots in one report; images decode one at a time. */
  totalPixels: 200_000_000,
  totalImageBytes: 64_000_000,
  jpegDecodeMB: 512,
} as const;
/** A4 content box (174 mm) at 96 px per inch, shared by the HTML, PDF and DOCX layouts. */
const CONTENT_PX = 657;
const FIGURE_PX = 720;
const CONTENT_TWIPS = 9864;

const STATUS = {
  unresolved:
    "No attribution conclusion is supported by the evidence reviewed.",
  hypothesis:
    "A working explanation consistent with the evidence, not an established fact.",
  "source-supported":
    "Supported by the cited sources, and only as reliable as those sources; not independently verified beyond them.",
  "user-confirmed":
    "Confirmed by the user. User confirmation is a user assertion, not independent proof.",
} as const;
export type AssessmentStatus = keyof typeof STATUS;

/** http(s) only, without userinfo or credential-like query or fragment keys. */
export function safeUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    [...url.searchParams.keys(), ...fragment.keys()].some((key) =>
      isCredentialParameterName(key),
    )
  )
    return undefined;
  return url.href;
}
const utc = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "Expected an ISO UTC timestamp ending in Z",
  )
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    "Invalid calendar timestamp",
  );
const line = (max: number) => z.string().trim().min(1).max(max);
const prose = (max: number) => z.string().trim().min(1).max(max);
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, "IDs use 1-32 letters, digits, - or _");
const reference = z.string().min(1).max(500);
const Section = z.strictObject({
  heading: line(200),
  paragraphs: z.array(prose(10_000)).max(50).optional(),
  bullets: z.array(prose(2_000)).max(100).optional(),
  table: z
    .strictObject({
      headers: z.array(line(200)).min(1).max(12),
      rows: z.array(z.array(z.string().max(2_000))).max(500),
    })
    .refine(
      (table) => table.rows.every((row) => row.length === table.headers.length),
      "Every table row needs exactly one cell per header",
    )
    .optional(),
});
const Source = z.strictObject({
  id,
  title: line(300),
  type: z.enum([
    "explorer",
    "company",
    "social",
    "case",
    "user-provided",
    "other",
  ]),
  url: z
    .string()
    .max(2_048)
    .refine(
      (value) => safeUrl(value) !== undefined,
      "URL must be http(s) without credentials",
    )
    .optional(),
  observedAt: utc.optional(),
  publishedAt: utc.optional(),
});
const Screenshot = z.strictObject({
  id,
  path: reference,
  caption: prose(1_000),
  sourceId: id,
  capturedAt: utc.nullable().optional(),
  redactions: z.array(prose(500)).max(20).optional(),
});
export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    title: line(200),
    subtitle: line(300).optional(),
    preparedAt: utc,
    classification: line(100),
    subject: z.strictObject({
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "Expected a full EVM address"),
      chainIds: z
        .array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
        .min(1)
        .max(20),
    }),
    caseFile: reference.optional(),
    summary: prose(10_000),
    assessment: z.strictObject({
      status: z.enum(
        Object.keys(STATUS) as [AssessmentStatus, ...AssessmentStatus[]],
      ),
      conclusion: prose(5_000),
    }),
    sections: z.array(Section).max(50).default([]),
    sources: z.array(Source).max(200).default([]),
    screenshots: z.array(Screenshot).max(50).default([]),
    limitations: z.array(prose(2_000)).max(50).default([]),
  })
  .superRefine((manifest, context) => {
    const duplicate = (values: (string | number)[]) =>
      values.find((value, index) => values.indexOf(value) !== index);
    const issues: [string, unknown][] = [
      ["Duplicate subject chain ID", duplicate(manifest.subject.chainIds)],
      ["Duplicate source ID", duplicate(manifest.sources.map((s) => s.id))],
      [
        "Duplicate screenshot ID",
        duplicate(manifest.screenshots.map((s) => s.id)),
      ],
      [
        "Duplicate screenshot path",
        duplicate(manifest.screenshots.map((s) => s.path)),
      ],
    ];
    for (const [message, value] of issues)
      if (value !== undefined)
        context.addIssue({ code: "custom", message: `${message}: ${value}` });
    const sources = new Set(manifest.sources.map((s) => s.id));
    manifest.screenshots.forEach((shot, index) => {
      if (!sources.has(shot.sourceId))
        context.addIssue({
          code: "custom",
          path: ["screenshots", index, "sourceId"],
          message: `Unknown source ID ${shot.sourceId}`,
        });
    });
  });
export type ReportManifest = z.infer<typeof manifestSchema>;

/** Throws one readable error listing every schema problem. Values are not echoed. */
export function parseManifest(input: unknown): ReportManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid report manifest:\n${z.prettifyError(result.error)}`,
    );
  return result.data;
}

export interface ImageInfo {
  type: "png" | "jpg";
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
}
/** Reads dimensions from the file structure itself; extension and signature must agree. */
export function probeImage(data: Buffer, name: string): ImageInfo {
  const extension = extname(name).toLowerCase();
  const fail = (reason: string): never => {
    throw new Error(`Screenshot ${name}: ${reason}`);
  };
  let info: ImageInfo | undefined;
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    if (extension !== ".png") fail("PNG content needs a .png extension");
    info = pngStructure(data, fail).info;
  } else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    if (extension !== ".jpg" && extension !== ".jpeg")
      fail("JPEG content needs a .jpg or .jpeg extension");
    info = jpegStructure(data, fail);
  } else
    fail(
      "only PNG and JPEG are supported (SVG, WebP, GIF and others are refused)",
    );
  const { width, height } = info!;
  if (
    width < 1 ||
    height < 1 ||
    width > LIMITS.imageSide ||
    height > LIMITS.imageSide ||
    width * height > LIMITS.imagePixels
  )
    fail(
      `dimensions ${width}x${height} exceed ${LIMITS.imageSide} px per side or ${LIMITS.imagePixels / 1_000_000} MP`,
    );
  return info!;
}

const PNG_DEPTHS: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
interface PngStructure {
  info: ImageInfo;
  idat: Buffer;
  /** Scanline layout per pass: rows, bytes per row including the filter byte, pixels per row. */
  rows: [number, number, number][];
  bits: number;
  /** Palette entries for indexed images, otherwise 0. */
  palette: number;
}
const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
/**
 * Every chunk CRC-checked; IHDR valid; no unknown critical chunk; PLTE and tRNS sized
 * and ordered per the PNG specification; contiguous IDAT; IEND last.
 */
function pngStructure(
  data: Buffer,
  fail: (reason: string) => never,
): PngStructure {
  if (data.length < 45) fail("truncated PNG");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20),
    [depth, color, compression, filter, interlace] = data.subarray(24, 29);
  let offset = 8,
    ended = false,
    palette = 0,
    idatState: "before" | "inside" | "after" = "before";
  const idat: Buffer[] = [],
    seen = new Set<string>();
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset),
      type = data.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > data.length) fail("truncated PNG chunk");
    if (!/^[A-Za-z]{4}$/.test(type)) fail("invalid PNG chunk type");
    if (offset === 8 && (type !== "IHDR" || length !== 13))
      fail("PNG must start with an IHDR chunk");
    if (
      crc32(data.subarray(offset + 4, offset + 8 + length)) !==
      data.readUInt32BE(offset + 8 + length)
    )
      fail(`PNG ${type} chunk CRC mismatch (corrupt file)`);
    if (/^[A-Z]/.test(type) && !PNG_CRITICAL.has(type))
      fail(`PNG has unsupported critical chunk ${type}`);
    if (["IHDR", "PLTE", "tRNS", "acTL"].includes(type) && seen.has(type))
      fail(`duplicate PNG ${type} chunk`);
    if (type === "acTL") fail("animated PNG is not supported");
    if (type === "PLTE") {
      if (seen.has("IDAT") || seen.has("tRNS"))
        fail("PNG PLTE must precede tRNS and IDAT");
      if (color === 0 || color === 4)
        fail("greyscale PNG must not have a palette");
      if (length === 0 || length % 3 || length / 3 > 256)
        fail("PNG palette must hold 1 to 256 RGB entries");
      if (color === 3 && length / 3 > 2 ** depth)
        fail("PNG palette has more entries than the bit depth allows");
      palette = length / 3;
    }
    if (type === "tRNS") {
      if (seen.has("IDAT")) fail("PNG tRNS must precede IDAT");
      const valid =
        color === 3
          ? palette > 0 && length <= palette
          : color === 0
            ? length === 2
            : color === 2
              ? length === 6
              : false;
      if (!valid) fail("invalid PNG transparency chunk");
    }
    seen.add(type);
    if (type === "IDAT") {
      if (idatState === "after") fail("PNG IDAT chunks must be contiguous");
      idatState = "inside";
      idat.push(data.subarray(offset + 8, offset + 8 + length));
    } else if (idatState === "inside") idatState = "after";
    offset += 12 + length;
    if (type === "IEND") {
      if (length) fail("PNG IEND must be empty");
      ended = true;
      break;
    }
  }
  if (!ended || offset !== data.length) fail("PNG must end with IEND");
  if (!idat.length) fail("PNG has no image data (IDAT)");
  const format = PNG_DEPTHS[color];
  if (!format || !format.depths.includes(depth))
    fail(`unsupported PNG colour type ${color} with bit depth ${depth}`);
  if (compression !== 0 || filter !== 0 || interlace > 1)
    fail("invalid PNG compression, filter or interlace method");
  if (color === 3 && !palette) fail("indexed PNG has no palette");
  const bits = format.channels * depth;
  const rows: [number, number, number][] = (
    interlace ? ADAM7 : [[0, 0, 1, 1]]
  ).flatMap(([x, y, dx, dy]) => {
    const w = width > x ? Math.ceil((width - x) / dx) : 0,
      h = height > y ? Math.ceil((height - y) / dy) : 0;
    return w && h
      ? [[h, 1 + Math.ceil((w * bits) / 8), w] as [number, number, number]]
      : [];
  });
  return {
    info: { type: "png", mime: "image/png", width, height },
    idat: Buffer.concat(idat),
    rows,
    bits,
    palette: color === 3 ? palette : 0,
  };
}
/** Marker walk from SOI to EOI: one frame header, tables, at least one scan with entropy data. */
function jpegStructure(
  data: Buffer,
  fail: (reason: string) => never,
): ImageInfo {
  let offset = 2,
    info: ImageInfo | undefined,
    huffman = false,
    tables = false,
    quantization = false,
    scans = 0,
    ended = false;
  while (offset < data.length) {
    if (data[offset] !== 0xff) fail("malformed JPEG marker");
    while (data[offset + 1] === 0xff) offset += 1;
    if (offset + 1 >= data.length) break;
    const marker = data[offset + 1];
    if (marker === 0xd9) {
      offset += 2;
      ended = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00) fail("malformed JPEG marker");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > data.length) fail("truncated JPEG segment");
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length)
      fail("truncated JPEG segment");
    const body = offset + 4;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (info) fail("JPEG has more than one frame header");
      const components = data[body + 5];
      if (
        length !== 8 + 3 * components ||
        components < 1 ||
        components > 4 ||
        ![8, 12].includes(data[body])
      )
        fail("invalid JPEG frame header");
      huffman = marker < 0xc8;
      info = {
        type: "jpg",
        mime: "image/jpeg",
        height: data.readUInt16BE(body + 1),
        width: data.readUInt16BE(body + 3),
      };
    } else if (marker === 0xc4) tables = true;
    else if (marker === 0xdb) quantization = true;
    else if (marker === 0xda) {
      if (!info) fail("JPEG has no frame header before image data");
      const components = data[body];
      if (components < 1 || components > 4 || length !== 6 + 2 * components)
        fail("invalid JPEG scan header");
      let cursor = offset + 2 + length;
      const start = cursor;
      while (cursor < data.length) {
        if (data[cursor] !== 0xff) {
          cursor += 1;
          continue;
        }
        const next = data[cursor + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) cursor += 2;
        else if (next === 0xff) cursor += 1;
        else break;
      }
      if (cursor === start) fail("JPEG scan has no image data");
      if (cursor >= data.length) fail("truncated JPEG image data (no EOI)");
      scans += 1;
      offset = cursor;
      continue;
    }
    offset += 2 + length;
  }
  if (!info) fail("JPEG frame header not found");
  if (!scans) fail("JPEG has no image data (SOS)");
  if (!ended) fail("truncated JPEG (no EOI marker)");
  if (offset !== data.length) fail("JPEG has data after the EOI marker");
  if (!quantization) fail("JPEG has no quantization table");
  if (huffman && !tables) fail("JPEG has no Huffman table");
  return info!;
}

/**
 * Full decode check, sequential and bounded. PNG: a streaming preflight (chunk order and
 * CRCs, palette rules, exact inflated size, row-by-row unfiltering and palette indices,
 * one row in memory) bounds the work, then pngjs performs a full reference decode. JPEG: jpeg-js decodes with tolerant decoding off
 * and resolution and memory limits. Embedded bytes and hashes are never altered.
 */
export async function verifyImageData(
  data: Buffer,
  name: string,
): Promise<void> {
  const fail = (reason: string): never => {
    throw new Error(`Screenshot ${name}: ${reason}`);
  };
  if (data[0] === 0xff) {
    const info = jpegStructure(data, fail);
    let decoded: { width: number; height: number };
    try {
      decoded = jpeg.decode(data, {
        useTArray: true,
        formatAsRGBA: false,
        tolerantDecoding: false,
        maxResolutionInMP: LIMITS.imagePixels / 1_000_000,
        maxMemoryUsageInMB: LIMITS.jpegDecodeMB,
      });
    } catch (error) {
      return fail(
        `JPEG does not decode (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (decoded.width !== info.width || decoded.height !== info.height)
      fail("JPEG decoded size differs from its frame header");
    return;
  }
  const { idat, rows, bits, palette } = pngStructure(data, fail);
  const expected = rows.reduce((sum, [count, size]) => sum + count * size, 0);
  const step = Math.max(1, bits >> 3);
  let segment = 0,
    row = 0,
    fill = 0,
    seen = 0,
    current = Buffer.alloc(rows[0][1]),
    previous = Buffer.alloc(rows[0][1]);
  /** Reverses the scanline filter, then checks every palette index is in range. */
  const finishRow = () => {
    const [count, size, pixels] = rows[segment];
    const type = current[0];
    if (type > 4)
      fail("PNG scanline has an invalid filter type (corrupt data)");
    for (let i = 1; i < size; i++) {
      const left = i > step ? current[i - step] : 0,
        up = previous[i],
        corner = i > step ? previous[i - step] : 0;
      let predictor = 0;
      if (type === 1) predictor = left;
      else if (type === 2) predictor = up;
      else if (type === 3) predictor = (left + up) >> 1;
      else if (type === 4) {
        const estimate = left + up - corner,
          a = Math.abs(estimate - left),
          b = Math.abs(estimate - up),
          c = Math.abs(estimate - corner);
        predictor = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      current[i] = (current[i] + predictor) & 255;
    }
    if (palette)
      for (let x = 0; x < pixels; x++) {
        const bit = x * bits,
          index =
            (current[1 + (bit >> 3)] >> (8 - bits - (bit & 7))) &
            ((1 << bits) - 1);
        if (index >= palette)
          fail(`PNG pixel uses palette index ${index} of ${palette} entries`);
      }
    [previous, current] = [current, previous];
    if (++row === count) {
      segment += 1;
      row = 0;
      if (segment < rows.length) {
        current = Buffer.alloc(rows[segment][1]);
        previous = Buffer.alloc(rows[segment][1]);
      }
    }
  };
  const inflate = createInflate();
  inflate.end(idat);
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      if (seen + chunk.length > expected) {
        inflate.destroy();
        fail("PNG image data is larger than its dimensions allow");
      }
      seen += chunk.length;
      for (let offset = 0; offset < chunk.length;) {
        const take = Math.min(current.length - fill, chunk.length - offset);
        chunk.copy(current, fill, offset, offset + take);
        fill += take;
        offset += take;
        if (fill === current.length) {
          fill = 0;
          finishRow();
        }
      }
    }
  } catch (error) {
    inflate.destroy();
    if (error instanceof Error && error.message.startsWith("Screenshot "))
      throw error;
    fail("PNG image data does not decompress (corrupt or truncated)");
  }
  if (seen !== expected)
    fail(`PNG image data is incomplete (${seen} of ${expected} bytes)`);
  // Bounded by the preflight above; pngjs then performs the reference decode.
  let decoded: { width: number; height: number };
  try {
    decoded = PNG.sync.read(data, { checkCRC: true });
  } catch (error) {
    return fail(
      `PNG does not decode (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const { info } = pngStructure(data, fail);
  if (decoded.width !== info.width || decoded.height !== info.height)
    fail("PNG decoded size differs from its header");
}

async function readBounded(
  path: string,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
    if (info.size > maxBytes)
      throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1 - bytes));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes)
        throw new Error(`${label} exceeds the ${maxBytes} byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await file.close();
  }
}
interface ConfinedFile {
  path: string;
  relativePath: string;
  data: Buffer;
  sha256: string;
}
const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
/** Bundle-relative only: no absolute paths, URLs, backslashes or `..`, and the real path must stay inside the root. */
async function readConfined(
  root: string,
  ref: string,
  label: string,
  maxBytes: number,
): Promise<ConfinedFile> {
  if (
    isAbsolute(ref) ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref) ||
    /[\\\0]/.test(ref) ||
    ref.split("/").includes("..")
  )
    throw new Error(
      `${label} must be a relative path inside the bundle root: ${JSON.stringify(ref)}`,
    );
  const path = await realpath(resolve(root, ref)).catch(() => {
    throw new Error(`${label} not found: ${JSON.stringify(ref)}`);
  });
  if (!path.startsWith(root + sep))
    throw new Error(
      `${label} resolves outside the bundle root: ${JSON.stringify(ref)}`,
    );
  const data = await readBounded(path, label, maxBytes);
  return {
    path,
    relativePath: relative(root, path).split(sep).join("/"),
    data,
    sha256: sha256(data),
  };
}

export interface LoadedScreenshot extends ConfinedFile {
  shot: ReportManifest["screenshots"][number];
  image: ImageInfo;
}
export interface ReportBundle {
  manifest: ReportManifest;
  manifestFile: { name: string; path: string; sha256: string; bytes: number };
  root: string;
  investigation?: Investigation;
  caseFile?: ConfinedFile;
  screenshots: LoadedScreenshot[];
  /** Real paths of every input, for output alias refusal. */
  inputs: string[];
}

/** Validates the manifest, the case identity and every screenshot. Reads only local files. */
export async function loadReportBundle(
  manifestPath: string,
  bundleRoot?: string,
): Promise<ReportBundle> {
  const path = await realpath(resolve(manifestPath));
  const bytes = await readBounded(path, "Manifest", LIMITS.manifestBytes);
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Manifest must contain valid JSON");
  }
  const manifest = parseManifest(json);
  const root = await realpath(resolve(bundleRoot ?? dirname(path)));
  const subject = normalizeAddress(manifest.subject.address);
  let investigation: Investigation | undefined,
    caseFile: ConfinedFile | undefined;
  if (manifest.caseFile) {
    caseFile = await readConfined(
      root,
      manifest.caseFile,
      "Case file",
      LIMITS.caseBytes,
    );
    try {
      investigation = parseInvestigation(
        JSON.parse(caseFile.data.toString("utf8")),
      );
    } catch (error) {
      throw new Error(
        `Case file is not a valid FlowLens case: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (normalizeAddress(investigation.root) !== subject)
      throw new Error(
        `Case root ${investigation.root} does not match subject address ${subject}`,
      );
  }
  const screenshots: LoadedScreenshot[] = [];
  let pixels = 0,
    imageBytes = 0;
  for (const shot of manifest.screenshots) {
    const file = await readConfined(
      root,
      shot.path,
      `Screenshot ${shot.id}`,
      LIMITS.imageBytes,
    );
    const image = probeImage(file.data, file.relativePath);
    pixels += image.width * image.height;
    imageBytes += file.data.length;
    if (pixels > LIMITS.totalPixels || imageBytes > LIMITS.totalImageBytes)
      throw new Error(
        `Screenshots exceed the total budget of ${LIMITS.totalPixels / 1_000_000} MP or ${LIMITS.totalImageBytes / 1_000_000} MB`,
      );
    await verifyImageData(file.data, file.relativePath);
    screenshots.push({ ...file, shot, image });
  }
  return {
    manifest,
    manifestFile: {
      name: basename(path),
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
    root,
    investigation,
    caseFile,
    screenshots,
    inputs: [
      path,
      ...(caseFile ? [caseFile.path] : []),
      ...screenshots.map((s) => s.path),
    ],
  };
}

/** Untrusted text → printable text: controls collapse to spaces, invisible and bidi marks become visible. */
export function cleanText(value: string): string {
  return value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(
      /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
      (c) =>
        `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`,
    )
    .replace(/[\p{Cs}\ufffe\uffff]/gu, "\ufffd");
}
export function escapeHtml(value: string): string {
  return cleanText(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

interface Run {
  text: string;
  mono?: boolean;
  bold?: boolean;
  italic?: boolean;
  href?: string;
}
type Cell = Run[];
type Block =
  | { kind: "title"; title: string; subtitle?: string; banner: string }
  | { kind: "heading"; level: 1 | 2; text: string; pageBreak?: boolean }
  | { kind: "paragraph"; runs: Run[]; note?: boolean }
  | { kind: "bullets"; items: Cell[] }
  | { kind: "table"; headers: string[]; rows: Cell[][]; widths: number[] }
  | {
      kind: "figure";
      screenshot: LoadedScreenshot;
      caption: Run[];
      size?: { width: number; height: number };
      pageBreak?: boolean;
    };
const run = (text: string, extra: Omit<Run, "text"> = {}): Run => ({
  text,
  ...extra,
});
const mono = (text: string) => run(text, { mono: true });
const plain = (text: string): Cell => [run(text)];
/** Display size in CSS px: fit the A4 content box, never upscale. */
export function displaySize(image: ImageInfo): {
  width: number;
  height: number;
} {
  const scale = Math.min(1, CONTENT_PX / image.width, FIGURE_PX / image.height);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function caseBlocks(bundle: ReportBundle): Block[] {
  const investigation = bundle.investigation!;
  const root = normalizeAddress(investigation.root);
  const view = walletFlows(investigation, { address: root, pageSize: 1 });
  const touching = filterTransfers(investigation.transfers, root).filter(
    (t) => normalizeAddress(t.from) === root || normalizeAddress(t.to) === root,
  );
  const inbound = (t: Transfer) =>
    normalizeAddress(t.to) === root && normalizeAddress(t.from) !== root;
  const chains = [
    ...new Set([
      ...bundle.manifest.subject.chainIds,
      ...touching.map((t) => t.chainId),
      ...view.coverage.map((c) => c.chainId),
    ]),
  ].sort((a, b) => a - b);
  const chainRows = chains.map((chainId): Cell[] => {
    const coverage = view.coverage.filter((c) => c.chainId === chainId);
    const first = touching
      .filter((t) => t.chainId === chainId && inbound(t))
      .sort(
        (a, b) =>
          Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
          a.blockNumber - b.blockNumber ||
          compare(a.id, b.id),
      )[0];
    const exhausted =
      coverage.length > 0 &&
      coverage.every((c) => c.status === "exhausted" && c.cursor === null);
    const streams = [...new Set(coverage.flatMap((c) => c.streams))].sort();
    const warnings = coverage.reduce((n, c) => n + c.warnings.length, 0);
    const count = touching.filter((t) => t.chainId === chainId).length;
    return [
      plain(String(chainId)),
      plain(
        coverage.length
          ? coverage
              .map(
                (c) =>
                  `${c.provider}: ${c.status}, ${c.pagesLoaded} page(s), ${c.cursor === null ? "no cursor" : "cursor present (more history)"}${c.warnings.length ? `, ${c.warnings.length} warning(s)` : ""}${c.errorCode ? `, ${c.errorCode}` : ""}`,
              )
              .join("; ")
          : "No coverage record: a gap",
      ),
      plain(String(count)),
      first
        ? [
            run(
              `${first.timestamp}, block ${first.blockNumber}, ${formatUnits(first.rawAmount, first.asset.decimals)} ${first.asset.symbol} from `,
            ),
            mono(first.from),
            run(" in tx "),
            mono(first.hash),
          ]
        : plain(count ? "No inbound transfer loaded" : "No loaded evidence"),
      plain(
        !first
          ? "Nothing to read"
          : exhausted
            ? `Earliest indexed inbound for streams ${streams.join(", ") || "none"}, NOT earliest-ever funding: indexes can omit transfers and other streams and chains are unchecked.${warnings ? ` ${warnings} coverage warning(s).` : ""}`
            : "First observed only, NOT earliest funding: indexed history is not exhausted.",
      ),
    ];
  });
  return [
    { kind: "heading", level: 1, text: "Loaded case evidence" },
    {
      kind: "paragraph",
      runs: [
        run("Case "),
        mono(investigation.id),
        run(
          `, ${investigation.mode} mode, snapshot ${investigation.updatedAt}, created ${investigation.createdAt}. ${investigation.transfers.length} transfers loaded, ${touching.length} touching the subject. Amounts are exact token units from raw integers. Net flow is inflow minus outflow within the loaded evidence; it is not a holding, balance, profit or loss.`,
        ),
      ],
    },
    { kind: "heading", level: 2, text: "Coverage and first observed inbound" },
    {
      kind: "table",
      headers: [
        "Chain",
        "Coverage",
        "Transfers",
        "First observed inbound",
        "Reading",
      ],
      rows: chainRows,
      widths: [8, 26, 10, 30, 26],
    },
    { kind: "heading", level: 2, text: "Asset flows per contract" },
    {
      kind: "paragraph",
      note: true,
      runs: [
        run(
          "One row per contract; same-symbol tokens are never merged. Only contract “native” is the chain's native asset. A symbol says nothing about who issued a token.",
        ),
      ],
    },
    {
      kind: "table",
      headers: ["Chain", "Symbol", "Contract", "Inflow", "Outflow", "Net"],
      rows: view.flows.map((flow) => [
        plain(String(flow.asset.chainId)),
        plain(flow.asset.symbol),
        flow.asset.contract ? [mono(flow.asset.contract)] : plain("native"),
        plain(formatUnits(flow.inflow, flow.asset.decimals)),
        plain(formatUnits(flow.outflow, flow.asset.decimals)),
        plain(formatUnits(flow.net, flow.asset.decimals)),
      ]),
      widths: [7, 13, 32, 16, 16, 16],
    },
  ];
}

const STANDARD_LIMITS = [
  "This report renders reviewed claims, saved evidence and local screenshots. Producing it made no provider, price, balance, label or other network request.",
  "Screenshots show what a page displayed when captured. They do not authenticate the page, its operator or any claim on it. A missing capture time is shown as unknown.",
  "The assessment status is the preparer's characterisation. User confirmation is a user assertion, not independent proof.",
  "Labels, counterparties, timing, amounts and shared token symbols do not by themselves prove ownership, control or attribution.",
  "SHA-256 values identify the exact files rendered. They do not prove where the files came from.",
];

/** Builds the format-neutral document. Deterministic for the same bundle. */
export function buildReport(bundle: ReportBundle): Block[] {
  const m = bundle.manifest;
  const subject = normalizeAddress(m.subject.address);
  const sources = new Map(m.sources.map((s) => [s.id, s]));
  const blocks: Block[] = [
    {
      kind: "title",
      title: m.title,
      subtitle: m.subtitle,
      banner: m.classification,
    },
    {
      kind: "table",
      headers: ["Field", "Value"],
      widths: [28, 72],
      rows: [
        [plain("Subject address"), [mono(subject)]],
        [plain("Chains"), plain(m.subject.chainIds.join(", "))],
        [plain("Prepared"), plain(m.preparedAt)],
        [plain("Classification"), plain(m.classification)],
        [
          plain("Assessment status"),
          [run(m.assessment.status, { bold: true })],
        ],
        [
          plain("Saved case"),
          bundle.investigation
            ? [
                mono(bundle.investigation.id),
                run(`, snapshot ${bundle.investigation.updatedAt}`),
              ]
            : plain("None: manifest claims and screenshots only"),
        ],
        [
          plain("Evidence"),
          plain(
            `${m.sources.length} source(s), ${bundle.screenshots.length} screenshot(s)`,
          ),
        ],
      ],
    },
    { kind: "heading", level: 1, text: "Summary" },
    { kind: "paragraph", runs: [run(m.summary)] },
    { kind: "heading", level: 2, text: "Assessment" },
    {
      kind: "paragraph",
      runs: [
        run(`Status: ${m.assessment.status}. `, { bold: true }),
        run(STATUS[m.assessment.status], { italic: true }),
      ],
    },
    { kind: "paragraph", runs: [run(m.assessment.conclusion)] },
  ];
  for (const section of m.sections) {
    blocks.push({ kind: "heading", level: 1, text: section.heading });
    for (const paragraph of section.paragraphs ?? [])
      blocks.push({ kind: "paragraph", runs: [run(paragraph)] });
    if (section.bullets?.length)
      blocks.push({ kind: "bullets", items: section.bullets.map(plain) });
    if (section.table)
      blocks.push({
        kind: "table",
        headers: section.table.headers,
        rows: section.table.rows.map((row) => row.map(plain)),
        widths: section.table.headers.map(() => 1),
      });
  }
  if (bundle.investigation) blocks.push(...caseBlocks(bundle));
  const gaps = bundle.investigation
    ? []
    : ["No saved case was attached, so no on-chain amounts are reported."];
  blocks.push(
    { kind: "heading", level: 1, text: "Limitations" },
    {
      kind: "bullets",
      items: [...m.limitations, ...gaps, ...STANDARD_LIMITS].map(plain),
    },
    { kind: "heading", level: 1, text: "Source register" },
    {
      kind: "table",
      headers: ["ID", "Source", "Type", "Observed", "Published", "Figures"],
      widths: [8, 42, 12, 14, 14, 10],
      rows: m.sources.map((s) => {
        const url = s.url ? safeUrl(s.url) : undefined;
        return [
          plain(s.id),
          url
            ? [run(s.title), run(" "), run(url, { href: url, mono: true })]
            : plain(s.title),
          plain(s.type),
          plain(s.observedAt ?? "unknown"),
          plain(s.publishedAt ?? "unknown"),
          plain(
            m.screenshots
              .filter((shot) => shot.sourceId === s.id)
              .map((shot) => shot.id)
              .join(", ") || "none",
          ),
        ];
      }),
    },
    { kind: "heading", level: 1, text: "Evidence inventory" },
    {
      kind: "paragraph",
      note: true,
      runs: [
        run(
          "Paths are relative to the bundle root. Hashes are SHA-256 of the exact bytes read.",
        ),
      ],
    },
    {
      kind: "table",
      headers: ["Item", "File", "Bytes", "SHA-256"],
      widths: [14, 30, 11, 45],
      rows: [
        [
          plain("Bundle digest"),
          plain("manifest, case and screenshot hashes"),
          plain(""),
          [mono(bundleDigest(bundle))],
        ],
        [
          plain("Manifest"),
          plain(bundle.manifestFile.name),
          plain(String(bundle.manifestFile.bytes)),
          [mono(bundle.manifestFile.sha256)],
        ],
        ...(bundle.caseFile
          ? [
              [
                plain("Case"),
                plain(bundle.caseFile.relativePath),
                plain(String(bundle.caseFile.data.length)),
                [mono(bundle.caseFile.sha256)],
              ],
            ]
          : []),
        ...bundle.screenshots.map((s) => [
          plain(`Screenshot ${s.shot.id}`),
          plain(s.relativePath),
          plain(String(s.data.length)),
          [mono(s.sha256)],
        ]),
      ],
    },
  );
  bundle.screenshots.forEach((s, index) => {
    const source = sources.get(s.shot.sourceId)!;
    const url = source.url ? safeUrl(source.url) : undefined;
    if (index === 0)
      blocks.push({
        kind: "heading",
        level: 1,
        text: "Screenshot appendix",
        pageBreak: true,
      });
    blocks.push(
      {
        kind: "heading",
        level: 2,
        text: `Figure ${s.shot.id}`,
        pageBreak: index > 0,
      },
      {
        kind: "figure",
        screenshot: s,
        caption: [
          run(`Figure ${s.shot.id}. `, { bold: true }),
          run(s.shot.caption),
          run(` Source ${source.id}: ${source.title}`),
          ...(url ? [run(" "), run(url, { href: url, mono: true })] : []),
          run(
            `. Captured: ${s.shot.capturedAt ?? "unknown (not recorded)"}. Redactions or crops: ${s.shot.redactions?.length ? s.shot.redactions.join("; ") : "none disclosed"}. File ${s.relativePath}, ${s.image.width}x${s.image.height} px, SHA-256 `,
          ),
          mono(s.sha256),
          run("."),
        ],
      },
    );
  });
  return blocks;
}

export const BRIEF_LIMITS = {
  title: 90,
  subtitle: 120,
  summary: 600,
  conclusion: 300,
  sections: 1,
  heading: 60,
  paragraphs: 1,
  paragraph: 300,
  /** Bullets plus table rows. */
  items: 4,
  bullet: 220,
  tableColumns: 4,
  cell: 100,
  limitations: 1,
  limitation: 250,
  sources: 6,
  sourceTitle: 80,
  screenshots: 2,
  caption: 140,
  host: 60,
  /** Includes generated labels, hosts and the digest line (about 400 of it). */
  pageOneText: 2300,
  /** Smallest allowed display scale and width, so a figure stays readable. */
  minScale: 1 / 3,
  minWidth: 320,
  singleFigureHeight: 860,
  stackedFigureHeight: 400,
} as const;
const BRIEF_STATUS: Record<AssessmentStatus, string> = {
  unresolved: "no attribution conclusion",
  hypothesis: "working explanation, not established",
  "source-supported": "as reliable as the cited sources",
  "user-confirmed": "user assertion, not independent proof",
};
const BRIEF_QUALIFICATION =
  "Sources and screenshots show what was stated or displayed; they do not by themselves prove ownership or control.";

/** One SHA-256 over the manifest, case and screenshot hashes, so a brief pins the exact bundle. */
export function bundleDigest(bundle: ReportBundle): string {
  const lines = [
    `manifest ${bundle.manifestFile.sha256}`,
    ...(bundle.caseFile
      ? [`case ${bundle.caseFile.relativePath} ${bundle.caseFile.sha256}`]
      : []),
    ...bundle.screenshots.map((s) => `image ${s.relativePath} ${s.sha256}`),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Brief figure size: fit the shared page, never upscale; null when it would be unreadably small. */
export function briefFigureSize(
  image: ImageInfo,
  count: number,
): { width: number; height: number } | null {
  const maxHeight =
    count > 1
      ? BRIEF_LIMITS.stackedFigureHeight
      : BRIEF_LIMITS.singleFigureHeight;
  const scale = Math.min(1, CONTENT_PX / image.width, maxHeight / image.height);
  const size = {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
  return scale < BRIEF_LIMITS.minScale ||
    size.width < Math.min(BRIEF_LIMITS.minWidth, image.width)
    ? null
    : size;
}

/**
 * Brief mode never shortens reviewed text. It refuses a manifest that cannot fit one
 * executive page plus one screenshot page, listing every violation at once.
 */
/** Wide glyphs (CJK, emoji, full-width forms) take about twice the advance of Latin text. */
export function displayWeight(text: string): number {
  let weight = 0;
  for (const c of cleanText(text).trim())
    weight +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\p{Extended_Pictographic}]|[\u{20000}-\u{3fffd}]/u.test(
        c,
      )
        ? 2
        : 1;
  return weight;
}
/** Every string the brief puts on page 1, including generated labels, hosts and the digest line. */
function briefPageOneText(bundle: ReportBundle): string[] {
  const m = bundle.manifest,
    section = m.sections[0];
  return [
    m.title,
    m.subtitle ?? "",
    m.classification,
    `Subject ${m.subject.address} · chain ${m.subject.chainIds.join(", ")} · prepared ${m.preparedAt}`,
    `Status: ${m.assessment.status} (${BRIEF_STATUS[m.assessment.status]}). `,
    m.assessment.conclusion,
    m.summary,
    section?.heading ?? "",
    ...(section?.paragraphs ?? []),
    ...(section?.bullets ?? []),
    ...(section?.table
      ? [section.table.headers, ...section.table.rows].flat()
      : []),
    `Qualification: ${m.limitations[0] ?? BRIEF_QUALIFICATION}`,
    ...m.sources.flatMap((s) => [s.id, ...sourceLink(s).map((r) => r.text)]),
    `Bundle SHA-256 ${"0".repeat(64)}. Detailed layout available from retained bundle; full investigation kept separately.`,
  ];
}
export function checkBrief(bundle: ReportBundle): void {
  const m = bundle.manifest,
    issues: string[] = [];
  const over = (label: string, value: string | undefined, max: number) => {
    if (value !== undefined && value.trim().length > max)
      issues.push(
        `${label} has ${value.trim().length} characters (max ${max})`,
      );
  };
  const count = (label: string, length: number, max: number) => {
    if (length > max) issues.push(`${label}: ${length} (max ${max})`);
  };
  over("title", m.title, BRIEF_LIMITS.title);
  over("subtitle", m.subtitle, BRIEF_LIMITS.subtitle);
  over("summary", m.summary, BRIEF_LIMITS.summary);
  over(
    "assessment.conclusion",
    m.assessment.conclusion,
    BRIEF_LIMITS.conclusion,
  );
  count("sections", m.sections.length, BRIEF_LIMITS.sections);
  const section = m.sections[0];
  if (section) {
    over("sections[0].heading", section.heading, BRIEF_LIMITS.heading);
    count(
      "sections[0].paragraphs",
      section.paragraphs?.length ?? 0,
      BRIEF_LIMITS.paragraphs,
    );
    section.paragraphs?.forEach((text, i) =>
      over(`sections[0].paragraphs[${i}]`, text, BRIEF_LIMITS.paragraph),
    );
    count(
      "sections[0] bullets plus table rows",
      (section.bullets?.length ?? 0) + (section.table?.rows.length ?? 0),
      BRIEF_LIMITS.items,
    );
    section.bullets?.forEach((text, i) =>
      over(`sections[0].bullets[${i}]`, text, BRIEF_LIMITS.bullet),
    );
    if (section.table) {
      count(
        "sections[0].table columns",
        section.table.headers.length,
        BRIEF_LIMITS.tableColumns,
      );
      [section.table.headers, ...section.table.rows].forEach((row, r) =>
        row.forEach((text, c) =>
          over(`sections[0].table cell [${r}][${c}]`, text, BRIEF_LIMITS.cell),
        ),
      );
    }
  }
  count("limitations", m.limitations.length, BRIEF_LIMITS.limitations);
  m.limitations.forEach((text, i) =>
    over(`limitations[${i}]`, text, BRIEF_LIMITS.limitation),
  );
  count("sources", m.sources.length, BRIEF_LIMITS.sources);
  m.sources.forEach((s, i) =>
    over(`sources[${i}].title`, s.title, BRIEF_LIMITS.sourceTitle),
  );
  count("screenshots", m.screenshots.length, BRIEF_LIMITS.screenshots);
  m.screenshots.forEach((s, i) =>
    over(`screenshots[${i}].caption`, s.caption, BRIEF_LIMITS.caption),
  );
  if (m.screenshots.length <= BRIEF_LIMITS.screenshots)
    for (const s of bundle.screenshots)
      if (!briefFigureSize(s.image, bundle.screenshots.length))
        issues.push(
          `screenshot ${s.shot.id} (${s.image.width}x${s.image.height} px) would shrink below readable size on a shared page; crop it tighter`,
        );
  const pageOne = briefPageOneText(bundle).reduce(
    (sum, text) => sum + displayWeight(text),
    0,
  );
  count(
    "page-1 text weight (characters, wide glyphs count 2)",
    pageOne,
    BRIEF_LIMITS.pageOneText,
  );
  for (const s of m.sources)
    if (s.url && safeUrl(s.url))
      over(`sources ${s.id} host`, new URL(s.url).host, BRIEF_LIMITS.host);
  if (issues.length)
    throw new Error(
      `Manifest is too long for --brief. Shorten the reviewed text (nothing is truncated automatically), or omit --brief for the detailed report:\n- ${issues.join("\n- ")}`,
    );
}

const day = (value: string | null | undefined) =>
  value ? value.slice(0, 10) : "unknown";
function sourceLink(source: ReportManifest["sources"][number]): Run[] {
  const url = source.url ? safeUrl(source.url) : undefined;
  return url
    ? [
        run(source.title, { href: url }),
        run(
          ` (${new URL(url).host}${source.observedAt ? `, observed ${day(source.observedAt)}` : ""})`,
        ),
      ]
    : [
        run(source.title),
        run(
          ` (${source.type}${source.observedAt ? `, observed ${day(source.observedAt)}` : ""})`,
        ),
      ];
}

/** One executive page plus at most one screenshot page. Call checkBrief first. */
export function buildBrief(bundle: ReportBundle): Block[] {
  checkBrief(bundle);
  const m = bundle.manifest,
    section = m.sections[0];
  const sources = new Map(m.sources.map((s) => [s.id, s]));
  const blocks: Block[] = [
    {
      kind: "title",
      title: m.title,
      subtitle: m.subtitle,
      banner: m.classification,
    },
    {
      kind: "paragraph",
      runs: [
        run("Subject ", { bold: true }),
        mono(normalizeAddress(m.subject.address)),
        run(
          ` · chain ${m.subject.chainIds.join(", ")} · prepared ${m.preparedAt}`,
        ),
      ],
    },
    {
      kind: "paragraph",
      runs: [
        run(`Status: ${m.assessment.status}`, { bold: true }),
        run(` (${BRIEF_STATUS[m.assessment.status]}). `, { italic: true }),
        run(m.assessment.conclusion),
      ],
    },
    { kind: "paragraph", runs: [run(m.summary)] },
  ];
  if (section) {
    blocks.push({ kind: "heading", level: 2, text: section.heading });
    for (const text of section.paragraphs ?? [])
      blocks.push({ kind: "paragraph", runs: [run(text)] });
    if (section.bullets?.length)
      blocks.push({ kind: "bullets", items: section.bullets.map(plain) });
    if (section.table)
      blocks.push({
        kind: "table",
        headers: section.table.headers,
        rows: section.table.rows.map((row) => row.map(plain)),
        widths: section.table.headers.map(() => 1),
      });
  }
  blocks.push({
    kind: "paragraph",
    runs: [
      run("Qualification: ", { bold: true }),
      run(m.limitations[0] ?? BRIEF_QUALIFICATION),
    ],
  });
  if (m.sources.length)
    blocks.push(
      { kind: "heading", level: 2, text: "Sources" },
      {
        kind: "bullets",
        items: m.sources.map((s) => [
          run(`${s.id} `, { bold: true }),
          ...sourceLink(s),
        ]),
      },
    );
  blocks.push({
    kind: "paragraph",
    note: true,
    runs: [
      run("Bundle SHA-256 "),
      mono(bundleDigest(bundle)),
      run(
        ". Detailed layout available from retained bundle; full investigation kept separately.",
      ),
    ],
  });
  bundle.screenshots.forEach((s, index) => {
    const source = sources.get(s.shot.sourceId)!;
    blocks.push({
      kind: "figure",
      screenshot: s,
      size: briefFigureSize(s.image, bundle.screenshots.length)!,
      pageBreak: index === 0,
      caption: [
        run(`Figure ${s.shot.id}. `, { bold: true }),
        run(`${s.shot.caption} Source: `),
        ...sourceLink(source).slice(0, 1),
        run(
          ` · captured ${day(s.shot.capturedAt)}${s.shot.redactions?.length ? " · crop/redaction disclosed in manifest" : ""}`,
        ),
      ],
    });
  });
  return blocks;
}

export interface RenderOptions {
  /** One executive page plus at most one screenshot page; detailed audit omitted. */
  brief?: boolean;
}
const blocksFor = (bundle: ReportBundle, options: RenderOptions) =>
  options.brief ? buildBrief(bundle) : buildReport(bundle);

function htmlRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      let html = escapeHtml(r.text);
      if (r.mono) html = `<code>${html}</code>`;
      if (r.bold) html = `<strong>${html}</strong>`;
      if (r.italic) html = `<em>${html}</em>`;
      const href = r.href ? safeUrl(r.href) : undefined;
      return href
        ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${html}</a>`
        : html;
    })
    .join("");
}
const CSS = `@page{size:A4;margin:20mm 18mm}
*{box-sizing:border-box}
body{margin:0;font:11pt/1.45 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1a1a1a;overflow-wrap:anywhere;word-break:break-word}
main{max-width:174mm;margin:0 auto}
main *{min-width:0;max-width:100%}
h1{font-size:15pt;margin:18pt 0 6pt;border-bottom:1px solid #ccc;padding-bottom:3pt;break-after:avoid}
h2{font-size:12pt;margin:12pt 0 4pt;break-after:avoid}
.title{font-size:22pt;border:0;margin:24pt 0 4pt}
.subtitle{font-size:12pt;color:#444;margin:0 0 10pt}
.banner{display:inline-block;border:1.5pt solid #8a1c1c;color:#8a1c1c;font-weight:600;padding:2pt 8pt;margin:0 0 12pt;text-transform:uppercase;letter-spacing:.04em}
p{margin:0 0 6pt}.note{color:#555;font-size:9.5pt}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;overflow-wrap:anywhere;word-break:break-all}
a{color:#0b4f9c}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin:4pt 0 10pt;font-size:9pt}
th,td{border:.5pt solid #bbb;padding:3pt 4pt;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
th{background:#eef1f4}thead{display:table-header-group}tr{break-inside:avoid}
.page-break{break-before:page}
figure{margin:6pt 0 0;break-inside:avoid;text-align:center}
figure img{display:block;margin:0 auto 6pt;border:.5pt solid #999}
figcaption{text-align:left;font-size:9.5pt}`;
/** Self-contained HTML: no script, no remote resource, images inline as data URLs. */
export function renderHtml(
  bundle: ReportBundle,
  options: RenderOptions = {},
): string {
  const body = blocksFor(bundle, options)
    .map((block) => {
      switch (block.kind) {
        case "title":
          return `<h1 class="title">${escapeHtml(block.title)}</h1>${block.subtitle ? `<p class="subtitle">${escapeHtml(block.subtitle)}</p>` : ""}<p class="banner">${escapeHtml(block.banner)}</p>`;
        case "heading":
          return `<h${block.level}${block.pageBreak ? ' class="page-break"' : ""}>${escapeHtml(block.text)}</h${block.level}>`;
        case "paragraph":
          return `<p${block.note ? ' class="note"' : ""}>${htmlRuns(block.runs)}</p>`;
        case "bullets":
          return `<ul>${block.items.map((item) => `<li>${htmlRuns(item)}</li>`).join("")}</ul>`;
        case "table": {
          const total = block.widths.reduce((a, b) => a + b, 0);
          return `<table><colgroup>${block.widths.map((w) => `<col style="width:${((w / total) * 100).toFixed(2)}%">`).join("")}</colgroup><thead><tr>${block.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${block.rows.length ? block.rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlRuns(cell)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${block.headers.length}">None recorded.</td></tr>`}</tbody></table>`;
        }
        case "figure": {
          const s = block.screenshot,
            size = block.size ?? displaySize(s.image);
          return `<figure${block.pageBreak ? ' class="page-break"' : ""}><img src="data:${s.image.mime};base64,${s.data.toString("base64")}" width="${size.width}" height="${size.height}" style="width:${size.width}px;height:${size.height}px" alt="${escapeHtml(`Figure ${s.shot.id}: ${s.shot.caption}`)}"><figcaption>${htmlRuns(block.caption)}</figcaption></figure>`;
        }
      }
    })
    .join("\n");
  const m = bundle.manifest;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(m.title)}</title>
<style>${CSS}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

const BROWSER_HELP =
  "PDF output needs a local Chromium. Install one with `npx playwright install chromium` or install Google Chrome, then retry. FlowLens never downloads a browser by itself; use .docx or .html output meanwhile.";
/** Renders the same self-contained HTML in a throwaway offline browser context. */
/** Counts page objects in a Chromium PDF (uncompressed object headers). */
export function pdfPageCount(pdf: Buffer): number {
  return pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
}
export async function renderPdf(
  bundle: ReportBundle,
  options: RenderOptions = {},
): Promise<Buffer> {
  const html = renderHtml(bundle, options);
  let chromium: typeof import("@playwright/test").chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    throw new Error(BROWSER_HELP);
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  for (const options of [{}, { channel: "chrome" }])
    try {
      browser = await chromium.launch({ headless: true, ...options });
      break;
    } catch {
      // Try the next locally installed browser.
    }
  if (!browser) throw new Error(BROWSER_HELP);
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const attempted: string[] = [];
    await context.route("**/*", (route) => {
      attempted.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const images = page.locator("figure img");
    const count = await images.count();
    if (count !== bundle.screenshots.length)
      throw new Error("Rendered figure count differs from the manifest");
    for (let index = 0; index < count; index++) {
      const shot = bundle.screenshots[index];
      const decoded = await images.nth(index).evaluate(async (node) => {
        const image = node as HTMLImageElement;
        try {
          await image.decode();
        } catch {
          return null;
        }
        return image.complete
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null;
      });
      if (
        !decoded ||
        decoded.width !== shot.image.width ||
        decoded.height !== shot.image.height
      )
        throw new Error(
          `Screenshot ${shot.relativePath}: the browser could not decode it at ${shot.image.width}x${shot.image.height}; no PDF written`,
        );
    }
    if (attempted.length)
      throw new Error(
        `Report rendering attempted ${attempted.length} network request(s); refused`,
      );
    if (options.brief) {
      await page.emulateMedia({ media: "print" });
      const overflow = await page.evaluate(() =>
        [...document.querySelectorAll("main, main *")]
          .filter(
            (node) =>
              !(node instanceof HTMLImageElement) &&
              node.scrollWidth > node.clientWidth + 1 &&
              node.clientWidth > 0,
          )
          .map((node) => node.tagName.toLowerCase()),
      );
      if (overflow.length)
        throw new Error(
          `Brief text overflows the page width in: ${[...new Set(overflow)].join(", ")}. Shorten or break the reviewed text; nothing is truncated automatically`,
        );
    }
    const m = bundle.manifest;
    const small =
      'font:7.5pt -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#555;width:100%;padding:0 18mm;gap:8pt;overflow-wrap:anywhere;';
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      tagged: true,
      outline: true,
      displayHeaderFooter: true,
      margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
      headerTemplate: `<div style="${small}display:flex;justify-content:space-between"><span style="min-width:0">${escapeHtml(m.title)}</span><span style="min-width:0;text-align:right">${escapeHtml(m.classification)}</span></div>`,
      footerTemplate: `<div style="${small}display:flex;justify-content:space-between"><span>Prepared ${escapeHtml(m.preparedAt)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
    if (options.brief) {
      const expected = bundle.screenshots.length ? 2 : 1,
        pages = pdfPageCount(pdf);
      if (pages !== expected)
        throw new Error(
          `Brief rendered ${pages} pages instead of ${expected}: page 1 text or the screenshot page does not fit. Shorten the reviewed text or crop the screenshots; nothing is truncated automatically`,
        );
    }
    return pdf;
  } finally {
    await browser.close();
  }
}

const FONT = "Calibri",
  MONO = "Consolas";
function docxRuns(runs: Run[], size = 22) {
  return runs.map((r) => {
    const text = new TextRun({
      text: cleanText(r.text),
      bold: r.bold,
      italics: r.italic,
      font: r.mono ? MONO : FONT,
      size: r.mono ? size - 2 : size,
      ...(r.href ? { style: "Hyperlink" } : {}),
    });
    const href = r.href ? safeUrl(r.href) : undefined;
    return href
      ? new ExternalHyperlink({ link: href, children: [text] })
      : text;
  });
}
/** Word document with semantic headings, fixed-layout tables, embedded images, header, footer and page numbers. */
export async function renderDocx(
  bundle: ReportBundle,
  options: RenderOptions = {},
): Promise<Buffer> {
  const m = bundle.manifest;
  const border = { style: BorderStyle.SINGLE, size: 4, color: "BBBBBB" };
  const children = blocksFor(bundle, options).flatMap((block) => {
    switch (block.kind) {
      case "title":
        return [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: cleanText(block.title) })],
          }),
          ...(block.subtitle
            ? [
                new Paragraph({
                  children: docxRuns([run(block.subtitle)], 24),
                }),
              ]
            : []),
          new Paragraph({
            spacing: { before: 120, after: 240 },
            children: [
              new TextRun({
                text: cleanText(block.banner).toUpperCase(),
                bold: true,
                color: "8A1C1C",
                font: FONT,
                size: 20,
              }),
            ],
          }),
        ];
      case "heading":
        return [
          new Paragraph({
            heading:
              block.level === 1
                ? HeadingLevel.HEADING_1
                : HeadingLevel.HEADING_2,
            pageBreakBefore: block.pageBreak,
            keepNext: true,
            children: [new TextRun({ text: cleanText(block.text) })],
          }),
        ];
      case "paragraph":
        return [
          new Paragraph({
            spacing: { after: 120 },
            children: docxRuns(
              block.note
                ? block.runs.map((r) => ({ ...r, italic: true }))
                : block.runs,
              block.note ? 19 : 22,
            ),
          }),
        ];
      case "bullets":
        return block.items.map(
          (item) =>
            new Paragraph({ bullet: { level: 0 }, children: docxRuns(item) }),
        );
      case "table": {
        const total = block.widths.reduce((a, b) => a + b, 0);
        const widths = block.widths.map((w) =>
          Math.floor((w / total) * CONTENT_TWIPS),
        );
        const cell = (runs: Run[], index: number, header = false) =>
          new TableCell({
            width: { size: widths[index], type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            borders: {
              top: border,
              bottom: border,
              left: border,
              right: border,
            },
            ...(header
              ? {
                  shading: {
                    type: ShadingType.CLEAR,
                    fill: "EEF1F4",
                    color: "auto",
                  },
                }
              : {}),
            children: [new Paragraph({ children: docxRuns(runs, 18) })],
          });
        const rows = block.rows.length
          ? block.rows
          : [
              block.headers.map((_, index) =>
                index ? [] : plain("None recorded."),
              ),
            ];
        return [
          new Table({
            width: { size: CONTENT_TWIPS, type: WidthType.DXA },
            columnWidths: widths,
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({
                tableHeader: true,
                cantSplit: true,
                children: block.headers.map((h, index) =>
                  cell([run(h, { bold: true })], index, true),
                ),
              }),
              ...rows.map(
                (row) =>
                  new TableRow({
                    cantSplit: true,
                    children: row.map((runs, index) => cell(runs, index)),
                  }),
              ),
            ],
          }),
          new Paragraph({ spacing: { after: 120 }, children: [] }),
        ];
      }
      case "figure": {
        const s = block.screenshot,
          size = block.size ?? displaySize(s.image);
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            pageBreakBefore: block.pageBreak,
            keepNext: true,
            children: [
              new ImageRun({
                type: s.image.type,
                data: s.data,
                transformation: size,
                altText: {
                  name: `Figure ${s.shot.id}`,
                  title: `Figure ${s.shot.id}`,
                  description: cleanText(s.shot.caption),
                },
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 80 },
            children: docxRuns(block.caption, 19),
          }),
        ];
      }
    }
  });
  const small = (text: string) =>
    new TextRun({
      text: cleanText(text),
      font: FONT,
      size: 15,
      color: "555555",
    });
  const document = new Document({
    creator: "FlowLens",
    title: cleanText(m.title),
    description: "Offline FlowLens evidence report",
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: {
              top: 1134,
              bottom: 1134,
              left: 1021,
              right: 1021,
              header: 567,
              footer: 567,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [small(`${m.title} · ${m.classification}`)],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  small(`Prepared ${m.preparedAt} · `),
                  new TextRun({
                    children: [
                      "Page ",
                      PageNumber.CURRENT,
                      " of ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    font: FONT,
                    size: 15,
                    color: "555555",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

export type ReportFormat = "pdf" | "docx" | "html";
const EXTENSIONS: Record<string, ReportFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".html": "html",
  ".htm": "html",
};
const USAGE =
  "Usage: node scripts/report-document.ts --manifest MANIFEST.json --output REPORT.pdf|.docx|.html [--format pdf|docx|html] [--bundle-root DIR] [--brief] [--force]";

/** Never modifies inputs; refuses existing output without --force and any output aliasing an input. */
export async function main(
  argv: string[],
): Promise<{ output: string; format: ReportFormat; bytes: number }> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      manifest: { type: "string" },
      output: { type: "string" },
      format: { type: "string" },
      "bundle-root": { type: "string" },
      force: { type: "boolean", default: false },
      brief: { type: "boolean", default: false },
    },
  });
  if (!values.manifest || !values.output) throw new Error(USAGE);
  const inferred = EXTENSIONS[extname(values.output).toLowerCase()];
  if (
    values.format !== undefined &&
    !["pdf", "docx", "html"].includes(values.format)
  )
    throw new Error(USAGE);
  const format = (values.format as ReportFormat | undefined) ?? inferred;
  if (!format || format !== inferred)
    throw new Error(
      `Output extension must be .${format ?? "pdf, .docx or .html"} to match the report format`,
    );
  const bundle = await loadReportBundle(values.manifest, values["bundle-root"]);
  const options = { brief: values.brief };
  if (options.brief) {
    checkBrief(bundle);
    // Every brief format is gated on the same rendered layout: width overflow and page count.
    if (format !== "pdf") await renderPdf(bundle, options);
  }
  const data =
    format === "html"
      ? Buffer.from(renderHtml(bundle, options))
      : format === "docx"
        ? await renderDocx(bundle, options)
        : await renderPdf(bundle, options);
  const output = await writeReportFile(
    values.output,
    data,
    bundle.inputs,
    values.force,
  );
  return { output, format, bytes: data.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    ({ output, format, bytes }) =>
      console.log(
        `Wrote ${format.toUpperCase()} report ${output} (${bytes} bytes)`,
      ),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
