import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tokenSymbol } from "./history-provider.ts";

const BASE_URL = "https://api.trongrid.io";
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_PAGES = 4;
const MAX_SEEN = 20_000;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_PROVIDER_INTERVAL_MS = 700;
const MIN_PROVIDER_INTERVAL_MS = 350;
const MAX_PROVIDER_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ALERT_AGE_MS = 120_000;
const MIN_MAX_ALERT_AGE_MS = 1_000;
const MAX_MAX_ALERT_AGE_MS = 120_000;
const TRON_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{34}$/;
const TXID = /^[0-9a-fA-F]{64}$/;
const MAX_RECENT = 10_000;
const MAX_TELEGRAM_TEXT = 3_900;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const UINT = /^\d+$/;

export type TronDirection = "inflow" | "outflow" | "self";
export type TronTransferKind = "trc20" | "native";

export interface TronTransfer {
  id: string;
  chain: "tron";
  kind: TronTransferKind;
  direction: TronDirection;
  txid: string;
  watched: string;
  from: string;
  to: string;
  contract: string | null;
  symbol: string;
  decimals: number;
  rawAmount: string;
  amount: string;
  /** Optional provider-supplied total USD estimate; absent means unpriced. */
  valueUsd?: string | null;
  timestamp: string;
}

export interface TronPage {
  transfers: TronTransfer[];
  cursor: string | null;
  exhausted: boolean;
  warnings: string[];
}

export interface TronFetchOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  apiKey?: string;
  limit?: number;
  maxResponseBytes?: number;
  requestIntervalMs?: number;
  maxAlertAgeMs?: number;
  now?: () => number;
}

interface Cursor {
  v: 1;
  trc20: string | null;
  native: string | null;
  trc20Done: boolean;
  nativeDone: boolean;
}

interface EndpointPage {
  rows: unknown[];
  next: string | null;
  done: boolean;
  warnings: string[];
}

function invalid(message: string): Error {
  return new Error(`Invalid Tron provider data: ${message}`);
}

function assertAddress(address: string): string {
  if (!TRON_ADDRESS.test(address))
    throw new Error(`Invalid Tron address: ${address}`);
  return address;
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(`Tron page limit must be between 1 and ${MAX_LIMIT}.`);
  return limit;
}

function baseUrl(options: TronFetchOptions): string {
  return (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 4096) throw new Error();
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<Cursor>;
    if (
      parsed.v !== 1 ||
      (parsed.trc20 !== null && typeof parsed.trc20 !== "string") ||
      (parsed.native !== null && typeof parsed.native !== "string") ||
      typeof parsed.trc20Done !== "boolean" ||
      typeof parsed.nativeDone !== "boolean"
    )
      throw new Error();
    return {
      v: 1,
      trc20: parsed.trc20 ?? null,
      native: parsed.native ?? null,
      trc20Done: parsed.trc20Done,
      nativeDone: parsed.nativeDone,
    };
  } catch {
    throw new Error("Invalid Tron pagination cursor.");
  }
}

function checksum(bytes: Uint8Array): Uint8Array {
  return createHash("sha256")
    .update(createHash("sha256").update(bytes).digest())
    .digest();
}

function decodeBase58(value: string): Uint8Array {
  let number = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) throw invalid("malformed Tron address encoding");
    number = number * 58n + BigInt(index);
  }
  const digits: number[] = [];
  while (number > 0n) {
    digits.push(Number(number & 255n));
    number >>= 8n;
  }
  digits.reverse();
  let leading = 0;
  while (leading < value.length && value[leading] === "1") leading += 1;
  return Uint8Array.from([...new Array(leading).fill(0), ...digits]);
}

function tronHex(address: string): string {
  const bytes = decodeBase58(assertAddress(address));
  if (bytes.length !== 25 || bytes[0] !== 0x41)
    throw invalid("Tron address has an invalid length or network prefix");
  const body = bytes.slice(0, 21);
  const expected = checksum(body).slice(0, 4);
  if (Buffer.compare(Buffer.from(expected), Buffer.from(bytes.slice(21))) !== 0)
    throw invalid("Tron address checksum does not match");
  return Buffer.from(body).toString("hex");
}

function hexAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^41[0-9a-fA-F]{40}$/.test(value))
    return null;
  return value.toLowerCase();
}

function rawUnits(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value !== "string" || !UINT.test(value) || value.length > 100)
    throw invalid("malformed amount");
  return BigInt(value).toString();
}

function optionalUsd(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? String(value) : null;
  }
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    value.length > 100
  )
    return null;
  return value;
}

function optionalStableIndex(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 20)
    return null;
  return BigInt(value).toString();
}

function usdAtLeast(
  value: string | null | undefined,
  threshold: bigint,
): boolean {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  const [whole] = value.split(".");
  const wholeUnits = BigInt(whole);
  if (wholeUnits > threshold) return true;
  if (wholeUnits < threshold) return false;
  return true;
}

function validUsd(value: string | null | undefined): value is string {
  return Boolean(value && /^\d+(?:\.\d+)?$/.test(value));
}

function isExpiredCursorError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Tron pagination cursor expired."
  );
}

function decimalAmount(raw: string, decimals: number): string {
  const value = raw.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function direction(watched: string, from: string, to: string): TronDirection {
  const watchedHex = tronHex(watched);
  const fromHex = from.toLowerCase();
  const toHex = to.toLowerCase();
  return fromHex === watchedHex && toHex === watchedHex
    ? "self"
    : fromHex === watchedHex
      ? "outflow"
      : "inflow";
}

function timestamp(value: unknown): string {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
    throw invalid("malformed block timestamp");
  return new Date(value).toISOString();
}

function safeTxid(value: unknown): string {
  if (typeof value !== "string" || !TXID.test(value))
    throw invalid("malformed transaction id");
  return value.toLowerCase();
}

function parseTrc20(
  row: unknown,
  watched: string,
  _rowIndex: number,
): TronTransfer | null {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw invalid("malformed TRC-20 row");
  const item = row as Record<string, unknown>;
  const txid = safeTxid(item.transaction_id);
  const from = typeof item.from === "string" ? item.from : "";
  const to = typeof item.to === "string" ? item.to : "";
  if (!TRON_ADDRESS.test(from) || !TRON_ADDRESS.test(to))
    throw invalid("malformed TRC-20 participants");
  const token = item.token_info;
  if (!token || typeof token !== "object" || Array.isArray(token))
    throw invalid("missing TRC-20 metadata");
  const metadata = token as Record<string, unknown>;
  const contract =
    typeof metadata.address === "string" && TRON_ADDRESS.test(metadata.address)
      ? metadata.address
      : null;
  const symbol = tokenSymbol(metadata.symbol);
  const decimals =
    typeof metadata.decimals === "number" &&
    Number.isSafeInteger(metadata.decimals) &&
    metadata.decimals >= 0 &&
    metadata.decimals <= 255
      ? metadata.decimals
      : null;
  if (decimals === null) throw invalid("malformed TRC-20 decimals");
  const rawAmount = rawUnits(item.value);
  const valueUsd = optionalUsd(item.value_usd ?? item.valueUsd);
  const eventIndex = optionalStableIndex(
    item.event_index ?? item.log_index ?? item.eventIndex,
  );
  const time = timestamp(item.block_timestamp);
  // A row index is not stable: the same transfer shifts position when a newer
  // transaction is indexed. Identity must survive pagination and polling.
  const eventId = `${txid}:trc20:${contract ?? "unknown"}:${from}:${to}:${rawAmount}${eventIndex === null ? "" : `:${eventIndex}`}`;
  return {
    id: eventId,
    chain: "tron",
    kind: "trc20",
    direction: direction(watched, tronHex(from), tronHex(to)),
    txid,
    watched,
    from,
    to,
    contract,
    symbol,
    decimals,
    rawAmount,
    amount: decimalAmount(rawAmount, decimals),
    valueUsd,
    timestamp: time,
  };
}

function parseNative(
  row: unknown,
  watched: string,
  _rowIndex: number,
): TronTransfer | null {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw invalid("malformed native row");
  const item = row as Record<string, unknown>;
  const txid = safeTxid(item.txID);
  const rawData = item.raw_data;
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData))
    return null;
  const contracts = (rawData as Record<string, unknown>).contract;
  if (!Array.isArray(contracts)) return null;
  const transferContracts = contracts.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).type === "TransferContract",
  );
  if (transferContracts.length > 1)
    throw invalid(
      "multiple native transfer contracts lack a stable event index",
    );
  const contract = transferContracts[0];
  if (!contract || typeof contract !== "object" || Array.isArray(contract))
    return null;
  const parameter = (contract as Record<string, unknown>).parameter;
  const value =
    parameter && typeof parameter === "object" && !Array.isArray(parameter)
      ? (parameter as Record<string, unknown>).value
      : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const from = hexAddress(fields.owner_address);
  const to = hexAddress(fields.to_address);
  if (!from || !to) throw invalid("malformed native participants");
  const rawAmount = rawUnits(fields.amount);
  const valueUsd = optionalUsd(item.value_usd ?? item.valueUsd);
  const blockTimestamp =
    item.block_timestamp ?? (rawData as Record<string, unknown>).timestamp;
  const time = timestamp(blockTimestamp);
  // A provider row index changes whenever a newer transaction is indexed.
  // Use the transfer fields instead so pagination and polling retain identity.
  const eventId = `${txid}:native:${from}:${to}:${rawAmount}`;
  return {
    id: eventId,
    chain: "tron",
    kind: "native",
    direction: direction(watched, from, to),
    txid,
    watched,
    from,
    to,
    contract: null,
    symbol: "TRX",
    decimals: 6,
    rawAmount,
    amount: decimalAmount(rawAmount, 6),
    valueUsd,
    timestamp: time,
  };
}

async function json(
  fetcher: typeof fetch,
  url: string,
  options: TronFetchOptions,
  cursorProvided = false,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: options.apiKey
      ? { "TRON-PRO-API-KEY": options.apiKey }
      : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (cursorProvided && [400, 404, 410].includes(response.status))
      throw new Error("Tron pagination cursor expired.");
    throw new Error(`TronGrid returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error("TronGrid returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > (options.maxResponseBytes ?? MAX_RESPONSE_BYTES)) {
        await reader.cancel().catch(() => undefined);
        throw new Error("TronGrid response exceeded the byte budget.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString("utf8");
  try {
    return JSON.parse(joined);
  } catch {
    throw new Error("TronGrid returned malformed JSON.");
  }
}

function pacedFetcher(fetcher: typeof fetch, intervalMs: number): typeof fetch {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_PROVIDER_INTERVAL_MS ||
    intervalMs > MAX_PROVIDER_INTERVAL_MS
  )
    throw new Error(
      `Tron provider interval must be between ${MIN_PROVIDER_INTERVAL_MS} and ${MAX_PROVIDER_INTERVAL_MS} milliseconds.`,
    );
  let nextRequestAt = 0;
  return async (input, init) => {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay > 0)
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, delay),
      );
    try {
      return await fetcher(input, init);
    } finally {
      nextRequestAt = Date.now() + intervalMs;
    }
  };
}

async function endpointPage(
  path: string,
  address: string,
  fingerprint: string | null,
  options: TronFetchOptions,
): Promise<EndpointPage> {
  const limit = assertLimit(options.limit ?? DEFAULT_LIMIT);
  const url = new URL(
    `${baseUrl(options)}/v1/accounts/${encodeURIComponent(address)}/${path}`,
  );
  url.searchParams.set("only_confirmed", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("order_by", "block_timestamp,desc");
  if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
  const value = await json(
    options.fetch ?? fetch,
    url.toString(),
    options,
    Boolean(fingerprint),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${path} response is not an object`);
  const body = value as Record<string, unknown>;
  if (
    body.success === false &&
    fingerprint &&
    /(?:expired|invalid).*(?:fingerprint|cursor)|(?:fingerprint|cursor).*(?:expired|invalid)/i.test(
      JSON.stringify(body).slice(0, 2_000),
    )
  )
    throw new Error("Tron pagination cursor expired.");
  if (!Array.isArray(body.data))
    throw invalid(`${path} response is missing data`);
  const meta = body.meta;
  const next =
    meta &&
    typeof meta === "object" &&
    !Array.isArray(meta) &&
    typeof (meta as Record<string, unknown>).fingerprint === "string"
      ? ((meta as Record<string, unknown>).fingerprint as string)
      : null;
  const warnings: string[] = [];
  const failed = body.success === false;
  if (failed) warnings.push(`${path} response reported failure`);
  const rows = failed ? [] : body.data;
  const done = failed ? false : body.data.length < limit || !next;
  if (!failed && body.data.length >= limit && !next)
    warnings.push(
      `${path} page was full but returned no fingerprint; older rows may be uncovered`,
    );
  return { rows, next, done, warnings };
}

export async function fetchTronPage(
  addressValue: string,
  cursorValue: string | null = null,
  options: TronFetchOptions = {},
): Promise<TronPage> {
  const address = assertAddress(addressValue);
  const cursor = decodeCursor(cursorValue);
  const warnings: string[] = [];
  const transfers: TronTransfer[] = [];
  const trc20 = cursor?.trc20Done
    ? { rows: [], next: null, done: true, warnings: [] }
    : await endpointPage(
        "transactions/trc20",
        address,
        cursor?.trc20 ?? null,
        options,
      );
  const native = cursor?.nativeDone
    ? { rows: [], next: null, done: true, warnings: [] }
    : await endpointPage(
        "transactions",
        address,
        cursor?.native ?? null,
        options,
      );
  warnings.push(...trc20.warnings, ...native.warnings);
  for (const [index, row] of trc20.rows.entries()) {
    try {
      const parsed = parseTrc20(row, address, index);
      if (
        parsed &&
        parsed.direction !== "inflow" &&
        parsed.direction !== "outflow" &&
        parsed.direction !== "self"
      )
        continue;
      if (parsed) transfers.push(parsed);
    } catch (error) {
      warnings.push(
        `TRC-20 row ${index} omitted: ${error instanceof Error ? error.message : "malformed provider data"}`,
      );
    }
  }
  for (const [index, row] of native.rows.entries()) {
    try {
      const parsed = parseNative(row, address, index);
      if (
        parsed &&
        parsed.direction !== "inflow" &&
        parsed.direction !== "outflow" &&
        parsed.direction !== "self"
      )
        continue;
      if (parsed) transfers.push(parsed);
    } catch (error) {
      warnings.push(
        `native row ${index} omitted: ${error instanceof Error ? error.message : "malformed provider data"}`,
      );
    }
  }
  const duplicateIds = new Set<string>();
  const firstSeenIds = new Set<string>();
  for (const transfer of transfers) {
    if (firstSeenIds.has(transfer.id)) duplicateIds.add(transfer.id);
    else firstSeenIds.add(transfer.id);
  }
  if (duplicateIds.size)
    warnings.push(
      `${duplicateIds.size} transfer(s) omitted because the provider supplied no stable event identity`,
    );
  const stableTransfers = transfers.filter(
    (transfer) => !duplicateIds.has(transfer.id),
  );
  stableTransfers.sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id),
  );
  const nextCursor: Cursor = {
    v: 1,
    trc20: trc20.next,
    native: native.next,
    trc20Done: trc20.done,
    nativeDone: native.done,
  };
  const exhausted = trc20.done && native.done;
  return {
    transfers: stableTransfers,
    cursor: exhausted ? null : encodeCursor(nextCursor),
    exhausted,
    warnings,
  };
}

export interface TronBalanceItem {
  contract: string | null;
  symbol: string;
  decimals: number;
  rawAmount: string;
  amount: string;
  valueUsd: string | null;
}

export interface TronBalanceSnapshot {
  address: string;
  native: TronBalanceItem | null;
  tokens: Record<string, TronBalanceItem>;
  retrievedAt: string;
  tokenListComplete: boolean;
  warnings: string[];
  scope?: "wallet" | "tracked";
  trackedAddresses?: number;
}

/** Reads the confirmed account snapshot. TronGrid does not provide reliable
 * token USD quotes here, so valueUsd stays null unless a future provider adds
 * an explicitly parsed quote. An omitted token row is not a zero balance: the
 * endpoint's token list is not a proof that a particular asset is absent. */
export async function fetchTronBalanceSnapshot(
  addressValue: string,
  options: TronFetchOptions = {},
): Promise<TronBalanceSnapshot> {
  const address = assertAddress(addressValue);
  const url = new URL(
    `${baseUrl(options)}/v1/accounts/${encodeURIComponent(address)}`,
  );
  url.searchParams.set("only_confirmed", "true");
  const body = await json(options.fetch ?? fetch, url.toString(), options);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw invalid("account response is not an object");
  const root = body as Record<string, unknown>;
  if (!Array.isArray(root.data) || !root.data.length)
    throw invalid("account response is missing data");
  const account = root.data[0];
  if (!account || typeof account !== "object" || Array.isArray(account))
    throw invalid("account row is malformed");
  const row = account as Record<string, unknown>;
  const nativeRawValue = row.balance;
  const warnings: string[] = [];
  const nativeRaw =
    nativeRawValue === undefined || nativeRawValue === null
      ? null
      : rawUnits(nativeRawValue);
  if (nativeRaw === null)
    warnings.push("TronGrid account response omitted the native balance");
  const tokens: Record<string, TronBalanceItem> = {};
  const tokenList = row.trc20;
  const tokenListComplete = Array.isArray(tokenList);
  if (tokenListComplete) {
    for (const [rowIndex, item] of tokenList.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        warnings.push(`trc20 balance row ${rowIndex} omitted`);
        continue;
      }
      for (const [contract, value] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!TRON_ADDRESS.test(contract)) {
          warnings.push(
            `trc20 balance row ${rowIndex} has an invalid contract`,
          );
          continue;
        }
        try {
          const raw = rawUnits(value);
          tokens[contract] = {
            contract,
            symbol: "TRC20",
            decimals: 0,
            rawAmount: raw,
            amount: raw,
            valueUsd: null,
          };
        } catch {
          warnings.push(`trc20 balance row ${rowIndex} has an invalid amount`);
        }
      }
    }
  } else {
    warnings.push("TronGrid account response omitted the complete trc20 list");
  }
  return {
    address,
    native:
      nativeRaw === null
        ? null
        : {
            contract: null,
            symbol: "TRX",
            decimals: 6,
            rawAmount: nativeRaw,
            amount: decimalAmount(nativeRaw, 6),
            valueUsd: null,
          },
    tokens,
    retrievedAt: new Date().toISOString(),
    tokenListComplete,
    warnings,
    scope: "wallet",
    trackedAddresses: 1,
  };
}

export function aggregateTronBalances(
  snapshots: readonly (TronBalanceSnapshot | null)[],
  trackedAddresses: readonly string[],
): TronBalanceSnapshot {
  const complete =
    snapshots.length === trackedAddresses.length &&
    snapshots.every(
      (snapshot) =>
        snapshot !== null &&
        snapshot.scope !== "tracked" &&
        snapshot.native !== null &&
        snapshot.tokenListComplete,
    );
  const validSnapshots = snapshots.filter(
    (snapshot): snapshot is TronBalanceSnapshot => snapshot !== null,
  );
  const warnings = validSnapshots.flatMap((snapshot) => snapshot.warnings);
  if (!complete) warnings.push("tracked Tron balance coverage is incomplete");
  const native = complete
    ? {
        contract: null,
        symbol: "TRX",
        decimals: 6,
        rawAmount: validSnapshots
          .reduce(
            (total, snapshot) => total + BigInt(snapshot.native!.rawAmount),
            0n,
          )
          .toString(),
        amount: "0",
        valueUsd: null,
      }
    : null;
  if (native) native.amount = decimalAmount(native.rawAmount, native.decimals);
  const tokens: Record<string, TronBalanceItem> = {};
  if (complete) {
    const contracts = new Set(
      validSnapshots.flatMap((snapshot) => Object.keys(snapshot.tokens)),
    );
    for (const contract of contracts) {
      if (!validSnapshots.every((snapshot) => snapshot.tokens[contract]))
        continue;
      const first = validSnapshots[0]!.tokens[contract]!;
      const rawAmount = validSnapshots
        .reduce(
          (total, snapshot) =>
            total + BigInt(snapshot.tokens[contract]!.rawAmount),
          0n,
        )
        .toString();
      tokens[contract] = {
        ...first,
        rawAmount,
        amount: rawAmount,
      };
    }
  }
  return {
    address: "tracked",
    native,
    tokens,
    retrievedAt: new Date().toISOString(),
    tokenListComplete: complete,
    warnings: [...new Set(warnings)],
    scope: "tracked",
    trackedAddresses: trackedAddresses.length,
  };
}

export function remainingTronBalance(
  snapshot: TronBalanceSnapshot,
  transfer: TronTransfer,
): TronBalanceItem | null {
  if (snapshot.scope !== "tracked") return null;
  if (transfer.kind === "native") return snapshot.native;
  if (!transfer.contract) return null;
  const known = snapshot.tokens[transfer.contract];
  if (known)
    return {
      ...known,
      symbol: transfer.symbol,
      decimals: transfer.decimals,
      amount: decimalAmount(known.rawAmount, transfer.decimals),
    };
  return null;
}

interface TronWalletState {
  seen: string[];
  bootstrapped: boolean;
  pendingCursor?: string | null;
}

export interface TronWatchState {
  version: 1;
  wallets: Record<string, TronWalletState>;
  health?: { fingerprint?: string; notifiedFingerprint?: string };
  pending?: Record<string, TronTransfer>;
  recent?: Record<string, TronTransfer>;
}

export interface TronPollResult {
  state: TronWatchState;
  transfers: TronTransfer[];
  warnings: string[];
  errors: string[];
}

export interface TronEnvironmentConfig {
  addresses: string[];
  token: string;
  chatId: string;
  telegramEnabled?: boolean;
  stateFile: string;
  intervalMs: number;
  providerIntervalMs: number;
  maxAlertAgeMs: number;
  baseUrl: string;
  apiKey?: string;
}

function parsePositiveInteger(
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

export function tronConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TronEnvironmentConfig {
  const addressText = env.TRON_WATCH_ADDRESSES?.trim();
  if (!addressText) throw new Error("TRON_WATCH_ADDRESSES is required");
  const addresses = [
    ...new Set(
      addressText.split(",").map((item) => assertAddress(item.trim())),
    ),
  ];
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const telegramEnabled = parseBoolean(
    env.TRON_WATCH_TELEGRAM_ENABLED,
    true,
    "TRON_WATCH_TELEGRAM_ENABLED",
  );
  const intervalMs = parsePositiveInteger(env.TRON_WATCH_INTERVAL_MS, 60_000);
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    throw new Error(
      `TRON_WATCH_INTERVAL_MS must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  const providerIntervalMs = parsePositiveInteger(
    env.TRON_PROVIDER_INTERVAL_MS,
    DEFAULT_PROVIDER_INTERVAL_MS,
  );
  if (
    providerIntervalMs < MIN_PROVIDER_INTERVAL_MS ||
    providerIntervalMs > MAX_PROVIDER_INTERVAL_MS
  )
    throw new Error(
      `TRON_PROVIDER_INTERVAL_MS must be between ${MIN_PROVIDER_INTERVAL_MS} and ${MAX_PROVIDER_INTERVAL_MS}`,
    );
  const maxAlertAgeMs = parsePositiveInteger(
    env.TRON_WATCH_MAX_ALERT_AGE_MS,
    DEFAULT_MAX_ALERT_AGE_MS,
  );
  if (
    maxAlertAgeMs < MIN_MAX_ALERT_AGE_MS ||
    maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS
  )
    throw new Error(
      `TRON_WATCH_MAX_ALERT_AGE_MS must be between ${MIN_MAX_ALERT_AGE_MS} and ${MAX_MAX_ALERT_AGE_MS}`,
    );
  return {
    addresses,
    token,
    chatId,
    telegramEnabled,
    stateFile: resolve(env.TRON_WATCH_STATE_FILE || ".local/tron-watcher.json"),
    intervalMs,
    providerIntervalMs,
    maxAlertAgeMs,
    baseUrl: (env.TRONGRID_BASE_URL || BASE_URL).replace(/\/+$/, ""),
    apiKey: env.TRONGRID_API_KEY?.trim() || undefined,
  };
}

export function createInitialTronState(addresses: string[]): TronWatchState {
  const wallets: TronWatchState["wallets"] = {};
  for (const address of addresses)
    wallets[assertAddress(address)] = { seen: [], bootstrapped: false };
  return { version: 1, wallets, pending: {}, recent: {} };
}

function normalizeWallet(value: unknown): TronWalletState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { seen: [], bootstrapped: false };
  const row = value as Record<string, unknown>;
  return {
    seen: Array.isArray(row.seen)
      ? row.seen
          .filter((item): item is string => typeof item === "string")
          .slice(-MAX_SEEN)
      : [],
    bootstrapped: row.bootstrapped === true,
    ...(typeof row.pendingCursor === "string"
      ? { pendingCursor: row.pendingCursor }
      : {}),
  };
}

function normalizeTransferRecord(value: unknown): Record<string, TronTransfer> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TronTransfer> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).id === "string"
    )
      result[key] = item as TronTransfer;
  }
  return result;
}

function trimTransferRecord(
  value: Record<string, TronTransfer>,
): Record<string, TronTransfer> {
  const entries = Object.entries(value);
  return Object.fromEntries(entries.slice(-MAX_RECENT));
}

function cursorAfterOverlap(
  value: string | null,
  overlapKinds: Set<TronTransferKind>,
): string | null {
  const cursor = decodeCursor(value);
  if (!cursor) return null;
  if (overlapKinds.has("trc20")) cursor.trc20Done = true;
  if (overlapKinds.has("native")) cursor.nativeDone = true;
  return cursor.trc20Done && cursor.nativeDone ? null : encodeCursor(cursor);
}

function suppressSwapRelatedInflows(
  transfers: TronTransfer[],
  context: TronTransfer[] = transfers,
): TronTransfer[] {
  const byTransaction = new Map<string, TronTransfer[]>();
  for (const transfer of context) {
    const rows = byTransaction.get(transfer.txid) ?? [];
    rows.push(transfer);
    byTransaction.set(transfer.txid, rows);
  }
  return transfers.filter((transfer) => {
    if (transfer.direction !== "inflow") return true;
    const rows = byTransaction.get(transfer.txid) ?? [];
    return !rows.some(
      (other) =>
        other.direction === "outflow" &&
        (other.kind !== transfer.kind || other.contract !== transfer.contract),
    );
  });
}

function retainAlertableTransfers(
  transfers: TronTransfer[],
  warnings: string[],
): TronTransfer[] {
  return transfers.filter((transfer) => {
    if (transfer.direction !== "inflow") return true;
    if (!validUsd(transfer.valueUsd)) {
      warnings.push(
        `${transfer.watched}: inflow suppressed (USD value unavailable)`,
      );
      return false;
    }
    if (!usdAtLeast(transfer.valueUsd, 1_000n)) {
      warnings.push(
        `${transfer.watched}: inflow suppressed (USD value below $1,000)`,
      );
      return false;
    }
    return true;
  });
}

function retainFreshPendingTransfers(
  transfers: TronTransfer[],
  now: number,
  maxAlertAgeMs: number,
  warnings: string[],
): TronTransfer[] {
  return transfers.filter((transfer) => {
    const observedAt = Date.parse(transfer.timestamp);
    const age = now - observedAt;
    if (!Number.isFinite(observedAt) || age > maxAlertAgeMs) {
      warnings.push(
        `${transfer.watched}: stale pending alert suppressed (${Number.isFinite(age) ? `${Math.floor(age / 1000)}s old` : "invalid timestamp"})`,
      );
      return false;
    }
    return true;
  });
}

export async function pollTronOnce(
  addresses: string[],
  previous: TronWatchState,
  options: TronFetchOptions = {},
): Promise<TronPollResult> {
  const state = createInitialTronState(addresses);
  if (!previous || previous.version !== 1 || !previous.wallets)
    throw new Error("Unsupported Tron watcher state.");
  state.health = previous.health;
  state.pending = normalizeTransferRecord(previous.pending);
  const recent = normalizeTransferRecord(previous.recent);
  state.recent = recent;
  const newTransfers: TronTransfer[] = [];
  const observedAll: TronTransfer[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const now = options.now?.() ?? Date.now();
  const maxAlertAgeMs = options.maxAlertAgeMs ?? DEFAULT_MAX_ALERT_AGE_MS;
  if (
    !Number.isSafeInteger(maxAlertAgeMs) ||
    maxAlertAgeMs < MIN_MAX_ALERT_AGE_MS ||
    maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS
  )
    throw new Error(
      `Tron alert age must be between ${MIN_MAX_ALERT_AGE_MS} and ${MAX_MAX_ALERT_AGE_MS} milliseconds.`,
    );
  const requestOptions = options.fetch
    ? options
    : {
        ...options,
        fetch: pacedFetcher(
          fetch,
          options.requestIntervalMs ?? DEFAULT_PROVIDER_INTERVAL_MS,
        ),
      };
  for (const addressValue of addresses) {
    const address = assertAddress(addressValue);
    const prior = normalizeWallet(previous.wallets[address]);
    const scanAddress = async (startCursor: string | null) => {
      const wallet = { ...prior, seen: [...prior.seen] };
      const seen = new Set(wallet.seen);
      const observed: TronTransfer[] = [];
      const addressNewTransfers: TronTransfer[] = [];
      const scanWarnings: string[] = [];
      const overlapKinds = new Set<TronTransferKind>();
      let cursor = startCursor;
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        const page = await fetchTronPage(address, cursor, requestOptions);
        scanWarnings.push(
          ...page.warnings.map((warning) => `${address}: ${warning}`),
        );
        for (const transfer of page.transfers) {
          observed.push(transfer);
          if (seen.has(transfer.id)) overlapKinds.add(transfer.kind);
          else {
            seen.add(transfer.id);
            wallet.seen.push(transfer.id);
            if (wallet.bootstrapped) {
              const observedAt = Date.parse(transfer.timestamp);
              const age = now - observedAt;
              if (Number.isFinite(age) && age > maxAlertAgeMs)
                scanWarnings.push(
                  `${address}: stale transfer suppressed (${Math.floor(age / 1000)}s old)`,
                );
              else addressNewTransfers.push(transfer);
            }
          }
        }
        cursor = cursorAfterOverlap(page.cursor, overlapKinds);
        if (page.exhausted || !cursor) break;
        if (pageIndex === MAX_PAGES - 1) {
          scanWarnings.push(
            `${address}: possible coverage gap after ${MAX_PAGES} bounded pages`,
          );
          break;
        }
      }
      wallet.seen = [...new Set(wallet.seen)].slice(-MAX_SEEN);
      wallet.pendingCursor = cursor;
      // A bounded catch-up can span several polls. Do not turn historical
      // rows into live alerts until both provider streams are exhausted.
      wallet.bootstrapped = prior.bootstrapped || cursor === null;
      return { wallet, observed, addressNewTransfers, scanWarnings };
    };

    const commitScan = (scanned: Awaited<ReturnType<typeof scanAddress>>) => {
      state.wallets[address] = scanned.wallet;
      warnings.push(...scanned.scanWarnings);
      observedAll.push(...scanned.observed);
      newTransfers.push(...scanned.addressNewTransfers);
      for (const transfer of scanned.observed) recent[transfer.id] = transfer;
    };

    try {
      commitScan(await scanAddress(prior.pendingCursor ?? null));
    } catch (error) {
      if (isExpiredCursorError(error)) {
        warnings.push(
          `${address}: pagination cursor expired; restarted from latest page; older coverage may be incomplete`,
        );
        try {
          commitScan(await scanAddress(null));
        } catch (retryError) {
          errors.push(
            `${address}: ${retryError instanceof Error ? retryError.message : "unknown provider failure"}`,
          );
          state.wallets[address] = {
            ...prior,
            seen: [...new Set(prior.seen)].slice(-MAX_SEEN),
          };
        }
      } else {
        errors.push(
          `${address}: ${error instanceof Error ? error.message : "unknown provider failure"}`,
        );
        state.wallets[address] = {
          ...prior,
          seen: [...new Set(prior.seen)].slice(-MAX_SEEN),
        };
      }
    }
  }

  state.recent = trimTransferRecord(recent);
  const context = [...Object.values(recent), ...observedAll];
  const retainedSwapPending = suppressSwapRelatedInflows(
    Object.values(state.pending),
    context,
  );
  const freshPending = retainFreshPendingTransfers(
    retainedSwapPending,
    now,
    maxAlertAgeMs,
    warnings,
  );
  const retainedPending = retainAlertableTransfers(freshPending, warnings);
  state.pending = Object.fromEntries(
    retainedPending.map((transfer) => [transfer.id, transfer]),
  );
  const eligible = retainAlertableTransfers(
    suppressSwapRelatedInflows(newTransfers, context),
    warnings,
  );
  for (const transfer of eligible) state.pending[transfer.id] = transfer;
  return {
    state,
    transfers: eligible,
    warnings: [...new Set(warnings)],
    errors,
  };
}

export async function loadTronState(
  path: string,
  addresses: string[],
): Promise<TronWatchState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as TronWatchState;
    if (value.version !== 1 || !value.wallets)
      throw new Error("Unsupported Tron watcher state.");
    const state = createInitialTronState(addresses);
    state.health = value.health;
    state.pending = normalizeTransferRecord(value.pending);
    state.recent = trimTransferRecord(normalizeTransferRecord(value.recent));
    for (const address of addresses)
      state.wallets[assertAddress(address)] = normalizeWallet(
        value.wallets[address],
      );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialTronState(addresses);
    throw error;
  }
}

export async function saveTronState(
  path: string,
  state: TronWatchState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function displayAmount(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return value;
  let roundedWhole = BigInt(whole || "0");
  let hundredths = Number(fraction.padEnd(3, "0").slice(0, 2));
  if (Number(fraction.padEnd(3, "0")[2]) >= 5) {
    hundredths += 1;
    if (hundredths === 100) {
      roundedWhole += 1n;
      hundredths = 0;
    }
  }
  const grouped = roundedWhole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${String(hundredths).padStart(2, "0")}`;
}

function displayUsd(value: string | null): string {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return "unavailable";
  const number = Number(value);
  if (!Number.isFinite(number)) return "unavailable";
  if (number >= 1_000_000_000)
    return `≈$${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `≈$${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `≈$${(number / 1_000).toFixed(2)}K`;
  return `≈$${number.toFixed(2)}`;
}

function displayUtcTime(timestamp: string): string {
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

export function formatTronAlert(
  transfer: TronTransfer,
  snapshot?: TronBalanceSnapshot | null,
): string {
  const symbol = tokenSymbol(transfer.symbol);
  const heading =
    transfer.direction === "inflow"
      ? `💰 ${symbol} INFLOW`
      : transfer.direction === "self"
        ? `🔄 ${symbol} SELF-TRANSFER`
        : `🚨 ${symbol} OUTFLOW`;
  const time = displayUtcTime(transfer.timestamp);
  const remaining = snapshot ? remainingTronBalance(snapshot, transfer) : null;
  return [
    heading,
    `Amount: ${displayAmount(transfer.amount)} ${symbol} · ${displayUsd(transfer.valueUsd ?? null)}`,
    remaining
      ? `Remaining: ${displayAmount(remaining.amount)} ${tokenSymbol(remaining.symbol)}${remaining.valueUsd === null ? "" : ` · ${displayUsd(remaining.valueUsd)}`}`
      : "Remaining: unavailable",
    `🕒 ${time} UTC`,
  ].join("\n");
}

export const TRON_WATCH_LIMITS = {
  maxPages: MAX_PAGES,
  maxSeen: MAX_SEEN,
  minIntervalMs: MIN_INTERVAL_MS,
  maxIntervalMs: MAX_INTERVAL_MS,
  minProviderIntervalMs: MIN_PROVIDER_INTERVAL_MS,
  maxProviderIntervalMs: MAX_PROVIDER_INTERVAL_MS,
  maxAlertAgeMs: MAX_MAX_ALERT_AGE_MS,
} as const;

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
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Telegram send failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };
  if (!body.ok)
    throw new Error(
      `Telegram rejected message: ${body.description ?? "unknown error"}`,
    );
}

export interface TronAlertBatch {
  ids: string[];
  text: string;
}

export function buildTronAlertBatches(
  alerts: Array<{ id: string; text: string }>,
  maxTextLength = MAX_TELEGRAM_TEXT,
): TronAlertBatch[] {
  if (!Number.isSafeInteger(maxTextLength) || maxTextLength < 1)
    throw new Error("Telegram batch size must be a positive integer.");
  const batches: TronAlertBatch[] = [];
  let current: TronAlertBatch | null = null;
  for (const alert of alerts) {
    const separator = current ? "\n\n" : "";
    if (
      current &&
      current.text.length + separator.length + alert.text.length > maxTextLength
    ) {
      batches.push(current);
      current = null;
    }
    if (!current) current = { ids: [], text: "" };
    current.ids.push(alert.id);
    current.text += `${current.text ? "\n\n" : ""}${alert.text}`;
  }
  if (current) batches.push(current);
  return batches;
}

export async function deliverTronAlertBatches(
  state: TronWatchState,
  batches: readonly TronAlertBatch[],
  sendMessage: (text: string, index: number) => Promise<void>,
  persist: (state: TronWatchState) => Promise<void>,
  options: { enabled?: boolean } = {},
): Promise<{
  state: TronWatchState;
  delivered: string[];
  dropped?: string[];
  error?: Error;
}> {
  if (!state.pending) state.pending = {};
  if (options.enabled === false) {
    const dropped = Object.keys(state.pending);
    if (!dropped.length) return { state, delivered: [], dropped };
    const next = { ...state, pending: {} };
    try {
      await persist(next);
    } catch (error) {
      return {
        state,
        delivered: [],
        dropped: [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    return { state: next, delivered: [], dropped };
  }
  const delivered: string[] = [];
  for (const [index, batch] of batches.entries()) {
    const sentItems = batch.ids
      .map((id) => [id, state.pending?.[id]] as const)
      .filter((entry): entry is readonly [string, TronTransfer] =>
        Boolean(entry[1]),
      );
    if (!sentItems.length) continue;
    try {
      await sendMessage(batch.text, index);
    } catch (error) {
      return {
        state,
        delivered,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    for (const [id] of sentItems) delete state.pending[id];
    try {
      await persist(state);
    } catch (error) {
      for (const [id, transfer] of sentItems) state.pending[id] = transfer;
      return {
        state,
        delivered,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    delivered.push(...sentItems.map(([id]) => id));
  }
  return { state, delivered };
}

function healthFingerprint(result: TronPollResult): string | null {
  const messages = [...result.errors, ...result.warnings]
    .map((message) => message.replace(/^[1-9A-HJ-NP-Za-km-z]{34}:\s*/, ""))
    .filter(Boolean);
  return messages.length
    ? [...new Set(messages)].join(" | ").slice(0, 900)
    : null;
}

function healthMessage(fingerprint: string, recovered: boolean): string {
  return recovered
    ? "✅ TRON monitor coverage recovered"
    : `⚠️ TRON monitor coverage impaired\n${fingerprint}`;
}

export async function runTronWatcher(
  config: TronEnvironmentConfig,
): Promise<never> {
  const telegramEnabled = config.telegramEnabled !== false;
  let state = await loadTronState(config.stateFile, config.addresses);
  const sharedFetch = pacedFetcher(fetch, config.providerIntervalMs);
  if (Object.values(state.wallets).some((wallet) => !wallet.bootstrapped)) {
    process.stderr.write(
      `tron watcher starting; bootstrapping existing history silently for ${config.addresses.length} address(es)\n`,
    );
  }
  for (;;) {
    const result = await pollTronOnce(config.addresses, state, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetch: sharedFetch,
      maxAlertAgeMs: config.maxAlertAgeMs,
    });
    for (const warning of result.warnings)
      process.stderr.write(`tron watcher warning: ${warning}\n`);
    for (const error of result.errors)
      process.stderr.write(`tron watcher error: ${error}\n`);
    const fingerprint = healthFingerprint(result);
    const priorFingerprint = state.health?.notifiedFingerprint;
    const health = fingerprint
      ? priorFingerprint === fingerprint
        ? null
        : healthMessage(fingerprint, false)
      : priorFingerprint
        ? healthMessage("", true)
        : null;
    result.state.health = fingerprint
      ? { fingerprint, notifiedFingerprint: fingerprint }
      : undefined;
    state = result.state;
    if (health)
      process.stderr.write(
        `tron watcher health: ${health.replace(/\n/g, " | ")}\n`,
      );
    let persisted = false;
    try {
      await saveTronState(config.stateFile, state);
      persisted = true;
    } catch (error) {
      process.stderr.write(
        `tron watcher state persistence error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
    if (persisted) {
      if (!telegramEnabled) {
        const delivery = await deliverTronAlertBatches(
          state,
          [],
          async () => undefined,
          (next) => saveTronState(config.stateFile, next),
          { enabled: false },
        );
        state = delivery.state;
        if (delivery.dropped?.length)
          process.stderr.write(
            `tron watcher Telegram delivery disabled; dropped ${delivery.dropped.length} pending alert(s)\n`,
          );
        if (delivery.error)
          process.stderr.write(
            `tron watcher delivery error: ${delivery.error.message}\n`,
          );
      } else {
        const snapshots: Array<TronBalanceSnapshot | null> = [];
        for (const address of config.addresses) {
          snapshots.push(
            await fetchTronBalanceSnapshot(address, {
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              fetch: sharedFetch,
            }).catch(() => null),
          );
        }
        const aggregate = aggregateTronBalances(snapshots, config.addresses);
        for (const warning of aggregate.warnings)
          process.stderr.write(`tron watcher balance warning: ${warning}\n`);
        const alerts: Array<{ id: string; text: string }> = [];
        for (const transfer of Object.values(state.pending ?? {})) {
          alerts.push({
            id: transfer.id,
            text: formatTronAlert(transfer, aggregate),
          });
        }
        const batches = buildTronAlertBatches(alerts);
        const delivery = await deliverTronAlertBatches(
          state,
          batches,
          (text) => sendTelegramMessage(config.token, config.chatId, text),
          (next) => saveTronState(config.stateFile, next),
        );
        state = delivery.state;
        if (delivery.error)
          process.stderr.write(
            `tron watcher delivery error: ${delivery.error.message}\n`,
          );
      }
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
  runTronWatcher(tronConfigFromEnvironment()).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
