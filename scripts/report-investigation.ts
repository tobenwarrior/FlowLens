// Offline Markdown report over one saved FlowLens case. Reads loaded evidence only:
// no provider, price, balance or label requests and no expansion.
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  link as hardLink,
  lstat,
  mkdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assetKey,
  filterTransfers,
  formatUnits,
  nodeKey,
  normalizeAddress,
} from "../src/domain/engine.ts";
import { walletFlows } from "../src/domain/wallet-flows.ts";
import { readSnapshot } from "../server/store.ts";
import type {
  Address,
  Asset,
  Coverage,
  Investigation,
  Transfer,
  WalletNode,
} from "../src/domain/types.ts";

export interface ReportOptions {
  /** Strongest transfers listed per asset contract; ranking never crosses assets. */
  top?: number;
  /** File name shown as the evidence source; directories are omitted. */
  sourceName?: string;
}

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i;
const HEX_HASH = /^0x[0-9a-f]{64}$/i;
// Kept in step with the UI explorer map; scripts cannot import the React component.
const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  957: "https://explorer.derive.xyz",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
};

/** Untrusted text → inert Markdown: no HTML, links, emphasis, tables or line breaks. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(
      /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g,
      (c) =>
        `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`,
    )
    .replace(/[\\`*_{}[\]()#+\-.!|~"':]/g, (c) => `\\${c}`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
const code = (value: string, pattern: RegExp) =>
  pattern.test(value) ? `\`${value}\`` : escapeMarkdown(value);
const address = (value: string) => code(value, HEX_ADDRESS);
function link(text: string, url: string | undefined): string {
  if (!url) return text;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return text;
  }
  if (parsed.protocol !== "https:") return text;
  return `[${text}](${parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
}
const explorer = (chainId: number, type: "tx" | "address", value: string) =>
  EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/${type}/${value}` : undefined;
const txRef = (t: Transfer) =>
  link(code(t.hash, HEX_HASH), explorer(t.chainId, "tx", t.hash));
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
function table(head: string[], rows: string[][]): string[] {
  if (!rows.length) return ["_None in loaded evidence._"];
  return [row(head), row(head.map(() => "---")), ...rows.map(row)];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const amount = (raw: string, decimals: number) => formatUnits(raw, decimals);
function range(values: string[]): string {
  if (!values.length) return "none";
  const sorted = [...values].sort(compare);
  return sorted[0] === sorted.at(-1)
    ? sorted[0]
    : `${sorted[0]} to ${sorted.at(-1)}`;
}
function labelText(node: WalletNode | undefined): string {
  const l = node?.label;
  if (!l) return "";
  return `${escapeMarkdown(l.text)} (${escapeMarkdown(`${l.kind}, ${l.confidence}, ${l.claimType ?? "unspecified claim"}`)}; source ${link(escapeMarkdown(l.source), l.sourceUrl)})`;
}
const symbolKey = (symbol: string) =>
  symbol.normalize("NFKC").trim().toLowerCase();
const contractCell = (asset: Asset) =>
  asset.contract
    ? link(
        address(asset.contract),
        explorer(asset.chainId, "address", asset.contract),
      )
    : "native";
function chronological(a: Transfer, b: Transfer): number {
  return (
    Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
    a.blockNumber - b.blockNumber ||
    compare(a.id, b.id)
  );
}

const LIMITS = [
  "Scope: loaded evidence in this saved case only. The report made no provider, price, balance or label request and did not expand any wallet.",
  "Net flow is loaded inflow minus loaded outflow per asset contract. It is not a holding, balance, profit, loss, buy or sell.",
  "No prices or USD values appear here; amounts are exact token units derived from raw integers and recorded decimals.",
  "Self-transfers count as both inflow and outflow. Reverted transactions are excluded by provider validation, yet a successful frame inside a larger transaction can still mislead.",
  "Dust, spam and same-symbol tokens from noncanonical contracts are reported per contract and never merged by symbol. Check the contract before treating any symbol as a known asset.",
  "Labels are recorded claims with their source and confidence. They, counterparties, timing and amounts do not prove ownership or attribution.",
  "Coverage that is partial, errored, unsupported or missing means chain or stream gaps. Absence of evidence here is not evidence of absence.",
];

function sourceCounts(transfers: Transfer[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of transfers)
    counts.set(t.source, (counts.get(t.source) ?? 0) + 1);
  return counts;
}
/** Deterministic: the same snapshot renders byte-identical Markdown. */
export function renderInvestigationReport(
  investigation: Investigation,
  options: ReportOptions = {},
): string {
  const top = options.top ?? 3;
  if (!Number.isSafeInteger(top) || top < 1 || top > 50)
    throw new Error("--top must be an integer from 1 to 50");
  const root = normalizeAddress(investigation.root);
  const view = walletFlows(investigation, { address: root, pageSize: 1 });
  const nodes = new Map(
    investigation.nodes.map((n) => [nodeKey(n.chainId, n.address), n]),
  );
  const node = (chainId: number, value: Address) =>
    nodes.get(nodeKey(chainId, value));
  const touching = filterTransfers(investigation.transfers, root).filter(
    (t) => normalizeAddress(t.from) === root || normalizeAddress(t.to) === root,
  );
  const direction = (t: Transfer) => {
    const incoming = normalizeAddress(t.to) === root,
      outgoing = normalizeAddress(t.from) === root;
    return incoming && outgoing ? "self" : incoming ? "in" : "out";
  };
  const synthetic =
    investigation.mode === "demo" ||
    investigation.transfers.some((t) => t.synthetic);
  const digest = createHash("sha256")
    .update(JSON.stringify(investigation))
    .digest("hex");
  const symbols = new Map<string, string[]>();
  const native = new Set(["eth"]);
  for (const t of investigation.transfers) {
    const key = `${t.chainId}:${symbolKey(t.asset.symbol)}`;
    const keys = symbols.get(key) ?? [];
    if (!keys.includes(assetKey(t.asset)))
      symbols.set(key, [...keys, assetKey(t.asset)]);
    if (t.asset.contract === null) native.add(symbolKey(t.asset.symbol));
  }
  const assetCell = (asset: Asset) => {
    const notes = [];
    if (
      (symbols.get(`${asset.chainId}:${symbolKey(asset.symbol)}`)?.length ??
        0) > 1
    )
      notes.push("same symbol as another contract");
    if (/[^\x20-\x7e]/.test(asset.symbol))
      notes.push("non-ASCII symbol, possible homograph");
    if (asset.contract && native.has(symbolKey(asset.symbol)))
      notes.push("token named like a native asset");
    const symbol = escapeMarkdown(asset.symbol);
    return notes.length ? `${symbol} (warning: ${notes.join("; ")})` : symbol;
  };
  const byAsset = new Map<string, Transfer[]>();
  for (const t of touching) {
    const key = assetKey(t.asset);
    if (!byAsset.has(key)) byAsset.set(key, []);
    byAsset.get(key)!.push(t);
  }
  const rootCoverage = (chainId: number) =>
    investigation.coverage.filter(
      (c) => normalizeAddress(c.address) === root && c.chainId === chainId,
    );
  const chains = [
    ...new Set([
      ...touching.map((t) => t.chainId),
      ...view.coverage.map((c) => c.chainId),
    ]),
  ].sort((a, b) => a - b);
  const out: string[] = [];

  out.push(
    `# FlowLens investigation report: ${escapeMarkdown(investigation.title)}`,
    "",
  );
  if (synthetic)
    out.push(
      "> **SYNTHETIC DEMO DATA.** This case contains fictional evidence and describes no real wallet.",
      "",
    );
  out.push(
    ...table(
      ["Field", "Value"],
      [
        ["Root wallet", address(root)],
        [
          "Root label",
          labelText(
            investigation.nodes.find(
              (n) => normalizeAddress(n.address) === root && n.label,
            ),
          ) || "none recorded",
        ],
        ["Case ID", code(investigation.id, /^[a-zA-Z0-9_-]{1,100}$/)],
        ["Mode", investigation.mode],
        ["Case created", investigation.createdAt],
        ["Snapshot time (case updatedAt)", investigation.updatedAt],
        [
          "Evidence retrieved",
          range(investigation.transfers.map((t) => t.retrievedAt)),
        ],
        [
          "Coverage updated",
          range(investigation.coverage.map((c) => c.updatedAt)),
        ],
        [
          "Loaded transfers (case / touching root)",
          `${investigation.transfers.length} / ${touching.length}`,
        ],
        [
          "Hidden graph evidence (still counted)",
          `${investigation.hiddenTransfers?.length ?? 0} transfers, ${investigation.hidden.length} wallets`,
        ],
        [
          "Protocol evidence attached",
          investigation.protocolEvidence
            ? `yes (${investigation.protocolEvidence.mode}), not analyzed here`
            : "no",
        ],
        [
          "Source file",
          options.sourceName
            ? escapeMarkdown(options.sourceName)
            : "not recorded",
        ],
        ["Normalized snapshot SHA-256", `\`${digest}\``],
      ],
    ),
    "",
    "## Limits",
    "",
    ...LIMITS.map((line) => `- ${line}`),
    "",
    "## Coverage per wallet and chain",
    "",
    ...table(
      [
        "Wallet",
        "Chain",
        "Provider",
        "Status",
        "Streams",
        "Pages",
        "Cursor",
        "Updated",
        "Warnings / error",
      ],
      [...investigation.coverage]
        .sort((a, b) => compare(a.key, b.key))
        .map((c: Coverage) => [
          `${address(c.address)}${normalizeAddress(c.address) === root ? " (root)" : ""}`,
          String(c.chainId),
          escapeMarkdown(c.provider),
          c.status,
          c.streams.join(", ") || "none",
          String(c.pagesLoaded),
          c.cursor === null ? "none" : "present (more history)",
          c.updatedAt,
          escapeMarkdown(
            [
              ...c.warnings,
              ...(c.errorCode ? [`${c.errorCode}: ${c.error ?? ""}`] : []),
            ].join("; "),
          ) || "none",
        ]),
    ),
    "",
  );
  const missing = chains.filter((chainId) => !rootCoverage(chainId).length);
  if (missing.length)
    out.push(
      `Root chains with transfers but no root coverage record: ${missing.join(", ")}.`,
      "",
    );

  out.push(
    "## Root asset flows per contract",
    "",
    "Exact loaded amounts. Each row is one contract; same-symbol rows are never combined. Only contract `native` is the chain's native asset.",
    "",
    ...table(
      [
        "Chain",
        "Asset",
        "Contract",
        "Decimals",
        "Inflow",
        "Outflow",
        "Net",
        "Transfers (in / out / self)",
      ],
      view.flows.map((flow) => {
        const rows = byAsset.get(assetKey(flow.asset)) ?? [];
        const count = (d: string) =>
          rows.filter((t) => direction(t) === d).length;
        return [
          String(flow.asset.chainId),
          assetCell(flow.asset),
          contractCell(flow.asset),
          String(flow.asset.decimals),
          amount(flow.inflow, flow.asset.decimals),
          amount(flow.outflow, flow.asset.decimals),
          amount(flow.net, flow.asset.decimals),
          `${count("in")} / ${count("out")} / ${count("self")}`,
        ];
      }),
    ),
    "",
    "## Strongest root transfers per asset",
    "",
    `Up to ${top} largest non-self transfers per contract by exact amount. Size is compared only within one contract; without prices there is no cross-asset ranking.`,
    "",
  );
  const strongest = view.flows.flatMap((flow) =>
    (byAsset.get(assetKey(flow.asset)) ?? [])
      .filter((t) => direction(t) !== "self")
      .sort((a, b) => {
        const delta = BigInt(b.rawAmount) - BigInt(a.rawAmount);
        return delta > 0n ? 1 : delta < 0n ? -1 : chronological(a, b);
      })
      .slice(0, top)
      .map((t) => {
        const counterparty = direction(t) === "in" ? t.from : t.to;
        return [
          t.timestamp,
          String(t.chainId),
          assetCell(t.asset),
          contractCell(t.asset),
          direction(t),
          amount(t.rawAmount, t.asset.decimals),
          `${address(counterparty)}${labelText(node(t.chainId, counterparty)) ? ` ${labelText(node(t.chainId, counterparty))}` : ""}`,
          txRef(t),
          code(t.id, /^[\w.:-]+$/),
        ];
      }),
  );
  out.push(
    ...table(
      [
        "Time (UTC)",
        "Chain",
        "Asset",
        "Contract",
        "Dir",
        "Amount",
        "Counterparty",
        "Transaction",
        "Evidence ID",
      ],
      strongest,
    ),
    "",
    "## First observed inbound transfer per chain",
    "",
    "The earliest inbound transfer in loaded evidence. It is the earliest indexed inbound only where root coverage on that chain is exhausted for every listed stream; it is not proof of funding source either way.",
    "",
  );
  out.push(
    ...table(
      [
        "Chain",
        "Time (UTC)",
        "Block",
        "Asset",
        "Contract",
        "Amount",
        "From",
        "Transaction",
        "Root coverage",
        "Reading",
      ],
      chains.flatMap((chainId) => {
        const first = touching
          .filter((t) => t.chainId === chainId && direction(t) === "in")
          .sort(chronological)[0];
        if (!first) return [];
        const coverage = rootCoverage(chainId);
        const exhausted =
          coverage.length > 0 &&
          coverage.every((c) => c.status === "exhausted" && c.cursor === null);
        const streams = [...new Set(coverage.flatMap((c) => c.streams))].sort();
        const warnings = coverage.reduce((n, c) => n + c.warnings.length, 0);
        return [
          [
            String(chainId),
            first.timestamp,
            String(first.blockNumber),
            assetCell(first.asset),
            contractCell(first.asset),
            amount(first.rawAmount, first.asset.decimals),
            `${address(first.from)}${labelText(node(chainId, first.from)) ? ` ${labelText(node(chainId, first.from))}` : ""}`,
            txRef(first),
            coverage.length
              ? coverage
                  .map(
                    (c) =>
                      `${escapeMarkdown(c.provider)} ${c.status}${c.cursor === null ? "" : ", cursor present"}`,
                  )
                  .join("; ")
              : "no record",
            exhausted
              ? `Earliest indexed inbound for streams ${streams.join(", ") || "none"}, NOT earliest-ever funding: indexes can omit transfers, and other streams and chains are unchecked.${warnings ? ` ${warnings} coverage warning(s) recorded.` : ""} Not proof of funding source.`
              : "First observed only, NOT earliest funding: indexed history is not exhausted.",
          ],
        ];
      }),
    ),
    "",
    "## Recorded labels",
    "",
    "Claims as recorded with their provenance. A label does not prove ownership.",
    "",
    ...table(
      [
        "Wallet",
        "Chain",
        "Category",
        "Label",
        "Retrieved",
        "Observed",
        "Evidence note",
      ],
      [...investigation.nodes]
        .filter((n) => n.label)
        .sort((a, b) =>
          compare(nodeKey(a.chainId, a.address), nodeKey(b.chainId, b.address)),
        )
        .map((n) => [
          address(n.address),
          String(n.chainId),
          n.category ?? "unspecified",
          labelText(n),
          n.label!.retrievedAt,
          n.label!.observedAt ?? "",
          escapeMarkdown(n.label!.evidenceNote ?? ""),
        ]),
    ),
    "",
    "## Evidence sources",
    "",
    "Recorded provider provenance per transfer. A source string is not authentication of the data or of any attribution.",
    "",
    ...table(
      ["Source", "Transfers"],
      [...sourceCounts(investigation.transfers)]
        .sort(([a], [b]) => compare(a, b))
        .map(([source, count]) => [escapeMarkdown(source), String(count)]),
    ),
    "",
  );
  if (investigation.notes.trim())
    out.push(
      "## Case notes (untrusted text, escaped)",
      "",
      escapeMarkdown(investigation.notes),
      "",
    );
  return `${out.join("\n").trimEnd()}\n`;
}

const USAGE =
  "Usage: node scripts/report-investigation.ts --file CASE.json --output REPORT.md [--force] [--top 1..50]";

/** Never writes the input case; refuses to replace an existing report without --force. */
export async function main(argv: string[]): Promise<string> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      file: { type: "string" },
      output: { type: "string" },
      force: { type: "boolean", default: false },
      top: { type: "string" },
    },
  });
  if (!values.file || !values.output) throw new Error(USAGE);
  const input = resolve(values.file);
  const top = values.top === undefined ? undefined : Number(values.top);
  const investigation = await readSnapshot(input);
  const report = renderInvestigationReport(investigation, {
    top,
    sourceName: basename(input),
  });
  return writeReportFile(values.output, report, [input], values.force);
}

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
const missing = (error: unknown) => {
  if (errorCode(error) === "ENOENT") return null;
  throw error;
};

/**
 * Writes a report without ever writing into an existing inode. The output is refused
 * when it names any input by path, symlink, directory symlink or hard link, and an
 * existing report is replaced only with `force`, by atomic rename of a fresh file.
 */
export async function writeReportFile(
  output: string,
  data: string | Uint8Array,
  inputs: string[],
  force: boolean,
): Promise<string> {
  const requested = resolve(output);
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  const target = join(await realpath(dirname(requested)), basename(requested));
  const identities = new Set<string>(),
    names = new Set<string>();
  for (const input of inputs) {
    const info = await stat(input);
    identities.add(`${info.dev}:${info.ino}`);
    names.add(await realpath(input));
  }
  const aliased = () =>
    new Error(
      "Output must differ from every input (case, manifest, screenshots), including through symlinks or hard links",
    );
  const check = async () => {
    const existing = await lstat(target).catch(missing);
    if (names.has(target)) throw aliased();
    if (!existing) return false;
    if (!existing.isFile())
      throw new Error(
        "Output exists and is not a regular file; refusing to replace it",
      );
    if (identities.has(`${existing.dev}:${existing.ino}`)) throw aliased();
    if (!force)
      throw new Error(
        `Report already exists: ${output}. Pass --force to replace it.`,
      );
    return true;
  };
  await check();
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  try {
    if (await check()) await rename(temporary, target);
    else
      await hardLink(temporary, target).catch(async (error: unknown) => {
        if (errorCode(error) === "EEXIST") await check();
        if (!["EPERM", "ENOTSUP", "EXDEV", "EMLINK"].includes(errorCode(error)))
          throw error;
        await copyFile(temporary, target, constants.COPYFILE_EXCL);
      });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (output) => console.log(`Wrote ${output}`),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
