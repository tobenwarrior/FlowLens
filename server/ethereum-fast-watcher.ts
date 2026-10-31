import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Address, Asset, Transfer } from "../src/domain/types.ts";
import {
  formatTransferAlert,
  type AlertValuation,
  type FlowEvent,
} from "./telegram-watcher.ts";
import {
  decimalProduct,
  fetchTokenQuote,
  fetchWalletValuation,
  type WalletValuationSnapshot,
} from "./telegram-valuation.ts";
import {
  createEntityTokenBalanceReader,
  type EntityTokenBalanceReader,
} from "./entity-token-balance.ts";
import {
  discoverWalletLeads,
  pruneExpiredWalletLeadState,
  type WalletLeadSource,
  type WalletLeadState,
} from "./wallet-lead-discovery.ts";
import {
  DEFAULT_UNISWAP_MAINNET_ROUTERS,
  detectUniswapRouteEvidence,
  type UniswapRouteEvidence,
} from "./uniswap-route-evidence.ts";
import {
  extractReceiptSwapProceeds,
  type CanonicalPoolTokens,
  type ReceiptSwapRoute,
  type SwapProceeds,
  type SwapReceipt,
  type ValuedSwapProceeds,
  valueSwapProceeds,
} from "./swap-proceeds.ts";
import type { TokenQuote } from "./telegram-valuation.ts";
import type { RpcClient } from "./rpc.ts";
import {
  scanNativeLeadTransfers,
  type NativeLeadScanResult,
} from "./native-lead-observations.ts";
import {
  beginNativeLeadScan,
  commitNativeLeadScan,
  createNativeLeadStreamState,
  normalizeNativeLeadStreamState,
  queueNativeLeadReplays,
  type NativeLeadStreamState,
} from "./native-lead-stream.ts";

const CHAIN_ID = 1;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const MAX_WALLETS = 100;
const MAX_DYNAMIC_LEADS = 100;
const MAX_LEAD_GENERATIONS = 2;
const MAX_NEW_LEADS_PER_CYCLE = 20;
const MAX_TOKENS = 500;
// PublicNode rejects an eth_getLogs address array above ten entries.
const TOKEN_CHUNK = 10;
const MAX_LOGS = 10_000;
const MAX_SEEN = 50_000;
const MAX_DEFERRED = 5_000;
const MAX_LEAD_QUEUE = 5_000;
const MAX_LEAD_CATCH_UP_TASKS = MAX_DYNAMIC_LEADS;
const MAX_RPC_RESPONSE_BYTES = 2_000_000;
const MAX_ALERT_AGE_MS = 2 * 60_000;
const MAX_RPC_CONCURRENCY = 8;
const DISCOVERY_CONCURRENCY = 4;
const DISCOVERY_SPACING_MS = 250;
// Lead discovery is advisory background work. Keep each batch bounded so a
// slow quote/receipt provider cannot delay the live cursor poll.
const MAX_LEAD_OBSERVATIONS_PER_CYCLE = 100;
/**
 * These are event signatures, rather than protocol labels. A receipt proves
 * that a contract emitted a swap-shaped event; token0/token1 verification
 * below proves that the event involved the asset being alerted.
 */
const SWAP_V2_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const SWAP_V3_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
export const UNISWAP_V3_FEE_SELECTOR = "0xddca3f43";
export const UNISWAP_V2_GET_PAIR_SELECTOR = "0xe6a43905";
export const UNISWAP_V3_GET_POOL_SELECTOR = "0x1698ee82";
export const UNISWAP_V2_FACTORY =
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f" as Address;
export const UNISWAP_V3_FACTORY =
  "0x1f98431c8ad98523631ae4a59f267346ea31f984" as Address;
const LEAD_EXCLUDED_ADDRESSES: readonly Address[] = [
  ZERO_ADDRESS as Address,
  UNISWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as Address,
  "0xe592427a0aece92de3edee1f18e0157c05861564" as Address,
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45" as Address,
];
const MAX_POOL_RECEIPT_LOGS = 256;
const MAX_POOL_CANDIDATES = 16;
const MAX_POOL_EVIDENCE_CACHE = 4_096;
const POOL_READ_CONCURRENCY = 4;
const MAX_POOL_RPC_CONCURRENCY = 8;
const INPUT_QUOTE_TIMEOUT_MS = 2_000;
const POOL_OUTPUT_QUOTE_TIMEOUT_MS = 2_500;
const ENTITY_TOTAL_TIMEOUT_MS = 3_000;

export interface FastWatchConfig {
  addresses: Address[];
  entityAddresses: Address[];
  manualTokenAddresses: Address[];
  /** Exact ERC-20 contracts whose movements should alert in every direction. */
  priorityTokenAddresses?: Address[];
  rpcUrl: string;
  token: string;
  chatId: string;
  stateFile: string;
  intervalMs: number;
  confirmations: number;
  maxBlockSpan: number;
  tokenRefreshMs: number;
}

export interface FastWatchState {
  version: 1;
  bootstrapped: boolean;
  lastBlock: number | null;
  lastHash: string | null;
  seen: string[];
  tokens: Address[];
  pending: FastPendingAlert[];
  deferred: FastDeferredLog[];
  /** Low-confidence recipients discovered from explicit seeds; never ownership-confirmed. */
  walletLeads?: WalletLeadState;
  /** Durable queue; discovery never blocks the live cursor poll. */
  leadQueue?: FastLeadObservation[];
  /** Catch-up flows produced by background discovery and awaiting delivery. */
  leadPendingFlows?: FastFlow[];
  /** Durable replay windows retained when provider catch-up is unavailable. */
  leadCatchUpTasks?: FastLeadCatchUpTask[];
  /** Durable cursor/replay state for top-level native ETH lead discovery. */
  nativeLeadStream?: NativeLeadStreamState;
}

export interface FastCopyButton {
  text: string;
  copy_text: { text: Address };
}

export interface FastReplyMarkup {
  inline_keyboard: FastCopyButton[][];
}

export interface FastPendingAlert {
  id: string;
  text: string;
  observedAt?: string;
  format?: "html";
  replyMarkup?: FastReplyMarkup;
}

export interface FastDeferredLog {
  key: string;
  log: LogRow;
  attempts: number;
  reason?: "metadata" | "pool" | "lead";
}

/** A confirmed seed observation awaiting bounded background lead discovery. */
export interface FastLeadObservation {
  transfer: Transfer;
  /** ERC-20 observations retain the exact log; native observations use tx.*. */
  log?: LogRow;
}

export interface FastLeadCatchUpTask {
  leads: WalletLeadState["leads"];
  fromBlock: number;
  targetBlock: number;
  attempts: number;
}

export interface FastFlow {
  wallet: Address;
  transfer: Transfer;
  direction: FlowEvent["direction"];
  /** The raw log lets unavailable pool checks be retried durably. */
  log?: LogRow;
  /** Priority token movement; bypasses the Uniswap-only dump filter. */
  priority?: boolean;
}

export interface FastEntityTotal {
  status: "complete" | "partial" | "unavailable";
  amount: string | null;
  symbol: string;
  rawBalance: string | null;
  decimals: number;
  usd: string | null;
}

export interface FastFormattedAlert {
  text: string;
  approxUsd: string | null;
  replyMarkup?: FastReplyMarkup;
}

export interface FastPoolEvidence {
  pools: Address[];
  status?: "verified" | "not-found" | "unavailable";
  venues?: Record<string, "uniswap-v2" | "uniswap-v3">;
  /** Receipt-decoded pool output; this is not wallet-realized proceeds. */
  poolOutputs?: SwapProceeds[];
}

export type FastWalletStatus = "seed" | "unconfirmed";

interface NativeTransactionEvidence {
  available: boolean;
  from?: Address;
  value?: bigint;
}

interface ReceiptLogEvidence {
  address: Address;
  topics: string[];
  data: string;
  logIndex: string;
  removed: boolean;
}

interface ReceiptEvidence {
  transactionHash: string;
  blockNumber: string;
  blockHash?: string;
  status?: string;
  logs: ReceiptLogEvidence[];
}

class PoolEvidenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolEvidenceUnavailableError";
  }
}

export interface FastScanResult {
  state: FastWatchState;
  flows: FastFlow[];
  warnings: string[];
  head: number;
  target: number;
  leadTransfers: Transfer[];
  leadObservations: Array<{ transfer: Transfer; log?: LogRow }>;
}

const address = (value: string, label: string): Address => {
  if (!ADDRESS.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value.toLowerCase() as Address;
};

const integer = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`Expected a non-negative integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Integer is out of range: ${value}`);
  return parsed;
};

function addresses(
  value: string | undefined,
  label: string,
  max: number,
): Address[] {
  if (!value) throw new Error(`${label} is required`);
  const values = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (!values.length || values.length > max)
    throw new Error(`${label} must contain 1-${max} addresses`);
  return values.map((item) => address(item, label));
}

function optionalAddresses(
  value: string | undefined,
  label: string,
  max: number,
): Address[] {
  return value?.trim() ? addresses(value, label, max) : [];
}

export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): FastWatchConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const intervalMs = integer(env.FLOWLENS_FAST_INTERVAL_MS, 4_000);
  const confirmations = integer(env.FLOWLENS_FAST_CONFIRMATIONS, 1);
  const maxBlockSpan = integer(env.FLOWLENS_FAST_MAX_BLOCK_SPAN, 40);
  const tokenRefreshMs = integer(env.FLOWLENS_FAST_TOKEN_REFRESH_MS, 300_000);
  if (intervalMs < 1_000 || intervalMs > 60_000)
    throw new Error("FLOWLENS_FAST_INTERVAL_MS must be 1000-60000");
  if (confirmations > 12)
    throw new Error("FLOWLENS_FAST_CONFIRMATIONS must be <=12");
  if (maxBlockSpan < 1 || maxBlockSpan > 2_000)
    throw new Error("FLOWLENS_FAST_MAX_BLOCK_SPAN must be 1-2000");
  return {
    addresses: addresses(
      env.FLOWLENS_FAST_WATCH_ADDRESSES?.trim() || env.FLOWLENS_WATCH_ADDRESSES,
      "FLOWLENS_FAST_WATCH_ADDRESSES",
      MAX_WALLETS,
    ),
    entityAddresses: env.FLOWLENS_ENTITY_ETHEREUM_ADDRESSES?.trim()
      ? addresses(
          env.FLOWLENS_ENTITY_ETHEREUM_ADDRESSES,
          "FLOWLENS_ENTITY_ETHEREUM_ADDRESSES",
          500,
        )
      : [],
    manualTokenAddresses: env.FLOWLENS_FAST_TOKEN_ADDRESSES?.trim()
      ? addresses(
          env.FLOWLENS_FAST_TOKEN_ADDRESSES,
          "FLOWLENS_FAST_TOKEN_ADDRESSES",
          MAX_TOKENS,
        )
      : [],
    priorityTokenAddresses: optionalAddresses(
      env.FLOWLENS_FAST_PRIORITY_TOKEN_ADDRESSES?.trim() ||
        env.FLOWLENS_FAST_ALERT_TOKEN_ADDRESSES?.trim(),
      "FLOWLENS_FAST_PRIORITY_TOKEN_ADDRESSES",
      50,
    ),
    rpcUrl: env.FLOWLENS_FAST_RPC_URL?.trim() || DEFAULT_RPC,
    token,
    chatId,
    stateFile: resolve(
      env.FLOWLENS_FAST_STATE_FILE ?? ".local/ethereum-fast-watcher.json",
    ),
    intervalMs,
    confirmations,
    maxBlockSpan,
    tokenRefreshMs,
  };
}

export function createInitialState(): FastWatchState {
  return {
    version: 1,
    bootstrapped: false,
    lastBlock: null,
    lastHash: null,
    seen: [],
    tokens: [],
    pending: [],
    deferred: [],
    walletLeads: { version: 1, leads: [] },
    leadQueue: [],
    leadPendingFlows: [],
    leadCatchUpTasks: [],
    nativeLeadStream: createNativeLeadStreamState(),
  };
}

function normalizeLog(value: unknown): LogRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.address !== "string" ||
    !ADDRESS.test(item.address) ||
    !Array.isArray(item.topics) ||
    item.topics.length < 3 ||
    item.topics.some((entry) => typeof entry !== "string") ||
    typeof item.data !== "string" ||
    !/^0x[0-9a-fA-F]*$/.test(item.data) ||
    typeof item.blockNumber !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(item.blockNumber) ||
    typeof item.blockHash !== "string" ||
    !HASH.test(item.blockHash) ||
    typeof item.transactionHash !== "string" ||
    !HASH.test(item.transactionHash) ||
    typeof item.logIndex !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(item.logIndex) ||
    (item.transactionIndex !== undefined &&
      (typeof item.transactionIndex !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(item.transactionIndex))) ||
    (item.removed !== undefined && typeof item.removed !== "boolean")
  )
    return null;
  return {
    address: item.address.toLowerCase() as Address,
    topics: item.topics as string[],
    data: item.data,
    blockNumber: item.blockNumber,
    blockHash: item.blockHash,
    transactionHash: item.transactionHash,
    logIndex: item.logIndex,
    ...(item.transactionIndex === undefined
      ? {}
      : { transactionIndex: item.transactionIndex }),
    removed: item.removed === true,
  };
}

function deferredKey(log: LogRow): string {
  return `${log.transactionHash.toLowerCase()}:${log.logIndex.toLowerCase()}`;
}

function normalizeLeadTransfer(value: unknown): Transfer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const asset = item.asset;
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;
  const rawAsset = asset as Record<string, unknown>;
  if (
    item.chainId !== CHAIN_ID ||
    (item.kind !== "erc20" && item.kind !== "native") ||
    item.status !== "success" ||
    typeof item.id !== "string" ||
    typeof item.hash !== "string" ||
    !HASH.test(item.hash) ||
    typeof item.eventIndex !== "string" ||
    !/^(?:log|tx)\.\d+$/.test(item.eventIndex) ||
    typeof item.from !== "string" ||
    !ADDRESS.test(item.from) ||
    typeof item.to !== "string" ||
    !ADDRESS.test(item.to) ||
    rawAsset.chainId !== CHAIN_ID ||
    typeof rawAsset.symbol !== "string" ||
    rawAsset.symbol.length < 1 ||
    rawAsset.symbol.length > 40 ||
    !Number.isSafeInteger(rawAsset.decimals) ||
    (rawAsset.decimals as number) < 0 ||
    (rawAsset.decimals as number) > 255 ||
    (item.kind === "erc20" &&
      (typeof rawAsset.contract !== "string" ||
        !ADDRESS.test(rawAsset.contract))) ||
    (item.kind === "native" && rawAsset.contract !== null) ||
    typeof item.rawAmount !== "string" ||
    !/^\d+$/.test(item.rawAmount) ||
    item.rawAmount.length > 300 ||
    typeof item.timestamp !== "string" ||
    !Number.isFinite(Date.parse(item.timestamp)) ||
    !Number.isSafeInteger(item.blockNumber) ||
    (item.blockNumber as number) < 0 ||
    typeof item.source !== "string" ||
    item.source.length > 200 ||
    typeof item.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(item.retrievedAt))
  )
    return null;
  const hash = item.hash.toLowerCase();
  const eventIndex = item.eventIndex;
  const eventNumber = eventIndex.slice(4);
  const contract =
    item.kind === "erc20" ? (rawAsset.contract as string).toLowerCase() : null;
  const id = `${CHAIN_ID}:${hash}:${item.kind}:${eventNumber}:${contract ?? "native"}`;
  if (item.id !== id) return null;
  return {
    id,
    chainId: CHAIN_ID,
    hash,
    kind: item.kind as "erc20" | "native",
    eventIndex,
    from: item.from.toLowerCase() as Address,
    to: item.to.toLowerCase() as Address,
    asset: {
      chainId: CHAIN_ID,
      symbol: rawAsset.symbol,
      decimals: rawAsset.decimals as number,
      contract: contract as Address | null,
    },
    rawAmount: item.rawAmount,
    timestamp: item.timestamp,
    blockNumber: item.blockNumber as number,
    status: "success",
    source: item.source,
    retrievedAt: item.retrievedAt,
  };
}

function normalizeLeadObservation(value: unknown): FastLeadObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const transfer = normalizeLeadTransfer(item.transfer);
  const log = item.log === undefined ? null : normalizeLog(item.log);
  if (!transfer || (transfer.kind === "erc20" && !log)) return null;
  if (transfer.kind === "native") return { transfer };
  if (!log) return null;
  const logBlock = Number.parseInt(log.blockNumber.slice(2), 16);
  const logIndex = Number.parseInt(log.logIndex.slice(2), 16);
  if (
    transfer.asset.contract !== log.address ||
    transfer.hash !== log.transactionHash.toLowerCase() ||
    transfer.blockNumber !== logBlock ||
    transfer.eventIndex !== `log.${logIndex}`
  )
    return null;
  return { transfer, log };
}

function normalizeLeadPendingFlow(value: unknown): FastFlow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const transfer = normalizeLeadTransfer(item.transfer);
  const log = normalizeLog(item.log);
  if (
    !transfer ||
    !log ||
    typeof item.wallet !== "string" ||
    !ADDRESS.test(item.wallet) ||
    (item.direction !== "outflow" &&
      item.direction !== "inflow" &&
      item.direction !== "self")
  )
    return null;
  const observation = normalizeLeadObservation({ transfer, log });
  if (!observation) return null;
  return {
    wallet: item.wallet.toLowerCase() as Address,
    transfer,
    direction: item.direction,
    log,
    ...(item.priority === true ? { priority: true } : {}),
  };
}

function normalizeLeadCatchUpTask(value: unknown): FastLeadCatchUpTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    !Array.isArray(item.leads) ||
    !Number.isSafeInteger(item.fromBlock) ||
    (item.fromBlock as number) < 0 ||
    !Number.isSafeInteger(item.targetBlock) ||
    (item.targetBlock as number) < (item.fromBlock as number) ||
    !Number.isSafeInteger(item.attempts) ||
    (item.attempts as number) < 0
  )
    return null;
  let leads: WalletLeadState["leads"];
  try {
    leads = pruneExpiredWalletLeadState({
      version: 1,
      leads: item.leads as WalletLeadState["leads"],
    }).leads;
  } catch {
    return null;
  }
  return leads.length
    ? {
        leads,
        fromBlock: item.fromBlock as number,
        targetBlock: item.targetBlock as number,
        attempts: item.attempts as number,
      }
    : null;
}

export function tokenAddressesFromState(state: FastWatchState): Address[] {
  const found = new Set<Address>();
  for (const id of state.seen) {
    const candidate = id.split(":").at(-1);
    if (candidate && ADDRESS.test(candidate))
      found.add(candidate.toLowerCase() as Address);
  }
  for (const deferred of state.deferred) found.add(deferred.log.address);
  for (const lead of state.walletLeads?.leads ?? [])
    if (lead.token) found.add(lead.token);
  for (const observation of state.leadQueue ?? [])
    if (observation.transfer.asset.contract)
      found.add(observation.transfer.asset.contract);
  for (const flow of state.leadPendingFlows ?? [])
    if (flow.transfer.asset.contract) found.add(flow.transfer.asset.contract);
  for (const task of state.leadCatchUpTasks ?? [])
    for (const lead of task.leads) if (lead.token) found.add(lead.token);
  return [...found].slice(0, MAX_TOKENS);
}

/** Include low-confidence leads in the paced balance/token refresh pass. */
export function walletAddressesForTokenDiscovery(
  config: FastWatchConfig,
  state: FastWatchState,
): Address[] {
  return [
    ...new Set([
      ...config.addresses,
      ...(state.walletLeads?.leads ?? []).map((lead) => lead.candidate),
    ]),
  ].slice(0, MAX_WALLETS + MAX_DYNAMIC_LEADS);
}

/**
 * Balance totals cover the configured entity wallets plus currently active
 * dynamic leads. Leads are explicit candidates only; this does not recursively
 * expand ownership or include queued/rejected candidates.
 */
export function entityAddressesForFastFlow(
  config: FastWatchConfig,
  _flow: FastFlow,
  activeLeadAddresses: readonly Address[] = [],
): Address[] {
  const seen = new Set<string>();
  const addresses: Address[] = [];
  for (const candidate of [...config.entityAddresses, ...activeLeadAddresses]) {
    const normalized = candidate.toLowerCase() as Address;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(normalized);
  }
  return addresses;
}

export function fastFlowWalletStatus(
  config: FastWatchConfig,
  flow: FastFlow,
): FastWalletStatus {
  return config.addresses.some(
    (addressValue) => addressValue.toLowerCase() === flow.wallet.toLowerCase(),
  )
    ? "seed"
    : "unconfirmed";
}

function normalizeFastReplyMarkup(value: unknown): FastReplyMarkup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.inline_keyboard) || raw.inline_keyboard.length > 17)
    return null;
  const rows: FastCopyButton[][] = [];
  for (const row of raw.inline_keyboard) {
    if (!Array.isArray(row) || row.length !== 1) return null;
    const button = row[0];
    if (!button || typeof button !== "object" || Array.isArray(button))
      return null;
    const item = button as Record<string, unknown>;
    const copy = item.copy_text;
    if (
      typeof item.text !== "string" ||
      item.text.length < 1 ||
      item.text.length > 64 ||
      !/^Copy (wallet|pool(?: \d+)?)$/.test(item.text) ||
      !copy ||
      typeof copy !== "object" ||
      Array.isArray(copy) ||
      typeof (copy as Record<string, unknown>).text !== "string" ||
      !ADDRESS.test((copy as Record<string, string>).text)
    )
      return null;
    rows.push([
      {
        text: item.text,
        copy_text: {
          text: (copy as Record<string, string>).text.toLowerCase() as Address,
        },
      },
    ]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

function normalizeState(value: unknown): FastWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Fast watcher state must be an object");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.bootstrapped !== "boolean" ||
    (raw.lastBlock !== null &&
      (!Number.isSafeInteger(raw.lastBlock) ||
        (raw.lastBlock as number) < 0)) ||
    (raw.lastHash !== null &&
      (typeof raw.lastHash !== "string" || !HASH.test(raw.lastHash))) ||
    !Array.isArray(raw.seen) ||
    raw.seen.some((id) => typeof id !== "string" || id.length > 400) ||
    (raw.pending !== undefined && !Array.isArray(raw.pending)) ||
    (Array.isArray(raw.pending) &&
      raw.pending.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof (item as Record<string, unknown>).id !== "string" ||
          typeof (item as Record<string, unknown>).text !== "string" ||
          (item as Record<string, string>).id.length > 400 ||
          (item as Record<string, string>).text.length > 4_000 ||
          ((item as Record<string, unknown>).observedAt !== undefined &&
            (typeof (item as Record<string, unknown>).observedAt !== "string" ||
              !Number.isFinite(
                Date.parse((item as Record<string, string>).observedAt),
              ))) ||
          ((item as Record<string, unknown>).format !== undefined &&
            (item as Record<string, unknown>).format !== "html") ||
          ((item as Record<string, unknown>).replyMarkup !== undefined &&
            normalizeFastReplyMarkup(
              (item as Record<string, unknown>).replyMarkup,
            ) === null),
      ))
  )
    throw new Error("Malformed fast watcher state");
  if (raw.deferred !== undefined && !Array.isArray(raw.deferred))
    throw new Error("Malformed fast watcher deferred queue");
  const deferred = (raw.deferred ?? []).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Malformed fast watcher deferred queue");
    const row = item as Record<string, unknown>;
    const log = normalizeLog(row.log);
    if (
      !log ||
      typeof row.key !== "string" ||
      row.key.length > 400 ||
      !Number.isSafeInteger(row.attempts) ||
      (row.attempts as number) < 0 ||
      (row.attempts as number) > Number.MAX_SAFE_INTEGER ||
      (row.reason !== undefined &&
        row.reason !== "metadata" &&
        row.reason !== "pool" &&
        row.reason !== "lead")
    )
      throw new Error("Malformed fast watcher deferred queue");
    return {
      key: deferredKey(log),
      log,
      attempts: row.attempts as number,
      reason:
        row.reason === "pool"
          ? ("pool" as const)
          : row.reason === "lead"
            ? ("lead" as const)
            : ("metadata" as const),
    };
  });
  if (deferred.length > MAX_DEFERRED)
    throw new Error("Fast watcher deferred queue exceeds bound");
  if (raw.leadQueue !== undefined && !Array.isArray(raw.leadQueue))
    throw new Error("Malformed fast watcher lead observation queue");
  const leadQueue = (raw.leadQueue ?? []).map((item) => {
    const observation = normalizeLeadObservation(item);
    if (!observation)
      throw new Error("Malformed fast watcher lead observation queue");
    return observation;
  });
  if (leadQueue.length > MAX_LEAD_QUEUE)
    throw new Error("Fast watcher lead observation queue exceeds bound");
  if (
    raw.leadPendingFlows !== undefined &&
    !Array.isArray(raw.leadPendingFlows)
  )
    throw new Error("Malformed fast watcher lead pending flow queue");
  const leadPendingFlows = (raw.leadPendingFlows ?? []).map((item) => {
    const flow = normalizeLeadPendingFlow(item);
    if (!flow)
      throw new Error("Malformed fast watcher lead pending flow queue");
    return flow;
  });
  if (leadPendingFlows.length > MAX_LEAD_QUEUE)
    throw new Error("Fast watcher lead pending flow queue exceeds bound");
  if (
    raw.leadCatchUpTasks !== undefined &&
    !Array.isArray(raw.leadCatchUpTasks)
  )
    throw new Error("Malformed fast watcher lead catch-up queue");
  const leadCatchUpTasks = (raw.leadCatchUpTasks ?? []).map((item) => {
    const task = normalizeLeadCatchUpTask(item);
    if (!task) throw new Error("Malformed fast watcher lead catch-up queue");
    return task;
  });
  if (leadCatchUpTasks.length > MAX_LEAD_CATCH_UP_TASKS)
    throw new Error("Fast watcher lead catch-up queue exceeds bound");
  let nativeLeadStream: NativeLeadStreamState;
  try {
    const legacyCursor =
      raw.lastBlock === null || raw.lastHash === null
        ? { lastBlock: null, lastHash: null }
        : {
            lastBlock: raw.lastBlock as number,
            lastHash: raw.lastHash as `0x${string}`,
          };
    nativeLeadStream = normalizeNativeLeadStreamState(
      raw.nativeLeadStream
        ? (raw.nativeLeadStream as NativeLeadStreamState)
        : createNativeLeadStreamState(legacyCursor),
      MAX_LEAD_CATCH_UP_TASKS,
    );
  } catch (error) {
    throw new Error(
      `Malformed fast watcher native lead stream: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let walletLeads: WalletLeadState;
  try {
    walletLeads = pruneExpiredWalletLeadState(
      raw.walletLeads as WalletLeadState | undefined,
    );
  } catch (error) {
    throw new Error(
      `Malformed fast watcher wallet lead state: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    version: 1,
    bootstrapped: raw.bootstrapped,
    lastBlock: raw.lastBlock as number | null,
    lastHash: raw.lastHash as string | null,
    seen: [...new Set(raw.seen as string[])].slice(-MAX_SEEN),
    tokens: Array.isArray(raw.tokens)
      ? [
          ...new Set(
            raw.tokens
              .filter(
                (item): item is string =>
                  typeof item === "string" && ADDRESS.test(item),
              )
              .map((item) => item.toLowerCase() as Address),
          ),
        ].slice(0, MAX_TOKENS)
      : [],
    pending: Array.isArray(raw.pending)
      ? (raw.pending as FastPendingAlert[]).slice(-MAX_SEEN).map((item) => {
          const markup = normalizeFastReplyMarkup(item.replyMarkup);
          return markup ? { ...item, replyMarkup: markup } : item;
        })
      : [],
    deferred,
    walletLeads,
    leadQueue,
    leadPendingFlows,
    leadCatchUpTasks,
    nativeLeadStream,
  };
}

export async function loadState(path: string): Promise<FastWatchState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialState();
    throw error;
  }
}

export async function saveState(
  path: string,
  state: FastWatchState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function queuePendingAlerts(
  state: FastWatchState,
  alerts: FastPendingAlert[],
): FastWatchState {
  const pending = new Map(state.pending.map((item) => [item.id, item]));
  for (const alert of alerts) pending.set(alert.id, alert);
  return { ...state, pending: [...pending.values()].slice(-MAX_SEEN) };
}

export function acknowledgePendingAlert(
  state: FastWatchState,
  id: string,
): FastWatchState {
  return { ...state, pending: state.pending.filter((item) => item.id !== id) };
}

export async function deliverPendingAlerts(
  initial: FastWatchState,
  persist: (state: FastWatchState) => Promise<void>,
  deliver: (text: string, replyMarkup?: FastReplyMarkup) => Promise<void>,
): Promise<FastWatchState> {
  let state = initial;
  for (const item of [...state.pending]) {
    if (!item.observedAt || !isFreshAlertTimestamp(item.observedAt)) {
      state = acknowledgePendingAlert(state, item.id);
      await persist(state);
      continue;
    }
    await deliver(
      item.format === "html" ? item.text : escapeTelegramHtml(item.text),
      item.replyMarkup,
    );
    state = acknowledgePendingAlert(state, item.id);
    await persist(state);
  }
  return state;
}

function isFreshAlertTimestamp(timestamp: string): boolean {
  const observedAt = Date.parse(timestamp);
  return (
    Number.isFinite(observedAt) && Date.now() - observedAt <= MAX_ALERT_AGE_MS
  );
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
      throw new Error("RPC response exceeded the bounded byte limit");
  }
  if (!response.body) throw new Error("RPC response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("RPC response exceeded the bounded byte limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class FastRpc implements RpcClient {
  readonly chainId = CHAIN_ID;
  readonly source = "PublicNode Ethereum RPC";
  readonly sourceUrl: string;
  private readonly url: string;
  private readonly fetcher: typeof fetch;
  private nextRequestId = 1;
  constructor(url: string, fetcher: typeof fetch = fetch) {
    this.url = url;
    this.sourceUrl = url;
    this.fetcher = fetcher;
  }
  async assertEthereumMainnet(): Promise<void> {
    const result = await this.request("eth_chainId", []);
    if (
      typeof result !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(result) ||
      BigInt(result) !== BigInt(CHAIN_ID)
    )
      throw new Error("Configured RPC is not Ethereum mainnet (chain 1)");
  }
  async request(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextRequestId++;
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    let body: {
      jsonrpc?: unknown;
      id?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      body = JSON.parse(
        await readBoundedResponse(response, MAX_RPC_RESPONSE_BYTES),
      ) as typeof body;
    } catch (error) {
      throw new Error(
        `RPC returned invalid or oversized JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("RPC response was not an object");
    if (body.jsonrpc !== "2.0" || body.id !== id)
      throw new Error("RPC response identity did not match the request");
    if (body.error)
      throw new Error(`RPC error: ${body.error.message ?? "unknown"}`);
    return body.result;
  }
}

interface Header {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
}
interface LogRow {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  transactionIndex?: string;
  removed?: boolean;
}
const hex = (value: number) => `0x${value.toString(16)}`;
const topic = (value: Address) => `0x${value.slice(2).padStart(64, "0")}`;
const parsedHex = (value: unknown, label: string): number => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`RPC returned malformed ${label}`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`RPC returned oversized ${label}`);
  return parsed;
};

async function header(rpc: RpcClient, block: number): Promise<Header> {
  const value = (await rpc.request("eth_getBlockByNumber", [
    hex(block),
    false,
  ])) as Record<string, unknown> | null;
  if (!value) throw new Error(`RPC returned no block ${block}`);
  return {
    number: parsedHex(value.number, "block number"),
    hash: String(value.hash),
    parentHash: String(value.parentHash),
    timestamp: parsedHex(value.timestamp, "block timestamp"),
  };
}

const chunks = <T>(values: T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    output.push(values.slice(index, index + size));
  return output;
};

async function fetchLogs(
  rpc: RpcClient,
  fromBlock: number,
  toBlock: number,
  tokens: Address[],
  wallets: Address[],
  position: 1 | 2,
): Promise<LogRow[]> {
  const output: LogRow[] = [];
  for (const tokenChunk of chunks(tokens, TOKEN_CHUNK)) {
    const requestedTokens = new Set(
      tokenChunk.map((token) => token.toLowerCase()),
    );
    const result = await rpc.request("eth_getLogs", [
      {
        fromBlock: hex(fromBlock),
        toBlock: hex(toBlock),
        address: tokenChunk.length === 1 ? tokenChunk[0] : tokenChunk,
        topics: [
          TRANSFER_TOPIC,
          position === 1 ? wallets.map(topic) : null,
          position === 2 ? wallets.map(topic) : null,
        ],
      },
    ]);
    if (!Array.isArray(result))
      throw new Error("RPC returned malformed log list");
    if (result.length >= MAX_LOGS)
      throw new Error(
        "RPC log response hit its bounded cap; coverage is incomplete",
      );
    for (const raw of result) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (
        typeof item.address !== "string" ||
        !ADDRESS.test(item.address) ||
        !requestedTokens.has(item.address.toLowerCase()) ||
        !Array.isArray(item.topics) ||
        item.topics.length < 3 ||
        item.topics.some((entry) => typeof entry !== "string") ||
        item.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
        typeof item.data !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(item.data) ||
        typeof item.blockNumber !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(item.blockNumber) ||
        typeof item.blockHash !== "string" ||
        !HASH.test(item.blockHash) ||
        typeof item.transactionHash !== "string" ||
        !HASH.test(item.transactionHash) ||
        typeof item.logIndex !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(item.logIndex) ||
        (item.transactionIndex !== undefined &&
          (typeof item.transactionIndex !== "string" ||
            !/^0x[0-9a-fA-F]+$/.test(item.transactionIndex)))
      )
        throw new Error("RPC returned malformed ERC-20 log");
      const block = parsedHex(item.blockNumber, "log block number");
      if (block < fromBlock || block > toBlock)
        throw new Error(
          "RPC returned an ERC-20 log outside the requested block range",
        );
      output.push({
        address: item.address.toLowerCase() as Address,
        topics: item.topics as string[],
        data: item.data,
        blockNumber: item.blockNumber,
        blockHash: item.blockHash,
        transactionHash: item.transactionHash,
        logIndex: item.logIndex,
        ...(item.transactionIndex === undefined
          ? {}
          : { transactionIndex: item.transactionIndex }),
        removed: item.removed === true,
      });
    }
  }
  return output;
}

function transferAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Malformed Transfer address topic");
  return `0x${value.slice(-40)}`.toLowerCase() as Address;
}

function metadataString(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(2), "hex");
  try {
    if (bytes.length >= 64) {
      const offset = Number(
        BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`),
      );
      if (offset + 32 <= bytes.length) {
        const length = Number(
          BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`),
        );
        if (offset + 32 + length <= bytes.length)
          return sanitizeSymbol(
            bytes
              .subarray(offset + 32, offset + 32 + length)
              .toString("utf8")
              .replace(/\0/g, ""),
          );
      }
    }
    return sanitizeSymbol(
      bytes.subarray(0, 32).toString("utf8").replace(/\0/g, "").slice(0, 32) ||
        "",
    );
  } catch {
    return null;
  }
}

function sanitizeSymbol(value: string): string | null {
  const clean = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._$-]/gu, "")
    .slice(0, 16);
  return clean || null;
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () =>
      worker(),
    ),
  );
  return output;
}

async function mapPacedConcurrent<T, R>(
  values: T[],
  limit: number,
  spacingMs: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  let nextStart = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      const now = Date.now();
      const start = Math.max(now, nextStart);
      nextStart = start + spacingMs;
      if (start > now)
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, start - now),
        );
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () =>
      worker(),
    ),
  );
  return output;
}

async function readNativeTransactionEvidence(
  rpc: RpcClient,
  hash: string,
): Promise<NativeTransactionEvidence> {
  try {
    const value = await rpc.request("eth_getTransactionByHash", [hash]);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { available: false };
    const row = value as Record<string, unknown>;
    if (
      typeof row.from !== "string" ||
      !ADDRESS.test(row.from) ||
      typeof row.value !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(row.value)
    )
      return { available: false };
    return {
      available: true,
      from: row.from.toLowerCase() as Address,
      value: BigInt(row.value),
    };
  } catch {
    return { available: false };
  }
}

const poolEvidenceCache = new WeakMap<
  RpcClient,
  Map<string, Promise<FastPoolEvidence>>
>();

interface PoolRpcGate {
  active: number;
  waiters: Array<() => void>;
}

const poolRpcGates = new WeakMap<RpcClient, PoolRpcGate>();

async function poolRpcRequest(
  rpc: RpcClient,
  method: string,
  params: unknown[],
): Promise<unknown> {
  let gate = poolRpcGates.get(rpc);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    poolRpcGates.set(rpc, gate);
  }
  if (gate.active >= MAX_POOL_RPC_CONCURRENCY)
    await new Promise<void>((resolve) => gate?.waiters.push(resolve));
  gate.active += 1;
  try {
    return await rpc.request(method, params);
  } finally {
    gate.active -= 1;
    gate.waiters.shift()?.();
  }
}

function decodeAddressResult(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    return null;
  const result = `0x${value.slice(-40)}`.toLowerCase();
  return ADDRESS.test(result) ? (result as Address) : null;
}

function receiptEvidence(value: unknown): ReceiptEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.transactionHash !== "string" ||
    !HASH.test(row.transactionHash) ||
    typeof row.blockNumber !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(row.blockNumber)
  )
    return null;
  if (!Array.isArray(row.logs) || row.logs.length > MAX_POOL_RECEIPT_LOGS)
    return null;
  if (
    row.status !== undefined &&
    (typeof row.status !== "string" || !/^0x[0-9a-fA-F]+$/.test(row.status))
  )
    return null;
  if (row.status !== undefined && BigInt(row.status as string) !== 1n)
    return null;
  const logs: ReceiptLogEvidence[] = [];
  for (const raw of row.logs) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.address !== "string" ||
      !ADDRESS.test(item.address) ||
      !Array.isArray(item.topics) ||
      item.topics.some((topicValue) => typeof topicValue !== "string") ||
      typeof item.data !== "string" ||
      !/^0x[0-9a-fA-F]*$/.test(item.data) ||
      typeof item.logIndex !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(item.logIndex) ||
      (item.removed !== undefined && typeof item.removed !== "boolean")
    )
      continue;
    logs.push({
      address: item.address.toLowerCase() as Address,
      topics: item.topics as string[],
      data: item.data,
      logIndex: item.logIndex,
      removed: item.removed === true,
    });
  }
  return {
    transactionHash: row.transactionHash.toLowerCase(),
    blockNumber: row.blockNumber,
    blockHash:
      typeof row.blockHash === "string" && HASH.test(row.blockHash)
        ? row.blockHash.toLowerCase()
        : undefined,
    status: row.status as string | undefined,
    logs,
  };
}

interface PoolPairRead {
  pool: Address | null;
  failed: boolean;
  tokenIndex?: 0 | 1;
  token0?: Address;
  token1?: Address;
}

interface PoolSwapCandidate {
  pool: Address;
  version: UniswapPoolVersion;
  log: ReceiptLogEvidence;
}

type UniswapPoolVersion = "v2" | "v3";

function paddedCallAddress(value: Address): string {
  return value.slice(2).padStart(64, "0");
}

function decodeUintResult(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function decodeSignedResult(value: string): bigint | null {
  const unsigned = decodeUintResult(value);
  if (unsigned === null) return null;
  return unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
}

function swapInputAmount(
  candidate: PoolSwapCandidate,
  tokenIndex: 0 | 1,
): bigint | null {
  const words = candidate.version === "v2" ? 4 : 5;
  const expectedLength = 2 + words * 64;
  if (candidate.log.data.length !== expectedLength) return null;
  const start = 2 + tokenIndex * 64;
  const value = `0x${candidate.log.data.slice(start, start + 64)}`;
  return candidate.version === "v2"
    ? decodeUintResult(value)
    : decodeSignedResult(value);
}

function directPoolOutputs(
  receipt: ReceiptEvidence,
  transfer: Transfer,
  candidates: PoolSwapCandidate[],
  matches: PoolPairRead[],
  directPools: Address[],
): SwapProceeds[] {
  const poolTokens = new Map<Address, CanonicalPoolTokens>();
  const legs: Array<ReceiptSwapRoute["legs"][number]> = [];
  matches.forEach((match, index) => {
    const candidate = candidates[index];
    const pool = match.pool;
    if (
      !pool ||
      !directPools.includes(pool) ||
      match.token0 === undefined ||
      match.token1 === undefined ||
      !candidate
    )
      return;
    poolTokens.set(pool, { token0: match.token0, token1: match.token1 });
    const swapLogIndex = Number.parseInt(candidate.log.logIndex.slice(2), 16);
    if (!Number.isSafeInteger(swapLogIndex)) return;
    let outputRecipient: Address | null = null;
    try {
      if (candidate.log.topics.length >= 3)
        outputRecipient = transferAddress(candidate.log.topics[2]);
    } catch {
      outputRecipient = null;
    }
    legs.push({
      pool,
      version: candidate.version,
      token: transfer.asset.contract as Address,
      poolAmount: transfer.rawAmount,
      swapLogIndex,
      ...(outputRecipient ? { outputRecipient } : {}),
    });
  });
  if (!legs.length) return [];
  const route: ReceiptSwapRoute = {
    transactionHash: receipt.transactionHash as `0x${string}`,
    blockNumber: Number.parseInt(receipt.blockNumber.slice(2), 16),
    legs,
  };
  const swapReceipt: SwapReceipt = {
    transactionHash: route.transactionHash,
    blockNumber: route.blockNumber,
    ...(receipt.blockHash
      ? { blockHash: receipt.blockHash as `0x${string}` }
      : {}),
    status: receipt.status,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: Number.parseInt(log.logIndex.slice(2), 16),
      removed: log.removed,
    })),
  };
  return extractReceiptSwapProceeds(swapReceipt, route, poolTokens);
}

function validAddressResult(value: unknown): Address | null | "failed" {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    return "failed";
  return decodeAddressResult(value);
}

async function poolMatchesAsset(
  rpc: RpcClient,
  pool: Address,
  token: Address,
  version: UniswapPoolVersion,
  blockTag: string,
): Promise<PoolPairRead> {
  try {
    const pairResults = await Promise.all([
      poolRpcRequest(rpc, "eth_call", [
        { to: pool, data: TOKEN0_SELECTOR },
        blockTag,
      ]),
      poolRpcRequest(rpc, "eth_call", [
        { to: pool, data: TOKEN1_SELECTOR },
        blockTag,
      ]),
      ...(version === "v3"
        ? [
            poolRpcRequest(rpc, "eth_call", [
              { to: pool, data: UNISWAP_V3_FEE_SELECTOR },
              blockTag,
            ]),
          ]
        : []),
    ]);
    const token0Result = validAddressResult(pairResults[0]);
    const token1Result = validAddressResult(pairResults[1]);
    if (token0Result === "failed" || token1Result === "failed")
      return { pool: null, failed: true };
    const token0 = token0Result;
    const token1 = token1Result;
    if (!token0 || !token1) return { pool: null, failed: false };
    const normalizedToken = token.toLowerCase();
    if (token0 !== normalizedToken && token1 !== normalizedToken)
      return { pool: null, failed: false };
    const tokenIndex: 0 | 1 = token0 === normalizedToken ? 0 : 1;
    let factoryCall: string;
    let factory: Address;
    if (version === "v2") {
      factory = UNISWAP_V2_FACTORY;
      factoryCall = `${UNISWAP_V2_GET_PAIR_SELECTOR}${paddedCallAddress(token0)}${paddedCallAddress(token1)}`;
    } else {
      const fee = decodeUintResult(pairResults[2]);
      if (fee === null || fee < 1n || fee > 0xffffffn)
        return { pool: null, failed: false };
      factory = UNISWAP_V3_FACTORY;
      factoryCall = `${UNISWAP_V3_GET_POOL_SELECTOR}${paddedCallAddress(token0)}${paddedCallAddress(token1)}${fee.toString(16).padStart(64, "0")}`;
    }
    const canonicalResult = validAddressResult(
      await poolRpcRequest(rpc, "eth_call", [
        { to: factory, data: factoryCall },
        blockTag,
      ]),
    );
    if (canonicalResult === "failed") return { pool: null, failed: true };
    return {
      // The pool is trusted only when the canonical Uniswap factory resolves
      // the exact token pair (and V3 fee tier) back to this address. A swap-
      // shaped event from another venue therefore cannot become a sale alert.
      pool: canonicalResult === pool ? pool : null,
      failed: false,
      tokenIndex,
      token0,
      token1,
    };
  } catch {
    // A failed pair read is unavailable evidence, not proof that this is not
    // a swap. The caller can retry it on a later bounded poll.
    return { pool: null, failed: true };
  }
}

async function readPoolEvidence(
  rpc: RpcClient,
  transfer: Transfer,
): Promise<FastPoolEvidence> {
  const token = transfer.asset.contract;
  if (!token || !ADDRESS.test(token) || !HASH.test(transfer.hash))
    return { pools: [], status: "not-found" };
  const rawReceipt = await poolRpcRequest(rpc, "eth_getTransactionReceipt", [
    transfer.hash,
  ]);
  if (rawReceipt === null)
    throw new PoolEvidenceUnavailableError(
      "transaction receipt is not indexed yet",
    );
  if (
    rawReceipt &&
    typeof rawReceipt === "object" &&
    !Array.isArray(rawReceipt) &&
    typeof (rawReceipt as Record<string, unknown>).status === "string" &&
    /^0x[0-9a-fA-F]+$/.test((rawReceipt as Record<string, string>).status) &&
    BigInt((rawReceipt as Record<string, string>).status) === 0n
  )
    return { pools: [], status: "not-found" };
  const receipt = receiptEvidence(rawReceipt);
  if (!receipt)
    throw new PoolEvidenceUnavailableError(
      "transaction receipt response was unavailable or malformed",
    );
  if (receipt.transactionHash !== transfer.hash.toLowerCase())
    return { pools: [], status: "unavailable" };
  let receiptBlock: number;
  try {
    receiptBlock = Number.parseInt(receipt.blockNumber.slice(2), 16);
  } catch {
    return { pools: [], status: "unavailable" };
  }
  if (
    !Number.isSafeInteger(receiptBlock) ||
    receiptBlock !== transfer.blockNumber
  )
    return { pools: [], status: "unavailable" };
  const normalizedToken = token.toLowerCase();
  const candidates: PoolSwapCandidate[] = [];
  for (const log of receipt.logs) {
    if (log.removed || log.topics.length !== 3) continue;
    const first = log.topics[0]?.toLowerCase();
    const version =
      first === SWAP_V2_TOPIC
        ? ("v2" as const)
        : first === SWAP_V3_TOPIC
          ? ("v3" as const)
          : null;
    if (version && log.data.length === 2 + (version === "v2" ? 4 : 5) * 64)
      candidates.push({
        pool: log.address,
        version,
        log,
      });
  }
  // If the bounded candidate set is exceeded, do not emit a partial pool
  // list that could hide a second hop.
  if (!candidates.length || candidates.length > MAX_POOL_CANDIDATES)
    return { pools: [], status: "not-found" };
  const matches = await mapConcurrent(
    candidates,
    POOL_READ_CONCURRENCY,
    (candidate) =>
      poolMatchesAsset(
        rpc,
        candidate.pool,
        token,
        candidate.version,
        hex(transfer.blockNumber),
      ),
  );
  // A verified pool is still useful if an unrelated swap candidate failed to
  // answer. Only defer when no candidate produced positive evidence at all.
  if (
    !matches.some((match) => match.pool !== null) &&
    matches.some((match) => match.failed)
  )
    throw new PoolEvidenceUnavailableError("pool token pair read unavailable");
  // Deliberately require a direct wallet -> pool token transfer. Router-
  // mediated paths are suppressed until we can prove the wallet leg and the
  // pool leg belong to the same swap. For direct pool sends, require the
  // matching pool Swap input and ordering as well, rather than treating any
  // swap-shaped log in the receipt as proof of a sale.
  const transferIndex = transfer.eventIndex.startsWith("log.")
    ? Number.parseInt(transfer.eventIndex.slice(4), 10)
    : -1;
  if (!Number.isSafeInteger(transferIndex) || !/^\d+$/.test(transfer.rawAmount))
    return { pools: [], status: "not-found" };
  const transferAmount = BigInt(transfer.rawAmount);
  const directPools = [
    ...new Set(
      matches.flatMap((match, index) => {
        const pool = match.pool;
        const candidate = candidates[index];
        if (
          !pool ||
          !candidate ||
          match.tokenIndex === undefined ||
          transfer.to.toLowerCase() !== pool ||
          !/^0x[0-9a-fA-F]+$/.test(candidate.log.logIndex) ||
          Number.parseInt(candidate.log.logIndex.slice(2), 16) <= transferIndex
        )
          return [];
        const swapInput = swapInputAmount(candidate, match.tokenIndex);
        if (
          swapInput === null ||
          swapInput <= 0n ||
          swapInput !== transferAmount
        )
          return [];
        const observed = receipt.logs.some((log) => {
          if (
            log.removed ||
            log.address !== normalizedToken ||
            log.topics.length < 3 ||
            log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
            !/^0x[0-9a-fA-F]{64}$/.test(log.data)
          )
            return false;
          try {
            if (
              transferAddress(log.topics[1]) !== transfer.from.toLowerCase() ||
              transferAddress(log.topics[2]) !== pool ||
              BigInt(log.data) !== transferAmount
            )
              return false;
            return Number.parseInt(log.logIndex.slice(2), 16) === transferIndex;
          } catch {
            return false;
          }
        });
        return observed ? [pool] : [];
      }),
    ),
  ];
  if (!directPools.length) return { pools: [], status: "not-found" };
  const venues: Record<string, "uniswap-v2" | "uniswap-v3"> = {};
  matches.forEach((match, index) => {
    if (match.pool && directPools.includes(match.pool))
      venues[match.pool] =
        candidates[index]?.version === "v3" ? "uniswap-v3" : "uniswap-v2";
  });
  return {
    pools: directPools,
    status: "verified",
    venues,
    poolOutputs: directPoolOutputs(
      receipt,
      transfer,
      candidates,
      matches,
      directPools,
    ),
  };
}

/**
 * Returns only pools proven by this transfer's receipt. The wallet leg must
 * transfer directly to the canonical pool; router-mediated paths are
 * intentionally suppressed until a separate wallet-leg correlation exists.
 * A recipient label or address suffix is never treated as a pool. The result
 * is cached per RPC client, transaction hash and token contract because
 * multiple token legs can share one receipt.
 */
export function detectPoolEvidence(
  rpc: RpcClient,
  transfer: Transfer,
): Promise<FastPoolEvidence> {
  if (rpc.chainId !== CHAIN_ID)
    return Promise.resolve({ pools: [], status: "unavailable" });
  let cache = poolEvidenceCache.get(rpc);
  if (!cache) {
    cache = new Map();
    poolEvidenceCache.set(rpc, cache);
  }
  const key = [
    transfer.hash,
    transfer.asset.contract ?? "native",
    transfer.eventIndex,
    transfer.from,
    transfer.to,
    transfer.rawAmount,
  ]
    .join(":")
    .toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<FastPoolEvidence> => {
    try {
      return await readPoolEvidence(rpc, transfer);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 300);
      process.stderr.write(
        `fast watcher pool evidence unavailable for ${transfer.hash}: ${detail}\n`,
      );
      return { pools: [], status: "unavailable" };
    }
  })();
  cache.set(key, promise);
  void promise.then((result) => {
    // Definitive no-pool results are safe to cache for this transfer. A
    // provider/indexing failure must be retried on a later bounded poll.
    if (result.status === "unavailable" && cache?.get(key) === promise)
      cache.delete(key);
  });
  if (cache.size > MAX_POOL_EVIDENCE_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return promise;
}

export function formatPoolEvidence(
  evidence: FastPoolEvidence | null,
): string | null {
  const pools = [
    ...new Set((evidence?.pools ?? []).filter((pool) => ADDRESS.test(pool))),
  ];
  if (!pools.length) return null;
  const label = pools.length === 1 ? "Pool" : "Pools";
  return `${label}: ${pools.join(", ")}`;
}

export interface FastVerifiedSwapResult {
  flows: FastFlow[];
  evidence: Map<string, FastPoolEvidence>;
  deferred: FastDeferredLog[];
  warnings: string[];
}

function fastPoolEvidenceFromRoute(
  route: UniswapRouteEvidence,
): FastPoolEvidence | null {
  if (route.status !== "verified" || !route.legs.length) return null;
  const pools = [...new Set(route.legs.map((leg) => leg.pool))];
  if (!pools.length) return null;
  const venues: Record<string, "uniswap-v2" | "uniswap-v3"> = {};
  for (const leg of route.legs) venues[leg.pool] = `uniswap-${leg.version}`;
  return {
    pools,
    status: "verified",
    venues,
    ...(route.poolOutputs?.length ? { poolOutputs: route.poolOutputs } : {}),
  };
}

/**
 * The fast feed is a dump feed, not a general transfer feed. A token outflow
 * is alertable only when the same transfer is bound to a receipt-emitted swap
 * event and the swap pool proves that it contains the token being sent.
 *
 * Every input flow has already been marked seen by scanOnce. This filter only
 * decides what may be formatted and queued; omitted transfers therefore still
 * advance the durable cursor without becoming Telegram alerts.
 */
export async function filterVerifiedSwapOutflows(
  flows: FastFlow[],
  rpc: RpcClient,
): Promise<FastVerifiedSwapResult> {
  let suppressedNonOutflow = 0;
  let suppressedNonToken = 0;
  let suppressedUnverified = 0;
  let unavailable = 0;
  const checked = await mapConcurrent(
    flows,
    MAX_RPC_CONCURRENCY,
    async (flow) => {
      if (flow.priority && flow.direction !== "outflow") {
        // Priority contracts are a transfer feed: keep inflows and
        // tracked-wallet movements without trying to classify them as sales.
        return { flow, keep: true, evidence: null, deferred: false };
      }
      if (flow.direction !== "outflow" && !flow.priority) {
        suppressedNonOutflow += 1;
        return { flow, keep: false, evidence: null, deferred: false };
      }
      if (
        flow.transfer.kind !== "erc20" ||
        !flow.transfer.asset.contract ||
        (flow.transfer.to.toLowerCase() === ZERO_ADDRESS && !flow.priority)
      ) {
        suppressedNonToken += 1;
        return { flow, keep: false, evidence: null, deferred: false };
      }
      const recipient = flow.transfer.to.toLowerCase() as Address;
      let evidence: FastPoolEvidence | null;
      let evidenceStatus: FastPoolEvidence["status"];
      if (DEFAULT_UNISWAP_MAINNET_ROUTERS.includes(recipient)) {
        // Router-mediated swaps need the separate receipt correlation: the
        // observed wallet leg, router-to-pool transfer, canonical factory
        // lookup, and matching V2/V3 input amount must all agree.
        const route = await detectUniswapRouteEvidence(rpc, flow.transfer);
        evidence = fastPoolEvidenceFromRoute(route);
        evidenceStatus = route.status;
      } else {
        const direct = await detectPoolEvidence(rpc, flow.transfer);
        evidence = direct.pools.length ? direct : null;
        evidenceStatus = direct.status;
      }
      if (!evidence || !evidence.pools.length) {
        if (flow.priority) {
          // A priority-token outflow must still alert when the recipient is a
          // wallet, protocol, or unsupported venue. Pool evidence only adds
          // a venue label; it is never required for this feed. Preserve the
          // completed check as an empty sentinel so formatting does not issue
          // the same receipt query a second time.
          return {
            flow,
            keep: true,
            evidence: { pools: [], status: evidenceStatus ?? "not-found" },
            deferred: false,
          };
        }
        if (evidenceStatus === "unavailable") unavailable += 1;
        suppressedUnverified += 1;
        return {
          flow,
          keep: false,
          evidence: null,
          deferred: evidenceStatus === "unavailable",
        };
      }
      return { flow, keep: true, evidence, deferred: false };
    },
  );
  const warnings: string[] = [];
  if (suppressedNonOutflow)
    warnings.push(
      `${suppressedNonOutflow} inflow or tracked-wallet transfer(s) suppressed; dump alerts include outflows only.`,
    );
  if (suppressedNonToken)
    warnings.push(
      `${suppressedNonToken} non-token or burn outflow(s) suppressed; dump alerts require ERC-20 transfers.`,
    );
  if (suppressedUnverified)
    warnings.push(
      `${suppressedUnverified} token outflow(s) suppressed because no receipt-verified swap pool was found; no pool was guessed.`,
    );
  if (unavailable)
    warnings.push(
      `${unavailable} token outflow(s) deferred because receipt or pool evidence was unavailable; they will be retried on a later bounded poll.`,
    );
  const evidence = new Map<string, FastPoolEvidence>();
  const deferred = checked
    .filter((item) => item.deferred && item.flow.log)
    .map((item) => ({
      key: deferredKey(item.flow.log as LogRow),
      log: item.flow.log as LogRow,
      attempts: 0,
      reason: "pool" as const,
    }));
  const retained = checked
    .filter((item) => item.keep)
    .map((item) => {
      if (item.evidence !== null)
        evidence.set(item.flow.transfer.id, item.evidence);
      return item.flow;
    });
  return { flows: retained, evidence, deferred, warnings };
}

/** Merge unavailable pool checks into the bounded durable retry queue. */
export function queueDeferredPoolLogs(
  state: FastWatchState,
  deferred: FastDeferredLog[],
): FastWatchState {
  if (!deferred.length) return state;
  const byKey = new Map(state.deferred.map((item) => [item.key, item]));
  for (const item of deferred) {
    const existing = byKey.get(item.key);
    byKey.set(item.key, {
      key: item.key,
      log: item.log,
      attempts: (existing?.attempts ?? 0) + 1,
      reason: "pool",
    });
  }
  const values = [...byKey.values()];
  if (values.length > MAX_DEFERRED)
    process.stderr.write(
      `fast watcher pool retry queue overflow: dropped ${values.length - MAX_DEFERRED} oldest item(s); cap ${MAX_DEFERRED}.\n`,
    );
  return {
    ...state,
    deferred: values.slice(-MAX_DEFERRED),
  };
}

/** Merge unavailable lead checks into the same bounded durable retry queue. */
export function queueDeferredLeadLogs(
  state: FastWatchState,
  deferred: FastDeferredLog[],
): FastWatchState {
  if (!deferred.length) return state;
  const byKey = new Map(state.deferred.map((item) => [item.key, item]));
  for (const item of deferred) {
    const existing = byKey.get(item.key);
    byKey.set(item.key, {
      key: item.key,
      log: item.log,
      attempts: (existing?.attempts ?? 0) + 1,
      reason: "lead",
    });
  }
  const values = [...byKey.values()];
  if (values.length > MAX_DEFERRED)
    process.stderr.write(
      `fast watcher lead retry queue overflow: dropped ${values.length - MAX_DEFERRED} oldest item(s); cap ${MAX_DEFERRED}.\n`,
    );
  return {
    ...state,
    deferred: values.slice(-MAX_DEFERRED),
  };
}

/**
 * Persist seed observations before any background provider work begins. The
 * queue is the restart boundary: an in-flight quote/receipt check may repeat,
 * but it cannot silently consume a cursor observation.
 */
export function queueLeadObservations(
  state: FastWatchState,
  observations: FastLeadObservation[],
): FastWatchState {
  if (!observations.length) return state;
  const byId = new Map(
    (state.leadQueue ?? []).map((observation) => [
      observation.transfer.id,
      observation,
    ]),
  );
  for (const observation of observations)
    byId.set(observation.transfer.id, observation);
  const values = [...byId.values()];
  if (values.length > MAX_LEAD_QUEUE)
    process.stderr.write(
      `fast watcher lead observation queue overflow: dropped ${values.length - MAX_LEAD_QUEUE} oldest item(s); cap ${MAX_LEAD_QUEUE}.\n`,
    );
  return { ...state, leadQueue: values.slice(-MAX_LEAD_QUEUE) };
}

function queueLeadPendingFlows(
  state: FastWatchState,
  flows: FastFlow[],
): FastWatchState {
  if (!flows.length) return state;
  const byId = new Map(
    (state.leadPendingFlows ?? []).map((flow) => [flow.transfer.id, flow]),
  );
  for (const flow of flows) byId.set(flow.transfer.id, flow);
  const values = [...byId.values()];
  if (values.length > MAX_LEAD_QUEUE)
    process.stderr.write(
      `fast watcher lead pending-flow queue overflow: dropped ${values.length - MAX_LEAD_QUEUE} oldest item(s); cap ${MAX_LEAD_QUEUE}.\n`,
    );
  return { ...state, leadPendingFlows: values.slice(-MAX_LEAD_QUEUE) };
}

function leadCatchUpTaskKey(task: FastLeadCatchUpTask): string {
  return task.leads
    .map((lead) => lead.candidate.toLowerCase())
    .sort()
    .join(",");
}

function queueLeadCatchUpTasks(
  state: FastWatchState,
  tasks: FastLeadCatchUpTask[],
): FastWatchState {
  if (!tasks.length) return state;
  const byKey = new Map(
    (state.leadCatchUpTasks ?? []).map((task) => [
      leadCatchUpTaskKey(task),
      task,
    ]),
  );
  for (const task of tasks) byKey.set(leadCatchUpTaskKey(task), task);
  const values = [...byKey.values()];
  if (values.length > MAX_LEAD_CATCH_UP_TASKS)
    process.stderr.write(
      `fast watcher lead catch-up queue overflow: dropped ${values.length - MAX_LEAD_CATCH_UP_TASKS} oldest task(s); cap ${MAX_LEAD_CATCH_UP_TASKS}.\n`,
    );
  return {
    ...state,
    leadCatchUpTasks: values.slice(-MAX_LEAD_CATCH_UP_TASKS),
  };
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function strictAddress(value: string): Address | null {
  return ADDRESS.test(value) ? (value.toLowerCase() as Address) : null;
}

function htmlAddressLink(addressValue: string, baseUrl: string): string | null {
  const normalized = strictAddress(addressValue);
  if (!normalized) return null;
  return `<a href="${baseUrl}${normalized}">${escapeTelegramHtml(normalized)}</a>`;
}

function formatFastUsd(value: string | null): string {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value))
    return "USD unavailable";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `≈$${value}`;
  if (numeric > 0 && numeric < 0.01) return "≈<$0.01";
  const suffix =
    numeric >= 1e9 ? "B" : numeric >= 1e6 ? "M" : numeric >= 1e3 ? "K" : "";
  const divisor =
    suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  return `≈$${(numeric / divisor).toFixed(2)}${suffix}`;
}

/**
 * Legacy copy-button markup remains available for queued messages created by
 * an earlier formatter; new alerts use the strict HTML links below.
 */
export function formatFastReplyMarkup(
  flow: FastFlow,
  poolEvidence: FastPoolEvidence | null,
): FastReplyMarkup | undefined {
  const rows: FastCopyButton[][] = [];
  const wallet = strictAddress(flow.transfer.from);
  if (wallet) rows.push([{ text: "Copy wallet", copy_text: { text: wallet } }]);
  const pools = [
    ...new Set(
      (poolEvidence?.pools ?? [])
        .map((pool) => strictAddress(pool))
        .filter((pool): pool is Address => pool !== null),
    ),
  ];
  pools.forEach((pool, index) =>
    rows.push([
      {
        text: pools.length === 1 ? "Copy pool" : `Copy pool ${index + 1}`,
        copy_text: { text: pool },
      },
    ]),
  );
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * The fast feed uses Telegram HTML only at this final boundary. The shared
 * formatter still owns amounts, rounding, remaining totals and UTC time; its
 * plain text is escaped before it is placed beside evidence-backed links.
 */
export function formatFastTelegramAlert(
  flow: FastFlow,
  valuation: AlertValuation,
  poolEvidence: FastPoolEvidence | null,
  walletStatus: FastWalletStatus = "seed",
  poolOutputs: ValuedSwapProceeds[] = [],
): string {
  const baseLines = escapeTelegramHtml(
    formatTransferAlert(flow.transfer, flow.wallet, valuation, flow.direction),
  ).split("\n");
  const isVerifiedUniswapDump =
    poolEvidence?.status === "verified" &&
    poolEvidence.pools.length > 0 &&
    poolEvidence.pools.every((pool) => {
      const venue = poolEvidence.venues?.[pool.toLowerCase()];
      return venue === "uniswap-v2" || venue === "uniswap-v3";
    });
  const isPriorityBurn =
    flow.priority && flow.transfer.to.toLowerCase() === ZERO_ADDRESS;
  const baseHeading = isPriorityBurn
    ? `🚨 ${escapeTelegramHtml(flow.transfer.asset.symbol)} BURN`
    : isVerifiedUniswapDump
      ? `🚨 ${escapeTelegramHtml(flow.transfer.asset.symbol)} DUMP on Uniswap`
      : (baseLines[0] ?? "🚨 TOKEN OUTFLOW");
  const amount =
    baseLines.find((line) => line.startsWith("Amount:")) ??
    "Amount: unavailable";
  const amountBase = amount.replace(/\s·\s(?:.*\$.*|USD unavailable)$/, "");
  const amountDisplay = isVerifiedUniswapDump
    ? `${amountBase} · ${
        poolOutputs.length === 1
          ? formatFastUsd(poolOutputs[0].valueUsd)
          : "USD unavailable"
      }`
    : amount;
  const remaining =
    baseLines.find((line) => line.startsWith("Remaining:")) ??
    "Remaining: unavailable";
  const remainingDisplay = remaining;
  const timestamp =
    baseLines.find((line) => line.startsWith("🕒")) ?? "🕒 unavailable";
  const from =
    htmlAddressLink(flow.transfer.from, "https://etherscan.io/address/") ??
    "unavailable";
  const pools = [
    ...new Set(
      (poolEvidence?.pools ?? [])
        .map((poolAddress) => {
          const link = htmlAddressLink(
            poolAddress,
            "https://dexscreener.com/ethereum/",
          );
          if (!link) return null;
          const venue = poolEvidence?.venues?.[poolAddress.toLowerCase()];
          const label =
            venue === "uniswap-v2"
              ? "Uniswap V2"
              : venue === "uniswap-v3"
                ? "Uniswap V3"
                : null;
          return label ? `${label} · ${link}` : link;
        })
        .filter((pool): pool is string => pool !== null),
    ),
  ];
  const recipient =
    htmlAddressLink(flow.transfer.to, "https://etherscan.io/address/") ??
    "unavailable";
  const to = pools.length ? pools.join(", ") : recipient;
  return [
    baseHeading,
    "",
    `From: ${from}`,
    ...(walletStatus === "unconfirmed" ? ["Linked wallet: unconfirmed"] : []),
    amountDisplay,
    "",
    `To: ${to}`,
    "",
    remainingDisplay,
    "",
    timestamp,
  ].join("\n");
}

export async function filterStandaloneInflows(
  flows: FastFlow[],
  rpc: RpcClient,
): Promise<{ flows: FastFlow[]; warnings: string[] }> {
  const outgoingByHash = new Map<string, FastFlow[]>();
  for (const flow of flows) {
    if (flow.direction !== "outflow") continue;
    const key = flow.transfer.hash.toLowerCase();
    const rows = outgoingByHash.get(key) ?? [];
    rows.push(flow);
    outgoingByHash.set(key, rows);
  }
  const evidence = new Map<string, Promise<NativeTransactionEvidence>>();
  let pairedSuppressed = 0;
  let nativeSuppressed = 0;
  let unavailableSuppressed = 0;
  const filtered = await mapConcurrent(
    flows,
    MAX_RPC_CONCURRENCY,
    async (flow) => {
      if (flow.direction !== "inflow") return { flow, keep: true };
      const hash = flow.transfer.hash.toLowerCase();
      const paired = (outgoingByHash.get(hash) ?? []).some(
        (other) =>
          other.transfer.asset.contract?.toLowerCase() !==
          flow.transfer.asset.contract?.toLowerCase(),
      );
      if (paired) {
        pairedSuppressed += 1;
        return { flow, keep: false };
      }
      let transactionPromise = evidence.get(hash);
      if (!transactionPromise) {
        transactionPromise = readNativeTransactionEvidence(rpc, hash);
        evidence.set(hash, transactionPromise);
      }
      const transaction = await transactionPromise;
      if (!transaction.available) {
        unavailableSuppressed += 1;
        return { flow, keep: false };
      }
      if (
        transaction.from === flow.wallet.toLowerCase() &&
        transaction.value !== undefined &&
        transaction.value > 0n
      ) {
        nativeSuppressed += 1;
        return { flow, keep: false };
      }
      return { flow, keep: true };
    },
  );
  const warnings: string[] = [];
  if (pairedSuppressed)
    warnings.push(
      `${pairedSuppressed} same-transaction ERC-20 inflow(s) suppressed as swap legs.`,
    );
  if (nativeSuppressed)
    warnings.push(
      `${nativeSuppressed} ERC-20 inflow(s) suppressed because the transaction carried native ETH from a watched wallet.`,
    );
  if (unavailableSuppressed)
    warnings.push(
      `${unavailableSuppressed} ERC-20 inflow(s) omitted because native-leg transaction evidence was unavailable.`,
    );
  return {
    flows: filtered.filter((item) => item.keep).map((item) => item.flow),
    warnings,
  };
}

class TokenMetadataUnavailableError extends Error {
  readonly tokenAddress: Address;

  constructor(tokenAddress: Address) {
    super(`Token metadata unavailable for ${tokenAddress}`);
    this.name = "TokenMetadataUnavailableError";
    this.tokenAddress = tokenAddress;
  }
}

async function transferFromLog(
  rpc: RpcClient,
  log: LogRow,
  metadata: Map<string, Promise<{ symbol: string; decimals: number } | null>>,
  timestamps: Map<number, Promise<number>>,
): Promise<Transfer | null> {
  if (!HASH.test(log.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(log.data))
    return null;
  const tokenAddress = log.address;
  let meta = metadata.get(tokenAddress);
  if (!meta) {
    meta = Promise.all([
      rpc.request("eth_call", [
        { to: tokenAddress, data: "0x95d89b41" },
        "latest",
      ]),
      rpc.request("eth_call", [
        { to: tokenAddress, data: "0x313ce567" },
        "latest",
      ]),
    ])
      .then(([symbolRaw, decimalsRaw]) => {
        const symbol = metadataString(symbolRaw);
        const decimals =
          typeof decimalsRaw === "string" &&
          /^0x[0-9a-fA-F]{64}$/.test(decimalsRaw)
            ? Number(BigInt(decimalsRaw))
            : -1;
        return symbol &&
          Number.isInteger(decimals) &&
          decimals >= 0 &&
          decimals <= 255
          ? { symbol, decimals }
          : null;
      })
      .catch(() => null);
    metadata.set(tokenAddress, meta);
  }
  const details = await meta;
  if (!details) throw new TokenMetadataUnavailableError(tokenAddress);
  const blockNumber = parsedHex(log.blockNumber, "log block number");
  let timestamp = timestamps.get(blockNumber);
  if (!timestamp) {
    timestamp = header(rpc, blockNumber).then((item) => item.timestamp);
    timestamps.set(blockNumber, timestamp);
  }
  const from = transferAddress(log.topics[1]);
  const to = transferAddress(log.topics[2]);
  const asset: Asset = {
    chainId: CHAIN_ID,
    symbol: details.symbol,
    decimals: details.decimals,
    contract: tokenAddress,
  };
  return {
    id: `${CHAIN_ID}:${log.transactionHash.toLowerCase()}:erc20:${parsedHex(log.logIndex, "log index")}:${tokenAddress}`,
    chainId: CHAIN_ID,
    hash: log.transactionHash.toLowerCase(),
    kind: "erc20",
    eventIndex: `log.${parsedHex(log.logIndex, "log index")}`,
    from,
    to,
    asset,
    rawAmount: BigInt(log.data).toString(),
    timestamp: new Date((await timestamp) * 1000).toISOString(),
    blockNumber,
    status: "success",
    source: "PublicNode Ethereum RPC eth_getLogs",
    retrievedAt: new Date().toISOString(),
  };
}

export interface FastDiscoveryResult {
  tokens: Address[];
  requestedWallets: number;
  succeededWallets: number;
  failedWallets: number;
}

export interface FastDiscoveryOptions {
  fetchWallet?: (wallet: Address) => Promise<WalletValuationSnapshot>;
  concurrency?: number;
  spacingMs?: number;
}

export async function discoverTokenAddressesDetailed(
  addressesToScan: Address[],
  options: FastDiscoveryOptions = {},
): Promise<FastDiscoveryResult> {
  const seen = new Set<Address>();
  const fetchWallet = options.fetchWallet ?? fetchWalletValuation;
  const snapshots = await mapPacedConcurrent(
    addressesToScan,
    options.concurrency ?? DISCOVERY_CONCURRENCY,
    options.spacingMs ?? DISCOVERY_SPACING_MS,
    async (wallet) => {
      try {
        return await fetchWallet(wallet);
      } catch {
        return null;
      }
    },
  );
  let succeeded = 0;
  for (const result of snapshots) {
    if (result) succeeded += 1;
    if (result)
      for (const token of result.tokens)
        if (token.contract) seen.add(token.contract.toLowerCase() as Address);
  }
  if (!succeeded)
    throw new Error("ERC-20 discovery failed for every watched wallet");
  return {
    tokens: [...seen].slice(0, MAX_TOKENS),
    requestedWallets: addressesToScan.length,
    succeededWallets: succeeded,
    failedWallets: addressesToScan.length - succeeded,
  };
}

export async function discoverTokenAddresses(
  addressesToScan: Address[],
): Promise<Address[]> {
  return (await discoverTokenAddressesDetailed(addressesToScan)).tokens;
}

interface FastLeadDiscoveryResult {
  state: WalletLeadState;
  added: WalletLeadState["leads"];
  skipped: number;
  retryObservations: FastLeadObservation[];
}

function leadSourcesForDiscovery(
  config: FastWatchConfig,
  state: FastWatchState,
): WalletLeadSource[] {
  const sources = new Map<Address, WalletLeadSource>();
  for (const seed of config.addresses)
    sources.set(seed, { address: seed, generation: 0, seed });
  for (const lead of state.walletLeads?.leads ?? []) {
    const source = lead.source ?? lead.seed;
    const generation = lead.generation ?? 1;
    if (generation > MAX_LEAD_GENERATIONS) continue;
    sources.set(lead.candidate, {
      address: lead.candidate,
      generation,
      seed: lead.seed,
    });
    // A legacy lead may not retain its source edge. Its configured seed is
    // still the safest bounded provenance root for the next observation.
    if (!sources.has(source))
      sources.set(source, {
        address: source,
        generation: Math.max(0, generation - 1),
        seed: lead.seed,
      });
  }
  return [...sources.values()];
}

async function discoverFastWalletLeads(
  config: FastWatchConfig,
  rpc: RpcClient,
  state: FastWatchState,
  observations: Array<{ transfer: Transfer; log?: LogRow }>,
): Promise<FastLeadDiscoveryResult> {
  const unique = [
    ...new Map(
      observations.map((observation) => [observation.transfer.id, observation]),
    ).values(),
  ];
  if (!unique.length)
    return {
      state: state.walletLeads ?? { version: 1, leads: [] },
      added: [],
      skipped: 0,
      retryObservations: [],
    };
  const leadState = state.walletLeads ?? { version: 1, leads: [] };
  const result = await discoverWalletLeads({
    seeds: config.addresses,
    sources: leadSourcesForDiscovery(config, state),
    maxGenerations: MAX_LEAD_GENERATIONS,
    excluded: LEAD_EXCLUDED_ADDRESSES,
    transfers: unique.map(({ transfer }) => transfer),
    rpc,
    state: leadState,
    maxCandidates: MAX_DYNAMIC_LEADS,
    maxNewPerCycle: MAX_NEW_LEADS_PER_CYCLE,
  });
  // Retryability is a separate full-ID channel; the human-facing skip list
  // is intentionally capped and must never drive durable retries.
  const retryEventIds = new Set(result.retryable.map((item) => item.eventId));
  return {
    state: result.state,
    added: result.added,
    skipped: result.skipped.length,
    retryObservations: unique.filter(({ transfer }) =>
      retryEventIds.has(transfer.id),
    ),
  };
}

export async function scanOnce(
  config: FastWatchConfig,
  rpc: RpcClient,
  previous: FastWatchState,
  tokenAddresses: Address[],
  dynamicAddresses: Address[] = [],
  replayFromBlock?: number,
  replayTarget?: number,
): Promise<FastScanResult> {
  const state = normalizeState(previous);
  // Priority contracts are always included in the log query, even when a
  // balance snapshot has not discovered them yet.
  tokenAddresses = [
    ...new Set([...(config.priorityTokenAddresses ?? []), ...tokenAddresses]),
  ].slice(0, MAX_TOKENS);
  if (!tokenAddresses.length)
    throw new Error(
      "No ERC-20 token contracts discovered; fast watcher coverage is empty",
    );
  const seedWallets = new Set(
    config.addresses.map((item) => item.toLowerCase()),
  );
  const wallets = new Set(
    [...config.addresses, ...dynamicAddresses].map((item) =>
      item.toLowerCase(),
    ),
  );
  const priorityTokens = new Set(
    (config.priorityTokenAddresses ?? []).map((item) => item.toLowerCase()),
  );
  const head = parsedHex(
    await rpc.request("eth_blockNumber", []),
    "chain head",
  );
  const chainTarget = head - config.confirmations;
  const target =
    replayTarget === undefined
      ? chainTarget
      : Math.min(chainTarget, replayTarget);
  if (!state.bootstrapped) {
    const targetHeader = await header(rpc, target);
    return {
      state: {
        ...state,
        bootstrapped: true,
        lastBlock: target,
        lastHash: targetHeader.hash,
        tokens: tokenAddresses,
      },
      flows: [],
      warnings: [
        `Fast watcher baseline set at observation block ${target}; earlier events were not replayed.`,
        `Coverage is limited to ${tokenAddresses.length} discovered ERC-20 contracts.`,
      ],
      head,
      target,
      leadTransfers: [],
      leadObservations: [],
    };
  }
  if (state.lastBlock === null || !state.lastHash)
    throw new Error("Fast watcher cursor is incomplete");
  if (
    target <= state.lastBlock &&
    state.deferred.length === 0 &&
    replayFromBlock === undefined
  )
    return {
      state,
      flows: [],
      warnings: [],
      head,
      target,
      leadTransfers: [],
      leadObservations: [],
    };
  const warnings: string[] = [];
  let fromBlock = state.lastBlock + 1;
  let outLogs: LogRow[] = [];
  let inLogs: LogRow[] = [];
  if (replayFromBlock !== undefined) {
    if (
      !Number.isSafeInteger(replayFromBlock) ||
      replayFromBlock < 0 ||
      replayFromBlock > target
    )
      throw new Error("Fast watcher replay block is outside the target range");
    fromBlock = replayFromBlock;
  }
  if (target > state.lastBlock || replayFromBlock !== undefined) {
    // Explicit lead catch-up may cover several bounded blocks. The caller
    // scopes the range to the configured replay window and filters activity
    // before each lead's funding event; do not turn that range into one RPC
    // request per block.
    const previousHeader = await header(rpc, state.lastBlock);
    if (
      target > state.lastBlock &&
      previousHeader.hash.toLowerCase() !== state.lastHash.toLowerCase()
    ) {
      if (replayFromBlock === undefined) {
        fromBlock = Math.max(0, state.lastBlock - 6);
        warnings.push(
          `Reorg detected near block ${state.lastBlock}; rescanning from ${fromBlock}. Previously delivered alerts cannot be retracted, so this feed is observed rather than final.`,
        );
      } else {
        warnings.push(
          `Reorg detected near block ${state.lastBlock}; preserving explicit replay window from ${fromBlock} to ${target}. Previously delivered alerts cannot be retracted, so this feed is observed rather than final.`,
        );
      }
    }
    if (target - fromBlock + 1 > config.maxBlockSpan) {
      const skippedTo = target - config.maxBlockSpan;
      warnings.push(
        `Fast watcher gap: blocks ${fromBlock}-${skippedTo} were outside the bounded scan window.`,
      );
      fromBlock = skippedTo + 1;
    }
    const trackedAddresses = [...wallets] as Address[];
    [outLogs, inLogs] = await Promise.all([
      fetchLogs(rpc, fromBlock, target, tokenAddresses, trackedAddresses, 1),
      fetchLogs(rpc, fromBlock, target, tokenAddresses, trackedAddresses, 2),
    ]);
  }
  const unique = new Map<string, LogRow>();
  for (const deferred of state.deferred)
    if (!deferred.log.removed) unique.set(deferred.key, deferred.log);
  for (const log of [...outLogs, ...inLogs]) {
    if (log.removed) {
      warnings.push(
        `Removed log observed in block ${parsedHex(log.blockNumber, "log block number")}.`,
      );
      continue;
    }
    unique.set(deferredKey(log), log);
  }
  const metadata = new Map<
    string,
    Promise<{ symbol: string; decimals: number } | null>
  >();
  const timestamps = new Map<number, Promise<number>>();
  const parsed = await mapConcurrent(
    [...unique.entries()],
    MAX_RPC_CONCURRENCY,
    async ([key, log]) => {
      try {
        return {
          key,
          log,
          transfer: await transferFromLog(rpc, log, metadata, timestamps),
          deferred: false,
        };
      } catch (error) {
        if (!(error instanceof TokenMetadataUnavailableError)) throw error;
        return { key, log, transfer: null, deferred: true };
      }
    },
  );
  const deferredByKey = new Map(state.deferred.map((item) => [item.key, item]));
  for (const item of parsed) {
    if (item.deferred) {
      const previousDeferred = deferredByKey.get(item.key);
      deferredByKey.set(item.key, {
        key: item.key,
        log: item.log,
        attempts: (previousDeferred?.attempts ?? 0) + 1,
        reason: "metadata",
      });
    } else {
      deferredByKey.delete(item.key);
    }
  }
  let deferred = [...deferredByKey.values()];
  if (deferred.length > MAX_DEFERRED) {
    warnings.push(
      `Deferred metadata queue exceeded ${MAX_DEFERRED} logs; oldest deferred logs were dropped.`,
    );
    deferred = deferred.slice(-MAX_DEFERRED);
  }
  const metadataDeferred = deferred.filter(
    (item) => item.reason !== "pool" && item.reason !== "lead",
  );
  if (metadataDeferred.length)
    warnings.push(
      `${metadataDeferred.length} ERC-20 log(s) deferred because token metadata is unavailable; cursor advanced safely.`,
    );
  const deferredKeys = new Set(state.deferred.map((item) => item.key));
  const transfers = parsed
    .filter(
      (item): item is typeof item & { transfer: Transfer } =>
        item.transfer !== null,
    )
    .map((item) => ({ key: item.key, log: item.log, transfer: item.transfer }));
  const seen = new Set(state.seen);
  const flows: FastFlow[] = [];
  const leadTransfers: Transfer[] = [];
  const leadObservations: Array<{ transfer: Transfer; log: LogRow }> = [];
  let staleCount = 0;
  for (const item of transfers) {
    const transfer = item.transfer;
    const priority =
      transfer.kind === "erc20" &&
      transfer.asset.contract !== null &&
      priorityTokens.has(transfer.asset.contract.toLowerCase());
    if (
      transfer.kind === "erc20" &&
      wallets.has(transfer.from.toLowerCase()) &&
      !wallets.has(transfer.to.toLowerCase()) &&
      transfer.to.toLowerCase() !== ZERO_ADDRESS
    ) {
      // Preserve the old root-only metric for callers while queueing every
      // tracked-wallet edge for bounded multi-generation discovery.
      if (seedWallets.has(transfer.from.toLowerCase()))
        leadTransfers.push(transfer);
      leadObservations.push({ transfer, log: item.log });
    }
    if (seen.has(transfer.id) && !deferredKeys.has(item.key)) continue;
    const fromWallet = wallets.has(transfer.from.toLowerCase());
    const toWallet = wallets.has(transfer.to.toLowerCase());
    if (!fromWallet && !toWallet) continue;
    if (fromWallet && toWallet && !priority) {
      // Transfers between any two tracked wallets are internal bookkeeping,
      // not an external dump. Mark the log seen so it cannot be re-alerted.
      seen.add(transfer.id);
      continue;
    }
    if (
      transfer.kind === "erc20" &&
      transfer.to.toLowerCase() === ZERO_ADDRESS &&
      !priority
    ) {
      seen.add(transfer.id);
      continue;
    }
    const direction: FastFlow["direction"] =
      fromWallet && toWallet ? "self" : fromWallet ? "outflow" : "inflow";
    seen.add(transfer.id);
    const age = Date.now() - Date.parse(transfer.timestamp);
    if (age > MAX_ALERT_AGE_MS) {
      staleCount += 1;
      continue;
    }
    flows.push({
      wallet: (fromWallet
        ? transfer.from
        : transfer.to
      ).toLowerCase() as Address,
      transfer,
      direction,
      log: item.log,
      ...(priority ? { priority: true } : {}),
    });
  }
  if (staleCount)
    warnings.push(
      replayFromBlock === undefined
        ? `${staleCount} stale transfer(s) were marked seen but not alerted; freshness is limited to ${Math.floor(MAX_ALERT_AGE_MS / 1000)} seconds.`
        : `Lead catch-up coverage gap: ${staleCount} stale transfer(s) were marked seen but not alerted; freshness is limited to ${Math.floor(MAX_ALERT_AGE_MS / 1000)} seconds.`,
    );
  const finalHeader =
    target > state.lastBlock ? await header(rpc, target) : null;
  return {
    state: {
      ...state,
      lastBlock: finalHeader?.number ?? state.lastBlock,
      lastHash: finalHeader?.hash ?? state.lastHash,
      tokens: tokenAddresses,
      seen: [...seen].slice(-MAX_SEEN),
      deferred,
    },
    flows: flows.sort(
      (left, right) => left.transfer.blockNumber - right.transfer.blockNumber,
    ),
    warnings: [...new Set(warnings)],
    head,
    target,
    leadTransfers,
    leadObservations,
  };
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: FastReplyMarkup,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        ...buildTelegramPayload(text, replyMarkup),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const body = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };
  if (!body.ok)
    throw new Error(
      `Telegram rejected message: ${body.description ?? "unknown error"}`,
    );
}

export function buildTelegramPayload(
  text: string,
  replyMarkup?: FastReplyMarkup,
): {
  text: string;
  parse_mode: "HTML";
  disable_web_page_preview: true;
  reply_markup?: FastReplyMarkup;
} {
  return {
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
}

async function readFastEntityTotal(
  reader: EntityTokenBalanceReader,
  wallets: Address[],
  flow: FastFlow,
): Promise<FastEntityTotal> {
  const contract = flow.transfer.asset.contract;
  if (!contract)
    return {
      status: "unavailable",
      amount: null,
      symbol: flow.transfer.asset.symbol,
      rawBalance: null,
      decimals: flow.transfer.asset.decimals,
      usd: null,
    };
  try {
    const result = await reader.read({
      wallets,
      tokens: [
        {
          contract,
          ...(/^[\x20-\x7e]+$/.test(flow.transfer.asset.symbol)
            ? { symbol: flow.transfer.asset.symbol }
            : {}),
          decimals: flow.transfer.asset.decimals,
        },
      ],
    });
    const item = result.tokens[0];
    const complete =
      result.coverage.complete &&
      item?.amount !== null &&
      item?.amount !== undefined &&
      item.rawBalance !== null &&
      item.rawBalance !== undefined;
    return {
      status: complete
        ? "complete"
        : result.coverage.status === "partial"
          ? "partial"
          : "unavailable",
      amount: complete ? item.amount : null,
      symbol: flow.transfer.asset.symbol,
      rawBalance: complete ? item.rawBalance : null,
      decimals: flow.transfer.asset.decimals,
      usd: null,
    };
  } catch {
    return {
      status: "unavailable",
      amount: null,
      symbol: flow.transfer.asset.symbol,
      rawBalance: null,
      decimals: flow.transfer.asset.decimals,
      usd: null,
    };
  }
}

async function valueFastPoolOutputs(
  flow: FastFlow,
  outputs: SwapProceeds[],
  inputQuote: string | null,
): Promise<ValuedSwapProceeds[]> {
  // A receipt can contain several pool legs, but without a downstream join we
  // cannot safely call one of them the final proceeds. Keep the alert explicit
  // rather than displaying an intermediate or ambiguous amount.
  if (outputs.length !== 1) return [];
  const outputQuoteCache = new Map<string, Promise<TokenQuote | null>>();
  const observedAt = new Date().toISOString();
  const valued = await mapConcurrent(
    outputs,
    MAX_POOL_RPC_CONCURRENCY,
    async (proceeds): Promise<ValuedSwapProceeds | null> => {
      const outputToken = proceeds.outputToken.toLowerCase() as Address;
      const inputToken = flow.transfer.asset.contract?.toLowerCase();
      let asset: { contract: Address; symbol: string; decimals: number };
      let quote: TokenQuote;
      if (inputToken && inputToken === outputToken) {
        asset = {
          contract: outputToken,
          symbol: flow.transfer.asset.symbol,
          decimals: flow.transfer.asset.decimals,
        };
        quote = {
          contract: outputToken,
          symbol: asset.symbol,
          decimals: asset.decimals,
          usd: inputQuote,
        };
      } else {
        let pending = outputQuoteCache.get(outputToken);
        if (!pending) {
          pending = Promise.race<TokenQuote | null>([
            fetchTokenQuote(outputToken).catch(() => null),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), POOL_OUTPUT_QUOTE_TIMEOUT_MS),
            ),
          ]);
          outputQuoteCache.set(outputToken, pending);
        }
        const fetched = await pending;
        if (!fetched) return null;
        asset = {
          contract: fetched.contract,
          symbol: fetched.symbol,
          decimals: fetched.decimals,
        };
        quote = fetched;
      }
      try {
        return valueSwapProceeds(proceeds, asset, {
          contract: quote.contract,
          usdPerToken: quote.usd,
          scope: "spot-indicative",
          observedAt,
          source: "Blockscout current token quote",
        });
      } catch {
        return null;
      }
    },
  );
  return valued.filter((item): item is ValuedSwapProceeds => item !== null);
}

export async function formatFastFlow(
  flow: FastFlow,
  rpc: RpcClient,
  quoteCache: Map<string, Promise<string | null>>,
  entityReader: EntityTokenBalanceReader | null,
  entityAddresses: Address[],
  verifiedEvidence?: FastPoolEvidence,
  walletStatus: FastWalletStatus = "seed",
): Promise<FastFormattedAlert> {
  const contract = flow.transfer.asset.contract;
  let quote: string | null = null;
  let entityTotal: FastEntityTotal | null = null;
  let poolEvidence: FastPoolEvidence | null = null;
  let valuedPoolOutputs: ValuedSwapProceeds[] = [];
  if (contract) {
    const key = contract.toLowerCase();
    let quotePromise = quoteCache.get(key);
    if (!quotePromise) {
      quotePromise = Promise.race<string | null>([
        fetchTokenQuote(contract)
          .then((value) => value.usd)
          .catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), INPUT_QUOTE_TIMEOUT_MS),
        ),
      ]);
      quoteCache.set(key, quotePromise);
    }
    const entityPromise =
      entityReader && entityAddresses.length
        ? Promise.race<FastEntityTotal>([
            readFastEntityTotal(entityReader, entityAddresses, flow),
            new Promise<FastEntityTotal>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    status: "unavailable",
                    amount: null,
                    symbol: flow.transfer.asset.symbol,
                    rawBalance: null,
                    decimals: flow.transfer.asset.decimals,
                    usd: null,
                  }),
                ENTITY_TOTAL_TIMEOUT_MS,
              ),
            ),
          ])
        : Promise.resolve(null);
    [quote, entityTotal, poolEvidence] = await Promise.all([
      quotePromise,
      entityPromise,
      verifiedEvidence
        ? Promise.resolve(verifiedEvidence)
        : flow.priority && flow.direction !== "outflow"
          ? Promise.resolve<FastPoolEvidence | null>(null)
          : DEFAULT_UNISWAP_MAINNET_ROUTERS.includes(
                flow.transfer.to.toLowerCase() as Address,
              )
            ? detectUniswapRouteEvidence(rpc, flow.transfer).then(
                fastPoolEvidenceFromRoute,
              )
            : detectPoolEvidence(rpc, flow.transfer),
    ]);
    if (poolEvidence?.poolOutputs?.length)
      valuedPoolOutputs = await valueFastPoolOutputs(
        flow,
        poolEvidence.poolOutputs,
        quote,
      );
  }
  if (
    entityTotal?.status === "complete" &&
    entityTotal.rawBalance !== null &&
    quote !== null
  ) {
    entityTotal = {
      ...entityTotal,
      usd: decimalProduct(entityTotal.rawBalance, entityTotal.decimals, quote),
    };
  }
  const valuation: AlertValuation = {
    approxUsd: quote
      ? decimalProduct(
          flow.transfer.rawAmount,
          flow.transfer.asset.decimals,
          quote,
        )
      : null,
    remainingAmount: null,
    remainingSymbol: null,
    remainingUsd: null,
    ...(entityTotal
      ? {
          trackedEthereumTotal: {
            status: entityTotal.status,
            amount: entityTotal.amount,
            symbol: entityTotal.symbol,
            usd: entityTotal.usd,
          },
        }
      : {}),
    totalPricedUsd: "unavailable",
    pricedAssets: 0,
    unpricedAssets: 0,
  };
  return {
    text: formatFastTelegramAlert(
      flow,
      valuation,
      poolEvidence,
      walletStatus,
      valuedPoolOutputs,
    ),
    approxUsd: valuation.approxUsd,
  };
}

interface LeadEventPosition {
  kind: "erc20" | "native";
  index: number;
}

function transferEventPosition(eventIndex: string): LeadEventPosition | null {
  const match = /^(log|tx)\.(\d+)$/.exec(eventIndex);
  if (!match) return null;
  const value = Number(match[2]);
  return Number.isSafeInteger(value)
    ? { kind: match[1] === "log" ? "erc20" : "native", index: value }
    : null;
}

function leadActivationEventPosition(
  eventId: string,
): LeadEventPosition | null {
  const parts = eventId.split(":");
  if (
    parts.length < 4 ||
    (parts[2] !== "erc20" && parts[2] !== "native") ||
    !/^\d+$/.test(parts[3])
  )
    return null;
  const value = Number(parts[3]);
  return Number.isSafeInteger(value) ? { kind: parts[2], index: value } : null;
}

function leadCandidatesForTransfer(
  transfer: Pick<Transfer, "from" | "to">,
  byCandidate: Map<string, WalletLeadState["leads"][number]>,
  includeRecipient = false,
): WalletLeadState["leads"][number][] {
  const candidates = [
    byCandidate.get(transfer.from.toLowerCase()),
    ...(includeRecipient ? [byCandidate.get(transfer.to.toLowerCase())] : []),
  ].filter(
    (lead): lead is WalletLeadState["leads"][number] => lead !== undefined,
  );
  return [
    ...new Map(
      candidates.map((lead) => [lead.candidate.toLowerCase(), lead]),
    ).values(),
  ];
}

function isAfterLeadActivation(
  transfer: Pick<Transfer, "blockNumber" | "eventIndex">,
  log: LogRow | undefined,
  lead: WalletLeadState["leads"][number],
): boolean {
  if (transfer.blockNumber > lead.blockNumber) return true;
  if (transfer.blockNumber < lead.blockNumber) return false;
  const activation = leadActivationEventPosition(lead.eventId);
  const flowPosition = transferEventPosition(transfer.eventIndex);
  if (!activation || !flowPosition) return false;
  const flowTransactionIndex = log?.transactionIndex;
  if (activation.kind === "erc20" && flowPosition.kind === "erc20") {
    const parsedFlowTransactionIndex =
      flowTransactionIndex && /^0x[0-9a-fA-F]+$/.test(flowTransactionIndex)
        ? parsedHex(flowTransactionIndex, "log transaction index")
        : null;
    if (
      lead.transactionIndex !== undefined ||
      parsedFlowTransactionIndex !== null
    ) {
      if (
        lead.transactionIndex === undefined ||
        parsedFlowTransactionIndex === null
      )
        return false;
      if (parsedFlowTransactionIndex !== lead.transactionIndex)
        return parsedFlowTransactionIndex > lead.transactionIndex;
    }
    return flowPosition.index > activation.index;
  }
  if (activation.kind === flowPosition.kind)
    return flowPosition.index > activation.index;
  // A native funding transaction can precede an ERC-20 log in the same
  // block. eth_getLogs exposes transactionIndex on compliant providers;
  // without it, retain the replay window instead of guessing.
  if (activation.kind === "native" && flowPosition.kind === "erc20") {
    if (!flowTransactionIndex || !/^0x[0-9a-fA-F]+$/.test(flowTransactionIndex))
      return false;
    return (
      parsedHex(flowTransactionIndex, "log transaction index") >
      activation.index
    );
  }
  return false;
}

/**
 * Keep only activity from a newly discovered lead after its seed funding.
 * Same-block ordering is strict: an event before or at the funding log cannot
 * be attributed to the lead. Unknown ordering is rejected rather than guessed.
 */
export function filterLeadCatchUpFlows(
  flows: FastFlow[],
  leads: WalletLeadState["leads"],
): FastFlow[] {
  const byCandidate = new Map(
    leads.map((lead) => [lead.candidate.toLowerCase(), lead]),
  );
  return flows.filter((flow) =>
    leadCandidatesForTransfer(flow.transfer, byCandidate, flow.priority).some(
      (lead) => isAfterLeadActivation(flow.transfer, flow.log, lead),
    ),
  );
}

/** Keep descendant lead observations in the same post-funding window as flows. */
export function filterLeadCatchUpObservations(
  observations: FastLeadObservation[],
  leads: WalletLeadState["leads"],
): FastLeadObservation[] {
  const byCandidate = new Map(
    leads.map((lead) => [lead.candidate.toLowerCase(), lead]),
  );
  return observations.filter((observation) =>
    leadCandidatesForTransfer(observation.transfer, byCandidate).some((lead) =>
      isAfterLeadActivation(observation.transfer, observation.log, lead),
    ),
  );
}

function hasUnknownNativeFundingOrdering(
  flows: FastFlow[],
  leads: WalletLeadState["leads"],
): boolean {
  const byCandidate = new Map(
    leads.map((lead) => [lead.candidate.toLowerCase(), lead]),
  );
  return flows.some((flow) => {
    return leadCandidatesForTransfer(
      flow.transfer,
      byCandidate,
      flow.priority,
    ).some((lead) => {
      if (flow.transfer.blockNumber !== lead.blockNumber) return false;
      const activation = leadActivationEventPosition(lead.eventId);
      const transfer = transferEventPosition(flow.transfer.eventIndex);
      return (
        activation?.kind === "native" &&
        transfer?.kind === "erc20" &&
        (!flow.log?.transactionIndex ||
          !/^0x[0-9a-fA-F]+$/.test(flow.log.transactionIndex))
      );
    });
  });
}

function hasUnknownNativeFundingObservationOrdering(
  observations: FastLeadObservation[],
  leads: WalletLeadState["leads"],
): boolean {
  const byCandidate = new Map(
    leads.map((lead) => [lead.candidate.toLowerCase(), lead]),
  );
  return observations.some((observation) => {
    return leadCandidatesForTransfer(observation.transfer, byCandidate).some(
      (lead) => {
        if (observation.transfer.blockNumber !== lead.blockNumber) return false;
        const activation = leadActivationEventPosition(lead.eventId);
        const transfer = transferEventPosition(observation.transfer.eventIndex);
        return (
          activation?.kind === "native" &&
          transfer?.kind === "erc20" &&
          (!observation.log?.transactionIndex ||
            !/^0x[0-9a-fA-F]+$/.test(observation.log.transactionIndex))
        );
      },
    );
  });
}

function nativeTrackedAddresses(
  config: FastWatchConfig,
  state: FastWatchState,
): Address[] {
  return [
    ...new Set([
      ...config.addresses,
      ...(state.walletLeads?.leads ?? []).map((lead) => lead.candidate),
    ]),
  ].slice(0, MAX_WALLETS + MAX_DYNAMIC_LEADS);
}

function nativeReplayTransfers(
  result: NativeLeadScanResult,
  candidate: Address,
  fundingBlock: number,
  fundingTransactionIndex?: number,
): Transfer[] {
  return result.transfers.filter((transfer) => {
    if (transfer.from.toLowerCase() !== candidate.toLowerCase()) return false;
    if (transfer.blockNumber > fundingBlock) return true;
    if (transfer.blockNumber < fundingBlock) return false;
    if (fundingTransactionIndex === undefined) return false;
    const parts = transfer.eventIndex.match(/^tx\.(\d+)$/);
    return parts !== null && Number(parts[1]) > fundingTransactionIndex;
  });
}

function mergeWalletLeadStates(
  current: WalletLeadState | undefined,
  incoming: WalletLeadState,
): WalletLeadState {
  const byCandidate = new Map<string, WalletLeadState["leads"][number]>();
  for (const lead of current?.leads ?? [])
    byCandidate.set(lead.candidate.toLowerCase(), lead);
  for (const lead of incoming.leads)
    if (!byCandidate.has(lead.candidate.toLowerCase()))
      byCandidate.set(lead.candidate.toLowerCase(), lead);
  return {
    version: 1,
    leads: [...byCandidate.values()].slice(0, MAX_DYNAMIC_LEADS),
  };
}

/**
 * Preserve historical native replay coverage when a lead is discovered while
 * a native block scan is already in flight. The next regular scan can start
 * after the lead's funding block, so it must receive a replay through the
 * scan's committed tip first.
 */
export function extendNativeLeadReplaysForLiveLeads(
  stream: NativeLeadStreamState,
  scanWallets: readonly Address[],
  liveLeads: readonly {
    candidate: Address;
    blockNumber: number;
    transactionIndex?: number;
  }[],
  targetBlock: number,
  maxTasks = MAX_LEAD_CATCH_UP_TASKS,
): NativeLeadStreamState {
  const scanned = new Set(scanWallets.map((wallet) => wallet.toLowerCase()));
  const missing = liveLeads.filter(
    (lead) => !scanned.has(lead.candidate.toLowerCase()),
  );
  if (!missing.length) return stream;
  return queueNativeLeadReplays(
    stream,
    missing.map((lead) => ({
      candidate: lead.candidate,
      blockNumber: lead.blockNumber,
      ...(lead.transactionIndex === undefined
        ? {}
        : { transactionIndex: lead.transactionIndex }),
    })),
    targetBlock,
    maxTasks,
  );
}

export async function runWatcher(config: FastWatchConfig): Promise<never> {
  const rpc = new FastRpc(config.rpcUrl);
  const entityReader = config.entityAddresses.length
    ? createEntityTokenBalanceReader({ rpcClient: rpc, cacheTtlMs: 15_000 })
    : null;
  let state = await loadState(config.stateFile);
  let tokenAddresses = [
    ...new Set([
      ...(config.priorityTokenAddresses ?? []),
      ...config.manualTokenAddresses,
      ...state.tokens,
      ...tokenAddressesFromState(state),
    ]),
  ].slice(0, MAX_TOKENS);
  let nextDiscoveryAt = 0;
  let discoveryBackoff = 60_000;
  let discoveryInFlight = false;
  let discoveryGeneration = 0;
  let leadTokenRefreshPending = false;
  let lastNoTokenLogAt = 0;
  let chainChecked = false;
  let leadDiscoveryInFlight: Promise<void> | null = null;
  let leadStateRevision = 0;
  let persistChain: Promise<void> = Promise.resolve();
  const persistCurrentState = (next: FastWatchState): Promise<void> => {
    const operation = persistChain.then(() =>
      saveState(config.stateFile, next),
    );
    persistChain = operation.catch(() => undefined);
    return operation;
  };
  const startDiscovery = (): void => {
    if (discoveryInFlight) return;
    discoveryInFlight = true;
    const generation = ++discoveryGeneration;
    const discoveryAddresses = walletAddressesForTokenDiscovery(config, state);
    void discoverTokenAddressesDetailed(discoveryAddresses)
      .then((discovery) => {
        if (generation !== discoveryGeneration) return;
        const historical = tokenAddressesFromState(state);
        const candidates = [
          ...new Set([
            ...(config.priorityTokenAddresses ?? []),
            ...tokenAddresses,
            ...state.tokens,
            ...historical,
            ...config.manualTokenAddresses,
            ...discovery.tokens,
          ]),
        ];
        tokenAddresses = candidates.slice(0, MAX_TOKENS);
        let detail = `Token coverage sources: ${discovery.tokens.length} current-balance, ${historical.length} historical, ${config.manualTokenAddresses.length} manual; tracking ${tokenAddresses.length} contracts.`;
        if (discovery.failedWallets)
          detail += ` ${discovery.failedWallets}/${discovery.requestedWallets} wallet discovery request(s) failed.`;
        if (candidates.length > MAX_TOKENS)
          detail += ` The ${MAX_TOKENS}-contract cap omitted ${candidates.length - MAX_TOKENS}; additional contracts are not monitored.`;
        detail +=
          " Current-balance discovery can omit fully dumped tokens; add manual token contracts to include them.";
        process.stderr.write(`fast watcher discovery: ${detail}\n`);
        if (leadTokenRefreshPending) {
          leadTokenRefreshPending = false;
          nextDiscoveryAt = 0;
        } else {
          nextDiscoveryAt = Date.now() + config.tokenRefreshMs;
        }
        discoveryBackoff = 60_000;
      })
      .catch((error: unknown) => {
        if (generation !== discoveryGeneration) return;
        nextDiscoveryAt = Date.now() + discoveryBackoff;
        discoveryBackoff = Math.min(discoveryBackoff * 2, 15 * 60_000);
        process.stderr.write(
          `fast watcher discovery error; retaining ${tokenAddresses.length} contracts and retrying in ${Math.ceil((nextDiscoveryAt - Date.now()) / 1000)}s: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        if (generation === discoveryGeneration) discoveryInFlight = false;
      });
  };
  const startLeadDiscovery = (): void => {
    if (leadDiscoveryInFlight) return;
    const queued = state.leadQueue ?? [];
    const existingTasks = state.leadCatchUpTasks ?? [];
    if (!queued.length && !existingTasks.length) return;
    const batch = queued.slice(0, MAX_LEAD_OBSERVATIONS_PER_CYCLE);
    const snapshot = state;
    const tokens = tokenAddresses;
    const task = (async (): Promise<void> => {
      try {
        const discovery = await discoverFastWalletLeads(
          config,
          rpc,
          snapshot,
          batch,
        );
        const snapshotTarget = snapshot.lastBlock;
        const newTasks: FastLeadCatchUpTask[] =
          snapshotTarget === null
            ? []
            : discovery.added.map((lead) => ({
                leads: [lead],
                // Keep the original funding block. The worker advances this
                // cursor in bounded windows instead of dropping older sales.
                fromBlock: lead.blockNumber,
                targetBlock: snapshotTarget,
                attempts: 0,
              }));
        const taskMap = new Map(
          existingTasks.map((task) => [leadCatchUpTaskKey(task), task]),
        );
        for (const task of newTasks) {
          const key = leadCatchUpTaskKey(task);
          if (!taskMap.has(key)) taskMap.set(key, task);
        }
        const tasksToProcess = [...taskMap.values()];
        const taskLeads = tasksToProcess.flatMap((task) => task.leads);
        let catchUpFlows: FastFlow[] = [];
        let catchUpLeadObservations: FastLeadObservation[] = [];
        let catchUpSucceeded = tasksToProcess.length === 0;
        let replayStart: number | null = null;
        let replayTarget: number | null = null;
        if (tasksToProcess.length && snapshotTarget !== null) {
          replayStart = Math.min(
            ...tasksToProcess.map((task) => task.fromBlock),
          );
          replayTarget = Math.min(
            Math.max(...tasksToProcess.map((task) => task.targetBlock)),
            replayStart + config.maxBlockSpan - 1,
          );
          try {
            const catchUp = await scanOnce(
              config,
              rpc,
              {
                ...snapshot,
                // Catch-up is read-only. Do not let its replay mutate the
                // live cursor, deferred queues or already delivered IDs.
                seen: [],
                deferred: [],
                leadQueue: [],
                leadPendingFlows: [],
              },
              tokens,
              [...new Set(taskLeads.map((lead) => lead.candidate))],
              replayStart,
              replayTarget,
            );
            for (const warning of catchUp.warnings)
              process.stderr.write(`fast watcher lead catch-up: ${warning}\n`);
            catchUpFlows = filterLeadCatchUpFlows(catchUp.flows, taskLeads);
            catchUpLeadObservations = filterLeadCatchUpObservations(
              catchUp.leadObservations,
              taskLeads,
            );
            const unknownOrdering =
              hasUnknownNativeFundingOrdering(catchUp.flows, taskLeads) ||
              hasUnknownNativeFundingObservationOrdering(
                catchUp.leadObservations,
                taskLeads,
              );
            if (unknownOrdering) {
              process.stderr.write(
                "fast watcher lead catch-up coverage gap: native funding and same-block ERC-20 activity had no transaction index; replay window retained.\n",
              );
              catchUpFlows = [];
              catchUpLeadObservations = [];
              catchUpSucceeded = false;
            } else {
              catchUpSucceeded = true;
            }
          } catch (error) {
            process.stderr.write(
              `fast watcher lead discovery catch-up deferred (attempt ${Math.max(...tasksToProcess.map((task) => task.attempts)) + 1}); replay window retained: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        } else if (tasksToProcess.length) {
          process.stderr.write(
            "fast watcher lead discovery catch-up deferred: cursor is not bootstrapped; replay window retained.\n",
          );
        }
        const processed = new Set(batch.map(({ transfer }) => transfer.id));
        const retryable = new Set(
          discovery.retryObservations.map(({ transfer }) => transfer.id),
        );
        const nextCatchUpTasks =
          catchUpSucceeded && replayTarget !== null
            ? tasksToProcess.flatMap((task) => {
                if (task.fromBlock > replayTarget) return [task];
                if (task.targetBlock <= replayTarget) return [];
                return [
                  {
                    ...task,
                    fromBlock: replayTarget + 1,
                    attempts: 0,
                  },
                ];
              })
            : tasksToProcess.map((task) => ({
                ...task,
                attempts: task.attempts + 1,
              }));
        const live = state;
        const startedTaskMap = new Map(
          existingTasks.map((task) => [leadCatchUpTaskKey(task), task]),
        );
        const remainingLiveTasks = (live.leadCatchUpTasks ?? []).filter(
          (task) => {
            const key = leadCatchUpTaskKey(task);
            const started = startedTaskMap.get(key);
            if (!started) return true;
            // If another state merge advanced this task while the background
            // scan was running, preserve that newer window.
            return (
              task.fromBlock !== started.fromBlock ||
              task.targetBlock !== started.targetBlock ||
              task.attempts !== started.attempts
            );
          },
        );
        const protectedLiveTaskKeys = new Set(
          remainingLiveTasks.map((task) => leadCatchUpTaskKey(task)),
        );
        const retainedQueue = (live.leadQueue ?? []).filter(
          ({ transfer }) => !processed.has(transfer.id),
        );
        const retryObservations = batch.filter(({ transfer }) =>
          retryable.has(transfer.id),
        );
        const retryIds = new Set(
          retryObservations.map(({ transfer }) => transfer.id),
        );
        const mergedLeads = mergeWalletLeadStates(
          live.walletLeads,
          discovery.state,
        );
        let next: FastWatchState = {
          ...live,
          walletLeads: mergedLeads,
          // Rotate retryable observations to the tail so a slow receipt or
          // price provider cannot starve newer lead edges.
          leadQueue: retainedQueue.filter(
            ({ transfer }) => !retryIds.has(transfer.id),
          ),
          // Preserve any task persisted while this batch was checking
          // receipts; the keyed merge below replaces only windows advanced
          // by this batch.
          leadCatchUpTasks: remainingLiveTasks,
        };
        next = queueLeadObservations(next, retryObservations);
        next = queueLeadObservations(next, catchUpLeadObservations);
        next = queueLeadCatchUpTasks(
          next,
          nextCatchUpTasks.filter(
            (task) => !protectedLiveTaskKeys.has(leadCatchUpTaskKey(task)),
          ),
        );
        next = queueLeadPendingFlows(next, catchUpFlows);
        if (discovery.added.length && snapshotTarget !== null) {
          next = {
            ...next,
            nativeLeadStream: queueNativeLeadReplays(
              next.nativeLeadStream ?? createNativeLeadStreamState(),
              discovery.added.map((lead) => ({
                candidate: lead.candidate,
                blockNumber: lead.blockNumber,
                ...(lead.transactionIndex === undefined
                  ? {}
                  : { transactionIndex: lead.transactionIndex }),
              })),
              snapshotTarget,
              MAX_LEAD_CATCH_UP_TASKS,
            ),
          };
        }
        state = next;
        leadStateRevision += 1;
        if (discovery.added.length) {
          // Ask the paced balance refresh to include new recipients as soon
          // as the current refresh slot is free; their token holdings are not
          // assumed to be covered by the seed-wallet snapshot.
          leadTokenRefreshPending = true;
          nextDiscoveryAt = 0;
          process.stderr.write(
            `fast watcher lead discovery: added ${discovery.added.length} low-confidence recipient lead(s); no ownership inferred. ${discovery.added
              .map(
                (lead) =>
                  `${lead.candidate} from ${lead.seed} via ${lead.evidenceSource} (${lead.eventId})`,
              )
              .join("; ")}\n`,
          );
        }
        if (discovery.skipped)
          process.stderr.write(
            `fast watcher lead discovery: ${discovery.skipped} candidate observation(s) skipped by bounded policy or unavailable evidence.\n`,
          );
        if (discovery.retryObservations.length)
          process.stderr.write(
            `fast watcher lead discovery: ${discovery.retryObservations.length} observation(s) retained for a later bounded retry.\n`,
          );
        await persistCurrentState(next);
      } catch (error) {
        process.stderr.write(
          `fast watcher lead discovery deferred; retaining queued observations: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        leadDiscoveryInFlight = null;
      }
    })();
    leadDiscoveryInFlight = task;
  };
  let nativeLeadDiscoveryInFlight: Promise<void> | null = null;
  const startNativeLeadDiscovery = (): void => {
    if (nativeLeadDiscoveryInFlight) return;
    const snapshot = state;
    const stream =
      snapshot.nativeLeadStream ??
      createNativeLeadStreamState(
        snapshot.lastBlock === null || snapshot.lastHash === null
          ? { lastBlock: null, lastHash: null }
          : {
              lastBlock: snapshot.lastBlock,
              lastHash: snapshot.lastHash as `0x${string}`,
            },
      );
    const trackedWallets = nativeTrackedAddresses(config, snapshot);
    if (!trackedWallets.length) return;
    const task = (async (): Promise<void> => {
      try {
        const nativeSnapshot = beginNativeLeadScan(
          stream,
          Math.min(config.maxBlockSpan, 20),
        );
        let regular: NativeLeadScanResult | null = null;
        if (nativeSnapshot.cursor.lastBlock === null) {
          const head = parsedHex(
            await rpc.request("eth_blockNumber", []),
            "native chain head",
          );
          const target = Math.max(0, head - config.confirmations);
          regular = await scanNativeLeadTransfers(rpc, {
            trackedWallets,
            fromBlock: target,
            toBlock: target,
            confirmations: config.confirmations,
            maxBlockSpan: 1,
            maxReceiptChecks: 256,
            maxTransactions: 20_000,
          });
        } else {
          let regularFrom = nativeSnapshot.cursor.lastBlock + 1;
          try {
            const cursorHeader = await header(
              rpc,
              nativeSnapshot.cursor.lastBlock,
            );
            if (
              cursorHeader.hash.toLowerCase() !==
              nativeSnapshot.cursor.lastHash?.toLowerCase()
            ) {
              const head = parsedHex(
                await rpc.request("eth_blockNumber", []),
                "native chain head",
              );
              if (
                head - config.confirmations <=
                nativeSnapshot.cursor.lastBlock
              ) {
                process.stderr.write(
                  `fast watcher native lead scan: reorg at cursor block ${nativeSnapshot.cursor.lastBlock} is not yet followed by a confirmed block; deferring.\n`,
                );
                return;
              }
              regularFrom = Math.max(0, nativeSnapshot.cursor.lastBlock - 6);
              process.stderr.write(
                `fast watcher native lead scan: reorg detected near block ${nativeSnapshot.cursor.lastBlock}; rescanning from ${regularFrom}.\n`,
              );
            }
          } catch (error) {
            process.stderr.write(
              `fast watcher native lead scan: cursor validation unavailable; retaining bounded retry: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            return;
          }
          regular = await scanNativeLeadTransfers(rpc, {
            trackedWallets,
            fromBlock: regularFrom,
            confirmations: config.confirmations,
            maxBlockSpan: Math.min(Math.max(config.maxBlockSpan, 8), 20),
            maxReceiptChecks: 256,
            maxTransactions: 20_000,
          });
        }
        for (const warning of regular.warnings)
          process.stderr.write(`fast watcher native lead scan: ${warning}\n`);
        const replayTransfers: Transfer[] = [];
        const completedReplayWindows: Array<{ key: string; toBlock: number }> =
          [];
        // Replay a small fair batch so a large lead set cannot stall the
        // regular native cursor scan. Rotate the starting point each commit
        // so an unavailable early window cannot starve later candidates.
        const replayWindows = nativeSnapshot.replayWindows;
        const replayOffset = replayWindows.length
          ? nativeSnapshot.revision % replayWindows.length
          : 0;
        const fairReplayWindows = [
          ...replayWindows.slice(replayOffset),
          ...replayWindows.slice(0, replayOffset),
        ].slice(0, 8);
        for (const window of fairReplayWindows) {
          try {
            const replay = await scanNativeLeadTransfers(rpc, {
              trackedWallets: [window.candidate],
              fromBlock: window.fromBlock,
              toBlock: window.toBlock,
              confirmations: config.confirmations,
              maxBlockSpan: Math.min(config.maxBlockSpan, 20),
              maxReceiptChecks: 64,
              maxTransactions: 20_000,
            });
            replayTransfers.push(
              ...nativeReplayTransfers(
                replay,
                window.candidate,
                window.fundingBlock,
                window.fundingTransactionIndex,
              ),
            );
            if (
              window.fundingTransactionIndex === undefined &&
              window.fromBlock <= window.fundingBlock &&
              window.toBlock >= window.fundingBlock
            ) {
              process.stderr.write(
                `fast watcher native lead replay coverage gap: funding transaction index unavailable for ${window.candidate}; same-block ETH activity retained for retry.\n`,
              );
            } else {
              completedReplayWindows.push({
                key: window.key,
                toBlock: replay.toBlock,
              });
            }
            for (const warning of replay.warnings)
              process.stderr.write(
                `fast watcher native lead replay: ${warning}\n`,
              );
          } catch (error) {
            process.stderr.write(
              `fast watcher native lead replay deferred; window retained: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
        const cursor =
          regular.lastBlockHash === null
            ? nativeSnapshot.cursor
            : {
                lastBlock: regular.toBlock,
                lastHash: regular.lastBlockHash,
              };
        const live = state;
        const liveStream =
          live.nativeLeadStream ?? createNativeLeadStreamState();
        let committedStream = commitNativeLeadScan(liveStream, nativeSnapshot, {
          success: true,
          cursor,
          completedReplayWindows,
        });
        if (regular.lastBlockHash !== null && regular.toBlock >= 0) {
          try {
            committedStream = extendNativeLeadReplaysForLiveLeads(
              committedStream,
              trackedWallets,
              live.walletLeads?.leads ?? [],
              regular.toBlock,
              MAX_LEAD_CATCH_UP_TASKS,
            );
          } catch (error) {
            process.stderr.write(
              `fast watcher native lead replay coverage gap: newly discovered lead replay could not be queued: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
        const observations = [...regular.transfers, ...replayTransfers].map(
          (transfer) => ({ transfer }),
        );
        let next: FastWatchState = {
          ...live,
          nativeLeadStream: committedStream,
        };
        next = queueLeadObservations(next, observations);
        state = next;
        leadStateRevision += 1;
        await persistCurrentState(next);
      } catch (error) {
        process.stderr.write(
          `fast watcher native lead scan deferred; cursor retained: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        nativeLeadDiscoveryInFlight = null;
      }
    })();
    nativeLeadDiscoveryInFlight = task;
  };
  for (;;) {
    try {
      if (!chainChecked) {
        await rpc.assertEthereumMainnet();
        chainChecked = true;
      }
      if (!discoveryInFlight && Date.now() >= nextDiscoveryAt) startDiscovery();
      startNativeLeadDiscovery();
      startLeadDiscovery();
      if (!tokenAddresses.length && state.tokens.length)
        tokenAddresses = state.tokens;
      if (!tokenAddresses.length) {
        const retryIn = Math.max(
          1,
          Math.ceil((nextDiscoveryAt - Date.now()) / 1000),
        );
        const notice = `No ERC-20 contracts available; discovery retry in ${retryIn}s.`;
        if (Date.now() - lastNoTokenLogAt >= 60_000) {
          process.stderr.write(`fast watcher warning: ${notice}\n`);
          lastNoTokenLogAt = Date.now();
        }
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, config.intervalMs),
        );
        continue;
      }
      state.tokens = tokenAddresses;
      const quoteCache = new Map<string, Promise<string | null>>();
      const leadRevisionAtScanStart = leadStateRevision;
      const dynamicAddresses = (state.walletLeads?.leads ?? []).map(
        (lead) => lead.candidate,
      );
      let result = await scanOnce(
        config,
        rpc,
        state,
        tokenAddresses,
        dynamicAddresses,
      );
      // The scan owns the cursor; background discovery owns only lead fields.
      // Merge the latest background fields so a completed task cannot be
      // overwritten by this cycle's older scan snapshot.
      const liveLeadState = state;
      let mergedState: FastWatchState = {
        ...result.state,
        walletLeads: liveLeadState.walletLeads,
        leadQueue: liveLeadState.leadQueue,
        leadPendingFlows: liveLeadState.leadPendingFlows,
        leadCatchUpTasks: liveLeadState.leadCatchUpTasks,
        nativeLeadStream: liveLeadState.nativeLeadStream,
      };
      mergedState = queueLeadObservations(mergedState, result.leadObservations);
      const pendingLeadFlows = mergedState.leadPendingFlows ?? [];
      const consumedLeadPendingIds = new Set(
        pendingLeadFlows.map((flow) => flow.transfer.id),
      );
      result = {
        ...result,
        flows: [...result.flows, ...pendingLeadFlows].sort(
          (left, right) =>
            left.transfer.blockNumber - right.transfer.blockNumber,
        ),
        state: { ...mergedState, leadPendingFlows: [] },
      };
      const eligible = await filterVerifiedSwapOutflows(result.flows, rpc);
      for (const warning of eligible.warnings)
        process.stderr.write(`fast watcher warning: ${warning}\n`);
      const activeLeadAddresses = (result.state.walletLeads?.leads ?? []).map(
        (lead) => lead.candidate,
      );
      const formatted = await mapConcurrent(
        eligible.flows,
        MAX_RPC_CONCURRENCY,
        async (flow) => {
          const alert = await formatFastFlow(
            flow,
            rpc,
            quoteCache,
            entityReader,
            entityAddressesForFastFlow(config, flow, activeLeadAddresses),
            eligible.evidence.get(flow.transfer.id),
            fastFlowWalletStatus(config, flow),
          );
          return { flow, alert };
        },
      );
      let staleAtDelivery = 0;
      const newAlerts: FastPendingAlert[] = formatted
        .filter((item) => {
          if (isFreshAlertTimestamp(item.flow.transfer.timestamp)) return true;
          staleAtDelivery += 1;
          return false;
        })
        .map(({ flow, alert }): FastPendingAlert => ({
          id: flow.transfer.id,
          text: alert.text,
          observedAt: flow.transfer.timestamp,
          format: "html",
        }));
      if (staleAtDelivery)
        process.stderr.write(
          `fast watcher warning: ${staleAtDelivery} alert(s) became stale before delivery and were omitted.\n`,
        );
      const deferredState = queueDeferredPoolLogs(
        result.state,
        eligible.deferred,
      );
      let nextState = queuePendingAlerts(deferredState, newAlerts);
      if (leadStateRevision !== leadRevisionAtScanStart) {
        const live = state;
        nextState = {
          ...nextState,
          walletLeads: live.walletLeads,
          leadQueue: live.leadQueue,
          leadPendingFlows: (live.leadPendingFlows ?? []).filter(
            (flow) => !consumedLeadPendingIds.has(flow.transfer.id),
          ),
          leadCatchUpTasks: live.leadCatchUpTasks,
          nativeLeadStream: live.nativeLeadStream,
        };
        nextState = queueLeadObservations(nextState, result.leadObservations);
      }
      state = nextState;
      // Persist the cursor and outbox before the first Telegram call. A crash
      // after a successful send can still duplicate one event, but a crash
      // before delivery cannot lose it or move the cursor past it.
      await persistCurrentState(state);
      const deliveredState = await deliverPendingAlerts(
        state,
        async (next) => {
          state = { ...state, pending: next.pending };
          await persistCurrentState(state);
          // Keep the outer loop aligned after each acknowledged send. If a
          // later item fails, this prevents already-persisted items returning
          // to the retry batch on the next cycle.
        },
        (text, replyMarkup) =>
          sendTelegram(config.token, config.chatId, text, replyMarkup),
      );
      state = { ...state, pending: deliveredState.pending };
      for (const warning of result.warnings)
        process.stderr.write(`fast watcher warning: ${warning}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`fast watcher error: ${detail}\n`);
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, config.intervalMs),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runWatcher(configFromEnvironment()).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
