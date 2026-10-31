import { normalizeAddress, transferId } from "./engine.ts";
import type { Address, Transfer } from "./types.ts";

export type InternalReplayMode = "synthetic" | "private";
export type InternalTraceType =
  | "CALL"
  | "STATICCALL"
  | "DELEGATECALL"
  | "CALLCODE"
  | "CREATE"
  | "CREATE2"
  | "SELFDESTRUCT";
export interface InternalProvenance {
  source: string;
  retrievedAt: string;
  synthetic: boolean;
  sourceUrl?: string;
  proofHash?: string;
  canonicalMetadata?: {
    source: string;
    sourceUrl: string;
    retrievedAt: string;
    proofHashes: string[];
  };
}
export interface InternalTrace {
  id: string;
  chainId: number;
  hash: string;
  blockNumber: number;
  timestamp: string;
  traceAddress: number[];
  type: InternalTraceType;
  from: Address;
  to: Address;
  rawValue: string;
  success: boolean;
  transactionSuccess: boolean;
  nativeAsset: { symbol: string; decimals: number };
  provenance: InternalProvenance;
}
export interface InternalTraceCoverage {
  id: string;
  chainId: number;
  address: Address;
  provider: string;
  traceProvider: boolean;
  blockFrom: number | null;
  blockTo: number | null;
  status: "partial" | "exhausted" | "unavailable" | "error";
  cursor: string | null;
  recordsObserved: number;
  warnings: string[];
  provenance: InternalProvenance;
}
export interface InternalEvidenceBundle {
  version: 1;
  mode: InternalReplayMode;
  traces: InternalTrace[];
  coverage: InternalTraceCoverage[];
}
export type InternalExclusionReason =
  | "root-transaction"
  | "failed-transaction"
  | "failed-trace"
  | "failed-ancestor"
  | "missing-ancestor"
  | "static-ancestor"
  | "terminal-ancestor"
  | "inherited-or-nonmoving-call"
  | "zero-value";
export interface InternalCoverageAnalysis {
  id: string;
  chainId: number;
  address: Address;
  provider: string;
  traceProviderSupplied: boolean;
  blockFrom: number | null;
  blockTo: number | null;
  cursor: string | null;
  recordsInBundle: number;
  recordsObserved: number;
  status: "supplied-scope-exhausted" | "partial" | "unavailable" | "error";
  fullWalletHistory: false;
  warnings: string[];
}
export interface InternalAnalysis {
  mode: InternalReplayMode;
  transfers: Transfer[];
  included: { traceId: string; transferId: string }[];
  excluded: { traceId: string; reason: InternalExclusionReason }[];
  coverage: InternalCoverageAnalysis[];
  warnings: string[];
}

const TYPES: InternalTraceType[] = [
  "CALL",
  "STATICCALL",
  "DELEGATECALL",
  "CALLCODE",
  "CREATE",
  "CREATE2",
  "SELFDESTRUCT",
];
const MOVING = new Set<InternalTraceType>([
  "CALL",
  "CREATE",
  "CREATE2",
  "SELFDESTRUCT",
]);
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(
      `${name} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}
function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${name} must be an array of at most ${max} items`);
  return value;
}
function timestamp(value: unknown, name: string): string {
  const s = text(value, name, 40),
    parts =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        s,
      );
  if (!parts || !Number.isFinite(Date.parse(s)))
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  const [, y, m, d, h, minute, sec] = parts,
    year = Number(y),
    month = Number(m),
    day = Number(d),
    leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(minute) > 59 ||
    Number(sec) > 59
  )
    throw new Error(`${name} must be a valid ISO timestamp`);
  return new Date(s).toISOString();
}
function provenance(
  input: unknown,
  mode: InternalReplayMode,
): InternalProvenance {
  const p = object(input, "Internal provenance"),
    synthetic = bool(p.synthetic, "Provenance synthetic flag");
  if (synthetic !== (mode === "synthetic"))
    throw new Error(
      "Internal provenance synthetic flag must match replay mode",
    );
  const result: InternalProvenance = {
    source: text(p.source, "Provenance source", 200),
    retrievedAt: timestamp(p.retrievedAt, "Provenance retrieval timestamp"),
    synthetic,
  };
  if (p.sourceUrl !== undefined) {
    const value = text(p.sourceUrl, "Provenance source URL", 2048);
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid provenance source URL");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error(
        "Provenance source URL must use HTTPS without credentials",
      );
    result.sourceUrl = value;
  }
  if (p.proofHash !== undefined)
    result.proofHash = evidenceProofHash(p.proofHash);
  if (p.canonicalMetadata !== undefined) {
    const metadata = object(
      p.canonicalMetadata,
      "Canonical metadata provenance",
    );
    const sourceUrl = text(
      metadata.sourceUrl,
      "Canonical metadata source URL",
      2048,
    );
    const url = new URL(sourceUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Canonical metadata source URL must use HTTPS without credentials, query or fragment",
      );
    const proofHashes = array(
      metadata.proofHashes,
      "Canonical metadata proofs",
      3,
    ).map(evidenceProofHash);
    if (!proofHashes.length || new Set(proofHashes).size !== proofHashes.length)
      throw new Error(
        "Canonical metadata requires one to three unique proof hashes",
      );
    result.canonicalMetadata = {
      source: text(metadata.source, "Canonical metadata source", 200),
      sourceUrl,
      retrievedAt: timestamp(
        metadata.retrievedAt,
        "Canonical metadata retrieval timestamp",
      ),
      proofHashes,
    };
  }
  return result;
}
function evidenceProofHash(input: unknown): string {
  const value = text(input, "Evidence proof hash", 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error("Evidence proof hash must identify SHA-256 content");
  return value;
}
function identity(chainId: number, hash: string, path: number[]): string {
  return `${chainId}:${hash}:trace:${path.length ? path.join(".") : "root"}`;
}
function pathKey(path: number[]): string {
  return path.join(".");
}
function parseTrace(input: unknown, mode: InternalReplayMode): InternalTrace {
  const t = object(input, "Internal trace"),
    chainId = integer(t.chainId, "Trace chain ID", 1),
    hash = text(t.hash, "Trace transaction hash", 66).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash))
    throw new Error("Invalid internal trace transaction hash");
  const traceAddress = array(t.traceAddress, "Trace address", 32).map((v) =>
    integer(v, "Trace address index", 0, 1_000_000),
  );
  if (`trace.${pathKey(traceAddress)}`.length > 100)
    throw new Error("Trace address exceeds the canonical event identity bound");
  const id = text(t.id, "Trace evidence ID", 300);
  if (id !== identity(chainId, hash, traceAddress))
    throw new Error(
      "Internal trace ID does not match chain, transaction and trace address",
    );
  const type = text(t.type, "Trace type", 20) as InternalTraceType;
  if (!TYPES.includes(type)) throw new Error("Unsupported internal trace type");
  const rawValue = text(t.rawValue, "Trace integer value", 78);
  if (!/^\d+$/.test(rawValue) || BigInt(rawValue) > 2n ** 256n - 1n)
    throw new Error(
      "Internal trace value must be an unsigned 256-bit integer string",
    );
  const asset = object(t.nativeAsset, "Native asset");
  return {
    id,
    chainId,
    hash,
    blockNumber: integer(t.blockNumber, "Trace block number"),
    timestamp: timestamp(t.timestamp, "Trace timestamp"),
    traceAddress,
    type,
    from: normalizeAddress(t.from as string),
    to: normalizeAddress(t.to as string),
    rawValue: BigInt(rawValue).toString(),
    success: bool(t.success, "Trace success"),
    transactionSuccess: bool(t.transactionSuccess, "Transaction success"),
    nativeAsset: {
      symbol: text(asset.symbol, "Native symbol", 40),
      decimals: integer(asset.decimals, "Native decimals", 0, 255),
    },
    provenance: provenance(t.provenance, mode),
  };
}
function parseCoverage(
  input: unknown,
  mode: InternalReplayMode,
): InternalTraceCoverage {
  const c = object(input, "Internal coverage"),
    status = text(
      c.status,
      "Internal coverage status",
      20,
    ) as InternalTraceCoverage["status"];
  if (!["partial", "exhausted", "unavailable", "error"].includes(status))
    throw new Error("Invalid internal coverage status");
  const blockFrom =
      c.blockFrom === null
        ? null
        : integer(c.blockFrom, "Coverage first block"),
    blockTo =
      c.blockTo === null ? null : integer(c.blockTo, "Coverage last block");
  if (
    (blockFrom === null) !== (blockTo === null) ||
    (blockFrom !== null && blockTo !== null && blockFrom > blockTo)
  )
    throw new Error(
      "Internal coverage block range must be a bounded ordered pair or two nulls",
    );
  const cursor =
    c.cursor === null ? null : text(c.cursor, "Internal coverage cursor", 4096);
  if (status === "exhausted" && cursor !== null)
    throw new Error(
      "Exhausted internal coverage cannot retain a next-page cursor",
    );
  return {
    id: text(c.id, "Coverage ID", 300),
    chainId: integer(c.chainId, "Coverage chain ID", 1),
    address: normalizeAddress(c.address as string),
    provider: text(c.provider, "Trace provider", 200),
    traceProvider: bool(c.traceProvider, "Trace-provider availability"),
    blockFrom,
    blockTo,
    status,
    cursor,
    recordsObserved: integer(
      c.recordsObserved,
      "Observed trace count",
      0,
      1_000_000_000,
    ),
    warnings: array(c.warnings, "Internal coverage warnings", 100).map((v) =>
      text(v, "Internal coverage warning", 1000),
    ),
    provenance: provenance(c.provenance, mode),
  };
}

/** Parse supplied observations only. This does not fetch or independently authenticate a trace provider. */
export function parseInternalEvidence(
  input: unknown,
  mode: InternalReplayMode,
): InternalEvidenceBundle {
  if (mode !== "synthetic" && mode !== "private")
    throw new Error("Invalid internal replay mode");
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("Internal evidence must be serializable JSON");
  }
  if (!serialized || new TextEncoder().encode(serialized).length > 2_000_000)
    throw new Error("Internal replay exceeds the 2 MB limit");
  const b = object(input, "Internal evidence");
  if (b.version !== 1) throw new Error("Unsupported internal evidence version");
  if (b.mode !== mode)
    throw new Error("Internal replay mode does not match the requested mode");
  const traces = array(b.traces, "Internal traces", 5000).map((t) =>
      parseTrace(t, mode),
    ),
    coverage = array(b.coverage, "Internal coverage scopes", 200).map((c) =>
      parseCoverage(c, mode),
    );
  const ids = new Set<string>(),
    txFacts = new Map<string, string>(),
    chainAssets = new Map<number, string>();
  for (const t of traces) {
    if (ids.has(t.id)) throw new Error(`Duplicate internal trace ID: ${t.id}`);
    ids.add(t.id);
    const transaction = `${t.chainId}:${t.hash}`,
      facts = JSON.stringify([
        t.blockNumber,
        t.timestamp,
        t.transactionSuccess,
        t.nativeAsset,
      ]);
    if (txFacts.has(transaction) && txFacts.get(transaction) !== facts)
      throw new Error("Conflicting internal transaction facts in replay");
    txFacts.set(transaction, facts);
    const asset = JSON.stringify(t.nativeAsset);
    if (chainAssets.has(t.chainId) && chainAssets.get(t.chainId) !== asset)
      throw new Error("Conflicting native asset metadata on one chain");
    chainAssets.set(t.chainId, asset);
    if (t.traceAddress.length === 0 && t.success !== t.transactionSuccess)
      throw new Error("Root trace success conflicts with transaction success");
  }
  if (new Set(coverage.map((c) => c.id)).size !== coverage.length)
    throw new Error("Duplicate internal coverage ID");
  return { version: 1, mode, traces, coverage };
}

/** Excludes inherited execution values and reverted paths before constructing balance-moving transfer evidence. */
export function analyzeInternalEvidence(
  bundle: InternalEvidenceBundle,
): InternalAnalysis {
  const data = parseInternalEvidence(bundle, bundle.mode),
    transfers: Transfer[] = [],
    included: InternalAnalysis["included"] = [],
    excluded: InternalAnalysis["excluded"] = [];
  const paths = new Map(
    data.traces.map((t) => [
      `${t.chainId}:${t.hash}:${pathKey(t.traceAddress)}`,
      t,
    ]),
  );
  for (const t of data.traces) {
    let reason: InternalExclusionReason | undefined;
    if (t.traceAddress.length === 0) reason = "root-transaction";
    else if (!t.transactionSuccess) reason = "failed-transaction";
    else if (!t.success) reason = "failed-trace";
    else {
      // Receipt-level transactionSuccess covers the top call; every intervening parent must be observed.
      const root = paths.get(`${t.chainId}:${t.hash}:`);
      // SELFDESTRUCT halts its execution frame, including under EIP-6780.
      if (root?.type === "SELFDESTRUCT") reason = "terminal-ancestor";
      else if (root?.type === "STATICCALL" && BigInt(t.rawValue) > 0n)
        reason = "static-ancestor";
      for (let length = 1; length < t.traceAddress.length; length++) {
        if (reason) break;
        const parent = paths.get(
          `${t.chainId}:${t.hash}:${pathKey(t.traceAddress.slice(0, length))}`,
        );
        if (!parent) {
          reason = "missing-ancestor";
          break;
        }
        if (!parent.success) {
          reason = "failed-ancestor";
          break;
        }
        if (parent.type === "SELFDESTRUCT") {
          reason = "terminal-ancestor";
          break;
        }
        if (parent.type === "STATICCALL" && BigInt(t.rawValue) > 0n) {
          reason = "static-ancestor";
          break;
        }
      }
      if (!reason && !MOVING.has(t.type))
        reason = "inherited-or-nonmoving-call";
      if (!reason && BigInt(t.rawValue) === 0n) reason = "zero-value";
    }
    if (reason) {
      excluded.push({ traceId: t.id, reason });
      continue;
    }
    const transfer: Transfer = {
      id: "",
      chainId: t.chainId,
      hash: t.hash,
      kind: "internal",
      eventIndex: `trace.${pathKey(t.traceAddress)}`,
      from: t.from,
      to: t.to,
      asset: {
        chainId: t.chainId,
        symbol: t.nativeAsset.symbol,
        decimals: t.nativeAsset.decimals,
        contract: null,
      },
      rawAmount: t.rawValue,
      timestamp: t.timestamp,
      blockNumber: t.blockNumber,
      status: "success",
      source: t.provenance.source,
      retrievedAt: t.provenance.retrievedAt,
      synthetic: t.provenance.synthetic,
    };
    transfer.id = transferId(transfer);
    transfers.push(transfer);
    included.push({ traceId: t.id, transferId: transfer.id });
  }
  const warnings = [
    data.mode === "synthetic"
      ? "Synthetic internal replay only; no live traces or wallet-history completeness were verified."
      : "Private supplied trace evidence only; source authenticity and provider completeness are not independently verified.",
  ];
  const excludedIds = new Map(excluded.map((e) => [e.traceId, e.reason]));
  const coverage: InternalCoverageAnalysis[] = data.coverage.map((c) => {
    const rows = data.traces.filter(
      (t) =>
        t.chainId === c.chainId &&
        (t.from === c.address || t.to === c.address) &&
        (c.blockFrom === null || t.blockNumber >= c.blockFrom) &&
        (c.blockTo === null || t.blockNumber <= c.blockTo),
    );
    const notes = [
      ...c.warnings,
      "Coverage applies only to the supplied wallet, block window and trace source; never to full wallet history.",
    ];
    let status: InternalCoverageAnalysis["status"] =
      c.status === "error" ? "error" : "partial";
    if (c.status === "error") {
      notes.push(
        "Trace acquisition or supplied evidence reported an error; unavailable provider coverage does not erase that failure.",
      );
    } else if (!c.traceProvider || c.status === "unavailable") {
      status = "unavailable";
      notes.push(
        "No actual trace provider is supplied for this scope; internal history is unavailable.",
      );
    } else if (c.blockFrom === null || c.blockTo === null)
      notes.push("The trace coverage block window is unknown.");
    else if (rows.some((t) => excludedIds.get(t.id) === "missing-ancestor"))
      notes.push(
        "Supplied traces omit intervening ancestors; effective internal movements may be missing.",
      );
    else if (rows.some((t) => excludedIds.get(t.id) === "static-ancestor"))
      notes.push(
        "Supplied traces assert a value movement under static execution context; inconsistent paths were excluded.",
      );
    else if (rows.some((t) => excludedIds.get(t.id) === "terminal-ancestor"))
      notes.push(
        "Supplied traces contain descendants of a terminal SELFDESTRUCT frame; inconsistent paths were excluded.",
      );
    else if (c.recordsObserved !== rows.length)
      notes.push(
        "Claimed observed trace count differs from matching rows in this replay; the supplied scope remains partial.",
      );
    else if (c.status === "exhausted" && c.cursor === null)
      status = "supplied-scope-exhausted";
    warnings.push(...notes);
    return {
      id: c.id,
      chainId: c.chainId,
      address: c.address,
      provider: c.provider,
      traceProviderSupplied: c.traceProvider,
      blockFrom: c.blockFrom,
      blockTo: c.blockTo,
      cursor: c.cursor,
      recordsInBundle: rows.length,
      recordsObserved: c.recordsObserved,
      status,
      fullWalletHistory: false,
      warnings: notes,
    };
  });
  if (coverage.length === 0)
    warnings.push(
      "No trace provider coverage records were supplied; internal-transfer coverage is unavailable.",
    );
  if (excluded.some((e) => e.reason === "missing-ancestor"))
    warnings.push(
      "Some trace paths have missing ancestors and were excluded from normalized funding.",
    );
  if (excluded.some((e) => e.reason === "static-ancestor"))
    warnings.push(
      "Value-moving descendants of STATICCALL are inconsistent observations and were excluded.",
    );
  if (excluded.some((e) => e.reason === "terminal-ancestor"))
    warnings.push(
      "SELFDESTRUCT terminates its execution frame; supplied descendants are inconsistent and were excluded.",
    );
  return {
    mode: data.mode,
    transfers,
    included,
    excluded,
    coverage,
    warnings: [...new Set(warnings)],
  };
}

export function createSyntheticInternalEvidence(): InternalEvidenceBundle {
  const from = "0x1111111111111111111111111111111111111111" as Address,
    to = "0x2222222222222222222222222222222222222222" as Address,
    hash = `0x${"a".repeat(64)}`;
  const p: InternalProvenance = {
    source: "Flowlens synthetic internal trace replay v1",
    retrievedAt: "2026-10-21T12:00:00.000Z",
    synthetic: true,
  };
  const trace = (
    traceAddress: number[],
    type: InternalTraceType = "CALL",
    rawValue = "100",
    success = true,
  ): InternalTrace => ({
    id: identity(1, hash, traceAddress),
    chainId: 1,
    hash,
    blockNumber: 100,
    timestamp: "2026-10-20T08:00:00.000Z",
    traceAddress,
    type,
    from,
    to,
    rawValue,
    success,
    transactionSuccess: true,
    nativeAsset: { symbol: "ETH", decimals: 18 },
    provenance: { ...p },
  });
  const traces = [
    trace([], "CALL", "1000"),
    trace([0]),
    trace([1], "DELEGATECALL", "500"),
    trace([1, 0], "CALL", "30"),
    trace([2], "CALL", "50", false),
    trace([2, 0], "CALL", "15"),
    trace([3], "CREATE2", "200"),
    trace([4], "STATICCALL", "100"),
    trace([5], "SELFDESTRUCT", "25"),
    trace([6], "CALLCODE", "9"),
    trace([7], "CALL", "0"),
    trace([8, 0], "CALL", "10"),
  ];
  return {
    version: 1,
    mode: "synthetic",
    traces,
    coverage: [
      {
        id: "synthetic-internal-scope",
        chainId: 1,
        address: from,
        provider: "synthetic-traces-v1",
        traceProvider: true,
        blockFrom: 100,
        blockTo: 100,
        status: "exhausted",
        cursor: null,
        recordsObserved: traces.length,
        warnings: [
          "Synthetic traces contain deliberately missing ancestors; no real provider was contacted.",
        ],
        provenance: { ...p },
      },
    ],
  };
}
