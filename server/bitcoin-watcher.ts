import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const MEMPOOL_API = "https://mempool.space/api";
const PAGE_SIZE = 25;
const MAX_SEEN = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_PROVIDER_INTERVAL_MS = 1_000;
const BALANCE_REFRESH_CONCURRENCY = 4;
const BALANCE_REFRESH_SPACING_MS = 250;
const DEFAULT_MAX_ALERT_AGE_MS = 120_000;
const MIN_MAX_ALERT_AGE_MS = 1_000;
const MAX_MAX_ALERT_AGE_MS = 120_000;
const HEALTH_RETRY_MS = 5 * 60_000;
const MIN_INFLOW_USD = 1_000;
const MAX_ADDRESS_LENGTH = 90;
const TXID = /^[0-9a-fA-F]{64}$/;
const SATS = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;

export type BitcoinDirection = "inflow" | "outflow";

export interface BitcoinTx {
  txid: string;
  vin?: BitcoinVin[];
  vout?: BitcoinVout[];
  status?: BitcoinTxStatus;
}

export interface BitcoinVin {
  prevout?: BitcoinOutput;
  is_coinbase?: boolean;
}

export type BitcoinVout = BitcoinOutput;

export interface BitcoinOutput {
  scriptpubkey_address?: string;
  value?: number | string;
}

export interface BitcoinTxStatus {
  confirmed?: boolean;
  block_time?: number | null;
  block_height?: number | null;
}

export interface BitcoinProvider {
  fetchTransactions(address: string): Promise<BitcoinTx[]>;
  fetchBalance(address: string): Promise<bigint | null>;
  /** Confirmed chain balance only; mempool outputs are excluded. */
  fetchConfirmedBalance?(address: string): Promise<bigint | null>;
  fetchUsdPrice(): Promise<string | null>;
}

export interface BitcoinBalanceAggregator {
  /** Last complete sum across every tracked address, or null if unavailable. */
  current(): bigint | null;
  /** Refreshes in the background; concurrent calls share one refresh. */
  refresh(): Promise<void>;
}

export interface BitcoinFlow {
  address: string;
  txid: string;
  direction: BitcoinDirection;
  netSats: bigint;
  spentSats: bigint;
  receivedSats: bigint;
  remainingSats: bigint | null;
  usdPrice: string | null;
  timestamp: string;
  confirmed: boolean;
}

export interface BitcoinAddressState {
  seen: string[];
  bootstrapped: boolean;
  /** A full page without a known boundary means older activity may be missed. */
  gap: boolean;
  lastError?: string;
  notifiedError?: string;
  activeHealthFingerprint?: string;
  notifiedHealthFingerprint?: string;
  lastHealthAttemptAt?: string;
}

export interface BitcoinWatchState {
  version: 1;
  addresses: Record<string, BitcoinAddressState>;
}

export interface BitcoinWatchConfig {
  addresses: string[];
  maxAlertAgeMs?: number;
}

export interface BitcoinHealthEvent {
  address: string;
  impaired: boolean;
  fingerprint?: string;
  detail?: string;
}

export interface BitcoinHealthNotification {
  address: string;
  kind: "impaired" | "recovered";
  fingerprint?: string;
  text: string;
}

export interface BitcoinPollResult {
  state: BitcoinWatchState;
  flows: BitcoinFlow[];
  warnings: string[];
  errors: string[];
  gaps: string[];
  health: BitcoinHealthEvent[];
}

export interface BitcoinEnvironmentConfig extends BitcoinWatchConfig {
  token: string;
  chatId: string;
  alertsEnabled: boolean;
  providerBaseUrl: string;
  priceUrl?: string;
  stateFile: string;
  intervalMs: number;
  providerIntervalMs: number;
  maxAlertAgeMs: number;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_MAP = new Map([...BECH32].map((char, index) => [char, index]));

function base58Decoded(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const hex = number === 0n ? "" : number.toString(16).padStart(2, "0");
  const body = hex ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  const leading = value.match(/^1+/)?.[0].length ?? 0;
  return new Uint8Array(Buffer.concat([Buffer.alloc(leading), body]));
}

function validBase58Address(value: string): boolean {
  if (!/^[13]/.test(value)) return false;
  const decoded = base58Decoded(value);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded[0] !== 0x00 && decoded[0] !== 0x05) return false;
  const payload = Buffer.from(decoded.slice(0, 21));
  const checksum = Buffer.from(decoded.slice(21));
  const digest = createHash("sha256")
    .update(createHash("sha256").update(payload).digest())
    .digest();
  return checksum.equals(digest.subarray(0, 4));
}

function bech32Polymod(values: number[]): number {
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++)
      if ((top >>> bit) & 1) checksum ^= generators[bit];
  }
  return checksum >>> 0;
}

function bech32Expand(prefix: string): number[] {
  return [
    ...[...prefix].map((char) => char.charCodeAt(0) >>> 5),
    0,
    ...[...prefix].map((char) => char.charCodeAt(0) & 31),
  ];
}

function convertBits(
  values: number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | null {
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of values) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    accumulator = (accumulator << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits) result.push((accumulator << (toBits - bits)) & maxValue);
  } else if (bits >= fromBits || (accumulator << (toBits - bits)) & maxValue)
    return null;
  return result;
}

function validBech32Address(value: string): boolean {
  if (value.length > MAX_ADDRESS_LENGTH || value !== value.toLowerCase())
    return false;
  const separator = value.lastIndexOf("1");
  if (separator < 1 || separator + 7 > value.length) return false;
  const prefix = value.slice(0, separator);
  if (prefix !== "bc") return false;
  const data = value
    .slice(separator + 1)
    .split("")
    .map((char) => BECH32_MAP.get(char));
  if (data.some((item) => item === undefined)) return false;
  const values = data as number[];
  const checksum = bech32Polymod([...bech32Expand(prefix), ...values]);
  const variant =
    checksum === 1 ? "bech32" : checksum === 0x2bc830a3 ? "bech32m" : null;
  if (!variant) return false;
  const version = values[0];
  if (version > 16) return false;
  const program = convertBits(values.slice(1, -6), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return false;
  if (version === 0 && program.length !== 20 && program.length !== 32)
    return false;
  return version === 0 ? variant === "bech32" : variant === "bech32m";
}

function validAddress(value: string): boolean {
  if (value.length < 14 || value.length > MAX_ADDRESS_LENGTH) return false;
  if (value.startsWith("bc1")) return validBech32Address(value);
  return validBase58Address(value);
}

export function parseBitcoinAddresses(value: string): string[] {
  const addresses = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => {
      if (!validAddress(address))
        throw new Error(`Invalid Bitcoin address: ${address}`);
      return address.startsWith("bc1") ? address.toLowerCase() : address;
    });
  if (!addresses.length)
    throw new Error("FLOWLENS_BTC_ADDRESSES must contain at least one address");
  return [...new Set(addresses)];
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`Expected a non-negative integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Integer is out of range: ${value}`);
  return parsed;
}

function booleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error("Expected a boolean configuration value.");
}

export function bitcoinConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BitcoinEnvironmentConfig {
  const addressText = env.FLOWLENS_BTC_ADDRESSES;
  if (!addressText) throw new Error("FLOWLENS_BTC_ADDRESSES is required");
  const alertsEnabled = booleanConfig(env.FLOWLENS_BTC_ALERTS_ENABLED, true);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const providerBaseUrl =
    env.FLOWLENS_BTC_PROVIDER_BASE_URL?.trim() || MEMPOOL_API;
  const priceUrl = env.FLOWLENS_BTC_PRICE_URL?.trim() || undefined;
  if (alertsEnabled && !token)
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (alertsEnabled && !chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const intervalMs = nonNegativeInteger(
    env.FLOWLENS_BTC_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    throw new Error(
      `FLOWLENS_BTC_INTERVAL_MS must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  const providerIntervalMs = nonNegativeInteger(
    env.FLOWLENS_BTC_PROVIDER_INTERVAL_MS,
    DEFAULT_PROVIDER_INTERVAL_MS,
  );
  if (providerIntervalMs > 10_000)
    throw new Error(
      "FLOWLENS_BTC_PROVIDER_INTERVAL_MS must be between 0 and 10000",
    );
  const maxAlertAgeMs = nonNegativeInteger(
    env.FLOWLENS_BTC_MAX_ALERT_AGE_MS,
    DEFAULT_MAX_ALERT_AGE_MS,
  );
  if (
    maxAlertAgeMs < MIN_MAX_ALERT_AGE_MS ||
    maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS
  )
    throw new Error(
      `FLOWLENS_BTC_MAX_ALERT_AGE_MS must be between ${MIN_MAX_ALERT_AGE_MS} and ${MAX_MAX_ALERT_AGE_MS}`,
    );
  return {
    addresses: parseBitcoinAddresses(addressText),
    token: token ?? "",
    chatId: chatId ?? "",
    alertsEnabled,
    providerBaseUrl,
    priceUrl,
    stateFile: resolve(
      env.FLOWLENS_BTC_STATE_FILE ?? ".local/bitcoin-watcher.json",
    ),
    intervalMs,
    providerIntervalMs,
    maxAlertAgeMs,
  };
}

export function createInitialBitcoinState(
  addresses: string[],
): BitcoinWatchState {
  const mapped: Record<string, BitcoinAddressState> = {};
  for (const address of addresses)
    mapped[address] = { seen: [], bootstrapped: false, gap: false };
  return { version: 1, addresses: mapped };
}

function normalizeState(
  value: unknown,
  addresses: string[],
): BitcoinWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Bitcoin watcher state must be an object");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !raw.addresses ||
    typeof raw.addresses !== "object" ||
    Array.isArray(raw.addresses)
  )
    throw new Error("Unsupported Bitcoin watcher state version");
  const state = createInitialBitcoinState(addresses);
  const source = raw.addresses as Record<string, unknown>;
  for (const address of addresses) {
    const item = source[address];
    if (item === undefined) continue;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Malformed Bitcoin address state");
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.bootstrapped !== "boolean" ||
      typeof candidate.gap !== "boolean" ||
      !Array.isArray(candidate.seen) ||
      candidate.seen.some((id) => typeof id !== "string" || !TXID.test(id))
    )
      throw new Error("Malformed Bitcoin address state");
    state.addresses[address] = {
      seen: [...new Set(candidate.seen)].slice(-MAX_SEEN),
      bootstrapped: candidate.bootstrapped,
      gap: candidate.gap,
      lastError:
        typeof candidate.lastError === "string"
          ? candidate.lastError.slice(0, 1000)
          : undefined,
      notifiedError:
        typeof candidate.notifiedError === "string"
          ? candidate.notifiedError.slice(0, 1000)
          : undefined,
      activeHealthFingerprint:
        typeof candidate.activeHealthFingerprint === "string"
          ? candidate.activeHealthFingerprint.slice(0, 1000)
          : undefined,
      notifiedHealthFingerprint:
        typeof candidate.notifiedHealthFingerprint === "string"
          ? candidate.notifiedHealthFingerprint.slice(0, 1000)
          : undefined,
      lastHealthAttemptAt:
        typeof candidate.lastHealthAttemptAt === "string"
          ? candidate.lastHealthAttemptAt
          : undefined,
    };
  }
  return state;
}

export async function loadBitcoinState(
  path: string,
  addresses: string[],
): Promise<BitcoinWatchState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")), addresses);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialBitcoinState(addresses);
    throw error;
  }
}

export async function saveBitcoinState(
  path: string,
  state: BitcoinWatchState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function sameAddress(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return right.startsWith("bc1")
    ? left.toLowerCase() === right
    : left === right;
}

function sats(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid satoshi amount");
    return BigInt(value);
  }
  if (typeof value !== "string" || !SATS.test(value))
    throw new Error("Invalid satoshi amount");
  return BigInt(value);
}

function normalizeTx(value: unknown): BitcoinTx {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Bitcoin transaction");
  const row = value as Record<string, unknown>;
  if (typeof row.txid !== "string" || !TXID.test(row.txid))
    throw new Error("Malformed Bitcoin transaction ID");
  if (row.vin !== undefined && !Array.isArray(row.vin))
    throw new Error("Malformed Bitcoin inputs");
  if (row.vout !== undefined && !Array.isArray(row.vout))
    throw new Error("Malformed Bitcoin outputs");
  return {
    txid: row.txid.toLowerCase(),
    vin: row.vin as BitcoinVin[] | undefined,
    vout: row.vout as BitcoinVout[] | undefined,
    status: row.status as BitcoinTxStatus | undefined,
  };
}

function sumOutputs(
  rows: BitcoinOutput[] | undefined,
  address: string,
): bigint {
  let total = 0n;
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object")
      throw new Error("Malformed Bitcoin output");
    if (sameAddress(row.scriptpubkey_address, address))
      total += sats(row.value);
  }
  return total;
}

function flowFromTransaction(
  tx: BitcoinTx,
  address: string,
  remainingSats: bigint | null,
  usdPrice: string | null,
  now: string,
): BitcoinFlow | null {
  if (!tx.vin || tx.vin.length === 0)
    throw new Error("Bitcoin transaction is missing inputs");
  const missingNonCoinbasePrevout = tx.vin.some(
    (item) => item.prevout === undefined && item.is_coinbase !== true,
  );
  if (missingNonCoinbasePrevout)
    throw new Error("Bitcoin input is missing prevout data");
  const spentSats = sumOutputs(
    tx.vin
      .map((item) => item.prevout)
      .filter((item): item is BitcoinOutput => item !== undefined),
    address,
  );
  const receivedSats = sumOutputs(tx.vout, address);
  if (spentSats === receivedSats) return null;
  const direction: BitcoinDirection =
    spentSats > receivedSats ? "outflow" : "inflow";
  const timestamp =
    tx.status?.block_time &&
    Number.isSafeInteger(tx.status.block_time) &&
    tx.status.block_time > 0
      ? new Date(tx.status.block_time * 1000).toISOString()
      : now;
  return {
    address,
    txid: tx.txid,
    direction,
    netSats:
      direction === "outflow"
        ? spentSats - receivedSats
        : receivedSats - spentSats,
    spentSats,
    receivedSats,
    remainingSats,
    usdPrice,
    timestamp,
    confirmed: tx.status?.confirmed === true,
  };
}

function validPrice(value: string | null): string | null {
  if (value === null || !DECIMAL.test(value) || value.length > 64) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? value : null;
}

function usdValueAtLeast(rawSats: bigint, price: string): boolean {
  if (!DECIMAL.test(price)) return false;
  const [whole, fraction = ""] = price.split(".");
  const digits = `${whole}${fraction}`;
  const scale = 10n ** BigInt(fraction.length);
  const valueNumerator = BigInt(digits) * rawSats;
  const thresholdNumerator = BigInt(MIN_INFLOW_USD) * 100_000_000n * scale;
  return valueNumerator >= thresholdNumerator;
}

export function shouldAlertBitcoinFlow(flow: BitcoinFlow): boolean {
  if (flow.direction !== "inflow") return true;
  return flow.usdPrice !== null && usdValueAtLeast(flow.netSats, flow.usdPrice);
}

function isStaleBitcoinTransaction(
  transaction: BitcoinTx,
  nowMs: number,
  maxAlertAgeMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const blockTime = transaction.status?.block_time;
  if (!Number.isSafeInteger(blockTime) || (blockTime as number) <= 0)
    return false;
  return nowMs - (blockTime as number) * 1000 > maxAlertAgeMs;
}

function healthFingerprint(details: string[]): string {
  return [...new Set(details)].join(" | ").slice(0, 1000);
}

export function buildBitcoinHealthNotifications(
  state: BitcoinWatchState,
  events: BitcoinHealthEvent[],
  now = Date.now(),
): BitcoinHealthNotification[] {
  const notifications: BitcoinHealthNotification[] = [];
  for (const event of events) {
    const addressState = state.addresses[event.address];
    if (!addressState) continue;
    const lastAttempt = addressState.lastHealthAttemptAt
      ? Date.parse(addressState.lastHealthAttemptAt)
      : NaN;
    if (Number.isFinite(lastAttempt) && now - lastAttempt < HEALTH_RETRY_MS)
      continue;
    if (event.impaired && event.fingerprint) {
      if (addressState.notifiedHealthFingerprint === event.fingerprint)
        continue;
      addressState.lastHealthAttemptAt = new Date(now).toISOString();
      notifications.push({
        address: event.address,
        kind: "impaired",
        fingerprint: event.fingerprint,
        text: [
          "⚠️ BTC coverage impaired",
          "Fresh alerts may be delayed or missed until the provider recovers.",
          `Detail: ${event.detail ?? event.fingerprint}`,
        ].join("\n"),
      });
    } else if (!event.impaired && addressState.notifiedHealthFingerprint) {
      addressState.lastHealthAttemptAt = new Date(now).toISOString();
      notifications.push({
        address: event.address,
        kind: "recovered",
        text: [
          "✅ BTC coverage recovered",
          "The latest provider poll completed without a freshness or coverage problem; live alerts resumed.",
        ].join("\n"),
      });
    }
  }
  return notifications;
}

export function markBitcoinHealthNotificationDelivered(
  state: BitcoinWatchState,
  notification: BitcoinHealthNotification,
): void {
  const addressState = state.addresses[notification.address];
  if (!addressState) return;
  if (notification.kind === "impaired")
    addressState.notifiedHealthFingerprint = notification.fingerprint;
  else addressState.notifiedHealthFingerprint = undefined;
}

export async function pollBitcoinOnce(
  config: BitcoinWatchConfig,
  provider: BitcoinProvider,
  previous: BitcoinWatchState,
  now = new Date().toISOString(),
): Promise<BitcoinPollResult> {
  const state = normalizeState(previous, config.addresses);
  const maxAlertAgeMs = config.maxAlertAgeMs ?? DEFAULT_MAX_ALERT_AGE_MS;
  if (
    !Number.isSafeInteger(maxAlertAgeMs) ||
    maxAlertAgeMs < MIN_MAX_ALERT_AGE_MS ||
    maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS
  )
    throw new Error(
      `Bitcoin alert age must be between ${MIN_MAX_ALERT_AGE_MS} and ${MAX_MAX_ALERT_AGE_MS} milliseconds.`,
    );
  const nowMs = Date.parse(now);
  const flows: BitcoinFlow[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const gaps: string[] = [];
  const health: BitcoinHealthEvent[] = [];
  let usdPrice: string | null | undefined;
  // mempool.space exposes one balance endpoint per address and this provider
  // deliberately paces requests. Multi-address totals are refreshed by the
  // background aggregator in runBitcoinWatcher so this alert scan stays fast.
  const singleAddressRemaining = config.addresses.length === 1;
  for (const address of config.addresses) {
    const addressState = state.addresses[address];
    const operational: string[] = [];
    let filteredInflowCount = 0;
    const finishHealth = () => {
      if (operational.length) {
        const fingerprint = healthFingerprint(operational);
        const detail = operational.join(" | ").slice(0, 1000);
        addressState.activeHealthFingerprint = fingerprint;
        health.push({ address, impaired: true, fingerprint, detail });
      } else {
        addressState.activeHealthFingerprint = undefined;
        health.push({ address, impaired: false });
      }
    };
    try {
      const transactions = (await provider.fetchTransactions(address)).map(
        normalizeTx,
      );
      const known = new Set(addressState.seen);
      const firstKnownIndex = transactions.findIndex((item) =>
        known.has(item.txid),
      );
      const newTransactions =
        firstKnownIndex >= 0
          ? transactions.slice(0, firstKnownIndex)
          : addressState.bootstrapped
            ? transactions
            : [];
      if (
        addressState.bootstrapped &&
        firstKnownIndex < 0 &&
        transactions.length >= PAGE_SIZE &&
        !addressState.gap
      ) {
        addressState.gap = true;
        const warning = `${address}: possible gap; Bitcoin provider returned a full page without a previously seen transaction`;
        warnings.push(warning);
        gaps.push(address);
        operational.push(
          "possible gap; provider returned a full page without a known boundary",
        );
      }
      if (!addressState.bootstrapped) addressState.bootstrapped = true;
      addressState.seen = [
        ...new Set([
          ...addressState.seen,
          ...transactions.map((item) => item.txid),
        ]),
      ].slice(-MAX_SEEN);
      if (!newTransactions.length) {
        addressState.lastError = undefined;
        finishHealth();
        continue;
      }
      const staleTransactions = newTransactions.filter((transaction) =>
        isStaleBitcoinTransaction(transaction, nowMs, maxAlertAgeMs),
      );
      if (staleTransactions.length) {
        const detail = `stale transaction data suppressed (${staleTransactions.length} event${staleTransactions.length === 1 ? "" : "s"})`;
        warnings.push(`${address}: ${detail}`);
        operational.push("stale transaction data suppressed");
      }
      if (usdPrice === undefined) {
        try {
          usdPrice = validPrice(await provider.fetchUsdPrice());
        } catch {
          usdPrice = null;
          warnings.push(
            "Bitcoin USD price unavailable; BTC alerts will omit estimated value",
          );
        }
      }
      let remainingSats: bigint | null = null;
      if (singleAddressRemaining) {
        try {
          remainingSats = await provider.fetchBalance(address);
        } catch {
          warnings.push(`${address}: Bitcoin balance unavailable`);
        }
      }
      for (const transaction of [...newTransactions].reverse()) {
        if (isStaleBitcoinTransaction(transaction, nowMs, maxAlertAgeMs))
          continue;
        const flow = flowFromTransaction(
          transaction,
          address,
          remainingSats,
          usdPrice ?? null,
          now,
        );
        if (flow) {
          if (!shouldAlertBitcoinFlow(flow)) {
            filteredInflowCount += 1;
            continue;
          }
          flows.push(flow);
        }
      }
      if (filteredInflowCount)
        warnings.push(
          `${address}: ${filteredInflowCount} BTC inflow(s) filtered below $${MIN_INFLOW_USD.toLocaleString("en-US")} or without a usable USD estimate`,
        );
      addressState.lastError = undefined;
      finishHealth();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown Bitcoin provider failure";
      errors.push(`${address}: ${message}`);
      addressState.lastError = message.slice(0, 1000);
      const fingerprint = healthFingerprint([`provider error: ${message}`]);
      addressState.activeHealthFingerprint = fingerprint;
      health.push({
        address,
        impaired: true,
        fingerprint,
        detail: message.slice(0, 1000),
      });
    }
  }
  return {
    state,
    flows,
    warnings: [...new Set(warnings)],
    errors,
    gaps,
    health,
  };
}

interface BitcoinDisplayAmount {
  text: string;
  approximate: boolean;
}

function formatSats(value: bigint): BitcoinDisplayAmount {
  const whole = value / 100_000_000n;
  if (whole === 0n && value > 0n && value < 1_000_000n)
    return { text: "<0.01", approximate: true };
  const cents = (value + 500_000n) / 1_000_000n;
  const roundedWhole = cents / 100n;
  const roundedFraction = (cents % 100n).toString().padStart(2, "0");
  return {
    text: `${roundedWhole.toLocaleString("en-US")}.${roundedFraction}`,
    approximate: value % 1_000_000n !== 0n,
  };
}

function formatUsd(value: bigint, price: string | null): string {
  if (!price) return "unavailable";
  const numeric = (Number(price) * Number(value)) / 100_000_000;
  if (!Number.isFinite(numeric)) return "unavailable";
  if (numeric < 0.01 && numeric > 0) return "≈<$0.01";
  const suffix =
    numeric >= 1e9 ? "B" : numeric >= 1e6 ? "M" : numeric >= 1e3 ? "K" : "";
  const divisor =
    suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  return `≈$${(numeric / divisor).toFixed(2)}${suffix}`;
}

function formatTime(timestamp: string): string {
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

export function formatBitcoinFlowAlert(flow: BitcoinFlow): string {
  const heading =
    flow.direction === "inflow" ? "💰 BTC INFLOW" : "🚨 BTC OUTFLOW";
  const amount = formatSats(flow.netSats);
  const remaining =
    flow.remainingSats === null ? null : formatSats(flow.remainingSats);
  return [
    heading,
    `Amount: ${amount.approximate ? "≈" : ""}${amount.text} BTC · ${formatUsd(flow.netSats, flow.usdPrice)}`,
    `Remaining: ${remaining === null ? "unavailable" : `${remaining.approximate ? "≈" : ""}${remaining.text} BTC`}`,
    `🕒 ${formatTime(flow.timestamp)}${flow.confirmed ? "" : " · pending"}`,
  ].join("\n");
}

async function readJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Bitcoin provider returned HTTP ${response.status}`);
  }
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES)
    throw new Error("Bitcoin provider response exceeds byte budget");
  if (!response.body) throw new Error("Bitcoin provider response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Bitcoin provider response exceeds byte budget");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data));
}

function createPacer(intervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(next, now) + intervalMs;
    if (wait)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
  };
}

/**
 * Keeps a complete, confirmed-only balance sum without making the alert poll
 * wait for every tracked address. A partial refresh is discarded rather than
 * presented as a misleading total.
 */
export function createBitcoinBalanceAggregator(
  provider: BitcoinProvider,
  addresses: string[],
): BitcoinBalanceAggregator {
  const tracked = [...new Set(addresses)];
  const pace = createPacer(BALANCE_REFRESH_SPACING_MS);
  let cached: bigint | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const work = (async () => {
      try {
        const fetchConfirmedBalance = provider.fetchConfirmedBalance;
        if (!fetchConfirmedBalance || tracked.length === 0) {
          cached = null;
          return;
        }
        const balances: Array<bigint | null> = Array(tracked.length).fill(null);
        let next = 0;
        const worker = async () => {
          for (;;) {
            const index = next++;
            if (index >= tracked.length) return;
            await pace();
            try {
              const balance = await fetchConfirmedBalance.call(
                provider,
                tracked[index]!,
              );
              balances[index] =
                typeof balance === "bigint" && balance >= 0n ? balance : null;
            } catch {
              balances[index] = null;
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(BALANCE_REFRESH_CONCURRENCY, tracked.length) },
            () => worker(),
          ),
        );
        if (balances.some((balance) => balance === null)) {
          cached = null;
          return;
        }
        let total = 0n;
        for (const balance of balances) total += balance ?? 0n;
        cached = total;
      } catch {
        // A failed refresh must never turn a partial result into a total.
        cached = null;
      }
    })();
    inFlight = work;
    work.then(
      () => {
        if (inFlight === work) inFlight = null;
      },
      () => {
        if (inFlight === work) inFlight = null;
      },
    );
    return work;
  };

  return {
    current: () => cached,
    refresh,
  };
}

function parseAddressBalance(result: unknown, includeMempool: boolean): bigint {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Bitcoin provider returned malformed address data");
  const row = result as Record<string, unknown>;
  const chain = row.chain_stats as Record<string, unknown>;
  const mempool = row.mempool_stats as Record<string, unknown>;
  const funded =
    sats(chain?.funded_txo_sum) +
    (includeMempool ? sats(mempool?.funded_txo_sum) : 0n);
  const spent =
    sats(chain?.spent_txo_sum) +
    (includeMempool ? sats(mempool?.spent_txo_sum) : 0n);
  return funded >= spent ? funded - spent : 0n;
}

export function createMempoolProvider(
  options: {
    fetch?: typeof fetch;
    baseUrl?: string;
    priceUrl?: string;
    intervalMs?: number;
  } = {},
): BitcoinProvider {
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? MEMPOOL_API).replace(/\/+$/, "");
  const priceUrl = options.priceUrl?.trim() || undefined;
  const pace = createPacer(options.intervalMs ?? DEFAULT_PROVIDER_INTERVAL_MS);
  const request = async (path: string): Promise<unknown> => {
    await pace();
    return readJson(fetcher, `${base}${path}`);
  };
  return {
    async fetchTransactions(address) {
      const result = await request(
        `/address/${encodeURIComponent(address)}/txs`,
      );
      if (!Array.isArray(result) || result.length > PAGE_SIZE)
        throw new Error(
          "Bitcoin provider returned malformed transaction history",
        );
      return result.map(normalizeTx);
    },
    async fetchBalance(address) {
      const result = await request(`/address/${encodeURIComponent(address)}`);
      return parseAddressBalance(result, true);
    },
    async fetchConfirmedBalance(address) {
      const result = await request(`/address/${encodeURIComponent(address)}`);
      return parseAddressBalance(result, false);
    },
    async fetchUsdPrice() {
      const result = priceUrl
        ? (await pace(), await readJson(fetcher, priceUrl))
        : await request("/v1/prices");
      if (!result || typeof result !== "object" || Array.isArray(result))
        return null;
      const row = result as Record<string, unknown>;
      const data = row.data as Record<string, unknown> | undefined;
      const usd = row.USD ?? data?.amount;
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0)
        return String(usd);
      if (typeof usd === "string" && DECIMAL.test(usd)) return usd;
      return null;
    },
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

export async function runBitcoinWatcher(
  config: BitcoinEnvironmentConfig,
): Promise<never> {
  const provider = createMempoolProvider({
    baseUrl: config.providerBaseUrl,
    intervalMs: config.providerIntervalMs,
    priceUrl: config.priceUrl,
  });
  const balanceAggregator =
    config.addresses.length > 1
      ? createBitcoinBalanceAggregator(
          createMempoolProvider({
            baseUrl: config.providerBaseUrl,
            intervalMs: config.providerIntervalMs,
          }),
          config.addresses,
        )
      : null;
  const refreshAggregate = () => {
    if (!balanceAggregator) return;
    void balanceAggregator.refresh().catch((error: unknown) => {
      process.stderr.write(
        `bitcoin watcher balance refresh error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    });
  };
  refreshAggregate();
  let state = await loadBitcoinState(config.stateFile, config.addresses);
  for (;;) {
    const result = await pollBitcoinOnce(
      { addresses: config.addresses, maxAlertAgeMs: config.maxAlertAgeMs },
      provider,
      state,
    );
    for (const warning of result.warnings)
      process.stderr.write(`bitcoin watcher warning: ${warning}\n`);
    for (const error of result.errors)
      process.stderr.write(`bitcoin watcher error: ${error}\n`);
    try {
      if (config.alertsEnabled) {
        for (const flow of result.flows) {
          const alertFlow = balanceAggregator
            ? { ...flow, remainingSats: balanceAggregator.current() }
            : flow;
          await sendTelegramMessage(
            config.token,
            config.chatId,
            formatBitcoinFlowAlert(alertFlow),
          );
        }
      }
      state = result.state;
      await saveBitcoinState(config.stateFile, state);
    } catch (error) {
      process.stderr.write(
        `bitcoin watcher delivery error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
    refreshAggregate();
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, config.intervalMs),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runBitcoinWatcher(bitcoinConfigFromEnvironment()).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
