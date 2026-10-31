import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readBoundedJsonFile } from "./store.ts";
import { nodeKey, normalizeAddress, parseLabel } from "../src/domain/engine.ts";
import type { Label, WalletNode } from "../src/domain/types.ts";
import type { StoredLabel } from "./label-store.ts";

/** The only catalogue loaded implicitly by the application is this tracked file. */
export const DEFAULT_PUBLIC_LABEL_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../data/wallet-labels.json",
);

/** A bounded catalogue is intentional; public labels are not a bulk provider dump. */
export const MAX_PUBLIC_LABELS = 50_000;

export interface RedistributionReview {
  /** Records a review state, not a licence or other grant of rights. */
  status: "reviewed" | "pending-review";
  basis: string;
  reviewedAt: string;
}

export interface PublicLabelEntry extends StoredLabel {
  redistribution: RedistributionReview;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, name: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as ObjectValue;
}

function exactKeys(
  value: ObjectValue,
  allowed: readonly string[],
  name: string,
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length)
    throw new Error(`${name} contains unsupported field '${unknown[0]}'`);
  const missing = required.find((key) => value[key] === undefined);
  if (missing) throw new Error(`${name} requires ${missing}`);
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
  const result = new Date(value);
  if (Number.isNaN(result.getTime()))
    throw new Error(`${name} must be a valid ISO timestamp`);
  return result.toISOString();
}

function parseRedistribution(input: unknown): RedistributionReview {
  const value = object(input, "redistribution");
  exactKeys(value, ["status", "basis", "reviewedAt"], "redistribution");
  if (value.status !== "reviewed")
    throw new Error(
      "public catalogue entries require redistribution status reviewed",
    );
  if (
    typeof value.basis !== "string" ||
    !value.basis.trim() ||
    value.basis.length > 500
  )
    throw new Error(
      "redistribution basis must be a nonempty string of at most 500 characters",
    );
  return {
    status: "reviewed",
    basis: value.basis,
    reviewedAt: timestamp(value.reviewedAt, "redistribution reviewedAt"),
  };
}

function parsePublicLabel(input: unknown): Label {
  const value = object(input, "public label");
  exactKeys(
    value,
    [
      "text",
      "source",
      "kind",
      "confidence",
      "retrievedAt",
      "sourceUrl",
      "claimType",
      "observedAt",
      "evidenceNote",
    ],
    "public label",
    [
      "text",
      "source",
      "kind",
      "confidence",
      "retrievedAt",
      "sourceUrl",
      "claimType",
      "observedAt",
    ],
  );
  if (typeof value.text !== "string" || !value.text.trim())
    throw new Error("public label text must be nonempty");
  if (typeof value.source !== "string" || !value.source.trim())
    throw new Error("public label source must be nonempty");
  if (typeof value.sourceUrl !== "string" || !value.sourceUrl.trim())
    throw new Error("public labels require sourceUrl");
  if (typeof value.claimType !== "string" || !value.claimType.trim())
    throw new Error("public labels require claimType provenance");
  if (typeof value.observedAt !== "string" || !value.observedAt.trim())
    throw new Error("public labels require observedAt provenance");
  const label = parseLabel(value);
  if (label.kind === "demo" || label.confidence === "synthetic")
    throw new Error(
      "synthetic or demo labels cannot enter the public catalogue",
    );
  if (label.confidence === "verified") {
    if (label.claimType !== "verified-evidence" || !label.evidenceNote?.trim())
      throw new Error(
        "verified public labels require a verified-evidence claim and evidenceNote",
      );
  }
  return label;
}

function parseEntry(input: unknown): PublicLabelEntry {
  const value = object(input, "public label entry");
  exactKeys(
    value,
    ["chainId", "address", "label", "updatedAt", "redistribution"],
    "public label entry",
  );
  if (
    typeof value.chainId !== "number" ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId < 1
  )
    throw new Error("public label entry requires a positive integer chain ID");
  const address = normalizeAddress(value.address as string);
  const label = parsePublicLabel(value.label);
  return {
    chainId: value.chainId,
    address,
    label,
    updatedAt: timestamp(value.updatedAt, "public label updatedAt"),
    redistribution: parseRedistribution(value.redistribution),
  };
}

/** Parse the tracked public catalogue without silently accepting unknown fields. */
export function parsePublicLabelCatalogue(
  input: unknown,
): Map<string, PublicLabelEntry> {
  const value = object(input, "public label catalogue");
  exactKeys(value, ["version", "labels"], "public label catalogue");
  if (value.version !== 1)
    throw new Error("public label catalogue version must be 1");
  if (!Array.isArray(value.labels) || value.labels.length > MAX_PUBLIC_LABELS)
    throw new Error(
      `public label catalogue labels must be an array of at most ${MAX_PUBLIC_LABELS} entries`,
    );
  const entries = new Map<string, PublicLabelEntry>();
  for (const item of value.labels) {
    const entry = parseEntry(item);
    const key = nodeKey(entry.chainId, entry.address);
    if (entries.has(key))
      throw new Error(`duplicate public label scope for ${key}`);
    entries.set(key, entry);
  }
  return entries;
}

/** Load only the tracked catalogue (or an explicitly injected test/review path). */
export async function loadPublicLabels(
  path = DEFAULT_PUBLIC_LABEL_FILE,
): Promise<Map<string, PublicLabelEntry>> {
  const raw = await readBoundedJsonFile(path, "Public wallet-label catalogue");
  return parsePublicLabelCatalogue(raw);
}

export function publicLabelKey(chainId: number, address: string): string {
  return nodeKey(chainId, address);
}

export function publicLabelEntries(
  labels: ReadonlyMap<string, PublicLabelEntry>,
): PublicLabelEntry[] {
  return [...labels.values()];
}

/** Apply only shared labels, preserving labels already attached to the case. */
export function applyPublicLabels(
  nodes: WalletNode[],
  labels: ReadonlyMap<string, PublicLabelEntry>,
  accept: (label: Label) => boolean = () => true,
): WalletNode[] {
  return nodes.map((node) => {
    if (node.label) return node;
    const entry = labels.get(nodeKey(node.chainId, node.address));
    return entry && accept(entry.label)
      ? { ...node, label: entry.label }
      : node;
  });
}
