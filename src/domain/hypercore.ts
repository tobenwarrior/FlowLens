import { keccak256, stringToHex } from "viem";
import { isCredentialParameterName } from "./source-url.ts";
import type { Address, Transfer } from "./types.ts";

export type HypercoreMode = "private" | "synthetic";

export const HYPERCORE_DOMAIN = "hypercore" as const;
export const HYPERCORE_PROVIDER = "hyperliquid-public-info" as const;
export const HYPERCORE_SCOPE = "non-funding-ledger" as const;
export const HYPERCORE_SOURCE_URL = "https://api.hyperliquid.xyz/info";
export const HYPERCORE_ARBITRUM_CHAIN_ID = 42161 as const;
export const HYPERCORE_BRIDGE_ACCOUNT =
  "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" as Address;
export const HYPERCORE_USDC_CONTRACT =
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831" as Address;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^-?(?:0|[0-9]+)(?:\.[0-9]+)?$/;
const MAX_BYTES = 5_000_000;
const MAX_STRING = 200_000;
const MAX_DELTA_BYTES = 250_000;
const MAX_ENTRIES = 20_000;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const TRANSPORT_SYSTEMS = new Set([
  "0x2000000000000000000000000000000000000000",
  "0x2222222222222222222222222222222222222222",
]);

export interface HypercoreRawLedgerEntry {
  time: number;
  hash: string;
  delta: Record<string, unknown>;
  id?: string;
  account?: string;
  provenance?: Partial<HypercoreProvenance>;
}

export interface HypercoreProvenance {
  source: string;
  retrievedAt: string;
  synthetic: boolean;
  sourceUrl?: string;
}

export type HypercoreFlowKind =
  "credit" | "debit" | "transfer" | "protocol" | "unknown";
export type HypercoreFlowDirection = "in" | "out" | "unknown";
export type HypercoreAccountingDirection = HypercoreFlowDirection;
export type HypercoreEndpointKind =
  "wallet-transfer" | "protocol-accounting" | "bridge-accounting" | "unknown";
export type HypercoreEndpointStatus = "complete" | "omitted";
export type HypercoreCounterparty =
  "wallet" | "system-transport" | "protocol" | "unknown";

export interface HypercoreFlow {
  kind: HypercoreFlowKind;
  direction: HypercoreFlowDirection;
  /**
   * Accounting direction is intentionally separate from wallet endpoint
   * direction. For example, a borrow/lend supply is an outflow of protocol
   * accounting without a wallet recipient address.
   */
  accountingDirection: HypercoreAccountingDirection;
  endpointKind: HypercoreEndpointKind;
  from: string | null;
  to: string | null;
  endpoints: HypercoreEndpointStatus;
  counterparty: HypercoreCounterparty;
}

export type HypercoreJson =
  | null
  | boolean
  | number
  | string
  | HypercoreJson[]
  | { [key: string]: HypercoreJson };

export type HypercoreDelta = { type: string } & {
  [key: string]: HypercoreJson;
};

export interface HypercoreEntry {
  domain: typeof HYPERCORE_DOMAIN;
  id: string;
  account: string;
  time: number;
  hash: string;
  hashKind: "ledger" | "virtual";
  isEvmTransaction: false;
  delta: HypercoreDelta;
  flow: HypercoreFlow;
  provenance: HypercoreProvenance;
}

export type HypercoreCoverageStatus =
  "partial" | "exhausted" | "error" | "unsupported";

export interface HypercoreCoverage {
  provider: string;
  scope: typeof HYPERCORE_SCOPE;
  account: string;
  startTime: number;
  endTime: number;
  status: HypercoreCoverageStatus;
  pagesLoaded: number;
  cursor: string | null;
  exhausted: boolean;
  fullHistory: false;
  retention: "undocumented";
  warnings: string[];
  provenance: HypercoreProvenance;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface HypercoreEvidenceBundle {
  version: 1;
  mode: HypercoreMode;
  account: string;
  entries: HypercoreEntry[];
  coverage: HypercoreCoverage;
}

export interface HypercoreCoverageAnalysis {
  provider: string;
  scope: "provider-window";
  account: string;
  startTime: number;
  endTime: number;
  status: HypercoreCoverageStatus;
  pagesLoaded: number;
  exhausted: boolean;
  fullHistory: false;
  retention: "undocumented";
}

export interface HypercoreAnalysis {
  version: 1;
  mode: HypercoreMode;
  account: string;
  entryCount: number;
  countsByType: Record<string, number>;
  countsByFlow: Record<HypercoreFlowKind, number>;
  coverage: HypercoreCoverageAnalysis;
  fullHistory: false;
  warnings: string[];
}

export class HypercoreEvidenceError extends Error {
  code = "INVALID_HYPERCORE_EVIDENCE";
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "HypercoreEvidenceError";
  }
}

export class HypercoreEvidenceConflictError extends HypercoreEvidenceError {
  code = "INVALID_HYPERCORE_EVIDENCE_CONFLICT";
  constructor(idOrReason: string) {
    super(`Conflicting HyperCore evidence: ${idOrReason}`);
    this.name = "HypercoreEvidenceConflictError";
  }
}

function fail(message: string): never {
  throw new HypercoreEvidenceError(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = MAX_STRING): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return fail(
      `${name} must be a non-empty string of at most ${max} characters`,
    );
  return value;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value))
    return fail(`${name} must be a valid EVM address`);
  return value.toLowerCase();
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(`${name} must be a non-negative safe integer`);
  return value;
}

function iso(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!Number.isFinite(Date.parse(result)))
    return fail(`${name} must be an ISO-compatible date string`);
  return result;
}

function sourceUrl(value: unknown): string {
  const result = text(value, "provenance.sourceUrl", 2_000);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    return fail("provenance.sourceUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    return fail("provenance.sourceUrl must use HTTPS without credentials");
  for (const key of parsed.searchParams.keys()) {
    if (isCredentialParameterName(key))
      return fail(
        "provenance.sourceUrl must not include credential parameters",
      );
  }
  if (parsed.hash) {
    const fragment = parsed.hash.slice(1);
    for (const key of new URLSearchParams(fragment).keys()) {
      if (isCredentialParameterName(key))
        return fail(
          "provenance.sourceUrl must not include credential parameters",
        );
    }
  }
  return result;
}

function jsonValue(value: unknown, name: string, depth = 0): HypercoreJson {
  if (depth > 24) return fail(`${name} is nested too deeply`);
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > MAX_STRING) return fail(`${name} is too long`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return fail(`${name} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      jsonValue(item, `${name}[${index}]`, depth + 1),
    );
  if (typeof value === "object") {
    const source = object(value, name);
    const result: { [key: string]: HypercoreJson } = {};
    for (const [key, item] of Object.entries(source)) {
      text(key, `${name} key`, 512);
      result[key] = jsonValue(item, `${name}.${key}`, depth + 1);
    }
    return result;
  }
  return fail(`${name} must contain JSON data only`);
}

function serialized(value: unknown, name: string, max = MAX_BYTES): string {
  let result: string;
  try {
    result = JSON.stringify(value);
  } catch {
    return fail(`${name} must be serializable JSON`);
  }
  if (!result) return fail(`${name} must not be undefined`);
  if (new TextEncoder().encode(result).length > max)
    return fail(`${name} exceeds its byte budget`);
  return result;
}

function stable(value: HypercoreJson): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  const source = serialized(value, "HyperCore evidence");
  return JSON.parse(source) as T;
}

export function hypercoreEntryFingerprint(
  account: string,
  time: number,
  hash: string,
  delta: HypercoreDelta,
): string {
  const payload: HypercoreJson = {
    account: account.toLowerCase(),
    time,
    hash: hash.toLowerCase(),
    delta,
  };
  return keccak256(stringToHex(stable(payload)));
}

function provenance(
  value: unknown,
  mode: HypercoreMode,
  fallback?: HypercoreProvenance,
): HypercoreProvenance {
  const source = value === undefined ? fallback : object(value, "provenance");
  if (!source) return fail("provenance is required");
  const synthetic = source.synthetic ?? fallback?.synthetic;
  if (typeof synthetic !== "boolean" || synthetic !== (mode === "synthetic"))
    return fail("provenance.synthetic must agree with the evidence mode");
  return {
    source: text(source.source ?? fallback?.source, "provenance.source", 300),
    retrievedAt: iso(
      source.retrievedAt ?? fallback?.retrievedAt,
      "provenance.retrievedAt",
    ),
    synthetic,
    ...(source.sourceUrl === undefined && fallback?.sourceUrl === undefined
      ? {}
      : {
          sourceUrl: sourceUrl(source.sourceUrl ?? fallback?.sourceUrl),
        }),
  };
}

function decimal(value: unknown, name: string): string {
  const result = text(value, name, 1_000);
  if (!DECIMAL.test(result))
    return fail(`${name} must be an exact decimal string`);
  return result;
}

function normalizeDelta(value: unknown): HypercoreDelta {
  const source = object(value, "entry.delta");
  const type = text(source.type, "entry.delta.type", 128);
  if (type === "funding" || type === "fill" || type === "trade")
    return fail(
      "Funding payments and trade fills are outside the non-funding HyperCore evidence scope",
    );
  const delta = jsonValue(source, "entry.delta") as HypercoreDelta;
  if (new TextEncoder().encode(stable(delta)).length > MAX_DELTA_BYTES)
    return fail("entry.delta exceeds its byte budget");
  for (const key of [
    "amount",
    "usdc",
    "usdcValue",
    "fee",
    "nativeTokenFee",
    "interestAmount",
  ]) {
    if (delta[key] !== undefined) decimal(delta[key], `entry.delta.${key}`);
  }
  if (delta.nonce !== undefined) integer(delta.nonce, "entry.delta.nonce");
  if (delta.isDeposit !== undefined && typeof delta.isDeposit !== "boolean")
    return fail("entry.delta.isDeposit must be a boolean");
  if (delta.user !== undefined)
    delta.user = address(delta.user, "entry.delta.user");
  if (delta.destination !== undefined)
    delta.destination = address(delta.destination, "entry.delta.destination");
  return { ...delta, type };
}

function directionFor(
  account: string,
  from: string,
  to: string,
): HypercoreFlowDirection {
  if (from === account && to !== account) return "out";
  if (to === account && from !== account) return "in";
  return "unknown";
}

function counterpartyFor(from: string, to: string): HypercoreCounterparty {
  // Keep this allowlist exact. A prefix such as 0x200 is a valid ordinary EVM
  // address range and is not evidence that an endpoint is system transport.
  const system = (value: string) => TRANSPORT_SYSTEMS.has(value);
  if (system(from) || system(to)) return "system-transport";
  return "wallet";
}

function accountingDirectionFor(
  account: string,
  delta: HypercoreDelta,
  from: string | null,
  to: string | null,
): HypercoreAccountingDirection {
  switch (delta.type) {
    case "deposit":
      return "in";
    case "withdraw":
      return "out";
    case "borrowLend": {
      const operation = textValue(delta.operation);
      if (operation === "supply") return "out";
      if (operation === "withdraw") return "in";
      return "unknown";
    }
    case "send":
    case "spotTransfer":
      return from && to ? directionFor(account, from, to) : "unknown";
    default:
      return "unknown";
  }
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function classifyFlow(account: string, delta: HypercoreDelta): HypercoreFlow {
  switch (delta.type) {
    case "deposit":
      return {
        kind: "credit",
        direction: "in",
        accountingDirection: "in",
        endpointKind: "bridge-accounting",
        from: null,
        to: account,
        endpoints: "omitted",
        counterparty: "unknown",
      };
    case "withdraw":
      return {
        kind: "debit",
        direction: "out",
        accountingDirection: "out",
        endpointKind: "bridge-accounting",
        from: account,
        to: null,
        endpoints: "omitted",
        counterparty: "unknown",
      };
    case "borrowLend":
    case "cStakingTransfer":
      return {
        kind: "protocol",
        direction: "unknown",
        accountingDirection: accountingDirectionFor(account, delta, null, null),
        endpointKind: "protocol-accounting",
        from: null,
        to: null,
        endpoints: "omitted",
        counterparty: "protocol",
      };
    case "send":
    case "spotTransfer": {
      const from = typeof delta.user === "string" ? delta.user : null;
      const to =
        typeof delta.destination === "string" ? delta.destination : null;
      if (!from || !to)
        return {
          kind: "transfer",
          direction: "unknown",
          accountingDirection: "unknown",
          endpointKind: "wallet-transfer",
          from,
          to,
          endpoints: "omitted",
          counterparty: "unknown",
        };
      return {
        kind: "transfer",
        direction: directionFor(account, from, to),
        accountingDirection: accountingDirectionFor(account, delta, from, to),
        endpointKind: "wallet-transfer",
        from,
        to,
        endpoints: "complete",
        counterparty: counterpartyFor(from, to),
      };
    }
    default:
      return {
        kind: "unknown",
        direction: "unknown",
        accountingDirection: "unknown",
        endpointKind: "unknown",
        from: null,
        to: null,
        endpoints: "omitted",
        counterparty: "unknown",
      };
  }
}

function parseEntry(
  value: unknown,
  account: string,
  mode: HypercoreMode,
  fallbackProvenance: HypercoreProvenance,
  allowMismatchedId = false,
): HypercoreEntry {
  const source = object(value, "HyperCore entry");
  const time = integer(source.time, "entry.time");
  const hash = text(source.hash, "entry.hash", 128).toLowerCase();
  if (!HASH.test(hash)) return fail("entry.hash must be a 32-byte hex hash");
  const delta = normalizeDelta(source.delta);
  const computedId = hypercoreEntryFingerprint(account, time, hash, delta);
  if (source.id !== undefined && source.id !== computedId && !allowMismatchedId)
    return fail(
      "entry.id does not match its account/time/hash/delta fingerprint",
    );
  const entryAccount =
    source.account === undefined
      ? account
      : address(source.account, "entry.account");
  if (entryAccount !== account)
    return fail("entry.account does not match the bundle account");
  const itemProvenance = provenance(
    source.provenance,
    mode,
    fallbackProvenance,
  );
  return {
    domain: HYPERCORE_DOMAIN,
    id:
      typeof source.id === "string" && allowMismatchedId
        ? source.id
        : computedId,
    account,
    time,
    hash,
    hashKind: hash === ZERO_HASH ? "virtual" : "ledger",
    isEvmTransaction: false,
    delta,
    flow: classifyFlow(account, delta),
    provenance: itemProvenance,
  };
}

function exactRawUnits(value: string, decimals: number): string | null {
  if (!/^(?:0|[0-9]+)(?:\.[0-9]+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  try {
    const scale = 10n ** BigInt(decimals);
    const fractionalUnits = BigInt(
      (fraction + "0".repeat(decimals)).slice(0, decimals) || "0",
    );
    return (BigInt(whole) * scale + fractionalUnits).toString();
  } catch {
    return null;
  }
}

function transferEventIdentity(transfer: Transfer): string {
  return [
    transfer.chainId,
    transfer.hash.toLowerCase(),
    transfer.kind,
    transfer.eventIndex,
    transfer.asset.contract?.toLowerCase() ?? "native",
  ].join(":");
}

function sameRawUnits(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return left === right;
  }
}

function sameTransferMaterial(left: Transfer, right: Transfer): boolean {
  return (
    left.chainId === right.chainId &&
    left.hash.toLowerCase() === right.hash.toLowerCase() &&
    left.kind === right.kind &&
    left.eventIndex === right.eventIndex &&
    left.asset.chainId === right.asset.chainId &&
    left.asset.symbol.toLowerCase() === right.asset.symbol.toLowerCase() &&
    left.asset.decimals === right.asset.decimals &&
    left.asset.contract?.toLowerCase() ===
      right.asset.contract?.toLowerCase() &&
    left.from.toLowerCase() === right.from.toLowerCase() &&
    left.to.toLowerCase() === right.to.toLowerCase() &&
    sameRawUnits(left.rawAmount, right.rawAmount) &&
    left.timestamp === right.timestamp &&
    left.blockNumber === right.blockNumber &&
    left.status === right.status &&
    (left.synthetic ?? false) === (right.synthetic ?? false)
  );
}

/**
 * Joins one already-loaded EVM ERC-20 transfer to a HyperCore bridge record.
 *
 * The join is deliberately narrow: exact ledger hash, Arbitrum One, canonical
 * USDC metadata, exact six-decimal raw units, the expected root/Bridge2
 * direction, matching evidence mode, and one-and-only-one event identity. A
 * repeated observation of the same event identity is deduplicated; conflicting
 * duplicate facts remain unresolved. It returns the existing EVM record
 * separately; it never fills HyperCore flow endpoints.
 */
export function findHypercoreBridgeTransfer(
  entry: HypercoreEntry,
  transfers: readonly Transfer[],
): Transfer | null {
  if (entry.delta.type !== "deposit" && entry.delta.type !== "withdraw")
    return null;
  const usdc = textValue(entry.delta.usdc);
  if (!usdc) return null;
  const rawAmount = exactRawUnits(usdc, 6);
  if (rawAmount === null) return null;

  const root = entry.account.toLowerCase();
  const bridge = HYPERCORE_BRIDGE_ACCOUNT.toLowerCase();
  const expectedFrom = entry.delta.type === "deposit" ? root : bridge;
  const expectedTo = entry.delta.type === "deposit" ? bridge : root;
  const cohorts = new Map<string, Transfer[]>();
  for (const transfer of transfers) {
    if ((transfer.synthetic ?? false) !== entry.provenance.synthetic) continue;
    const identity = transferEventIdentity(transfer);
    const cohort = cohorts.get(identity);
    if (cohort) cohort.push(transfer);
    else cohorts.set(identity, [transfer]);
  }
  const matches = new Map<string, Transfer>();
  for (const [identity, cohort] of cohorts) {
    const transfer = cohort[0];
    if (!transfer || transfer.hash.toLowerCase() !== entry.hash.toLowerCase())
      continue;
    if (cohort.some((candidate) => !sameTransferMaterial(transfer, candidate)))
      return null;
    if (
      transfer.chainId !== HYPERCORE_ARBITRUM_CHAIN_ID ||
      transfer.kind !== "erc20" ||
      transfer.status !== "success" ||
      transfer.asset.chainId !== HYPERCORE_ARBITRUM_CHAIN_ID ||
      transfer.asset.decimals !== 6 ||
      transfer.asset.symbol.toLowerCase() !== "usdc" ||
      transfer.asset.contract?.toLowerCase() !== HYPERCORE_USDC_CONTRACT ||
      transfer.hash.toLowerCase() !== entry.hash.toLowerCase() ||
      transfer.from.toLowerCase() !== expectedFrom ||
      transfer.to.toLowerCase() !== expectedTo
    )
      continue;
    try {
      if (BigInt(transfer.rawAmount) !== BigInt(rawAmount)) continue;
    } catch {
      continue;
    }
    matches.set(identity, transfer);
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

function parseCoverage(
  value: unknown,
  account: string,
  mode: HypercoreMode,
): HypercoreCoverage {
  const source = object(value, "HyperCore coverage");
  const coverageAccount = address(
    source.account ?? account,
    "coverage.account",
  );
  if (coverageAccount !== account)
    return fail("HyperCore coverage account does not match the bundle account");
  const startTime = integer(source.startTime, "coverage.startTime");
  const endTime = integer(source.endTime, "coverage.endTime");
  if (endTime < startTime) return fail("HyperCore coverage window is invalid");
  const provider = text(
    source.provider ?? HYPERCORE_PROVIDER,
    "coverage.provider",
    200,
  );
  if (source.scope !== undefined && source.scope !== HYPERCORE_SCOPE)
    return fail("HyperCore coverage scope must be non-funding-ledger");
  const pagesLoaded = integer(source.pagesLoaded ?? 0, "coverage.pagesLoaded");
  const cursor = source.cursor;
  if (cursor !== null && cursor !== undefined)
    text(cursor, "coverage.cursor", 100_000);
  const exhausted =
    typeof source.exhausted === "boolean"
      ? source.exhausted
      : source.status === "exhausted";
  const statusValue = source.status ?? (exhausted ? "exhausted" : "partial");
  if (
    typeof statusValue !== "string" ||
    !(["partial", "exhausted", "error", "unsupported"] as const).includes(
      statusValue as HypercoreCoverageStatus,
    )
  )
    return fail("coverage.status is invalid");
  const status = statusValue as HypercoreCoverageStatus;
  if (source.fullHistory !== false)
    return fail("HyperCore coverage must declare fullHistory false");
  if (source.retention !== "undocumented")
    return fail("HyperCore retention must remain undocumented");
  const cursorValue = (cursor ?? null) as string | null;
  if (status === "exhausted" && cursorValue !== null)
    return fail(
      "Exhausted HyperCore coverage cannot retain a next-page cursor",
    );
  if (exhausted !== (status === "exhausted"))
    return fail("HyperCore coverage exhaustion must match its status");
  const warnings = source.warnings ?? [];
  if (
    !Array.isArray(warnings) ||
    warnings.length > 100 ||
    warnings.some((item) => typeof item !== "string")
  )
    return fail("coverage.warnings must be at most 100 strings");
  const error =
    source.error === undefined
      ? undefined
      : text(source.error, "coverage.error", 500);
  let errorCode: string | undefined;
  if (source.errorCode !== undefined) {
    errorCode = text(source.errorCode, "coverage.errorCode", 64);
    if (!ERROR_CODE.test(errorCode))
      return fail("coverage error code must be uppercase and machine-readable");
  }
  let retryable: boolean | undefined;
  if (source.retryable !== undefined) {
    if (typeof source.retryable !== "boolean")
      return fail("coverage.retryable must be a boolean");
    retryable = source.retryable;
  }
  const coverageProvenance = provenance(source.provenance, mode);
  return {
    provider,
    scope: HYPERCORE_SCOPE,
    account,
    startTime,
    endTime,
    status,
    pagesLoaded,
    cursor: cursorValue,
    exhausted,
    fullHistory: false,
    retention: "undocumented",
    warnings: [...warnings],
    provenance: coverageProvenance,
    ...(error === undefined ? {} : { error }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

export function parseHypercoreEvidence(
  input: unknown,
  expectedMode?: HypercoreMode,
  allowMismatchedIds = false,
): HypercoreEvidenceBundle {
  serialized(input, "HyperCore evidence");
  const value = object(input, "HyperCore evidence");
  if (value.version !== 1)
    return fail("Unsupported HyperCore evidence version");
  if (value.mode !== "private" && value.mode !== "synthetic")
    return fail("HyperCore evidence mode must be private or synthetic");
  const mode = value.mode as HypercoreMode;
  if (expectedMode && mode !== expectedMode)
    return fail(`HyperCore evidence mode must be ${expectedMode}`);
  const accountValue = address(value.account, "HyperCore account");
  const coverage = parseCoverage(value.coverage, accountValue, mode);
  if (!Array.isArray(value.entries))
    return fail("HyperCore entries must be an array");
  if (value.entries.length > MAX_ENTRIES)
    return fail(`HyperCore entries exceed the ${MAX_ENTRIES} record limit`);
  const entries = value.entries.map((entry) =>
    parseEntry(
      entry,
      accountValue,
      mode,
      coverage.provenance,
      allowMismatchedIds,
    ),
  );
  const seen = new Map<string, HypercoreEntry>();
  for (const entry of entries) {
    const previous = seen.get(entry.id);
    if (!previous) {
      seen.set(entry.id, entry);
      continue;
    }
    if (material(previous) !== material(entry))
      throw new HypercoreEvidenceConflictError(entry.id);
    if (entry.provenance.retrievedAt > previous.provenance.retrievedAt)
      seen.set(entry.id, entry);
  }
  return {
    version: 1,
    mode,
    account: accountValue,
    entries: [...seen.values()].sort(orderEntries),
    coverage,
  };
}

function material(entry: HypercoreEntry): string {
  return stable({
    domain: entry.domain,
    account: entry.account,
    time: entry.time,
    hash: entry.hash,
    hashKind: entry.hashKind,
    delta: entry.delta,
    flow: entry.flow,
  } as unknown as HypercoreJson);
}

function orderEntries(a: HypercoreEntry, b: HypercoreEntry): number {
  return a.time - b.time || a.id.localeCompare(b.id);
}

function mergeCoverage(
  previous: HypercoreCoverage,
  incoming: HypercoreCoverage,
): HypercoreCoverage {
  if (
    previous.account !== incoming.account ||
    previous.provider !== incoming.provider ||
    previous.scope !== incoming.scope ||
    previous.startTime !== incoming.startTime ||
    previous.endTime !== incoming.endTime
  )
    throw new HypercoreEvidenceConflictError("coverage window or provider");
  const cursorEqual = previous.cursor === incoming.cursor;
  const previousTerminal = previous.status === "exhausted";
  const incomingTerminal = incoming.status === "exhausted";
  let newer: HypercoreCoverage;
  if (previousTerminal && !incomingTerminal) {
    // A terminal window is sticky. A stale partial/error observation cannot
    // reopen it, even if its timestamp or page count is newer.
    newer = previous;
  } else if (
    !previousTerminal &&
    incomingTerminal &&
    incoming.pagesLoaded >= previous.pagesLoaded
  ) {
    newer = incoming;
  } else if (incoming.pagesLoaded > previous.pagesLoaded) {
    newer = incoming;
  } else if (previous.pagesLoaded > incoming.pagesLoaded) {
    newer = previous;
  } else {
    if (!cursorEqual)
      throw new HypercoreEvidenceConflictError(
        "coverage cursor changed without a page-count advance",
      );
    newer =
      incoming.provenance.retrievedAt >= previous.provenance.retrievedAt
        ? incoming
        : previous;
  }
  return {
    ...newer,
    warnings: [...new Set([...previous.warnings, ...incoming.warnings])],
  };
}

export function mergeHypercoreEvidence(
  previous: HypercoreEvidenceBundle | undefined,
  incoming: HypercoreEvidenceBundle,
): HypercoreEvidenceBundle {
  if (!previous) return clone(parseHypercoreEvidence(incoming));
  const next = parseHypercoreEvidence(incoming, undefined, true);
  const current = parseHypercoreEvidence(previous, next.mode);
  if (current.account !== next.account)
    throw new HypercoreEvidenceConflictError("account");
  const result = new Map(current.entries.map((entry) => [entry.id, entry]));
  for (const entry of next.entries) {
    const prior = result.get(entry.id);
    if (!prior) {
      result.set(entry.id, entry);
      continue;
    }
    if (material(prior) !== material(entry))
      throw new HypercoreEvidenceConflictError(entry.id);
    if (entry.provenance.retrievedAt >= prior.provenance.retrievedAt)
      result.set(entry.id, entry);
  }
  return parseHypercoreEvidence({
    version: 1,
    mode: current.mode,
    account: current.account,
    entries: [...result.values()],
    coverage: mergeCoverage(current.coverage, next.coverage),
  });
}

export function analyzeHypercoreEvidence(
  input: HypercoreEvidenceBundle,
): HypercoreAnalysis {
  const bundle = parseHypercoreEvidence(input);
  const countsByType: Record<string, number> = {};
  const countsByFlow: Record<HypercoreFlowKind, number> = {
    credit: 0,
    debit: 0,
    transfer: 0,
    protocol: 0,
    unknown: 0,
  };
  for (const entry of bundle.entries) {
    countsByType[entry.delta.type] = (countsByType[entry.delta.type] ?? 0) + 1;
    countsByFlow[entry.flow.kind] += 1;
  }
  return {
    version: 1,
    mode: bundle.mode,
    account: bundle.account,
    entryCount: bundle.entries.length,
    countsByType,
    countsByFlow,
    coverage: {
      provider: bundle.coverage.provider,
      scope: "provider-window",
      account: bundle.account,
      startTime: bundle.coverage.startTime,
      endTime: bundle.coverage.endTime,
      status: bundle.coverage.status,
      pagesLoaded: bundle.coverage.pagesLoaded,
      exhausted: bundle.coverage.exhausted,
      fullHistory: false,
      retention: "undocumented",
    },
    fullHistory: false,
    warnings: [
      "HyperCore evidence covers only the provider-scoped non-funding ledger window; complete wallet history is not claimed.",
      "Funding payments and trade fills are omitted from this bundle.",
      "Ledger fingerprints identify supplied records and are not independent unique EVM transaction proof.",
      "Transfers to system transport addresses describe protocol transport, not ownership or beneficiary control.",
    ],
  };
}
