import {
  analyzeSafeEvidence,
  createSyntheticSafeEvidence,
  parseSafeEvidence,
} from "./safe.ts";
import type { SafeEvidenceBundle, SafeExecution } from "./safe.ts";
import {
  createSyntheticBridgeEvidence,
  matchBridgeEvidence,
  parseBridgeEvidence,
} from "./bridges.ts";
import type { BridgeEvidenceBundle } from "./bridges.ts";
import {
  analyzeInternalEvidence,
  createSyntheticInternalEvidence,
  parseInternalEvidence,
} from "./internal.ts";
import type { InternalEvidenceBundle } from "./internal.ts";

export type ReplayMode = "synthetic" | "private";
export interface ProtocolEvidenceBundle {
  version: 1;
  mode: ReplayMode;
  safe?: SafeEvidenceBundle;
  bridges?: BridgeEvidenceBundle;
  internal?: InternalEvidenceBundle;
}

/** Replays are supplied observations, not an authenticated provider fetch or automatic ledger import. */
export function parseProtocolEvidence(
  input: unknown,
  expectedMode?: ReplayMode,
): ProtocolEvidenceBundle {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("Protocol evidence must be serializable JSON");
  }
  if (!serialized || new TextEncoder().encode(serialized).length > 5_000_000)
    throw new Error("Protocol evidence exceeds the 5 MB limit");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Protocol evidence must be an object");
  const value = input as Record<string, unknown>;
  if (value.version !== 1)
    throw new Error("Unsupported protocol evidence version");
  if (value.mode !== "synthetic" && value.mode !== "private")
    throw new Error("Protocol evidence mode must be synthetic or private");
  if (expectedMode && value.mode !== expectedMode)
    throw new Error(
      `Protocol evidence mode must be ${expectedMode} for this investigation`,
    );
  if (
    value.safe === undefined &&
    value.bridges === undefined &&
    value.internal === undefined
  )
    throw new Error(
      "Protocol evidence needs at least one Safe, bridge or internal component",
    );
  const result: ProtocolEvidenceBundle = { version: 1, mode: value.mode };
  if (value.safe !== undefined)
    result.safe = parseSafeEvidence(value.safe, value.mode);
  if (value.bridges !== undefined)
    result.bridges = parseBridgeEvidence(value.bridges, value.mode);
  if (value.internal !== undefined)
    result.internal = parseInternalEvidence(value.internal, value.mode);
  return result;
}

export class EvidenceConflictError extends Error {
  code = "INVALID_EVIDENCE_CONFLICT";
  retryable = false;
  constructor(id: string) {
    super(
      `Conflicting material facts for evidence ID ${id}. Earlier evidence was retained.`,
    );
    this.name = "EvidenceConflictError";
  }
}

interface EvidenceRecord {
  id: string;
  provenance: { retrievedAt: string };
}
function fingerprint(value: unknown, parent = ""): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => fingerprint(item));
    if (parent === "owners") items.sort();
    return `[${items.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const isProvenance =
      parent === "provenance" ||
      (typeof object.source === "string" &&
        typeof object.synthetic === "boolean" &&
        typeof object.retrievedAt === "string");
    return `{${Object.keys(object)
      .filter((key) => !(isProvenance && key === "retrievedAt"))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${fingerprint(object[key], key)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function newer<T extends EvidenceRecord>(previous: T, incoming: T): T {
  return incoming.provenance.retrievedAt >= previous.provenance.retrievedAt
    ? incoming
    : previous;
}
function sameRecord<T extends EvidenceRecord>(previous: T, incoming: T): T {
  if (fingerprint(previous) !== fingerprint(incoming))
    throw new EvidenceConflictError(incoming.id);
  return newer(previous, incoming);
}
function mergeRecords<T extends EvidenceRecord>(
  previous: T[],
  incoming: T[],
  combine: (previous: T, incoming: T) => T = sameRecord,
): T[] {
  const result = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) {
    const existing = result.get(row.id);
    result.set(row.id, existing ? combine(existing, row) : row);
  }
  return [...result.values()];
}
function mergeCoverage<T extends EvidenceRecord>(previous: T, incoming: T): T {
  const identity = (row: T) => {
    const record = row as unknown as Record<string, unknown>;
    const provenance = { ...row.provenance } as Record<string, unknown>;
    if (typeof provenance.sourceUrl === "string") {
      const url = new URL(provenance.sourceUrl);
      // Safe service pages share one attribution; retain the exact latest page in the returned record.
      if (record.stream !== undefined && record.safeAddress !== undefined)
        url.searchParams.delete("offset");
      provenance.sourceUrl = url.href;
    }
    return Object.fromEntries(
      [
        "id",
        "chainId",
        "safeAddress",
        "address",
        "protocol",
        "stream",
        "provider",
        "provenance",
      ]
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, key === "provenance" ? provenance : record[key]]),
    );
  };
  if (fingerprint(identity(previous)) !== fingerprint(identity(incoming)))
    throw new EvidenceConflictError(incoming.id);
  return newer(previous, incoming);
}
function mergeExecution(
  previous: SafeExecution,
  incoming: SafeExecution,
): SafeExecution {
  const mutable = new Set([
    "signatures",
    "signatureCoverage",
    "authorizationPath",
    "status",
    "nonce",
    "safeTxHash",
    "configurationEvidenceId",
    "transactionIndex",
  ]);
  const core = (record: SafeExecution) =>
    Object.fromEntries(
      Object.entries(record).filter(([key]) => !mutable.has(key)),
    );
  if (fingerprint(core(previous)) !== fingerprint(core(incoming)))
    throw new EvidenceConflictError(incoming.id);
  const result = { ...newer(previous, incoming) };
  if (
    previous.transactionIndex !== undefined &&
    incoming.transactionIndex !== undefined &&
    previous.transactionIndex !== incoming.transactionIndex
  )
    throw new EvidenceConflictError(incoming.id);
  if (
    previous.transactionIndex !== undefined ||
    incoming.transactionIndex !== undefined
  )
    result.transactionIndex =
      previous.transactionIndex ?? incoming.transactionIndex;
  for (const key of [
    "nonce",
    "safeTxHash",
    "configurationEvidenceId",
  ] as const) {
    if (
      previous[key] !== undefined &&
      incoming[key] !== undefined &&
      previous[key] !== incoming[key]
    )
      throw new EvidenceConflictError(incoming.id);
    const value = previous[key] ?? incoming[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["authorizationPath", "status"] as const) {
    if (
      previous[key] !== "unknown" &&
      incoming[key] !== "unknown" &&
      previous[key] !== incoming[key]
    )
      throw new EvidenceConflictError(incoming.id);
  }
  result.authorizationPath =
    previous.authorizationPath === "unknown"
      ? incoming.authorizationPath
      : previous.authorizationPath;
  result.status =
    previous.status === "unknown" ? incoming.status : previous.status;
  result.signatures = mergeRecords(previous.signatures, incoming.signatures);
  const coverage = { unavailable: 0, partial: 1, "reported-complete": 2 };
  result.signatureCoverage =
    coverage[previous.signatureCoverage] >= coverage[incoming.signatureCoverage]
      ? previous.signatureCoverage
      : incoming.signatureCoverage;
  return result;
}

/** Retains earlier observations across pages; stable identities cannot silently change material facts. */
export function mergeProtocolEvidence(
  previous: ProtocolEvidenceBundle | undefined,
  incoming: ProtocolEvidenceBundle,
): ProtocolEvidenceBundle {
  const next = parseProtocolEvidence(incoming);
  if (!previous) return next;
  const current = parseProtocolEvidence(previous, next.mode);
  const result: ProtocolEvidenceBundle = { ...current };
  if (next.safe)
    result.safe = current.safe
      ? {
          version: 1,
          mode: next.mode,
          configurations: mergeRecords(
            current.safe.configurations,
            next.safe.configurations,
          ),
          executions: mergeRecords(
            current.safe.executions,
            next.safe.executions,
            mergeExecution,
          ),
          configurationEvents: mergeRecords(
            current.safe.configurationEvents,
            next.safe.configurationEvents,
          ),
          coverage: mergeRecords(
            current.safe.coverage,
            next.safe.coverage,
            mergeCoverage,
          ),
          labels: mergeRecords(current.safe.labels, next.safe.labels),
        }
      : next.safe;
  if (next.bridges)
    result.bridges = current.bridges
      ? {
          version: 1,
          mode: next.mode,
          observations: mergeRecords(
            current.bridges.observations,
            next.bridges.observations,
          ),
          assetMappings: mergeRecords(
            current.bridges.assetMappings,
            next.bridges.assetMappings,
          ),
          coverage: mergeRecords(
            current.bridges.coverage,
            next.bridges.coverage,
            mergeCoverage,
          ),
        }
      : next.bridges;
  if (next.internal)
    result.internal = current.internal
      ? {
          version: 1,
          mode: next.mode,
          traces: mergeRecords(current.internal.traces, next.internal.traces),
          coverage: mergeRecords(
            current.internal.coverage,
            next.internal.coverage,
            mergeCoverage,
          ),
        }
      : next.internal;
  return parseProtocolEvidence(result);
}
export function analyzeProtocolEvidence(input: ProtocolEvidenceBundle) {
  const bundle = parseProtocolEvidence(input);
  return {
    version: 1,
    mode: bundle.mode,
    ...(bundle.safe ? { safe: analyzeSafeEvidence(bundle.safe) } : {}),
    ...(bundle.bridges ? { bridges: matchBridgeEvidence(bundle.bridges) } : {}),
    ...(bundle.internal
      ? { internal: analyzeInternalEvidence(bundle.internal) }
      : {}),
    caveats: [
      bundle.mode === "synthetic"
        ? "Entirely synthetic replay. No live claim or provider retrieval."
        : "Private supplied-evidence replay. Claims are not independently authenticated by import.",
      "Replay observations are separate from indexed transfer history and do not silently change graph totals.",
      "Configuration, observed signatures, matched transport, beneficiary credit and ownership are distinct claims.",
      "Coverage is limited to each supplied observation stream; no complete wallet history is inferred.",
    ],
  };
}
export function createSyntheticProtocolEvidence(): ProtocolEvidenceBundle {
  return parseProtocolEvidence({
    version: 1,
    mode: "synthetic",
    safe: createSyntheticSafeEvidence(),
    bridges: createSyntheticBridgeEvidence(),
    internal: createSyntheticInternalEvidence(),
  });
}
