import { normalizeAddress } from "../src/domain/engine.ts";
import type { Address, Transfer } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;
// The watcher may follow more than the original 20 leads, but expansion stays
// bounded so a noisy recipient cannot turn into unbounded graph crawling.
const MAX_ADDRESSES = 250;
const MAX_GENERATIONS = 3;
const DEFAULT_MAX_GENERATIONS = 2;
const MAX_SEEDS = 100;
const MAX_EXCLUDED = 1_000;
const MAX_TRANSFERS = 20_000;
const MAX_RECEIPT_LOGS = 256;
const MAX_EVENTS_PER_CANDIDATE = 8;
const MAX_SKIP_DETAILS = 20;
const MAX_RETRYABLE = 20_000;
const MAX_TEXT_LENGTH = 1_000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const HEX_QUANTITY_PATTERN = /^0x[0-9a-f]+$/i;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Evidence that a bounded tracked source sent native ETH or an ERC-20 token to
 * an empty-code account at the transfer's block. This is a low-confidence lead,
 * not an ownership or attribution claim.
 */
export interface WalletLeadEvidence {
  seed: Address;
  candidate: Address;
  chainId: 1;
  eventId: string;
  transactionHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  token: Address | null;
  symbol: string;
  decimals: number;
  rawAmount: string;
  timestamp: string;
  observedAt: string;
  expiresAt?: string;
  confidence: "low";
  basis:
    | "seed-erc20-outflow-to-empty-account"
    | "source-erc20-outflow-to-empty-account"
    | "source-native-outflow-to-empty-account";
  evidenceSource: string;
  /** Source wallet for this edge. Omitted on legacy seed evidence. */
  source?: Address;
  /** Zero for configured seeds; increases by one for each bounded hop. */
  generation?: number;
  /** Native transaction position for same-block replay ordering. */
  transactionIndex?: number;
}

export interface WalletLeadState {
  version: 1;
  leads: readonly WalletLeadEvidence[];
}

export type WalletLeadSkipReason =
  | "invalid-transfer"
  | "not-seed-outflow"
  | "zero-or-dust"
  | "excluded"
  | "already-known"
  | "candidate-cap"
  | "generation-cap"
  | "price-unavailable"
  | "below-threshold"
  | "contract"
  | "code-unavailable"
  | "invalid-code"
  | "receipt-unavailable"
  | "receipt-mismatch"
  | "receipt-log-mismatch";

export interface WalletLeadSource {
  address: Address;
  generation: number;
  seed: Address;
}

export interface WalletLeadSkip {
  reason: WalletLeadSkipReason;
  candidate?: Address;
  eventId?: string;
}

export type WalletLeadRetryReason =
  | "candidate-cap"
  | "receipt-unavailable"
  | "receipt-mismatch"
  | "receipt-log-mismatch"
  | "price-unavailable"
  | "code-unavailable"
  | "invalid-code";

export interface WalletLeadRetry {
  reason: WalletLeadRetryReason;
  candidate: Address;
  eventId: string;
  transactionHash: `0x${string}`;
}

export interface DiscoverWalletLeadsInput {
  /** Explicit roots. Existing state leads are also used as bounded sources. */
  seeds: readonly Address[];
  /** Optional caller-owned source set. State leads are merged into this set. */
  sources?: readonly WalletLeadSource[];
  /** Maximum number of edges from a configured seed (hard bounded). */
  maxGenerations?: number;
  /** Known service, burn, or otherwise excluded destinations. */
  excluded?: readonly Address[];
  /** Optional caller-owned policy for known services not represented in the list. */
  excludeAddress?: (address: Address) => boolean;
  /** Confirmed successful transfer observations from the caller's log stream. */
  transfers: readonly Transfer[];
  rpc: RpcClient;
  state?: WalletLeadState;
  maxCandidates?: number;
  maxNewPerCycle?: number;
  /** Raw token units. The default rejects only zero; callers can set a dust floor. */
  minRawAmount?: bigint;
  /** Optional caller-supplied valuation floor; no price is inferred here. */
  minUsd?: number;
  usdValue?: (transfer: Transfer) => number | null;
  /** Optional bounded lifetime for a lead; callers can omit it for no expiry. */
  leadTtlMs?: number;
  now?: Date | string;
}

export interface DiscoverWalletLeadsResult {
  added: WalletLeadEvidence[];
  state: WalletLeadState;
  skipped: WalletLeadSkip[];
  /** Complete bounded retry queue, independent of the capped human skip list. */
  retryable: WalletLeadRetry[];
}

interface NormalizedTransfer {
  id: string;
  hash: `0x${string}`;
  eventIndex: string;
  kind: "native" | "erc20";
  from: Address;
  to: Address;
  token: Address | null;
  symbol: string;
  decimals: number;
  rawAmount: string;
  timestamp: string;
  blockNumber: number;
  source: string;
}

interface NativeTransaction {
  hash: `0x${string}`;
  blockNumber: number;
  from: Address;
  to: Address;
  value: bigint;
  transactionIndex: number | null;
}

interface ReceiptLog {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  removed: boolean;
}

interface Receipt {
  transactionHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  status: bigint;
  /** Optional on legacy/indexer receipts; used for same-block replay ordering. */
  transactionIndex: number | null;
  logs: ReceiptLog[];
}

function address(value: unknown): Address | null {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value.trim()))
    return null;
  return normalizeAddress(value);
}

function normalizedAddressList(
  values: readonly Address[] | undefined,
  name: string,
  max: number,
): Address[] {
  if (!values) return [];
  if (values.length > max)
    throw new Error(`${name} must contain at most ${max} addresses.`);
  return values.map((value) => {
    const result = address(value);
    if (!result) throw new Error(`${name} contains an invalid address.`);
    return result;
  });
}

function hexQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !HEX_QUANTITY_PATTERN.test(value))
    return null;
  try {
    const result = BigInt(value);
    if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(result);
  } catch {
    return null;
  }
}

function receiptLog(value: unknown): ReceiptLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const logAddress = address(item.address),
    blockNumber = hexQuantity(item.blockNumber),
    logIndex = hexQuantity(item.logIndex);
  if (
    !logAddress ||
    blockNumber === null ||
    logIndex === null ||
    typeof item.blockHash !== "string" ||
    !HASH_PATTERN.test(item.blockHash) ||
    typeof item.transactionHash !== "string" ||
    !HASH_PATTERN.test(item.transactionHash) ||
    !Array.isArray(item.topics) ||
    item.topics.some(
      (topic) => typeof topic !== "string" || !/^0x[0-9a-f]{64}$/i.test(topic),
    ) ||
    typeof item.data !== "string" ||
    !/^0x[0-9a-f]*$/i.test(item.data) ||
    (item.removed !== undefined && typeof item.removed !== "boolean")
  )
    return null;
  return {
    address: logAddress,
    topics: item.topics as string[],
    data: item.data,
    blockNumber,
    blockHash: item.blockHash.toLowerCase() as `0x${string}`,
    transactionHash: item.transactionHash.toLowerCase() as `0x${string}`,
    logIndex,
    removed: item.removed === true,
  };
}

function parseReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const blockNumber = hexQuantity(item.blockNumber);
  const transactionIndex =
    item.transactionIndex === undefined || item.transactionIndex === null
      ? null
      : hexQuantity(item.transactionIndex);
  if (
    blockNumber === null ||
    typeof item.transactionHash !== "string" ||
    !HASH_PATTERN.test(item.transactionHash) ||
    typeof item.blockHash !== "string" ||
    !HASH_PATTERN.test(item.blockHash) ||
    typeof item.status !== "string" ||
    !HEX_QUANTITY_PATTERN.test(item.status) ||
    (item.transactionIndex !== undefined &&
      item.transactionIndex !== null &&
      transactionIndex === null) ||
    !Array.isArray(item.logs) ||
    item.logs.length > MAX_RECEIPT_LOGS
  )
    return null;
  let status: bigint;
  try {
    status = BigInt(item.status);
  } catch {
    return null;
  }
  const logs = item.logs.map(receiptLog);
  if (logs.some((log): log is null => log === null)) return null;
  return {
    transactionHash: item.transactionHash.toLowerCase() as `0x${string}`,
    blockNumber,
    blockHash: item.blockHash.toLowerCase() as `0x${string}`,
    status,
    transactionIndex,
    logs: logs as ReceiptLog[],
  };
}

function transferLogIndex(eventIndex: string): number | null {
  if (!/^log\.\d+$/.test(eventIndex)) return null;
  const value = Number(eventIndex.slice(4));
  return Number.isSafeInteger(value) ? value : null;
}

function transferTransactionIndex(eventIndex: string): number | null {
  if (!/^tx(?:\.\d+)?$/.test(eventIndex)) return null;
  if (eventIndex === "tx") return null;
  const value = Number(eventIndex.slice(3));
  return Number.isSafeInteger(value) ? value : null;
}

function topicAddress(topic: string): Address | null {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(topic)) return null;
  return address(`0x${topic.slice(-40)}`);
}

function matchesObservedTransfer(
  receipt: Receipt,
  transfer: NormalizedTransfer,
): boolean {
  const eventIndex = transferLogIndex(transfer.eventIndex);
  if (
    receipt.status !== 1n ||
    receipt.transactionHash !== transfer.hash ||
    receipt.blockNumber !== transfer.blockNumber ||
    eventIndex === null
  )
    return false;
  const token = transfer.token,
    from = transfer.from,
    to = transfer.to;
  return receipt.logs.some((log) => {
    if (
      log.removed ||
      log.address !== token ||
      log.blockNumber !== transfer.blockNumber ||
      log.blockHash !== receipt.blockHash ||
      log.transactionHash !== transfer.hash ||
      log.logIndex !== eventIndex ||
      log.topics.length < 3 ||
      log.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
      !/^0x[0-9a-f]{64}$/i.test(log.data)
    )
      return false;
    const logFrom = topicAddress(log.topics[1]),
      logTo = topicAddress(log.topics[2]);
    if (!logFrom || !logTo || logFrom !== from || logTo !== to) return false;
    try {
      return BigInt(log.data) === BigInt(transfer.rawAmount);
    } catch {
      return false;
    }
  });
}

function parseNativeTransaction(value: unknown): NativeTransaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const hash =
      typeof item.hash === "string" && HASH_PATTERN.test(item.hash)
        ? (item.hash.toLowerCase() as `0x${string}`)
        : null,
    blockNumber = hexQuantity(item.blockNumber),
    from = address(item.from),
    to = address(item.to),
    valueHex = item.value,
    transactionIndex =
      item.transactionIndex === undefined || item.transactionIndex === null
        ? null
        : hexQuantity(item.transactionIndex);
  if (
    !hash ||
    blockNumber === null ||
    !from ||
    !to ||
    (item.transactionIndex !== undefined &&
      item.transactionIndex !== null &&
      transactionIndex === null) ||
    typeof valueHex !== "string" ||
    !HEX_QUANTITY_PATTERN.test(valueHex)
  )
    return null;
  let valueAmount: bigint;
  try {
    valueAmount = BigInt(valueHex);
  } catch {
    return null;
  }
  return { hash, blockNumber, from, to, value: valueAmount, transactionIndex };
}

function matchesNativeTransfer(
  transaction: NativeTransaction,
  transfer: NormalizedTransfer,
): boolean {
  if (transfer.kind !== "native") return false;
  if (!/^tx(?:\.\d+)?$/.test(transfer.eventIndex)) return false;
  const transactionIndex = transferTransactionIndex(transfer.eventIndex);
  try {
    return (
      transaction.hash === transfer.hash &&
      transaction.blockNumber === transfer.blockNumber &&
      transaction.from === transfer.from &&
      transaction.to === transfer.to &&
      transaction.value === BigInt(transfer.rawAmount) &&
      (transactionIndex === null ||
        transaction.transactionIndex === transactionIndex)
    );
  } catch {
    return false;
  }
}

function boundedInteger(value: number | undefined, name: string): number {
  const result = value ?? MAX_ADDRESSES;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_ADDRESSES)
    throw new Error(`${name} must be an integer from 1 to ${MAX_ADDRESSES}.`);
  return result;
}

function observationTime(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("now must be a valid date.");
  return date.toISOString();
}

function parseTransfer(value: Transfer): NormalizedTransfer | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Transfer>;
  if (
    candidate.chainId !== 1 ||
    (candidate.kind !== "erc20" && candidate.kind !== "native") ||
    candidate.status !== "success" ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 300 ||
    typeof candidate.eventIndex !== "string" ||
    candidate.eventIndex.length === 0 ||
    candidate.eventIndex.length > 100 ||
    typeof candidate.hash !== "string" ||
    !HASH_PATTERN.test(candidate.hash) ||
    !Number.isSafeInteger(candidate.blockNumber) ||
    (candidate.blockNumber as number) < 0 ||
    typeof candidate.timestamp !== "string" ||
    Number.isNaN(Date.parse(candidate.timestamp)) ||
    typeof candidate.source !== "string" ||
    candidate.source.length > 200
  )
    return null;
  const from = address(candidate.from),
    to = address(candidate.to),
    asset = candidate.asset,
    token = address(asset?.contract);
  if (
    !from ||
    !to ||
    !asset ||
    asset.chainId !== 1 ||
    (candidate.kind === "erc20" && !token) ||
    (candidate.kind === "native" && token !== null) ||
    typeof asset.symbol !== "string" ||
    asset.symbol.length === 0 ||
    asset.symbol.length > 40 ||
    !Number.isSafeInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > 255 ||
    typeof candidate.rawAmount !== "string" ||
    candidate.rawAmount.length > MAX_TEXT_LENGTH ||
    !/^\d+$/.test(candidate.rawAmount)
  )
    return null;
  try {
    if (BigInt(candidate.rawAmount) < 1n) return null;
  } catch {
    return null;
  }
  return {
    id: candidate.id,
    hash: candidate.hash.toLowerCase() as `0x${string}`,
    eventIndex: candidate.eventIndex,
    kind: candidate.kind,
    from,
    to,
    token,
    symbol: asset.symbol,
    decimals: asset.decimals,
    rawAmount: candidate.rawAmount,
    timestamp: candidate.timestamp,
    blockNumber: candidate.blockNumber as number,
    source: candidate.source,
  };
}

function normalizedEvidence(value: WalletLeadEvidence): WalletLeadEvidence {
  if (!value || value.chainId !== 1 || value.confidence !== "low")
    throw new Error("Invalid wallet lead evidence.");
  const seed = address(value.seed),
    candidate = address(value.candidate),
    token = address(value.token);
  const source = value.source === undefined ? undefined : address(value.source);
  if (
    !seed ||
    !candidate ||
    (value.basis !== "source-native-outflow-to-empty-account" && !token) ||
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    value.eventId.length > 300 ||
    typeof value.transactionHash !== "string" ||
    !HASH_PATTERN.test(value.transactionHash) ||
    !Number.isSafeInteger(value.blockNumber) ||
    value.blockNumber < 0 ||
    typeof value.blockHash !== "string" ||
    !HASH_PATTERN.test(value.blockHash) ||
    typeof value.symbol !== "string" ||
    value.symbol.length === 0 ||
    value.symbol.length > 40 ||
    !Number.isSafeInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    typeof value.rawAmount !== "string" ||
    value.rawAmount.length > MAX_TEXT_LENGTH ||
    !/^\d+$/.test(value.rawAmount) ||
    BigInt(value.rawAmount) < 1n ||
    typeof value.timestamp !== "string" ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.observedAt !== "string" ||
    Number.isNaN(Date.parse(value.observedAt)) ||
    (value.expiresAt !== undefined &&
      (typeof value.expiresAt !== "string" ||
        Number.isNaN(Date.parse(value.expiresAt)))) ||
    ![
      "seed-erc20-outflow-to-empty-account",
      "source-erc20-outflow-to-empty-account",
      "source-native-outflow-to-empty-account",
    ].includes(value.basis) ||
    (value.source !== undefined && !source) ||
    (value.generation !== undefined &&
      (!Number.isSafeInteger(value.generation) ||
        value.generation < 0 ||
        value.generation > MAX_GENERATIONS)) ||
    (value.transactionIndex !== undefined &&
      (!Number.isSafeInteger(value.transactionIndex) ||
        value.transactionIndex < 0)) ||
    typeof value.evidenceSource !== "string" ||
    value.evidenceSource.length > 200
  )
    throw new Error("Invalid wallet lead evidence.");
  return {
    ...value,
    seed,
    candidate,
    token,
    ...(source ? { source } : {}),
    transactionHash: value.transactionHash.toLowerCase() as `0x${string}`,
    blockHash: value.blockHash.toLowerCase() as `0x${string}`,
  };
}

function normalizedState(
  state: WalletLeadState | undefined,
  maxCandidates: number,
): WalletLeadState {
  if (!state) return { version: 1, leads: [] };
  if (state.version !== 1 || !Array.isArray(state.leads))
    throw new Error("Invalid wallet lead state.");
  const leads: WalletLeadEvidence[] = [],
    seen = new Set<Address>();
  for (const value of state.leads) {
    const lead = normalizedEvidence(value);
    if (seen.has(lead.candidate)) continue;
    seen.add(lead.candidate);
    if (leads.length < maxCandidates) leads.push(lead);
  }
  return { version: 1, leads };
}

/** Pure merge point for atomically persisting leads alongside watcher state. */
export function mergeWalletLeadState(
  state: WalletLeadState | undefined,
  added: readonly WalletLeadEvidence[],
  maxCandidates = MAX_ADDRESSES,
): WalletLeadState {
  const cap = boundedInteger(maxCandidates, "maxCandidates");
  const base = normalizedState(state, cap),
    leads = [...base.leads],
    seen = new Set(leads.map((lead) => lead.candidate));
  for (const value of added) {
    const lead = normalizedEvidence(value);
    if (seen.has(lead.candidate)) continue;
    if (leads.length >= cap) break;
    seen.add(lead.candidate);
    leads.push(lead);
  }
  return { version: 1, leads };
}

/** Purely remove leads whose optional TTL has elapsed. */
export function pruneExpiredWalletLeadState(
  state: WalletLeadState | undefined,
  now: Date | string = new Date(),
): WalletLeadState {
  const observedAt = observationTime(now);
  const base = normalizedState(state, MAX_ADDRESSES);
  const cutoff = Date.parse(observedAt);
  return {
    version: 1,
    leads: base.leads.filter(
      (lead) =>
        lead.expiresAt === undefined || Date.parse(lead.expiresAt) > cutoff,
    ),
  };
}

function addSkip(skipped: WalletLeadSkip[], item: WalletLeadSkip): void {
  if (skipped.length < MAX_SKIP_DETAILS) skipped.push(item);
}

function addRetry(retryable: WalletLeadRetry[], item: WalletLeadRetry): void {
  if (
    retryable.some(
      (existing) =>
        existing.candidate === item.candidate &&
        existing.eventId === item.eventId,
    )
  )
    return;
  // Keep provider gaps separate from the human detail cap. The queue is still
  // bounded by the transfer input ceiling, and preserves every attempted ID.
  if (retryable.length < MAX_RETRYABLE) retryable.push(item);
}

function retainCandidateCapacity(
  skipped: WalletLeadSkip[],
  retryable: WalletLeadRetry[],
  candidate: Address,
  alternatives: readonly NormalizedTransfer[],
): void {
  for (const transfer of alternatives) {
    addSkip(skipped, {
      reason: "candidate-cap",
      candidate,
      eventId: transfer.id,
    });
    addRetry(retryable, {
      reason: "candidate-cap",
      candidate,
      eventId: transfer.id,
      transactionHash: transfer.hash,
    });
  }
}

/**
 * Find bounded, low-confidence wallet leads from already confirmed transfer
 * observations. Explicit seeds and the current state/source set are inspected
 * through a fixed generation bound; this function never expands indefinitely.
 */
export async function discoverWalletLeads(
  input: DiscoverWalletLeadsInput,
): Promise<DiscoverWalletLeadsResult> {
  if (input.rpc.chainId !== 1)
    throw new Error("Wallet lead discovery requires an Ethereum RPC client.");
  const seeds = normalizedAddressList(input.seeds, "seeds", MAX_SEEDS);
  if (seeds.length === 0)
    throw new Error("At least one seed address is required.");
  const excluded = new Set(
    normalizedAddressList(input.excluded, "excluded", MAX_EXCLUDED),
  );
  if (!Array.isArray(input.transfers) || input.transfers.length > MAX_TRANSFERS)
    throw new Error(
      `transfers must contain at most ${MAX_TRANSFERS} observations.`,
    );
  const seedSet = new Set(seeds);
  for (const seed of seeds) excluded.add(seed);
  const maxCandidates = boundedInteger(input.maxCandidates, "maxCandidates");
  const maxNewPerCycle = boundedInteger(input.maxNewPerCycle, "maxNewPerCycle");
  const maxGenerations = input.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
  if (
    !Number.isSafeInteger(maxGenerations) ||
    maxGenerations < 1 ||
    maxGenerations > MAX_GENERATIONS
  )
    throw new Error(
      `maxGenerations must be an integer from 1 to ${MAX_GENERATIONS}.`,
    );
  const minRawAmount = input.minRawAmount ?? 1n;
  if (typeof minRawAmount !== "bigint" || minRawAmount < 1n)
    throw new Error("minRawAmount must be a positive bigint.");
  if (
    input.minUsd !== undefined &&
    (!Number.isFinite(input.minUsd) || input.minUsd < 0 || !input.usdValue)
  )
    throw new Error(
      "minUsd requires a finite non-negative value and usdValue.",
    );
  if (
    input.leadTtlMs !== undefined &&
    (!Number.isSafeInteger(input.leadTtlMs) ||
      input.leadTtlMs < 1 ||
      input.leadTtlMs > MAX_TTL_MS)
  )
    throw new Error(
      `leadTtlMs must be an integer from 1 to ${MAX_TTL_MS} milliseconds.`,
    );
  const observedAt = observationTime(input.now),
    state = pruneExpiredWalletLeadState(
      normalizedState(input.state, maxCandidates),
      observedAt,
    ),
    known = new Set(state.leads.map((lead) => lead.candidate)),
    sourceMap = new Map<Address, WalletLeadSource>(),
    skipped: WalletLeadSkip[] = [],
    retryable: WalletLeadRetry[] = [],
    candidates = new Map<Address, NormalizedTransfer[]>();

  for (const seed of seeds)
    sourceMap.set(seed, { address: seed, generation: 0, seed });
  for (const source of input.sources ?? []) {
    const sourceAddress = address(source.address),
      sourceSeed = address(source.seed);
    if (
      !sourceAddress ||
      !sourceSeed ||
      !Number.isSafeInteger(source.generation) ||
      source.generation < 0 ||
      source.generation > maxGenerations ||
      !seedSet.has(sourceSeed)
    )
      throw new Error("sources contains an invalid bounded wallet source.");
    if (!sourceMap.has(sourceAddress))
      sourceMap.set(sourceAddress, {
        address: sourceAddress,
        generation: source.generation,
        seed: sourceSeed,
      });
  }
  for (const lead of state.leads) {
    const sourceSeed = lead.seed,
      generation = lead.generation ?? 1;
    if (
      generation <= maxGenerations &&
      sourceMap.has(sourceSeed) &&
      !sourceMap.has(lead.candidate)
    )
      sourceMap.set(lead.candidate, {
        address: lead.candidate,
        generation,
        seed: sourceSeed,
      });
  }
  const available = Math.min(
    maxNewPerCycle,
    maxCandidates - state.leads.length,
  );

  for (const rawTransfer of input.transfers) {
    const transfer = parseTransfer(rawTransfer);
    if (!transfer) {
      addSkip(skipped, { reason: "invalid-transfer" });
      continue;
    }
    const source = sourceMap.get(transfer.from);
    if (!source) {
      addSkip(skipped, { reason: "not-seed-outflow", eventId: transfer.id });
      continue;
    }
    if (source.generation >= maxGenerations) {
      addSkip(skipped, {
        reason: "generation-cap",
        candidate: transfer.to,
        eventId: transfer.id,
      });
      continue;
    }
    if (
      transfer.to === ZERO_ADDRESS ||
      BigInt(transfer.rawAmount) < minRawAmount
    ) {
      addSkip(skipped, {
        reason: "zero-or-dust",
        candidate: transfer.to,
        eventId: transfer.id,
      });
      continue;
    }
    if (input.minUsd !== undefined) {
      let usd: number | null;
      try {
        usd = input.usdValue?.(rawTransfer) ?? null;
      } catch {
        usd = null;
      }
      if (usd === null || !Number.isFinite(usd)) {
        addSkip(skipped, {
          reason: "price-unavailable",
          candidate: transfer.to,
          eventId: transfer.id,
        });
        addRetry(retryable, {
          reason: "price-unavailable",
          candidate: transfer.to,
          eventId: transfer.id,
          transactionHash: transfer.hash,
        });
        continue;
      }
      if (usd < input.minUsd) {
        addSkip(skipped, {
          reason: "below-threshold",
          candidate: transfer.to,
          eventId: transfer.id,
        });
        continue;
      }
    }
    if (
      excluded.has(transfer.to) ||
      sourceMap.has(transfer.to) ||
      known.has(transfer.to) ||
      (() => {
        try {
          return input.excludeAddress?.(transfer.to) === true;
        } catch {
          return true;
        }
      })()
    ) {
      addSkip(skipped, {
        reason: known.has(transfer.to) ? "already-known" : "excluded",
        candidate: transfer.to,
        eventId: transfer.id,
      });
      continue;
    }
    const alternatives = candidates.get(transfer.to);
    if (alternatives) {
      if (alternatives.length < MAX_EVENTS_PER_CANDIDATE) {
        alternatives.push(transfer);
      } else {
        addSkip(skipped, {
          reason: "candidate-cap",
          candidate: transfer.to,
          eventId: transfer.id,
        });
        addRetry(retryable, {
          reason: "candidate-cap",
          candidate: transfer.to,
          eventId: transfer.id,
          transactionHash: transfer.hash,
        });
      }
      continue;
    }
    if (available <= 0 || candidates.size >= MAX_ADDRESSES) {
      addSkip(skipped, {
        reason: "candidate-cap",
        candidate: transfer.to,
        eventId: transfer.id,
      });
      addRetry(retryable, {
        reason: "candidate-cap",
        candidate: transfer.to,
        eventId: transfer.id,
        transactionHash: transfer.hash,
      });
      continue;
    }
    candidates.set(transfer.to, [transfer]);
  }

  const added: WalletLeadEvidence[] = [];
  const receiptCache = new Map<
    string,
    {
      receipt: Receipt | null;
      reason: "unavailable" | "malformed";
    }
  >();
  const transactionCache = new Map<string, NativeTransaction | null>();
  const candidateEntries = [...candidates.entries()];
  for (const [
    candidateIndex,
    [recipient, alternatives],
  ] of candidateEntries.entries()) {
    if (added.length >= available) {
      for (const [
        remainingRecipient,
        remainingAlternatives,
      ] of candidateEntries.slice(candidateIndex))
        retainCandidateCapacity(
          skipped,
          retryable,
          remainingRecipient,
          remainingAlternatives,
        );
      break;
    }
    let verifiedTransfer: {
      transfer: NormalizedTransfer;
      receipt: Receipt;
      transaction?: NativeTransaction;
    } | null = null;
    for (const transfer of alternatives) {
      let receiptCheck = receiptCache.get(transfer.hash);
      if (!receiptCheck) {
        try {
          const rawReceipt = await input.rpc.request(
            "eth_getTransactionReceipt",
            [transfer.hash],
          );
          if (rawReceipt === null) {
            receiptCheck = { receipt: null, reason: "unavailable" };
          } else {
            const receipt = parseReceipt(rawReceipt);
            receiptCheck =
              receipt === null
                ? { receipt: null, reason: "malformed" }
                : { receipt, reason: "malformed" };
          }
        } catch {
          receiptCheck = { receipt: null, reason: "unavailable" };
        }
        receiptCache.set(transfer.hash, receiptCheck);
      }
      if (!receiptCheck.receipt) {
        const reason =
          receiptCheck.reason === "unavailable"
            ? "receipt-unavailable"
            : "receipt-mismatch";
        addSkip(skipped, {
          reason,
          candidate: recipient,
          eventId: transfer.id,
        });
        addRetry(retryable, {
          reason,
          candidate: recipient,
          eventId: transfer.id,
          transactionHash: transfer.hash,
        });
        continue;
      }
      const receipt = receiptCheck.receipt;
      if (
        receipt.status !== 1n ||
        receipt.transactionHash !== transfer.hash ||
        receipt.blockNumber !== transfer.blockNumber
      ) {
        addSkip(skipped, {
          reason: "receipt-mismatch",
          candidate: recipient,
          eventId: transfer.id,
        });
        addRetry(retryable, {
          reason: "receipt-mismatch",
          candidate: recipient,
          eventId: transfer.id,
          transactionHash: transfer.hash,
        });
        continue;
      }
      let nativeTransaction: NativeTransaction | undefined;
      if (transfer.kind === "native") {
        let cachedTransaction = transactionCache.get(transfer.hash);
        if (cachedTransaction === undefined) {
          try {
            const rawTransaction = await input.rpc.request(
              "eth_getTransactionByHash",
              [transfer.hash],
            );
            cachedTransaction = parseNativeTransaction(rawTransaction);
          } catch {
            cachedTransaction = null;
          }
          transactionCache.set(transfer.hash, cachedTransaction);
        }
        if (
          !cachedTransaction ||
          !matchesNativeTransfer(cachedTransaction, transfer)
        ) {
          addSkip(skipped, {
            reason: "receipt-log-mismatch",
            candidate: recipient,
            eventId: transfer.id,
          });
          addRetry(retryable, {
            reason: "receipt-log-mismatch",
            candidate: recipient,
            eventId: transfer.id,
            transactionHash: transfer.hash,
          });
          continue;
        }
        nativeTransaction = cachedTransaction;
      } else if (!matchesObservedTransfer(receipt, transfer)) {
        addSkip(skipped, {
          reason: "receipt-log-mismatch",
          candidate: recipient,
          eventId: transfer.id,
        });
        addRetry(retryable, {
          reason: "receipt-log-mismatch",
          candidate: recipient,
          eventId: transfer.id,
          transactionHash: transfer.hash,
        });
        continue;
      }
      verifiedTransfer = {
        transfer,
        receipt,
        ...(nativeTransaction ? { transaction: nativeTransaction } : {}),
      };
      break;
    }
    if (!verifiedTransfer) continue;
    const { transfer, receipt: verifiedReceipt } = verifiedTransfer;
    const source = sourceMap.get(transfer.from);
    if (!source) continue;
    let code: unknown;
    try {
      code = await input.rpc.request("eth_getCode", [
        recipient,
        `0x${transfer.blockNumber.toString(16)}`,
      ]);
    } catch {
      addSkip(skipped, {
        reason: "code-unavailable",
        candidate: recipient,
        eventId: transfer.id,
      });
      addRetry(retryable, {
        reason: "code-unavailable",
        candidate: recipient,
        eventId: transfer.id,
        transactionHash: transfer.hash,
      });
      continue;
    }
    if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code)) {
      addSkip(skipped, {
        reason: "invalid-code",
        candidate: recipient,
        eventId: transfer.id,
      });
      addRetry(retryable, {
        reason: "invalid-code",
        candidate: recipient,
        eventId: transfer.id,
        transactionHash: transfer.hash,
      });
      continue;
    }
    if (code.toLowerCase() !== "0x") {
      addSkip(skipped, {
        reason: "contract",
        candidate: recipient,
        eventId: transfer.id,
      });
      continue;
    }
    const lead: WalletLeadEvidence = {
      // Preserve the configured root through every bounded hop; `source`
      // records the immediate funding wallet.
      seed: source.seed,
      candidate: recipient,
      chainId: 1,
      eventId: transfer.id,
      transactionHash: transfer.hash,
      blockNumber: transfer.blockNumber,
      blockHash: verifiedReceipt.blockHash,
      token: transfer.token,
      symbol: transfer.symbol,
      decimals: transfer.decimals,
      rawAmount: transfer.rawAmount,
      timestamp: transfer.timestamp,
      observedAt,
      confidence: "low",
      basis:
        transfer.kind === "native"
          ? "source-native-outflow-to-empty-account"
          : source.generation === 0
            ? "seed-erc20-outflow-to-empty-account"
            : "source-erc20-outflow-to-empty-account",
      evidenceSource: transfer.source,
      ...(source.generation > 0 || transfer.kind === "native"
        ? { source: transfer.from, generation: source.generation + 1 }
        : {}),
      ...(transfer.kind === "native" &&
      verifiedTransfer.transaction?.transactionIndex !== null &&
      verifiedTransfer.transaction?.transactionIndex !== undefined
        ? {
            transactionIndex: verifiedTransfer.transaction.transactionIndex,
          }
        : {}),
    };
    if (input.leadTtlMs !== undefined) {
      lead.expiresAt = new Date(
        Date.parse(observedAt) + input.leadTtlMs,
      ).toISOString();
    }
    const transactionIndex =
      verifiedTransfer.transaction?.transactionIndex ??
      verifiedReceipt.transactionIndex;
    if (transactionIndex !== null && transactionIndex !== undefined)
      lead.transactionIndex = transactionIndex;
    added.push(lead);
  }
  return {
    added,
    state: mergeWalletLeadState(state, added, maxCandidates),
    skipped,
    retryable,
  };
}
