import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const MAX_SKILL_LINES = 200;
export const MAX_SKILL_BYTES = 25 * 1024;
export const REVIEWED_BINARY_ASSETS = Object.freeze([]);
const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imageExtensions = new Set([".png", ".jpg", ".jpeg"]);

export function logicalLines(text) {
  if (!text.length) return [];
  const lines = text.split(/\r\n|[\n\r\u0085\u2028\u2029]/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function imageSignature(path, data) {
  if (extname(path).toLowerCase() === ".png")
    return (
      data.length >= 45 &&
      data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      data.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
    );
  return (
    data.length >= 4 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data.at(-2) === 255 &&
    data.at(-1) === 217
  );
}

export async function checkSkills(
  root = rootPath,
  { allowMissing = false, binaryAssets = REVIEWED_BINARY_ASSETS } = {},
) {
  const requested = resolve(root);
  if ((await lstat(requested)).isSymbolicLink())
    throw new Error("Skill root: symbolic link rejected");
  const base = await realpath(requested);
  const directory = join(base, "skills");
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("skills: expected a directory, not a symbolic link");
  } catch (error) {
    if (allowMissing && error.code === "ENOENT")
      return { text: [], binary: [], missing: true };
    throw new Error("skills: missing, unreadable or symbolic-link directory", {
      cause: error,
    });
  }
  const reviewed = new Set(binaryAssets),
    text = [],
    binary = [],
    findings = [];
  async function walk(parent) {
    for (const name of (await readdir(parent)).sort()) {
      const path = join(parent, name);
      const label = relative(base, path).split(sep).join("/");
      const reject = (reason) =>
        findings.push(`${JSON.stringify(label)}: ${reason}`);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        reject("symbolic link rejected");
        continue;
      }
      if (stat.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stat.isFile()) {
        reject("expected a regular file");
        continue;
      }
      if (
        name === "SKILL.md" &&
        !/^skills\/[^./][^/]*\/[^./][^/]*\/SKILL\.md$/.test(label)
      )
        reject("SKILL.md must be skills/<category>/<skill>/SKILL.md");
      const image = imageExtensions.has(extname(name).toLowerCase());
      if (stat.size > (image ? 8_000_000 : MAX_SKILL_BYTES)) {
        reject(
          `${stat.size} bytes exceeds ${image ? 8_000_000 : MAX_SKILL_BYTES} byte limit`,
        );
        continue;
      }
      if (image && !reviewed.has(label)) {
        reject("binary asset requires explicit REVIEWED_BINARY_ASSETS entry");
        continue;
      }
      const canonical = await realpath(path);
      if (!canonical.startsWith(directory + sep)) {
        reject("path escapes skills directory");
        continue;
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let data;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        ) {
          reject("file changed during inspection");
          continue;
        }
        data = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (data.length !== stat.size) {
        reject("file changed during inspection");
        continue;
      }
      if (image) {
        if (!imageSignature(path, data))
          reject("reviewed binary image signature mismatch");
        else binary.push(label);
        continue;
      }
      if (reviewed.has(label)) {
        reject("reviewed binary path is not a supported image");
        continue;
      }
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        reject("non-UTF-8 data is not an approved binary asset");
        continue;
      }
      if (
        [...content].some((char) => {
          const code = char.codePointAt(0);
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
        })
      ) {
        reject("non-text control bytes rejected");
        continue;
      }
      const lines = logicalLines(content);
      if (lines.length > MAX_SKILL_LINES)
        reject(`${lines.length} logical lines exceeds ${MAX_SKILL_LINES}`);
      text.push({ path: label, lines: lines.length, bytes: data.length });
    }
  }
  await walk(directory);
  if (findings.length)
    throw new Error(`Skill layout check failed:\n${findings.join("\n")}`);
  return { text, binary, missing: false };
}

export async function main(args = process.argv.slice(2)) {
  let root = rootPath;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--root" || args[1].startsWith("--"))
      throw new Error("Usage: node scripts/check-skills.mjs [--root DIR]");
    root = resolve(args[1]);
  }
  const result = await checkSkills(root);
  console.log(
    JSON.stringify({
      audit: "passed",
      textFiles: result.text.length,
      binaryFiles: result.binary.length,
      maxLines: MAX_SKILL_LINES,
      maxBytes: MAX_SKILL_BYTES,
      textBytes: result.text.reduce((total, file) => total + file.bytes, 0),
    }),
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error && !error.code
        ? error.message
        : "Skill layout check failed: filesystem operation unavailable",
    );
    process.exitCode = 1;
  });
