#!/usr/bin/env node
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { normalizeAddress, parseLabel } from "../src/domain/engine.ts";
import type { Address, Label } from "../src/domain/types.ts";
import {
  DEFAULT_PUBLIC_LABEL_FILE,
  loadPublicLabels,
} from "../server/public-labels.ts";
import { readBoundedJsonFile } from "../server/store.ts";

const MAX_PRIVATE_LABELS = 50_000;
const PRIVATE_DRAFT_DIR = resolve(process.cwd(), ".local");

interface PrepareOptions {
  source: string;
  output?: string;
  chainId: number;
  address: string;
  redistributionBasis?: string;
  reviewedAt?: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, name: string): string {
  const parts =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
          value,
        )
      : null;
  if (
    typeof value !== "string" ||
    !parts ||
    value.length > 40 ||
    Number.isNaN(Date.parse(value))
  )
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  )
    throw new Error(`${name} must be a valid ISO timestamp`);
  return new Date(value).toISOString();
}

async function assertDraftPath(path: string): Promise<void> {
  const resolved = resolve(path);
  let parent = dirname(resolved);
  while (true) {
    if (basename(parent) === ".local") {
      if (resolved === parent)
        throw new Error("Draft output must be a new file under .local/");
      break;
    }
    const next = dirname(parent);
    if (next === parent)
      throw new Error("Draft output must be a new file under .local/");
    parent = next;
  }
  let current = dirname(resolved);
  while (true) {
    const stat = await lstat(current).catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error("Draft output cannot traverse a symbolic link");
    if (basename(current) === ".local") break;
    const next = dirname(current);
    if (next === current)
      throw new Error("Draft output must be a new file under .local/");
    current = next;
  }
}

function requireShareableLabel(value: unknown): Label {
  const raw = object(value, "local label");
  const label = parseLabel(raw);
  if (!label.sourceUrl) throw new Error("Selected label requires sourceUrl");
  if (!label.observedAt) throw new Error("Selected label requires observedAt");
  if (!label.claimType) throw new Error("Selected label requires claimType");
  if (label.kind === "demo" || label.confidence === "synthetic")
    throw new Error("Synthetic or demo labels cannot be prepared for sharing");
  if (
    label.confidence === "verified" &&
    (label.claimType !== "verified-evidence" || !label.evidenceNote?.trim())
  )
    throw new Error(
      "Verified labels require a verified-evidence claim and evidenceNote",
    );
  return label;
}

function localLabelCandidates(raw: unknown): unknown[] {
  const value = object(raw, "local label file");
  if (!Array.isArray(value.labels) || value.labels.length > MAX_PRIVATE_LABELS)
    throw new Error(
      `Local label file requires a labels array of at most ${MAX_PRIVATE_LABELS} entries`,
    );
  return value.labels;
}

/** Select exactly one local label and write a non-overwriting private draft. */
export async function preparePublicLabelDraft(options: PrepareOptions) {
  if (
    !Number.isSafeInteger(options.chainId) ||
    options.chainId < 1 ||
    typeof options.source !== "string" ||
    !options.source.trim()
  )
    throw new Error("Preparation requires a source file and positive chain ID");
  const address = normalizeAddress(options.address);
  const output = resolve(options.output ?? joinDraftPath());
  await assertDraftPath(output);
  const raw = await readBoundedJsonFile(
    resolve(options.source),
    "Local label file",
  );
  const candidates: Record<string, unknown>[] = [];
  for (const item of localLabelCandidates(raw)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.chainId !== options.chainId) continue;
    let candidateAddress: Address;
    try {
      candidateAddress = normalizeAddress(entry.address as string);
    } catch {
      continue;
    }
    if (candidateAddress === address) candidates.push(entry);
  }
  if (candidates.length === 0)
    throw new Error(
      `No local label found for chain ${options.chainId} and address ${address}`,
    );
  if (candidates.length > 1)
    throw new Error(
      `Local label file contains duplicate labels for chain ${options.chainId} and address ${address}`,
    );
  const candidate = candidates[0];
  const label = requireShareableLabel(candidate.label);
  const updatedAt = timestamp(candidate.updatedAt, "Selected label updatedAt");
  const basis =
    options.redistributionBasis?.trim() ||
    "Pending review of redistribution rights; do not commit or share this draft.";
  if (basis.length > 500)
    throw new Error("redistribution basis must be at most 500 characters");
  const reviewedAt = timestamp(
    options.reviewedAt ?? new Date().toISOString(),
    "redistribution reviewedAt",
  );
  const draft = {
    version: 1,
    labels: [
      {
        chainId: options.chainId,
        address,
        label,
        updatedAt,
        redistribution: {
          status: options.redistributionBasis?.trim()
            ? ("reviewed" as const)
            : ("pending-review" as const),
          basis,
          reviewedAt,
        },
      },
    ],
  };
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(draft, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { output, draft };
}

function joinDraftPath(): string {
  return resolve(PRIVATE_DRAFT_DIR, "wallet-labels.draft.json");
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(`Unknown or incomplete option: ${name ?? ""}`);
    if (flags[name] !== undefined) throw new Error(`Duplicate option: ${name}`);
    flags[name] = value;
  }
  return flags;
}

function assertFlags(
  flags: Record<string, string>,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(flags).find((name) => !accepted.has(name));
  if (unknown) throw new Error(`Unknown option for this command: ${unknown}`);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args.shift() ?? "help";
  const flags = parseFlags(args);
  if (command === "help") {
    assertFlags(flags, []);
    process.stdout.write(
      `${JSON.stringify(
        {
          usage: "node scripts/wallet-labels.ts <validate|prepare>",
          validate: "--file data/wallet-labels.json",
          prepare:
            "--file .local/labels.json --chain N --address EVM [--output .local/wallet-labels.draft.json] [--redistribution-basis TEXT] [--reviewed-at ISO_TIMESTAMP]",
          note: "Preparation selects one exact chain/address and never writes the tracked catalogue.",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "validate") {
    assertFlags(flags, ["--file"]);
    const file = resolve(flags["--file"] ?? DEFAULT_PUBLIC_LABEL_FILE);
    const labels = await loadPublicLabels(file);
    process.stdout.write(
      `${JSON.stringify({ valid: true, file, entries: labels.size })}\n`,
    );
    return;
  }
  if (command !== "prepare") throw new Error("Use validate, prepare or help");
  assertFlags(flags, [
    "--file",
    "--source",
    "--output",
    "--chain",
    "--address",
    "--redistribution-basis",
    "--reviewed-at",
  ]);
  if (flags["--file"] !== undefined && flags["--source"] !== undefined)
    throw new Error("prepare accepts either --file or --source, not both");
  const source = flags["--file"] ?? flags["--source"];
  if (!source || !flags["--chain"] || !flags["--address"])
    throw new Error("prepare requires --file, --chain and --address");
  if (!/^\d+$/.test(flags["--chain"]))
    throw new Error("--chain must be a positive safe integer");
  const chainId = Number(flags["--chain"]);
  if (!Number.isSafeInteger(chainId) || chainId < 1)
    throw new Error("--chain must be a positive safe integer");
  const result = await preparePublicLabelDraft({
    source,
    output: flags["--output"],
    chainId,
    address: flags["--address"],
    redistributionBasis: flags["--redistribution-basis"],
    reviewedAt: flags["--reviewed-at"],
  });
  process.stdout.write(
    `${JSON.stringify({ prepared: true, output: result.output, entries: 1 })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Operation failed",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
