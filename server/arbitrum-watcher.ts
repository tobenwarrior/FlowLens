import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchOnChainPrices } from "./price-provider.ts";
import { createPublicRpcClient, type RpcClient } from "./rpc.ts";
import { assetKey } from "../src/domain/engine.ts";
import type { Address, Asset } from "../src/domain/types.ts";

export const ARBITRUM_CHAIN_ID = 42161;
export const DEFAULT_ARB_CONTRACT =
  "0x912ce59144191c1204e64559fe8253a0e49e6548" as Address;
export const DEFAULT_ARBITRUM_RPC_URL =
  "https://arbitrum-one-rpc.publicnode.com";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const DEFAULT_INTERVAL_MS = 4_000;
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_MAX_BLOCK_SPAN = 200;
const DEFAULT_NATIVE_MAX_BLOCK_SPAN = 20;
const DEFAULT_MAX_ALERT_AGE_MS = 120_000;
const DEFAULT_PRICE_REFRESH_MS = 60_000;
const DEFAULT_MIN_INFLOW_USD = "1000";
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;
const MAX_CONFIRMATIONS = 12;
const MAX_BLOCK_SPAN = 200;
const MAX_NATIVE_MAX_BLOCK_SPAN = 200;
// Leave room in the shared 64-call RPC budget for the native stream, head and cursors.
const MAX_TOKEN_TIMESTAMP_BLOCKS = 32;
const MIN_ALERT_AGE_MS = 1_000;
const MAX_ALERT_AGE_MS = 120_000;
const MIN_PRICE_REFRESH_MS = 30_000;
const MAX_PRICE_REFRESH_MS = 15 * 60_000;
const REORG_REWIND_BLOCKS = 6;
const MAX_SEEN = 50_000;
const MAX_PENDING = 5_000;
const MAX_LOGS = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000;

export type ArbitrumDirection = "inflow" | "outflow" | "self";
export type ArbitrumAssetKind = "native" | "erc20";

export interface ArbitrumRpc extends RpcClient {
  requests?: string[];
}

export interface ArbitrumPrices {
  arbUsd: string | null;
  ethUsd: string | null;
  retrievedAt: string;
  warnings: string[];
}

export interface ArbitrumFlow {
  id: string;
  chainId: typeof ARBITRUM_CHAIN_ID;
  watched: Address;
  kind: ArbitrumAssetKind;
  direction: ArbitrumDirection;
  txHash: string;
  logIndex?: number;
  asset: "ARB" | "ETH";
  contract: Address | null;
  decimals: number;
  rawAmount: string;
  priceUsd: string | null;
  timestamp: string;
  blockNumber: number;
}

export interface ArbitrumPendingAlert {
  id: string;
  text: string;
  timestamp: string;
}

export interface ArbitrumWatchState {
  version: 1;
  bootstrapped: boolean;
  lastBlock: number | null;
  lastHash: string | null;
  /** Per-stream cursors let token logs catch up without claiming native coverage. */
  tokenCursor?: ArbitrumCursor;
  nativeCursor?: ArbitrumCursor;
  seen: string[];
  pending: ArbitrumPendingAlert[];
}

export interface ArbitrumCursor {
  lastBlock: number | null;
  lastHash: string | null;
}

export interface ArbitrumWatchConfig {
  address: Address;
  arbContract: Address;
  confirmations: number;
  maxBlockSpan: number;
  nativeMaxBlockSpan?: number;
  maxAlertAgeMs: number;
  minInflowUsd: string;
}

export interface ArbitrumEnvironmentConfig extends ArbitrumWatchConfig {
  token: string;
  chatId: string;
  telegramEnabled?: boolean;
  rpcUrl?: string;
  stateFile: string;
  intervalMs: number;
  priceRefreshMs: number;
}

export interface ArbitrumPollResult {
  state: ArbitrumWatchState;
  flows: ArbitrumFlow[];
  warnings: string[];
  head: number;
  target: number;
}

/** A future entity-wide balance, never a single-wallet snapshot. */
export type ArbitrumBalance = {
  rawAmount: string;
  priceUsd: string | null;
};

function canonicalAddress(value: string, label: string): Address {
  if (!ADDRESS.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value.toLowerCase() as Address;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`Expected a non-negative integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Integer is out of range: ${value}`);
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  label: string,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false`);
}

function parseHttpsUrl(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  const raw = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (parsed.username || parsed.password || parsed.hash)
    throw new Error(`${label} must not include credentials or a fragment`);
  return parsed.href.replace(/\/$/, "");
}

function parseDecimal(value: string, label: string): string {
  if (!DECIMAL.test(value) || value.length > 128)
    throw new Error(`Invalid ${label}: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (BigInt(whole) === 0n && BigInt(fraction || "0") === 0n)
    throw new Error(`${label} must be greater than zero`);
  return value;
}

export function arbitrumConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ArbitrumEnvironmentConfig {
  const addressValue = env.FLOWLENS_ARBITRUM_WATCH_ADDRESS?.trim();
  if (!addressValue)
    throw new Error("FLOWLENS_ARBITRUM_WATCH_ADDRESS is required");
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const telegramEnabled = parseBoolean(
    env.FLOWLENS_ARBITRUM_TELEGRAM_ENABLED,
    true,
    "FLOWLENS_ARBITRUM_TELEGRAM_ENABLED",
  );
  const rpcUrl = parseHttpsUrl(
    env.FLOWLENS_ARBITRUM_RPC_URL,
    DEFAULT_ARBITRUM_RPC_URL,
    "FLOWLENS_ARBITRUM_RPC_URL",
  );
  const intervalMs = parseInteger(
    env.FLOWLENS_ARBITRUM_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  const confirmations = parseInteger(
    env.FLOWLENS_ARBITRUM_CONFIRMATIONS,
    DEFAULT_CONFIRMATIONS,
  );
  const maxBlockSpan = parseInteger(
    env.FLOWLENS_ARBITRUM_MAX_BLOCK_SPAN,
    DEFAULT_MAX_BLOCK_SPAN,
  );
  const nativeMaxBlockSpan = parseInteger(
    env.FLOWLENS_ARBITRUM_NATIVE_MAX_BLOCK_SPAN,
    DEFAULT_NATIVE_MAX_BLOCK_SPAN,
  );
  const maxAlertAgeMs = parseInteger(
    env.FLOWLENS_ARBITRUM_MAX_ALERT_AGE_MS,
    DEFAULT_MAX_ALERT_AGE_MS,
  );
  const priceRefreshMs = parseInteger(
    env.FLOWLENS_ARBITRUM_PRICE_REFRESH_MS,
    DEFAULT_PRICE_REFRESH_MS,
  );
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    throw new Error(
      `FLOWLENS_ARBITRUM_INTERVAL_MS must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  if (confirmations > MAX_CONFIRMATIONS)
    throw new Error(
      `FLOWLENS_ARBITRUM_CONFIRMATIONS must be <=${MAX_CONFIRMATIONS}`,
    );
  if (maxBlockSpan < 1 || maxBlockSpan > MAX_BLOCK_SPAN)
    throw new Error(
      `FLOWLENS_ARBITRUM_MAX_BLOCK_SPAN must be 1-${MAX_BLOCK_SPAN}`,
    );
  if (nativeMaxBlockSpan < 1 || nativeMaxBlockSpan > MAX_NATIVE_MAX_BLOCK_SPAN)
    throw new Error(
      `FLOWLENS_ARBITRUM_NATIVE_MAX_BLOCK_SPAN must be 1-${MAX_NATIVE_MAX_BLOCK_SPAN}`,
    );
  if (maxAlertAgeMs < MIN_ALERT_AGE_MS || maxAlertAgeMs > MAX_ALERT_AGE_MS)
    throw new Error(
      `FLOWLENS_ARBITRUM_MAX_ALERT_AGE_MS must be between ${MIN_ALERT_AGE_MS} and ${MAX_ALERT_AGE_MS}`,
    );
  if (
    priceRefreshMs < MIN_PRICE_REFRESH_MS ||
    priceRefreshMs > MAX_PRICE_REFRESH_MS
  )
    throw new Error(
      `FLOWLENS_ARBITRUM_PRICE_REFRESH_MS must be between ${MIN_PRICE_REFRESH_MS} and ${MAX_PRICE_REFRESH_MS}`,
    );
  const arbContract = canonicalAddress(
    env.FLOWLENS_ARBITRUM_ARB_CONTRACT?.trim() || DEFAULT_ARB_CONTRACT,
    "Arbitrum ARB contract",
  );
  if (arbContract !== DEFAULT_ARB_CONTRACT)
    throw new Error(
      `FLOWLENS_ARBITRUM_ARB_CONTRACT must be the canonical ARB contract ${DEFAULT_ARB_CONTRACT}`,
    );
  return {
    address: canonicalAddress(addressValue, "Arbitrum watch address"),
    arbContract,
    confirmations,
    maxBlockSpan,
    maxAlertAgeMs,
    minInflowUsd: parseDecimal(
      env.FLOWLENS_ARBITRUM_MIN_INFLOW_USD?.trim() || DEFAULT_MIN_INFLOW_USD,
      "FLOWLENS_ARBITRUM_MIN_INFLOW_USD",
    ),
    token,
    chatId,
    telegramEnabled,
    rpcUrl,
    stateFile: resolve(
      env.FLOWLENS_ARBITRUM_STATE_FILE || ".local/arbitrum-watcher.json",
    ),
    intervalMs,
    nativeMaxBlockSpan,
    priceRefreshMs,
  };
}

export function createInitialArbitrumState(): ArbitrumWatchState {
  return {
    version: 1,
    bootstrapped: false,
    lastBlock: null,
    lastHash: null,
    seen: [],
    pending: [],
  };
}

function normalizeState(value: unknown): ArbitrumWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Arbitrum watcher state must be an object");
  const raw = value as Record<string, unknown>;
  const legacyCursor: ArbitrumCursor = {
    lastBlock: raw.lastBlock as number | null,
    lastHash: raw.lastHash as string | null,
  };
  const readCursor = (value: unknown, label: string): ArbitrumCursor => {
    if (value === undefined) return legacyCursor;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Malformed Arbitrum ${label} cursor`);
    const cursor = value as Record<string, unknown>;
    if (
      (cursor.lastBlock !== null &&
        (!Number.isSafeInteger(cursor.lastBlock) ||
          (cursor.lastBlock as number) < 0)) ||
      (cursor.lastHash !== null &&
        (typeof cursor.lastHash !== "string" || !HASH.test(cursor.lastHash))) ||
      (cursor.lastBlock === null) !== (cursor.lastHash === null)
    )
      throw new Error(`Malformed Arbitrum ${label} cursor`);
    return {
      lastBlock: cursor.lastBlock as number | null,
      lastHash: cursor.lastHash as string | null,
    };
  };
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
    !Array.isArray(raw.pending) ||
    raw.pending.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>).id !== "string" ||
        typeof (item as Record<string, unknown>).text !== "string" ||
        typeof (item as Record<string, unknown>).timestamp !== "string" ||
        (item as ArbitrumPendingAlert).id.length > 400 ||
        (item as ArbitrumPendingAlert).text.length > 4_000 ||
        Number.isNaN(Date.parse((item as ArbitrumPendingAlert).timestamp)),
    )
  )
    throw new Error("Malformed Arbitrum watcher state");
  const tokenCursor = readCursor(raw.tokenCursor, "token");
  const nativeCursor = readCursor(raw.nativeCursor, "native");
  const aggregate = [tokenCursor, nativeCursor]
    .filter((cursor) => cursor.lastBlock !== null)
    .sort((left, right) => left.lastBlock! - right.lastBlock!)[0];
  return {
    version: 1,
    bootstrapped: raw.bootstrapped,
    lastBlock: aggregate?.lastBlock ?? null,
    lastHash: aggregate?.lastHash ?? null,
    tokenCursor,
    nativeCursor,
    seen: [...new Set(raw.seen as string[])].slice(-MAX_SEEN),
    pending: (raw.pending as ArbitrumPendingAlert[]).slice(-MAX_PENDING),
  };
}

export async function loadArbitrumState(
  path: string,
): Promise<ArbitrumWatchState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialArbitrumState();
    throw error;
  }
}

export async function saveArbitrumState(
  path: string,
  state: ArbitrumWatchState,
): Promise<void> {
  const normalized = normalizeState(state);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function queueArbitrumPendingAlerts(
  state: ArbitrumWatchState,
  alerts: ArbitrumPendingAlert[],
  warnings: string[] = [],
): ArbitrumWatchState {
  const pending = new Map(state.pending.map((item) => [item.id, item]));
  for (const alert of alerts) pending.set(alert.id, alert);
  const entries = [...pending.values()];
  if (entries.length > MAX_PENDING)
    warnings.push(
      `Arbitrum pending alert cap reached; dropped ${entries.length - MAX_PENDING} oldest unsent alert(s).`,
    );
  return { ...state, pending: entries.slice(-MAX_PENDING) };
}

export async function deliverArbitrumPendingAlerts(
  initial: ArbitrumWatchState,
  persist: (state: ArbitrumWatchState) => Promise<void>,
  deliver: (text: string) => Promise<void>,
  options: {
    nowMs?: () => number;
    maxAlertAgeMs?: number;
    enabled?: boolean;
  } = {},
): Promise<{
  state: ArbitrumWatchState;
  delivered: string[];
  dropped: string[];
  warnings: string[];
  error?: Error;
}> {
  let state = initial;
  const delivered: string[] = [];
  const dropped: string[] = [];
  const warnings: string[] = [];
  const maxAlertAgeMs = options.maxAlertAgeMs ?? MAX_ALERT_AGE_MS;
  if (
    !Number.isSafeInteger(maxAlertAgeMs) ||
    maxAlertAgeMs < MIN_ALERT_AGE_MS ||
    maxAlertAgeMs > MAX_ALERT_AGE_MS
  )
    throw new Error(
      `Arbitrum alert age must be between ${MIN_ALERT_AGE_MS} and ${MAX_ALERT_AGE_MS} milliseconds.`,
    );
  if (options.enabled === false) {
    const dropped = state.pending.map((item) => item.id);
    if (!dropped.length) return { state, delivered: [], dropped, warnings: [] };
    const next = { ...state, pending: [] };
    try {
      await persist(next);
    } catch (error) {
      return {
        state,
        delivered: [],
        dropped: [],
        warnings: [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    return {
      state: next,
      delivered: [],
      dropped,
      warnings: [
        `Arbitrum Telegram delivery disabled; dropped ${dropped.length} pending alert(s).`,
      ],
    };
  }
  const isStale = (item: ArbitrumPendingAlert): boolean => {
    const observedAt = Date.parse(item.timestamp);
    const age = (options.nowMs?.() ?? Date.now()) - observedAt;
    return !Number.isFinite(observedAt) || age > maxAlertAgeMs;
  };
  const dropStale = async (
    item: ArbitrumPendingAlert,
  ): Promise<Error | null> => {
    const next = {
      ...state,
      pending: state.pending.filter((candidate) => candidate.id !== item.id),
    };
    try {
      await persist(next);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    state = next;
    dropped.push(item.id);
    warnings.push(
      `Arbitrum ${item.id} pending alert dropped because it exceeded the ${Math.floor(maxAlertAgeMs / 1000)}s freshness window.`,
    );
    return null;
  };
  for (const item of [...state.pending]) {
    if (isStale(item)) {
      const error = await dropStale(item);
      if (error) return { state, delivered, dropped, warnings, error };
      continue;
    }
    // A previous delivery/persist can consume most of the freshness window.
    // Recheck synchronously immediately before starting the Telegram request.
    if (isStale(item)) {
      const error = await dropStale(item);
      if (error) return { state, delivered, dropped, warnings, error };
      continue;
    }
    try {
      await deliver(item.text);
    } catch (error) {
      return {
        state,
        delivered,
        dropped,
        warnings,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    const next = {
      ...state,
      pending: state.pending.filter((candidate) => candidate.id !== item.id),
    };
    try {
      await persist(next);
    } catch (error) {
      return {
        state,
        delivered,
        dropped,
        warnings,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    state = next;
    delivered.push(item.id);
  }
  return { state, delivered, dropped, warnings };
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function parseHex(value: unknown, label: string): number {
  if (typeof value !== "string" || !HEX.test(value))
    throw new Error(`RPC returned malformed ${label}`);
  const result = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(result))
    throw new Error(`RPC returned oversized ${label}`);
  return result;
}

function parseBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !HEX.test(value))
    throw new Error(`RPC returned malformed ${label}`);
  return BigInt(value);
}

function topic(address: Address): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function parseTopicAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("RPC returned malformed ERC-20 address topic");
  return `0x${value.slice(-40)}`.toLowerCase() as Address;
}

interface BlockData {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: unknown[];
}

async function readBlock(
  rpc: ArbitrumRpc,
  number: number,
  fullTransactions: boolean,
): Promise<BlockData> {
  const value = await rpc.request("eth_getBlockByNumber", [
    hex(number),
    fullTransactions,
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`RPC returned no Arbitrum block ${number}`);
  const row = value as Record<string, unknown>;
  if (
    typeof row.hash !== "string" ||
    !HASH.test(row.hash) ||
    typeof row.parentHash !== "string" ||
    !HASH.test(row.parentHash)
  )
    throw new Error(`RPC returned malformed Arbitrum block ${number}`);
  const transactions = row.transactions;
  if (!Array.isArray(transactions))
    throw new Error(`RPC returned malformed transactions for block ${number}`);
  return {
    number: parseHex(row.number, "block number"),
    hash: row.hash.toLowerCase(),
    parentHash: row.parentHash.toLowerCase(),
    timestamp: parseHex(row.timestamp, "block timestamp"),
    transactions,
  };
}

interface LogData {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  removed: boolean;
}

async function readLogs(
  rpc: ArbitrumRpc,
  config: ArbitrumWatchConfig,
  fromBlock: number,
  toBlock: number,
  position: 1 | 2,
): Promise<LogData[]> {
  const result = await rpc.request("eth_getLogs", [
    {
      fromBlock: hex(fromBlock),
      toBlock: hex(toBlock),
      address: config.arbContract,
      topics: [
        TRANSFER_TOPIC,
        position === 1 ? [topic(config.address)] : null,
        position === 2 ? [topic(config.address)] : null,
      ],
    },
  ]);
  if (!Array.isArray(result))
    throw new Error("RPC returned malformed log list");
  if (result.length >= MAX_LOGS)
    throw new Error(
      "RPC log response hit its bounded cap; cursor was retained",
    );
  const logs: LogData[] = [];
  for (const raw of result) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("RPC returned malformed ERC-20 log");
    const row = raw as Record<string, unknown>;
    if (
      typeof row.address !== "string" ||
      !ADDRESS.test(row.address) ||
      !Array.isArray(row.topics) ||
      row.topics.length < 3 ||
      typeof row.topics[0] !== "string" ||
      row.topics.some((item) => typeof item !== "string") ||
      typeof row.data !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(row.data) ||
      typeof row.blockNumber !== "string" ||
      typeof row.blockHash !== "string" ||
      !HASH.test(row.blockHash) ||
      typeof row.transactionHash !== "string" ||
      !HASH.test(row.transactionHash) ||
      typeof row.logIndex !== "string"
    )
      throw new Error("RPC returned malformed ERC-20 log");
    logs.push({
      address: row.address.toLowerCase() as Address,
      topics: row.topics as string[],
      data: row.data,
      blockNumber: parseHex(row.blockNumber, "log block number"),
      blockHash: row.blockHash.toLowerCase(),
      transactionHash: row.transactionHash.toLowerCase(),
      logIndex: parseHex(row.logIndex, "log index"),
      removed: row.removed === true,
    });
  }
  return logs;
}

function direction(
  watched: Address,
  from: Address,
  to: Address,
): ArbitrumDirection {
  const fromWatched = from === watched;
  const toWatched = to === watched;
  return fromWatched && toWatched ? "self" : fromWatched ? "outflow" : "inflow";
}

function decimalParts(value: string): { digits: string; scale: number } | null {
  if (!DECIMAL.test(value) || value.length > 128) return null;
  const [whole, fraction = ""] = value.split(".");
  return {
    digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0",
    scale: fraction.length,
  };
}

function decimalProduct(
  rawAmount: string,
  decimals: number,
  price: string,
): string | null {
  const parsed = decimalParts(price);
  if (!/^\d+$/.test(rawAmount) || !parsed) return null;
  return scaled(
    BigInt(rawAmount) * BigInt(parsed.digits),
    decimals + parsed.scale,
  );
}

function scaled(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const padded = value.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function usdAtLeast(
  rawAmount: string,
  decimals: number,
  price: string | null,
  threshold: string,
): boolean {
  const parsedPrice = price ? decimalParts(price) : null;
  const parsedThreshold = decimalParts(threshold);
  if (!/^\d+$/.test(rawAmount) || !parsedPrice || !parsedThreshold)
    return false;
  const left =
    BigInt(rawAmount) *
    BigInt(parsedPrice.digits) *
    10n ** BigInt(parsedThreshold.scale);
  const right =
    BigInt(parsedThreshold.digits) *
    10n ** BigInt(decimals + parsedPrice.scale);
  return left >= right;
}

export function shouldAlertArbitrumFlow(
  flow: ArbitrumFlow,
  minInflowUsd = DEFAULT_MIN_INFLOW_USD,
): boolean {
  if (flow.direction === "self") return false;
  return (
    flow.direction === "outflow" ||
    usdAtLeast(flow.rawAmount, flow.decimals, flow.priceUsd, minInflowUsd)
  );
}

interface StreamScanResult {
  cursor: ArbitrumCursor;
  flows: ArbitrumFlow[];
  warnings: string[];
}

async function streamStart(
  rpc: ArbitrumRpc,
  cursor: ArbitrumCursor,
  label: string,
  warnings: string[],
): Promise<number> {
  if (cursor.lastBlock === null || cursor.lastHash === null)
    throw new Error(`Arbitrum ${label} cursor is incomplete`);
  const previousBlock = await readBlock(rpc, cursor.lastBlock, false);
  if (previousBlock.hash === cursor.lastHash.toLowerCase())
    return cursor.lastBlock + 1;
  const fromBlock = Math.max(0, cursor.lastBlock - REORG_REWIND_BLOCKS);
  warnings.push(
    `Arbitrum ${label} reorg detected near block ${cursor.lastBlock}; rescanning from ${fromBlock}. Previously delivered alerts cannot be retracted.`,
  );
  return fromBlock;
}

async function logsForRange(
  rpc: ArbitrumRpc,
  config: ArbitrumWatchConfig,
  fromBlock: number,
  toBlock: number,
): Promise<LogData[]> {
  const [outLogs, inLogs] = await Promise.all([
    readLogs(rpc, config, fromBlock, toBlock, 1),
    readLogs(rpc, config, fromBlock, toBlock, 2),
  ]);
  return [...outLogs, ...inLogs];
}

function parseNativeTransfer(
  block: BlockData,
  transaction: unknown,
  watched: Address,
  priceUsd: string | null,
): ArbitrumFlow | null {
  if (
    !transaction ||
    typeof transaction !== "object" ||
    Array.isArray(transaction)
  )
    throw new Error(
      `RPC returned malformed transaction in block ${block.number}`,
    );
  const row = transaction as Record<string, unknown>;
  if (typeof row.hash !== "string" || !HASH.test(row.hash))
    throw new Error(
      `RPC returned malformed transaction hash in block ${block.number}`,
    );
  if (typeof row.from !== "string")
    throw new Error(
      `RPC returned malformed transaction sender in block ${block.number}`,
    );
  const from = canonicalAddress(row.from, "transaction sender");
  const to =
    row.to === null || row.to === undefined
      ? null
      : canonicalAddress(String(row.to), "transaction recipient");
  const rawAmount = parseBigInt(row.value, "native transaction value");
  if (rawAmount === 0n || (from !== watched && to !== watched)) return null;
  const destination =
    to ?? ("0x0000000000000000000000000000000000000000" as Address);
  return {
    id: `${ARBITRUM_CHAIN_ID}:${row.hash.toLowerCase()}:native`,
    chainId: ARBITRUM_CHAIN_ID,
    watched,
    kind: "native",
    direction: direction(watched, from, destination),
    txHash: row.hash.toLowerCase(),
    asset: "ETH",
    contract: null,
    decimals: 18,
    rawAmount: rawAmount.toString(),
    priceUsd,
    timestamp: new Date(block.timestamp * 1000).toISOString(),
    blockNumber: block.number,
  };
}

function parseTokenLog(
  log: LogData,
  block: BlockData,
  config: ArbitrumWatchConfig,
  priceUsd: string | null,
): ArbitrumFlow | null {
  if (log.removed) return null;
  if (log.address !== config.arbContract) return null;
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = parseTopicAddress(log.topics[1]);
  const to = parseTopicAddress(log.topics[2]);
  if (from !== config.address && to !== config.address) return null;
  const rawAmount = BigInt(log.data);
  if (rawAmount === 0n) return null;
  return {
    id: `${ARBITRUM_CHAIN_ID}:${log.transactionHash}:erc20:${log.logIndex}:${config.arbContract}`,
    chainId: ARBITRUM_CHAIN_ID,
    watched: config.address,
    kind: "erc20",
    direction: direction(config.address, from, to),
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    asset: "ARB",
    contract: config.arbContract,
    decimals: 18,
    rawAmount: rawAmount.toString(),
    priceUsd,
    timestamp: new Date(block.timestamp * 1000).toISOString(),
    blockNumber: block.number,
  };
}

async function scanTokenStream(
  config: ArbitrumWatchConfig,
  rpc: ArbitrumRpc,
  cursor: ArbitrumCursor,
  target: number,
  priceUsd: string | null,
): Promise<StreamScanResult> {
  const warnings: string[] = [];
  if (cursor.lastBlock === null || cursor.lastHash === null)
    throw new Error("Arbitrum token cursor is incomplete");
  if (target <= cursor.lastBlock) return { cursor, flows: [], warnings };
  const fromBlock = await streamStart(rpc, cursor, "token", warnings);
  let scanTo = Math.min(target, fromBlock + config.maxBlockSpan - 1);
  if (scanTo < target)
    warnings.push(
      `Arbitrum token catch-up bounded to blocks ${fromBlock}-${scanTo}; later blocks remain queued for the next poll.`,
    );

  let logs = await logsForRange(rpc, config, fromBlock, scanTo);
  let eventBlocks = [...new Set(logs.map((log) => log.blockNumber))].sort(
    (left, right) => left - right,
  );
  if (eventBlocks.length > MAX_TOKEN_TIMESTAMP_BLOCKS) {
    scanTo = eventBlocks[MAX_TOKEN_TIMESTAMP_BLOCKS - 1]!;
    warnings.push(
      `Arbitrum token timestamp lookup bounded to ${MAX_TOKEN_TIMESTAMP_BLOCKS} event blocks; later blocks remain queued for the next poll.`,
    );
    logs = await logsForRange(rpc, config, fromBlock, scanTo);
    eventBlocks = [...new Set(logs.map((log) => log.blockNumber))].sort(
      (left, right) => left - right,
    );
  }

  const blocks = new Map<number, BlockData>();
  for (const number of eventBlocks) {
    if (number < fromBlock || number > scanTo)
      throw new Error(`RPC log points outside token scan: ${number}`);
    blocks.set(number, await readBlock(rpc, number, false));
  }
  const finalBlock =
    blocks.get(scanTo) ?? (await readBlock(rpc, scanTo, false));
  blocks.set(scanTo, finalBlock);
  const flows: ArbitrumFlow[] = [];
  for (const log of logs) {
    const block = blocks.get(log.blockNumber);
    if (!block)
      throw new Error(`RPC log points outside token scan: ${log.blockNumber}`);
    if (log.blockHash !== block.hash)
      throw new Error(
        `RPC log block hash mismatch at token block ${log.blockNumber}; cursor was retained`,
      );
    const flow = parseTokenLog(log, block, config, priceUsd);
    if (flow) flows.push(flow);
  }
  return {
    cursor: { lastBlock: scanTo, lastHash: finalBlock.hash },
    flows,
    warnings,
  };
}

async function scanNativeStream(
  config: ArbitrumWatchConfig,
  rpc: ArbitrumRpc,
  cursor: ArbitrumCursor,
  target: number,
  priceUsd: string | null,
): Promise<StreamScanResult> {
  const warnings: string[] = [];
  if (cursor.lastBlock === null || cursor.lastHash === null)
    throw new Error("Arbitrum native cursor is incomplete");
  if (target <= cursor.lastBlock) return { cursor, flows: [], warnings };
  const fromBlock = await streamStart(rpc, cursor, "native", warnings);
  const nativeMaxBlockSpan =
    config.nativeMaxBlockSpan ?? DEFAULT_NATIVE_MAX_BLOCK_SPAN;
  const scanTo = Math.min(target, fromBlock + nativeMaxBlockSpan - 1);
  if (scanTo < target)
    warnings.push(
      `Arbitrum native catch-up bounded to blocks ${fromBlock}-${scanTo}; later blocks remain queued for the next poll.`,
    );
  const blocks = new Map<number, BlockData>();
  for (let number = fromBlock; number <= scanTo; number += 1)
    blocks.set(number, await readBlock(rpc, number, true));
  const flows: ArbitrumFlow[] = [];
  for (const block of blocks.values()) {
    for (const transaction of block.transactions) {
      const flow = parseNativeTransfer(
        block,
        transaction,
        config.address,
        priceUsd,
      );
      if (flow) flows.push(flow);
    }
  }
  const finalBlock = blocks.get(scanTo);
  if (!finalBlock)
    throw new Error("Arbitrum native scan did not produce its final block");
  return {
    cursor: { lastBlock: scanTo, lastHash: finalBlock.hash },
    flows,
    warnings,
  };
}

export async function pollArbitrumOnce(
  config: ArbitrumWatchConfig,
  rpc: ArbitrumRpc,
  previous: ArbitrumWatchState,
  options: {
    nowMs?: number;
    prices?: Pick<ArbitrumPrices, "arbUsd" | "ethUsd">;
  } = {},
): Promise<ArbitrumPollResult> {
  if (rpc.chainId !== ARBITRUM_CHAIN_ID)
    throw new Error("Arbitrum watcher requires chain 42161");
  const state = normalizeState(previous);
  const head = parseHex(await rpc.request("eth_blockNumber", []), "chain head");
  const target = head - config.confirmations;
  if (target < 0) throw new Error("Arbitrum chain head is below confirmations");
  const prices = options.prices ?? { arbUsd: null, ethUsd: null };
  if (!state.bootstrapped) {
    const baseline = await readBlock(rpc, target, false);
    const cursor = { lastBlock: target, lastHash: baseline.hash };
    return {
      state: {
        ...state,
        bootstrapped: true,
        lastBlock: target,
        lastHash: baseline.hash,
        tokenCursor: cursor,
        nativeCursor: cursor,
      },
      flows: [],
      warnings: [
        `Arbitrum baseline set at observation block ${target}; earlier events were not replayed.`,
        "Native ETH coverage includes direct transaction values only; internal contract transfers are not scanned.",
      ],
      head,
      target,
    };
  }
  const tokenCursor = state.tokenCursor;
  const nativeCursor = state.nativeCursor;
  if (!tokenCursor || !nativeCursor)
    throw new Error("Arbitrum watcher stream cursors are incomplete");
  if (
    tokenCursor.lastBlock === null ||
    tokenCursor.lastHash === null ||
    nativeCursor.lastBlock === null ||
    nativeCursor.lastHash === null
  )
    throw new Error("Arbitrum watcher stream cursors are incomplete");
  if (target <= tokenCursor.lastBlock && target <= nativeCursor.lastBlock)
    return { state, flows: [], warnings: [], head, target };
  const [tokenScan, nativeScan] = await Promise.all([
    scanTokenStream(config, rpc, tokenCursor, target, prices.arbUsd),
    scanNativeStream(config, rpc, nativeCursor, target, prices.ethUsd),
  ]);
  const warnings = [...tokenScan.warnings, ...nativeScan.warnings];
  const candidates = new Map<string, ArbitrumFlow>();
  for (const flow of [...tokenScan.flows, ...nativeScan.flows])
    candidates.set(flow.id, flow);

  const seen = new Set(state.seen);
  const flows: ArbitrumFlow[] = [];
  const nowMs = options.nowMs ?? Date.now();
  for (const flow of [...candidates.values()].sort(
    (left, right) =>
      left.blockNumber - right.blockNumber || left.id.localeCompare(right.id),
  )) {
    if (seen.has(flow.id)) continue;
    seen.add(flow.id);
    if (flow.direction === "self") {
      warnings.push("Arbitrum self-transfer suppressed from Telegram alerts.");
      continue;
    }
    const age = nowMs - Date.parse(flow.timestamp);
    if (Number.isFinite(age) && age > config.maxAlertAgeMs) {
      warnings.push(
        `Arbitrum stale ${flow.asset} transfer suppressed (${Math.floor(age / 1000)}s old).`,
      );
      continue;
    }
    if (!shouldAlertArbitrumFlow(flow, config.minInflowUsd)) {
      warnings.push(
        flow.priceUsd === null
          ? `Arbitrum ${flow.asset} inflow suppressed because its USD value was unavailable.`
          : `Arbitrum ${flow.asset} inflow suppressed because its USD value was below $${config.minInflowUsd}.`,
      );
      continue;
    }
    flows.push(flow);
  }
  const aggregate = [tokenScan.cursor, nativeScan.cursor].sort(
    (left, right) => left.lastBlock! - right.lastBlock!,
  )[0]!;
  return {
    state: {
      ...state,
      lastBlock: aggregate.lastBlock,
      lastHash: aggregate.lastHash,
      tokenCursor: tokenScan.cursor,
      nativeCursor: nativeScan.cursor,
      seen: [...seen].slice(-MAX_SEEN),
    },
    flows,
    warnings: [...new Set(warnings)],
    head,
    target,
  };
}

function roundedDecimal(value: string, places = 2): string {
  const parsed = decimalParts(value);
  if (!parsed) return "unavailable";
  const scale = parsed.scale;
  const digits = BigInt(parsed.digits || "0");
  let rounded: bigint;
  if (scale <= places) rounded = digits * 10n ** BigInt(places - scale);
  else {
    const divisor = 10n ** BigInt(scale - places);
    rounded = (digits + divisor / 2n) / divisor;
  }
  const text = scaled(rounded, places);
  const [whole, fraction = ""] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fraction.padEnd(places, "0")}`;
}

function amountText(rawAmount: string, decimals: number): string {
  return roundedDecimal(scaled(BigInt(rawAmount), decimals));
}

function utcText(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  const parts = new Intl.DateTimeFormat("en-SG", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")} · ${part("hour")}:${part("minute")}:${part("second")} UTC`;
}

export function formatArbitrumAlert(
  flow: ArbitrumFlow,
  aggregateRemaining: ArbitrumBalance | null = null,
): string {
  const heading =
    flow.direction === "inflow"
      ? `💰 ${flow.asset} INFLOW`
      : `🚨 ${flow.asset} OUTFLOW`;
  const value = flow.priceUsd
    ? decimalProduct(flow.rawAmount, flow.decimals, flow.priceUsd)
    : null;
  const remainingValue =
    aggregateRemaining?.priceUsd && aggregateRemaining.rawAmount
      ? decimalProduct(
          aggregateRemaining.rawAmount,
          flow.decimals,
          aggregateRemaining.priceUsd,
        )
      : null;
  const remaining =
    aggregateRemaining === null
      ? "Remaining: unavailable"
      : `Remaining: ${amountText(aggregateRemaining.rawAmount, flow.decimals)} ${flow.asset}${remainingValue === null ? "" : ` · ≈$${roundedDecimal(remainingValue)}`}`;
  return [
    heading,
    `Amount: ${amountText(flow.rawAmount, flow.decimals)} ${flow.asset} · ${value === null ? "unavailable" : `≈$${roundedDecimal(value)}`}`,
    remaining,
    `🕒 ${utcText(flow.timestamp)}`,
  ].join("\n");
}

/**
 * Reads current ARB/ETH spot quotes from the configured public Arbitrum RPC's
 * Uniswap V3 route. A missing or unusable pool quote is intentionally reported
 * as unpriced so substantial-inflow filtering fails closed.
 */
export async function fetchArbitrumPrices(
  options: {
    client?: ArbitrumRpc;
    tokenContract?: Address;
    now?: () => string;
  } = {},
): Promise<ArbitrumPrices> {
  const contract = options.tokenContract ?? DEFAULT_ARB_CONTRACT;
  const arbAsset: Asset = {
    chainId: ARBITRUM_CHAIN_ID,
    symbol: "ARB",
    decimals: 18,
    contract,
  };
  const ethAsset: Asset = {
    chainId: ARBITRUM_CHAIN_ID,
    symbol: "ETH",
    decimals: 18,
    contract: null,
  };
  const result = await fetchOnChainPrices(
    ARBITRUM_CHAIN_ID,
    [arbAsset, ethAsset],
    {
      client: options.client,
      now: options.now,
      maxAssets: 2,
    },
  );
  const arbUsd =
    result.quotes.find((quote) => quote.key === assetKey(arbAsset))?.usd ??
    null;
  const ethUsd =
    result.quotes.find((quote) => quote.key === assetKey(ethAsset))?.usd ??
    null;
  const warnings = [...result.warnings];
  if (ethUsd === null)
    warnings.push(
      "Arbitrum ETH USD price unavailable; ETH inflows will be filtered.",
    );
  if (arbUsd === null)
    warnings.push(
      "Arbitrum ARB USD price unavailable; ARB inflows will be filtered.",
    );
  return {
    ethUsd,
    arbUsd,
    retrievedAt: options.now?.() ?? new Date().toISOString(),
    warnings: [...new Set(warnings)],
  };
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Telegram send failed with HTTP ${response.status}`);
  const body = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };
  if (!body.ok)
    throw new Error(
      `Telegram rejected message: ${body.description ?? "unknown error"}`,
    );
}

export async function runArbitrumWatcher(
  config: ArbitrumEnvironmentConfig,
): Promise<never> {
  const telegramEnabled = config.telegramEnabled !== false;
  const rpcUrl = config.rpcUrl ?? DEFAULT_ARBITRUM_RPC_URL;
  const createRpc = () => {
    const fetcher =
      rpcUrl === DEFAULT_ARBITRUM_RPC_URL
        ? undefined
        : async (_input: RequestInfo | URL, init?: RequestInit) =>
            fetch(rpcUrl, init);
    const client = createPublicRpcClient(ARBITRUM_CHAIN_ID, {
      fetch: fetcher,
      intervalMs: 350,
      maxCalls: 64,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxDurationMs: 120_000,
    });
    return rpcUrl === DEFAULT_ARBITRUM_RPC_URL
      ? client
      : {
          ...client,
          source: "Configured Arbitrum RPC",
          sourceUrl: rpcUrl,
        };
  };
  let state = await loadArbitrumState(config.stateFile);
  let prices: ArbitrumPrices = {
    arbUsd: null,
    ethUsd: null,
    retrievedAt: "",
    warnings: [],
  };
  let nextPriceAt = 0;
  for (;;) {
    try {
      // Public RPC budgets are per client instance; renew the bounded client
      // each cycle so a long-running watcher does not exhaust its deadline.
      const rpc = createRpc();
      await rpc.request("eth_chainId", []);
      if (Date.now() >= nextPriceAt) {
        prices = await fetchArbitrumPrices({
          tokenContract: config.arbContract,
        });
        nextPriceAt = Date.now() + config.priceRefreshMs;
        for (const warning of prices.warnings)
          process.stderr.write(`arbitrum watcher warning: ${warning}\n`);
      }
      const result = await pollArbitrumOnce(config, rpc, state, { prices });
      for (const warning of result.warnings)
        process.stderr.write(`arbitrum watcher warning: ${warning}\n`);
      const alerts: ArbitrumPendingAlert[] = [];
      if (telegramEnabled)
        for (const flow of result.flows) {
          alerts.push({
            id: flow.id,
            text: formatArbitrumAlert(flow),
            timestamp: flow.timestamp,
          });
        }
      const outboxWarnings: string[] = [];
      state = telegramEnabled
        ? queueArbitrumPendingAlerts(result.state, alerts, outboxWarnings)
        : result.state;
      for (const warning of outboxWarnings)
        process.stderr.write(`arbitrum watcher warning: ${warning}\n`);
      await saveArbitrumState(config.stateFile, state);
      const delivery = await deliverArbitrumPendingAlerts(
        state,
        (next) => saveArbitrumState(config.stateFile, next),
        (text) => sendTelegramMessage(config.token, config.chatId, text),
        {
          maxAlertAgeMs: config.maxAlertAgeMs,
          enabled: telegramEnabled,
        },
      );
      state = delivery.state;
      for (const warning of delivery.warnings)
        process.stderr.write(`arbitrum watcher warning: ${warning}\n`);
      if (delivery.error)
        process.stderr.write(
          `arbitrum watcher delivery error: ${delivery.error.message}\n`,
        );
    } catch (error) {
      process.stderr.write(
        `arbitrum watcher error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, config.intervalMs),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runArbitrumWatcher(arbitrumConfigFromEnvironment()).catch(
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
