import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundedJson, ProviderError } from "./history-provider.ts";

const PUBLIC_RPC = "https://api.mainnet.solana.com";
const HELIUS_RPC = "https://mainnet.helius-rpc.com/";
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;
const UINT = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const MAX_RESPONSE_BYTES = 8_000_000;
// Public Solana RPCs can time out while walking several history pages. One
// bounded page keeps the live poll responsive; the durable cursor backfills
// older rows on later polls and marks the scope partial when it cannot keep up.
const SIGNATURE_PAGE_SIZE = 50;
const MAX_SIGNATURE_PAGES = 1;
const MAX_BACKFILL_PAGES = 2;
const MAX_TRANSACTION_FETCHES = 20;
const MAX_PENDING = 1_000;
const MAX_SEEN = 10_000;
const MAX_TOKEN_ACCOUNTS = 5_000;
const MAX_DECIMALS = 255;
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_PROVIDER_INTERVAL_MS = 300;
const MIN_PROVIDER_INTERVAL_MS = 250;
const MAX_PROVIDER_INTERVAL_MS = 10_000;
const MAX_MISSING_ATTEMPTS = 3;
const DEFAULT_MAX_ALERT_AGE_MS = 120_000;
const MAX_MAX_ALERT_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_ALERT_USD = "1000";
const MAX_MIN_ALERT_USD_LENGTH = 64;
const MAX_PRICE_MINTS = 50;
const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export type SolanaDirection = "inflow" | "outflow";

export interface SolanaSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string | null;
}

export interface SolanaTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  meta: Record<string, unknown> | null;
  transaction: Record<string, unknown>;
}

export interface SolanaBalanceToken {
  mint: string;
  rawAmount: string;
  decimals: number;
}

export interface SolanaBalanceSnapshot {
  nativeLamports: string;
  tokens: SolanaBalanceToken[];
}

export interface SolanaProvider {
  fetchSignatures(address: string, before?: string): Promise<SolanaSignature[]>;
  fetchTransaction(signature: string): Promise<SolanaTransaction | null>;
  fetchBalances(address: string): Promise<SolanaBalanceSnapshot>;
  fetchUsdPrices?(mints: string[]): Promise<Map<string, string>>;
}

export interface SolanaFlow {
  /** Internal delivery scope; alert formatting intentionally omits it. */
  watchAddress?: string;
  signature: string;
  slot: number;
  direction: SolanaDirection;
  mint: string | null;
  symbol: string;
  decimals: number;
  rawAmount: string;
  remainingRaw: string | null;
  remainingSymbol: string | null;
  timestamp: string | null;
  usdValue?: string | null;
  remainingUsdValue?: string | null;
  isFee?: boolean;
  confirmed: boolean;
}

export interface SolanaPendingSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  attempts: number;
}

export interface SolanaAddressState {
  seen: string[];
  pending: SolanaPendingSignature[];
  bootstrapped: boolean;
  gap: boolean;
  backfillBefore?: string;
  lastError?: string;
}

export interface SolanaWatchState {
  version: 1;
  addresses: Record<string, SolanaAddressState>;
}

export interface SolanaWatchConfig {
  addresses: string[];
  maxAlertAgeMs?: number;
  minAlertUsd?: string;
  backfill?: boolean;
}

export interface SolanaPollResult {
  state: SolanaWatchState;
  flows: SolanaFlow[];
  warnings: string[];
  errors: string[];
  gaps: string[];
}

export interface SolanaEnvironmentConfig extends SolanaWatchConfig {
  token: string;
  chatId: string;
  alertsEnabled: boolean;
  stateFile: string;
  intervalMs: number;
  providerIntervalMs: number;
  maxAlertAgeMs: number;
  minAlertUsd: string;
  backfill: boolean;
  rpcUrl?: string;
  heliusApiKey?: string;
  jupiterApiKey?: string;
}

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function isSolanaAddress(value: unknown): value is string {
  return typeof value === "string" && SOLANA_ADDRESS.test(value);
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE.test(value);
}

function uint(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ProviderError("INVALID_PROVIDER_DATA", `Malformed ${field}.`);
    return String(value);
  }
  if (typeof value !== "string" || !UINT.test(value) || value.length > 100)
    throw new ProviderError("INVALID_PROVIDER_DATA", `Malformed ${field}.`);
  return BigInt(value).toString();
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProviderError("INVALID_PROVIDER_DATA", `Malformed ${field}.`);
  return value;
}

function decimals(value: unknown, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_DECIMALS
  )
    throw new ProviderError("INVALID_PROVIDER_DATA", `Malformed ${field}.`);
  return value as number;
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

function canonicalDecimal(value: string, field: string): string {
  if (!DECIMAL.test(value) || value.length > MAX_MIN_ALERT_USD_LENGTH)
    throw new Error(`${field} must be a non-negative decimal.`);
  const [whole, fraction = ""] = value.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function booleanConfig(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error("Expected a boolean configuration value.");
}

export function parseSolanaAddresses(value: string): string[] {
  const addresses = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => {
      if (!isSolanaAddress(address))
        throw new Error(`Invalid Solana address: ${address}`);
      return address;
    });
  if (!addresses.length)
    throw new Error(
      "FLOWLENS_SOLANA_ADDRESSES must contain at least one address",
    );
  return [...new Set(addresses)];
}

export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SolanaEnvironmentConfig {
  const addressText =
    env.FLOWLENS_SOLANA_ADDRESSES ?? env.FLOWLENS_SOLANA_ADDRESS;
  if (!addressText) throw new Error("FLOWLENS_SOLANA_ADDRESSES is required");
  const alertsEnabled = booleanConfig(env.FLOWLENS_SOLANA_ALERTS_ENABLED, true);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (alertsEnabled && !token)
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (alertsEnabled && !chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const intervalMs = nonNegativeInteger(
    env.FLOWLENS_SOLANA_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    throw new Error(
      `FLOWLENS_SOLANA_INTERVAL_MS must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  const providerIntervalMs = nonNegativeInteger(
    env.FLOWLENS_SOLANA_PROVIDER_INTERVAL_MS,
    DEFAULT_PROVIDER_INTERVAL_MS,
  );
  if (
    providerIntervalMs < MIN_PROVIDER_INTERVAL_MS ||
    providerIntervalMs > MAX_PROVIDER_INTERVAL_MS
  )
    throw new Error(
      `FLOWLENS_SOLANA_PROVIDER_INTERVAL_MS must be between ${MIN_PROVIDER_INTERVAL_MS} and ${MAX_PROVIDER_INTERVAL_MS}`,
    );
  const maxAlertAgeMs = nonNegativeInteger(
    env.FLOWLENS_SOLANA_MAX_ALERT_AGE_MS,
    DEFAULT_MAX_ALERT_AGE_MS,
  );
  if (maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS)
    throw new Error(
      `FLOWLENS_SOLANA_MAX_ALERT_AGE_MS must be at most ${MAX_MAX_ALERT_AGE_MS}`,
    );
  const minAlertUsd = canonicalDecimal(
    env.FLOWLENS_SOLANA_MIN_ALERT_USD ?? DEFAULT_MIN_ALERT_USD,
    "FLOWLENS_SOLANA_MIN_ALERT_USD",
  );
  const backfill = booleanConfig(env.FLOWLENS_SOLANA_BACKFILL, false);
  return {
    addresses: parseSolanaAddresses(addressText),
    token: token ?? "",
    chatId: chatId ?? "",
    alertsEnabled,
    stateFile: resolve(
      env.FLOWLENS_SOLANA_STATE_FILE ?? ".local/solana-watcher.json",
    ),
    intervalMs,
    providerIntervalMs,
    maxAlertAgeMs,
    minAlertUsd,
    backfill,
    rpcUrl: env.FLOWLENS_SOLANA_RPC_URL?.trim() || undefined,
    heliusApiKey:
      env.FLOWLENS_SOLANA_HELIUS_API_KEY?.trim() ||
      env.HELIUS_API_KEY?.trim() ||
      undefined,
    jupiterApiKey: env.JUPITER_API_KEY?.trim() || undefined,
  };
}

export function createInitialState(addresses: string[]): SolanaWatchState {
  const mapped: Record<string, SolanaAddressState> = {};
  for (const address of addresses)
    mapped[address] = {
      seen: [],
      pending: [],
      bootstrapped: false,
      gap: false,
    };
  return { version: 1, addresses: mapped };
}

function normalizePending(value: unknown): SolanaPendingSignature {
  const candidate = row(value);
  if (
    !validSignature(candidate.signature) ||
    !Number.isSafeInteger(candidate.slot) ||
    (candidate.blockTime !== null &&
      candidate.blockTime !== undefined &&
      (!Number.isSafeInteger(candidate.blockTime) ||
        (candidate.blockTime as number) < 0)) ||
    (candidate.err !== null && candidate.err !== undefined) ||
    !Number.isSafeInteger(candidate.attempts) ||
    (candidate.attempts as number) < 0 ||
    (candidate.attempts as number) > MAX_MISSING_ATTEMPTS
  )
    throw new Error("Malformed Solana pending signature");
  return {
    signature: candidate.signature,
    slot: candidate.slot as number,
    blockTime: (candidate.blockTime ?? null) as number | null,
    err: candidate.err ?? null,
    attempts: candidate.attempts as number,
  };
}

function normalizeState(value: unknown, addresses: string[]): SolanaWatchState {
  const raw = row(value);
  if (
    raw.version !== 1 ||
    !raw.addresses ||
    typeof raw.addresses !== "object" ||
    Array.isArray(raw.addresses)
  )
    throw new Error("Unsupported Solana watcher state version");
  const source = raw.addresses as Row;
  const state = createInitialState(addresses);
  for (const address of addresses) {
    const item = source[address];
    if (item === undefined) continue;
    const candidate = row(item);
    if (
      typeof candidate.bootstrapped !== "boolean" ||
      typeof candidate.gap !== "boolean" ||
      !Array.isArray(candidate.seen) ||
      candidate.seen.some((entry) => !validSignature(entry)) ||
      (candidate.pending !== undefined && !Array.isArray(candidate.pending))
    )
      throw new Error("Malformed Solana address state");
    const pending = (
      Array.isArray(candidate.pending) ? candidate.pending : []
    ).map(normalizePending);
    if (pending.length > MAX_PENDING)
      throw new Error("Solana pending queue exceeds bound");
    state.addresses[address] = {
      seen: [...new Set(candidate.seen as string[])].slice(-MAX_SEEN),
      pending,
      bootstrapped: candidate.bootstrapped,
      gap: candidate.gap,
      backfillBefore: validSignature(candidate.backfillBefore)
        ? candidate.backfillBefore
        : undefined,
      lastError:
        typeof candidate.lastError === "string"
          ? candidate.lastError.slice(0, 500)
          : undefined,
    };
  }
  return state;
}

export async function loadState(
  path: string,
  addresses: string[],
): Promise<SolanaWatchState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")), addresses);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialState(addresses);
    throw error;
  }
}

export async function saveState(
  path: string,
  state: SolanaWatchState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
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

async function readRpcJson(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProviderError(
      "NETWORK_ERROR",
      `Solana RPC request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(
      response.status === 429 ? "RATE_LIMITED" : "PROVIDER_HTTP_ERROR",
      `Solana RPC returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
  }
  const value = row(await boundedJson(response, MAX_RESPONSE_BYTES));
  if (value.error) {
    const error = row(value.error);
    throw new ProviderError(
      "RPC_ERROR",
      typeof error.message === "string"
        ? error.message.slice(0, 300)
        : "Solana RPC returned an error.",
      false,
    );
  }
  if (!("result" in value))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Solana RPC response omitted result.",
    );
  return value.result;
}

async function readSolanaUsdPrices(
  fetcher: typeof fetch,
  mints: string[],
  apiKey?: string,
): Promise<Map<string, string>> {
  const selected = [...new Set(mints)].slice(0, MAX_PRICE_MINTS);
  if (!selected.length) return new Map();
  let response: Response;
  try {
    response = await fetcher(
      `${JUPITER_PRICE_API}?ids=${encodeURIComponent(selected.join(","))}`,
      {
        headers: apiKey ? { "x-api-key": apiKey } : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new ProviderError(
      "PRICE_UNAVAILABLE",
      "Solana USD price request failed.",
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(
      "PRICE_UNAVAILABLE",
      `Solana USD price endpoint returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
  }
  const value = row(await boundedJson(response, MAX_RESPONSE_BYTES));
  const prices = new Map<string, string>();
  for (const [mint, raw] of Object.entries(value)) {
    if (!isSolanaAddress(mint)) continue;
    const usd = row(raw).usdPrice;
    if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0)
      prices.set(mint, String(usd));
    else if (typeof usd === "string" && DECIMAL.test(usd))
      prices.set(mint, canonicalDecimal(usd, "Solana USD price"));
  }
  return prices;
}

function normalizeSignature(value: unknown): SolanaSignature {
  const candidate = row(value);
  if (!validSignature(candidate.signature))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Malformed Solana signature.",
    );
  const slot = numberField(candidate.slot, "Solana slot");
  const blockTime =
    candidate.blockTime === null || candidate.blockTime === undefined
      ? null
      : numberField(candidate.blockTime, "Solana block time");
  return {
    signature: candidate.signature,
    slot,
    blockTime,
    err: candidate.err ?? null,
    confirmationStatus:
      typeof candidate.confirmationStatus === "string"
        ? candidate.confirmationStatus
        : null,
  };
}

function normalizeTransaction(
  value: unknown,
  requestedSignature: string,
): SolanaTransaction | null {
  if (value === null) return null;
  const candidate = row(value);
  if (
    candidate.signature !== undefined &&
    (!validSignature(candidate.signature) ||
      candidate.signature !== requestedSignature)
  )
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Solana transaction signature did not match the requested signature.",
    );
  const signatureValue = requestedSignature;
  if (!Number.isSafeInteger(candidate.slot) || (candidate.slot as number) < 0)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Malformed Solana transaction slot.",
    );
  const meta = candidate.meta === null ? null : row(candidate.meta);
  const transaction = row(candidate.transaction);
  if (!Object.keys(transaction).length)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Malformed Solana transaction body.",
    );
  return {
    signature: signatureValue,
    slot: candidate.slot as number,
    blockTime:
      candidate.blockTime === null || candidate.blockTime === undefined
        ? null
        : numberField(candidate.blockTime, "Solana block time"),
    meta,
    transaction,
  };
}

export function createSolanaProvider(
  options: {
    fetch?: typeof fetch;
    rpcUrl?: string;
    heliusApiKey?: string;
    jupiterApiKey?: string;
    intervalMs?: number;
  } = {},
): SolanaProvider {
  const fetcher = options.fetch ?? fetch;
  const url =
    options.rpcUrl?.trim() ||
    (options.heliusApiKey?.trim()
      ? `${HELIUS_RPC}?api-key=${encodeURIComponent(options.heliusApiKey.trim())}`
      : PUBLIC_RPC);
  const pace = createPacer(options.intervalMs ?? DEFAULT_PROVIDER_INTERVAL_MS);
  let requestId = 0;
  const request = async (
    method: string,
    params: unknown[],
  ): Promise<unknown> => {
    await pace();
    return readRpcJson(fetcher, url, {
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    });
  };
  return {
    async fetchSignatures(address, before) {
      const optionsValue: Record<string, unknown> = {
        limit: SIGNATURE_PAGE_SIZE,
        commitment: "confirmed",
      };
      if (before) optionsValue.before = before;
      const result = await request("getSignaturesForAddress", [
        address,
        optionsValue,
      ]);
      if (!Array.isArray(result) || result.length > SIGNATURE_PAGE_SIZE)
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          "Solana RPC returned malformed signature history.",
        );
      return result.map(normalizeSignature);
    },
    async fetchTransaction(signatureValue) {
      const result = await request("getTransaction", [
        signatureValue,
        {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      return normalizeTransaction(result, signatureValue);
    },
    async fetchBalances(address) {
      const native = row(
        await request("getBalance", [address, { commitment: "confirmed" }]),
      );
      const nativeValue = row(native.value).value ?? native.value;
      let nativeLamports: string;
      if (typeof nativeValue === "number") {
        if (!Number.isSafeInteger(nativeValue) || nativeValue < 0)
          throw new ProviderError(
            "INVALID_PROVIDER_DATA",
            "Solana RPC returned an unsafe native balance.",
          );
        nativeLamports = String(nativeValue);
      } else nativeLamports = uint(nativeValue, "native balance");
      const aggregate = new Map<string, SolanaBalanceToken>();
      for (const programId of TOKEN_PROGRAMS) {
        const tokensResult = row(
          await request("getTokenAccountsByOwner", [
            address,
            { programId },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ]),
        );
        const values = tokensResult.value;
        if (!Array.isArray(values) || values.length > MAX_TOKEN_ACCOUNTS)
          throw new ProviderError(
            "INVALID_PROVIDER_DATA",
            "Solana RPC returned malformed token balances.",
          );
        for (const item of values) {
          const account = row(row(item).account);
          const data = row(account.data);
          const parsed = row(data.parsed);
          const info = row(parsed.info);
          const tokenAmount = row(info.tokenAmount);
          if (!isSolanaAddress(info.mint)) continue;
          const amount = uint(tokenAmount.amount, "token balance");
          const tokenDecimals = decimals(
            tokenAmount.decimals,
            "token decimals",
          );
          const existing = aggregate.get(info.mint);
          aggregate.set(info.mint, {
            mint: info.mint,
            rawAmount: existing
              ? (BigInt(existing.rawAmount) + BigInt(amount)).toString()
              : amount,
            decimals: existing?.decimals ?? tokenDecimals,
          });
        }
      }
      return { nativeLamports, tokens: [...aggregate.values()] };
    },
    async fetchUsdPrices(mints) {
      return readSolanaUsdPrices(fetcher, mints, options.jupiterApiKey?.trim());
    },
  };
}

function accountKeys(
  transaction: SolanaTransaction,
): Array<string | undefined> {
  const message = row(row(transaction.transaction).message);
  const keys = message.accountKeys;
  const result: Array<string | undefined> = Array.isArray(keys)
    ? keys.map((key) => {
        const value = typeof key === "string" ? key : row(key).pubkey;
        return isSolanaAddress(value) ? value : undefined;
      })
    : [];
  // Versioned transactions may address accounts loaded through lookup tables.
  // Those keys follow the static message keys in the transaction account index.
  const loaded = row(transaction.meta).loadedAddresses;
  for (const field of ["writable", "readonly"]) {
    const values = row(loaded)[field];
    if (!Array.isArray(values)) continue;
    for (const value of values)
      result.push(isSolanaAddress(value) ? value : undefined);
  }
  return result;
}

interface TokenAccountState {
  mint: string;
  owner: string | null;
  decimals: number;
}

function tokenAccounts(
  meta: Row,
  keys: Array<string | undefined>,
): Map<string, TokenAccountState> {
  const result = new Map<string, TokenAccountState>();
  for (const field of ["preTokenBalances", "postTokenBalances"]) {
    const values = meta[field];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      const balance = row(item);
      const accountIndex = balance.accountIndex;
      const tokenAccount =
        Number.isSafeInteger(accountIndex) && (accountIndex as number) >= 0
          ? keys[accountIndex as number]
          : undefined;
      if (!tokenAccount || !isSolanaAddress(balance.mint)) continue;
      const tokenAmount = row(balance.uiTokenAmount);
      if (!UINT.test(String(tokenAmount.amount ?? ""))) continue;
      const tokenDecimals =
        Number.isSafeInteger(tokenAmount.decimals) &&
        (tokenAmount.decimals as number) >= 0 &&
        (tokenAmount.decimals as number) <= MAX_DECIMALS
          ? (tokenAmount.decimals as number)
          : null;
      if (tokenDecimals === null) continue;
      result.set(tokenAccount, {
        mint: balance.mint,
        owner: isSolanaAddress(balance.owner)
          ? balance.owner
          : (result.get(tokenAccount)?.owner ?? null),
        decimals: tokenDecimals,
      });
    }
  }
  return result;
}

function instructionList(
  transaction: SolanaTransaction,
): Array<{ id: string; value: unknown }> {
  const message = row(row(transaction.transaction).message);
  const values: Array<{ id: string; value: unknown }> = [];
  if (Array.isArray(message.instructions))
    message.instructions.forEach((value, index) =>
      values.push({ id: `top:${index}`, value }),
    );
  const inner = row(transaction.meta).innerInstructions;
  if (Array.isArray(inner)) {
    for (const group of inner) {
      const groupRow = row(group);
      const index = groupRow.index;
      if (!Array.isArray(groupRow.instructions)) continue;
      groupRow.instructions.forEach((value, instructionIndex) =>
        values.push({
          id: `inner:${String(index)}:${instructionIndex}`,
          value,
        }),
      );
    }
  }
  return values;
}

function symbolForMint(mint: string): string {
  return `SPL:${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function timestampFor(transaction: SolanaTransaction): string | null {
  if (transaction.blockTime === null) return null;
  const timestamp = new Date(transaction.blockTime * 1000);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function parseTransactionFlows(
  transaction: SolanaTransaction,
  wallet: string,
): SolanaFlow[] {
  const meta = transaction.meta;
  if (!meta || (meta.err !== null && meta.err !== undefined)) return [];
  const timestamp = timestampFor(transaction);
  if (timestamp === null) return [];
  const keys = accountKeys(transaction);
  const tokenState = tokenAccounts(meta, keys);
  const flows: SolanaFlow[] = [];
  const feeValue = meta.fee === undefined ? "0" : uint(meta.fee, "fee");
  if (keys[0] === wallet && feeValue !== "0")
    flows.push({
      signature: transaction.signature,
      slot: transaction.slot,
      direction: "outflow",
      mint: null,
      symbol: "SOL",
      decimals: 9,
      rawAmount: feeValue,
      remainingRaw: null,
      remainingSymbol: "SOL",
      timestamp,
      usdValue: null,
      isFee: true,
      confirmed: true,
    });
  for (const item of instructionList(transaction)) {
    const instruction = row(item.value);
    const parsed = row(instruction.parsed);
    const info = row(parsed.info);
    const type = parsed.type;
    const program = instruction.program;
    if (program === "system" && type === "transfer") {
      const source = info.source;
      const destination = info.destination;
      if (!isSolanaAddress(source) || !isSolanaAddress(destination)) continue;
      const amount = uint(info.lamports, "lamports");
      if (source === wallet && destination !== wallet)
        flows.push({
          signature: transaction.signature,
          slot: transaction.slot,
          direction: "outflow",
          mint: null,
          symbol: "SOL",
          decimals: 9,
          rawAmount: amount,
          remainingRaw: null,
          remainingSymbol: "SOL",
          timestamp,
          usdValue: null,
          confirmed: true,
        });
      else if (destination === wallet && source !== wallet)
        flows.push({
          signature: transaction.signature,
          slot: transaction.slot,
          direction: "inflow",
          mint: null,
          symbol: "SOL",
          decimals: 9,
          rawAmount: amount,
          remainingRaw: null,
          remainingSymbol: "SOL",
          timestamp,
          usdValue: null,
          confirmed: true,
        });
      continue;
    }
    if (
      (program !== "spl-token" &&
        program !== "spl-token-2022" &&
        !TOKEN_PROGRAMS.has(String(instruction.programId ?? ""))) ||
      (type !== "transfer" && type !== "transferChecked")
    )
      continue;
    const source = info.source;
    const destination = info.destination;
    if (!isSolanaAddress(source) || !isSolanaAddress(destination)) continue;
    const sourceState = tokenState.get(source);
    const destinationState = tokenState.get(destination);
    const tokenAmount = row(info.tokenAmount);
    const amountValue = info.amount ?? tokenAmount.amount;
    const amount =
      typeof amountValue === "string" && UINT.test(amountValue)
        ? BigInt(amountValue).toString()
        : null;
    if (amount === null) continue;
    const mint = isSolanaAddress(info.mint)
      ? info.mint
      : (sourceState?.mint ?? destinationState?.mint);
    const tokenDecimals =
      Number.isSafeInteger(tokenAmount.decimals) &&
      (tokenAmount.decimals as number) >= 0
        ? (tokenAmount.decimals as number)
        : (sourceState?.decimals ?? destinationState?.decimals);
    if (!mint || tokenDecimals === undefined || tokenDecimals > MAX_DECIMALS)
      continue;
    const sourceOwner = sourceState?.owner ?? null;
    const destinationOwner = destinationState?.owner ?? null;
    let direction: SolanaDirection | null = null;
    if (sourceOwner === wallet && destinationOwner !== wallet)
      direction = "outflow";
    else if (destinationOwner === wallet && sourceOwner !== wallet)
      direction = "inflow";
    if (!direction) continue;
    flows.push({
      signature: transaction.signature,
      slot: transaction.slot,
      direction,
      mint,
      symbol: symbolForMint(mint),
      decimals: tokenDecimals,
      rawAmount: amount,
      remainingRaw: null,
      remainingSymbol: symbolForMint(mint),
      timestamp,
      usdValue: null,
      confirmed: true,
    });
  }
  const outgoingAssets = new Set(
    flows
      .filter((flow) => flow.direction === "outflow" && !flow.isFee)
      .map((flow) => flow.mint ?? "SOL"),
  );
  for (const flow of flows) flow.watchAddress = wallet;
  return flows.filter(
    (flow) =>
      flow.direction !== "inflow" ||
      ![...outgoingAssets].some((asset) => asset !== (flow.mint ?? "SOL")),
  );
}

function applyBalances(
  flows: SolanaFlow[],
  balances: SolanaBalanceSnapshot,
): void {
  const tokenBalances = new Map(
    balances.tokens.map((item) => [item.mint, item]),
  );
  for (const flow of flows) {
    if (flow.mint === null) {
      flow.remainingRaw = balances.nativeLamports;
      flow.remainingSymbol = "SOL";
    } else {
      flow.remainingRaw = tokenBalances.get(flow.mint)?.rawAmount ?? "0";
      flow.remainingSymbol = flow.symbol;
    }
  }
}

function decimalParts(value: string): { digits: string; scale: number } | null {
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return {
    digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0",
    scale: fraction.length,
  };
}

function decimalProduct(
  raw: string,
  decimalsValue: number,
  price: string,
): string | null {
  const parsed = decimalParts(price);
  if (!parsed || !UINT.test(raw)) return null;
  const digits = BigInt(raw) * BigInt(parsed.digits);
  const scale = decimalsValue + parsed.scale;
  if (scale === 0) return digits.toString();
  const padded = digits.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function decimalAtLeast(value: string | null, threshold: string): boolean {
  if (value === null) return false;
  const left = decimalParts(value);
  const right = decimalParts(threshold);
  if (!left || !right) return false;
  const scale = Math.max(left.scale, right.scale);
  return (
    BigInt(left.digits) * 10n ** BigInt(scale - left.scale) >=
    BigInt(right.digits) * 10n ** BigInt(scale - right.scale)
  );
}

function applyUsdPrices(
  flows: SolanaFlow[],
  prices: Map<string, string>,
): void {
  for (const flow of flows) {
    const mint = flow.mint ?? SOLANA_NATIVE_MINT;
    const price = prices.get(mint) ?? "";
    flow.usdValue = decimalProduct(flow.rawAmount, flow.decimals, price);
    flow.remainingUsdValue =
      flow.remainingRaw === null
        ? null
        : decimalProduct(flow.remainingRaw, flow.decimals, price);
  }
}

function isStaleFlow(
  flow: SolanaFlow,
  now: string,
  maxAgeMs: number | undefined,
): boolean {
  if (flow.timestamp === null) return true;
  if (maxAgeMs === undefined) return false;
  const eventMs = Date.parse(flow.timestamp);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return true;
  return eventMs < nowMs - maxAgeMs || eventMs > nowMs + 60_000;
}

function passesUsdFloor(
  flow: SolanaFlow,
  threshold: string | undefined,
): boolean {
  if (threshold === undefined || flow.direction === "outflow") return true;
  // Inflows remain fail-closed so an unpriced credit cannot be mistaken for a
  // qualifying sale-side alert. Outflows are always retained for investigation.
  return decimalAtLeast(flow.usdValue ?? null, threshold);
}

function addPending(
  state: SolanaAddressState,
  signatures: SolanaSignature[],
): boolean {
  const known = new Set([
    ...state.seen,
    ...state.pending.map((item) => item.signature),
  ]);
  let overflow = false;
  for (const value of signatures) {
    if (known.has(value.signature)) continue;
    if (state.pending.length >= MAX_PENDING) {
      // Keep the signature unseen so a later poll can retry it after the queue
      // drains. Dropping it here would create an unrepairable blind spot.
      overflow = true;
      continue;
    }
    if (value.err !== null && value.err !== undefined) {
      // A failed transaction has no successful transfer to alert on. Consume it
      // so an arbitrary provider error object cannot poison the durable queue.
      markSeen(state, value.signature);
      known.add(value.signature);
      continue;
    }
    state.pending.push({
      signature: value.signature,
      slot: value.slot,
      blockTime: value.blockTime,
      err: value.err,
      attempts: 0,
    });
    known.add(value.signature);
  }
  if (overflow) state.gap = true;
  return overflow;
}

function markSeen(state: SolanaAddressState, signature: string): void {
  state.seen = [...new Set([...state.seen, signature])].slice(-MAX_SEEN);
}

export async function pollSolanaOnce(
  config: SolanaWatchConfig,
  provider: SolanaProvider,
  previous: SolanaWatchState,
  now = new Date().toISOString(),
): Promise<SolanaPollResult> {
  const state = normalizeState(previous, config.addresses);
  const flows: SolanaFlow[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const gaps: string[] = [];
  for (const address of config.addresses) {
    const addressState = state.addresses[address];
    if (!config.backfill) addressState.backfillBefore = undefined;
    const wasGap = addressState.gap;
    try {
      const signatures: SolanaSignature[] = [];
      let before: string | undefined;
      let overlap = false;
      let exhausted = false;
      for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
        const result = await provider.fetchSignatures(address, before);
        if (!result.length) {
          exhausted = true;
          break;
        }
        signatures.push(...result);
        if (result.some((item) => addressState.seen.includes(item.signature))) {
          overlap = true;
          break;
        }
        if (result.length < SIGNATURE_PAGE_SIZE) {
          exhausted = true;
          break;
        }
        before = result[result.length - 1].signature;
      }
      if (!addressState.bootstrapped) {
        for (const item of signatures) markSeen(addressState, item.signature);
        addressState.bootstrapped = true;
        if (
          !overlap &&
          !exhausted &&
          signatures.length >= SIGNATURE_PAGE_SIZE * MAX_SIGNATURE_PAGES
        ) {
          const warning =
            "possible gap; Solana signature history exceeded the bounded page budget during bootstrap";
          if (!wasGap) {
            warnings.push(warning);
            gaps.push(address);
          }
          addressState.gap = true;
          if (config.backfill) addressState.backfillBefore = before;
        }
        continue;
      }
      if (
        !overlap &&
        !exhausted &&
        signatures.length >= SIGNATURE_PAGE_SIZE * MAX_SIGNATURE_PAGES
      ) {
        const warning =
          "possible gap; Solana signature history exceeded the bounded page budget";
        if (!wasGap) {
          warnings.push(warning);
          gaps.push(address);
        }
        addressState.gap = true;
        if (config.backfill && !addressState.backfillBefore)
          addressState.backfillBefore = before;
      } else if (overlap && !addressState.backfillBefore) {
        // The latest window reached a known boundary. Pending work may still keep coverage partial.
        addressState.gap = addressState.gap || addressState.pending.length > 0;
      }
      addPending(addressState, signatures);

      if (config.backfill && addressState.backfillBefore) {
        let backfillBefore = addressState.backfillBefore;
        let backfillComplete = false;
        for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
          const result = await provider.fetchSignatures(
            address,
            backfillBefore,
          );
          if (!result.length) {
            backfillComplete = true;
            break;
          }
          const hit = result.some((item) =>
            addressState.seen.includes(item.signature),
          );
          const overflow = addPending(addressState, result);
          if (overflow) break;
          if (hit || result.length < SIGNATURE_PAGE_SIZE) {
            backfillComplete = true;
            break;
          }
          backfillBefore = result[result.length - 1].signature;
        }
        if (backfillComplete) addressState.backfillBefore = undefined;
        else addressState.backfillBefore = backfillBefore;
      }

      const work = addressState.pending.slice(0, MAX_TRANSACTION_FETCHES);
      const completed = new Set<string>();
      const addressFlows: SolanaFlow[] = [];
      let addressError = false;
      for (const pending of work) {
        if (pending.err !== null && pending.err !== undefined) {
          completed.add(pending.signature);
          continue;
        }
        try {
          const transaction = await provider.fetchTransaction(
            pending.signature,
          );
          if (transaction === null) {
            pending.attempts = Math.min(
              MAX_MISSING_ATTEMPTS,
              pending.attempts + 1,
            );
            if (pending.attempts >= MAX_MISSING_ATTEMPTS) {
              completed.add(pending.signature);
              warnings.push(
                "a Solana transaction was unavailable after bounded retries; coverage may be incomplete",
              );
              addressState.gap = true;
            }
            continue;
          }
          if (transaction.signature !== pending.signature)
            throw new ProviderError(
              "INVALID_PROVIDER_DATA",
              "Solana transaction signature did not match the requested signature.",
            );
          const parsed = parseTransactionFlows(transaction, address);
          addressFlows.push(...parsed);
          completed.add(pending.signature);
        } catch (error) {
          addressError = true;
          pending.attempts = Math.min(
            MAX_MISSING_ATTEMPTS,
            pending.attempts + 1,
          );
          const message =
            error instanceof Error
              ? error.message
              : "Unknown Solana transaction provider failure";
          errors.push(message);
          addressState.lastError = message.slice(0, 500);
          addressState.gap = true;
          if (pending.attempts >= MAX_MISSING_ATTEMPTS) {
            completed.add(pending.signature);
            warnings.push(
              "a Solana transaction could not be fetched after bounded retries; coverage may be incomplete",
            );
          }
          continue;
        }
      }
      addressState.pending = addressState.pending.filter(
        (item) => !completed.has(item.signature),
      );
      for (const signatureValue of completed)
        markSeen(addressState, signatureValue);
      if (
        addressFlows.some(
          (flow) =>
            flow.signature && addressState.seen.includes(flow.signature),
        )
      ) {
        try {
          applyBalances(
            addressFlows.filter((flow) => flow.signature),
            await provider.fetchBalances(address),
          );
        } catch {
          warnings.push(
            "Solana balance snapshot unavailable; flow alerts omit remaining holdings",
          );
        }
      }
      flows.push(...addressFlows);
      if (
        config.backfill &&
        !addressState.pending.length &&
        !addressState.backfillBefore &&
        !addressError
      )
        addressState.gap = false;
      if (!addressError) addressState.lastError = undefined;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown Solana provider failure";
      errors.push(message);
      addressState.lastError = message.slice(0, 500);
      addressState.gap = true;
    }
  }
  if (flows.length && provider.fetchUsdPrices) {
    const mints = [
      ...new Set(flows.map((flow) => flow.mint ?? SOLANA_NATIVE_MINT)),
    ];
    try {
      applyUsdPrices(flows, await provider.fetchUsdPrices(mints));
    } catch {
      // Unknown prices are kept as null and fail closed when a USD floor is configured.
    }
  }
  const filteredFlows = flows.filter(
    (flow) =>
      !isStaleFlow(flow, now, config.maxAlertAgeMs) &&
      passesUsdFloor(flow, config.minAlertUsd),
  );
  return {
    state,
    flows: filteredFlows,
    warnings: [...new Set(warnings)],
    errors,
    gaps,
  };
}

interface DisplayDecimal {
  text: string;
  approximate: boolean;
}

function fixedDecimal(value: bigint, places: number): string {
  const unit = 10n ** BigInt(places);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(places, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${fraction}`;
}

function roundedDecimal(value: string, places = 2): DisplayDecimal | null {
  const parsed = decimalParts(value);
  if (!parsed || places < 0 || places > 18) return null;
  const digits = BigInt(parsed.digits);
  let rounded: bigint;
  let approximate = false;
  if (parsed.scale <= places) {
    rounded = digits * 10n ** BigInt(places - parsed.scale);
  } else {
    const divisor = 10n ** BigInt(parsed.scale - places);
    rounded = (digits + divisor / 2n) / divisor;
    approximate = digits % divisor !== 0n;
  }
  if (digits > 0n && rounded === 0n)
    return {
      text: `<0.${"0".repeat(Math.max(places - 1, 0))}1`,
      approximate: true,
    };
  return { text: fixedDecimal(rounded, places), approximate };
}

function formatQuantity(
  raw: string | null,
  decimalsValue: number,
): DisplayDecimal {
  if (
    raw === null ||
    !UINT.test(raw) ||
    decimalsValue < 0 ||
    decimalsValue > MAX_DECIMALS
  )
    return { text: "unavailable", approximate: false };
  const value = BigInt(raw);
  let rounded: bigint;
  let approximate = false;
  if (decimalsValue <= 2) {
    rounded = value * 10n ** BigInt(2 - decimalsValue);
  } else {
    const divisor = 10n ** BigInt(decimalsValue - 2);
    rounded = (value + divisor / 2n) / divisor;
    approximate = value % divisor !== 0n;
  }
  if (value > 0n && rounded === 0n) return { text: "<0.01", approximate: true };
  return { text: fixedDecimal(rounded, 2), approximate };
}

function formatUsdValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "unavailable";
  const rounded = roundedDecimal(value);
  if (rounded === null) return "unavailable";
  return `${rounded.approximate ? "≈" : ""}$${rounded.text}`;
}

function formatTime(timestamp: string | null): string {
  if (timestamp === null) return "unavailable UTC";
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

export function formatSolanaFlowAlert(flow: SolanaFlow): string {
  const heading =
    flow.direction === "outflow"
      ? `🚨 ${flow.symbol} OUTFLOW`
      : `💰 ${flow.symbol} INFLOW`;
  const amount = formatQuantity(flow.rawAmount, flow.decimals);
  const remaining = formatQuantity(flow.remainingRaw, flow.decimals);
  const remainingLine =
    flow.remainingRaw === null
      ? "Remaining: unavailable"
      : `Remaining: ${remaining.approximate ? "≈" : ""}${remaining.text} ${flow.remainingSymbol ?? flow.symbol}${flow.remainingUsdValue == null ? "" : ` · ${formatUsdValue(flow.remainingUsdValue)}`}`;
  return [
    flow.isFee ? "🧾 SOL NETWORK FEE" : heading,
    `Amount: ${amount.approximate ? "≈" : ""}${amount.text} ${flow.symbol} · ${formatUsdValue(flow.usdValue)}`,
    remainingLine,
    `🕒 ${formatTime(flow.timestamp)}${flow.confirmed ? "" : " · pending"}`,
  ].join("\n");
}

interface SolanaDeliveryGroup {
  key: string;
  address: string;
  signature: string;
  flows: SolanaFlow[];
}

function deliveryGroups(flows: SolanaFlow[]): SolanaDeliveryGroup[] {
  const groups = new Map<string, SolanaDeliveryGroup>();
  for (const flow of flows) {
    if (!flow.watchAddress || flow.isFee) continue;
    const key = `${flow.watchAddress}:${flow.signature}`;
    const group = groups.get(key) ?? {
      key,
      address: flow.watchAddress,
      signature: flow.signature,
      flows: [],
    };
    group.flows.push(flow);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function groupSolanaFlowAlerts(flows: SolanaFlow[]): string[] {
  return deliveryGroups(flows).map((group) =>
    group.flows.map(formatSolanaFlowAlert).join("\n\n"),
  );
}

function restoreUndelivered(
  state: SolanaWatchState,
  groups: SolanaDeliveryGroup[],
): void {
  for (const group of groups) {
    const addressState = state.addresses[group.address];
    const first = group.flows[0];
    if (!addressState || !first) continue;
    addressState.seen = addressState.seen.filter(
      (signature) => signature !== group.signature,
    );
    if (addressState.pending.some((item) => item.signature === group.signature))
      continue;
    const parsedTimestamp = first.timestamp
      ? Date.parse(first.timestamp)
      : Number.NaN;
    addressState.pending.push({
      signature: group.signature,
      slot: first.slot,
      blockTime: Number.isFinite(parsedTimestamp)
        ? Math.floor(parsedTimestamp / 1000)
        : null,
      err: null,
      attempts: 0,
    });
  }
}

function markDelivered(
  state: SolanaWatchState,
  group: SolanaDeliveryGroup,
): void {
  const addressState = state.addresses[group.address];
  if (!addressState) return;
  addressState.pending = addressState.pending.filter(
    (item) => item.signature !== group.signature,
  );
  markSeen(addressState, group.signature);
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

export interface SolanaDeliveryDependencies {
  save: typeof saveState;
  send: typeof sendTelegramMessage;
}

export async function deliverSolanaFlowGroups(
  config: Pick<SolanaEnvironmentConfig, "stateFile" | "token" | "chatId">,
  state: SolanaWatchState,
  flows: SolanaFlow[],
  dependencies: SolanaDeliveryDependencies = {
    save: saveState,
    send: sendTelegramMessage,
  },
): Promise<void> {
  const groups = deliveryGroups(flows);
  restoreUndelivered(state, groups);
  // Persist the outbox before the first external send. A restart can then
  // retry unsent groups instead of losing the alert between polling and send.
  await dependencies.save(config.stateFile, state);
  for (const group of groups) {
    await dependencies.send(
      config.token,
      config.chatId,
      group.flows.map(formatSolanaFlowAlert).join("\n\n"),
    );
    markDelivered(state, group);
    await dependencies.save(config.stateFile, state);
  }
}

export async function runSolanaWatcher(
  config: SolanaEnvironmentConfig,
): Promise<never> {
  const provider = createSolanaProvider(config);
  let state = await loadState(config.stateFile, config.addresses);
  for (;;) {
    const result = await pollSolanaOnce(
      {
        addresses: config.addresses,
        maxAlertAgeMs: config.maxAlertAgeMs,
        minAlertUsd: config.minAlertUsd,
        backfill: config.backfill,
      },
      provider,
      state,
    );
    for (const warning of result.warnings)
      process.stderr.write(`solana watcher warning: ${warning}\n`);
    for (const error of result.errors)
      process.stderr.write(`solana watcher error: ${error}\n`);
    try {
      state = result.state;
      if (config.alertsEnabled)
        await deliverSolanaFlowGroups(config, state, result.flows);
      else await saveState(config.stateFile, state);
    } catch (error) {
      process.stderr.write(
        `solana watcher delivery error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, config.intervalMs),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runSolanaWatcher(configFromEnvironment()).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
