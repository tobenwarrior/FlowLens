import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address, Asset } from "../src/domain/types.ts";
import { ProviderError, boundedJson, tokenSymbol } from "./history-provider.ts";
import { createPublicRpcClient } from "./rpc.ts";
import type { PublicRpcOptions, RpcClient } from "./rpc.ts";

const ETHEREUM_CHAIN_ID = 1;
const BASE_URL = "https://eth.blockscout.com/api/v2";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d+$/;
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TOKENS = 1_000;
const MAX_DECIMAL_LENGTH = 128;
const BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

export interface BalanceItem {
  contract: Address | null;
  symbol: string;
  decimals: number;
  rawBalance: string;
  amount: string;
  priceUsd: string | null;
  valueUsd: string | null;
}

export interface WalletValuationSnapshot {
  wallet: Address;
  chainId: number;
  retrievedAt: string;
  native: BalanceItem;
  tokens: BalanceItem[];
  totalPricedUsd: string;
  pricedAssets: number;
  unpricedAssets: number;
  warnings: string[];
}

export interface TokenQuote {
  contract: Address;
  symbol: string;
  decimals: number;
  usd: string | null;
}

export interface ValuationOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => string;
  maxResponseBytes?: number;
  /** Injected read-only RPC for bounded token balance lookups and tests. */
  rpcClient?: RpcClient;
  /** Alternate RPC factory for tests or a caller with an explicitly authorized endpoint. */
  createRpcClient?: (chainId: number, options: PublicRpcOptions) => RpcClient;
}

function fail(message: string): never {
  throw new ProviderError("INVALID_PROVIDER_DATA", message);
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    fail(`Provider returned a malformed ${field}.`);
  return value.toLowerCase() as Address;
}

function rawAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !UINT.test(value) || value.length > 100)
    fail(`Provider returned a malformed ${field}.`);
  return BigInt(value).toString();
}

function decimals(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value))
    fail(`Provider returned a malformed ${field}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > 255)
    fail(`Provider returned a malformed ${field}.`);
  return result;
}

function decimalParts(
  value: string,
  field: string,
): { digits: string; scale: number } {
  if (!DECIMAL.test(value) || value.length > MAX_DECIMAL_LENGTH)
    fail(`Provider returned a malformed ${field}.`);
  const [whole, fraction = ""] = value.split(".");
  const digits = `${whole || "0"}${fraction}`.replace(/^0+(?=\d)/, "");
  return { digits: digits || "0", scale: fraction.length };
}

function formatScaled(value: bigint, scale: number): string {
  const digits = value.toString();
  if (scale === 0) return digits;
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Exact display multiplication of raw units by a decimal USD quote. */
export function decimalProduct(
  raw: string,
  assetDecimals: number,
  price: string,
): string {
  if (!UINT.test(raw) || !Number.isInteger(assetDecimals) || assetDecimals < 0)
    throw new Error("Invalid decimal product input.");
  const parsed = decimalParts(price, "USD price");
  return formatScaled(
    BigInt(raw) * BigInt(parsed.digits),
    assetDecimals + parsed.scale,
  );
}

function decimalAmount(raw: string, assetDecimals: number): string {
  return formatScaled(BigInt(raw), assetDecimals);
}

function decimalAdd(left: string, right: string): string {
  const a = decimalParts(left, "USD amount");
  const b = decimalParts(right, "USD amount");
  const scale = Math.max(a.scale, b.scale);
  return formatScaled(
    BigInt(a.digits) * 10n ** BigInt(scale - a.scale) +
      BigInt(b.digits) * 10n ** BigInt(scale - b.scale),
    scale,
  );
}

async function getJson(
  url: string,
  options: ValuationOptions,
  purpose: string,
): Promise<unknown> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProviderError(
      "NETWORK_ERROR",
      `${purpose} request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError(
      "PROVIDER_HTTP_ERROR",
      `${purpose} returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
  }
  return boundedJson(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
}

function baseUrl(options: ValuationOptions): string {
  return (options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
}

function quote(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    !DECIMAL.test(value) ||
    value.length > MAX_DECIMAL_LENGTH
  )
    fail(`Provider returned a malformed ${field}.`);
  return value;
}

function balanceItem(
  contract: Address | null,
  symbol: string,
  raw: string,
  assetDecimals: number,
  priceUsd: string | null,
): BalanceItem {
  return {
    contract,
    symbol: symbol || (contract === null ? "ETH" : "TOKEN"),
    decimals: assetDecimals,
    rawBalance: raw,
    amount: decimalAmount(raw, assetDecimals),
    priceUsd,
    valueUsd:
      priceUsd === null ? null : decimalProduct(raw, assetDecimals, priceUsd),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`Provider returned malformed ${field}.`);
  return value as Record<string, unknown>;
}

export async function fetchWalletValuation(
  wallet: Address,
  options: ValuationOptions = {},
): Promise<WalletValuationSnapshot> {
  const address = canonicalAddress(wallet, "wallet address");
  const root = baseUrl(options);
  const [rawAddress, rawBalances] = await Promise.all([
    getJson(`${root}/addresses/${address}`, options, "address balance"),
    getJson(
      `${root}/addresses/${address}/token-balances`,
      options,
      "token balances",
    ),
  ]);
  const addressData = record(rawAddress, "address balance");
  const rawNative = rawAmount(addressData.coin_balance, "native balance");
  const nativePrice = quote(addressData.exchange_rate, "native USD price");
  const native = balanceItem(null, "ETH", rawNative, 18, nativePrice);
  if (!Array.isArray(rawBalances) || rawBalances.length > MAX_TOKENS)
    fail("Provider returned too many token balances.");
  const warnings: string[] = [];
  const tokens: BalanceItem[] = [];
  let skippedAssets = 0;
  for (const itemValue of rawBalances) {
    const item = record(itemValue, "token balance");
    const token = record(item.token, "token metadata");
    const raw = rawAmount(item.value, "token balance");
    if (raw === "0") continue;
    if (token.type !== "ERC-20") {
      skippedAssets += 1;
      warnings.push(
        `${token.symbol ?? token.address_hash ?? "token"}: unsupported ${String(token.type ?? "unknown")} balance; excluded from fungible holdings.`,
      );
      continue;
    }
    const contract = canonicalAddress(token.address_hash, "token address");
    const itemDecimals = decimals(token.decimals, "token decimals");
    const price = quote(
      token.exchange_rate,
      `${token.symbol ?? "token"} USD price`,
    );
    if (price === null)
      warnings.push(`${token.symbol ?? contract}: no current USD price.`);
    tokens.push(
      balanceItem(
        contract,
        tokenSymbol(token.symbol),
        raw,
        itemDecimals,
        price,
      ),
    );
  }
  const items = [native, ...tokens];
  let totalPricedUsd = "0";
  let pricedAssets = 0;
  for (const item of items) {
    if (item.valueUsd === null) continue;
    totalPricedUsd = decimalAdd(totalPricedUsd, item.valueUsd);
    pricedAssets += 1;
  }
  return {
    wallet: address,
    chainId: ETHEREUM_CHAIN_ID,
    retrievedAt: options.now?.() ?? new Date().toISOString(),
    native,
    tokens,
    totalPricedUsd,
    pricedAssets,
    unpricedAssets: items.length - pricedAssets + skippedAssets,
    warnings,
  };
}

export async function fetchTokenQuote(
  contract: Address,
  options: ValuationOptions = {},
): Promise<TokenQuote> {
  const address = canonicalAddress(contract, "token address");
  const value = record(
    await getJson(
      `${baseUrl(options)}/tokens/${address}`,
      options,
      "token quote",
    ),
    "token quote",
  );
  return {
    contract: address,
    symbol: tokenSymbol(value.symbol),
    decimals: decimals(value.decimals, "token decimals"),
    usd: quote(value.exchange_rate, "token USD price"),
  };
}

/**
 * Read a token balance directly when Blockscout's token-balances list omits the
 * token (which can happen after a full dump). A successful zero is returned as
 * the exact decimal string "0"; provider or decode failures return null so the
 * caller never turns an unavailable balance into a false zero.
 */
export async function fetchTokenBalance(
  wallet: Address,
  asset: Asset,
  options: ValuationOptions = {},
): Promise<string | null> {
  if (asset.chainId !== ETHEREUM_CHAIN_ID || asset.contract === null)
    return null;
  let address: Address;
  let contract: Address;
  try {
    address = canonicalAddress(wallet, "wallet address");
    contract = canonicalAddress(asset.contract, "token address");
  } catch {
    return null;
  }
  const client =
    options.rpcClient ??
    (options.createRpcClient ?? createPublicRpcClient)(1, {
      fetch: options.fetch,
      maxCalls: 1,
      maxDurationMs: 20_000,
    });
  try {
    const raw = await client.request("eth_call", [
      {
        to: contract,
        data: encodeFunctionData({
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
      },
      "latest",
    ]);
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(raw))
      return null;
    const decoded = decodeFunctionResult({
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      data: raw as `0x${string}`,
    });
    if (typeof decoded !== "bigint") return null;
    return decimalAmount(decoded.toString(), asset.decimals);
  } catch {
    return null;
  }
}

/** Match a transfer asset to its current snapshot quote, when present. */
export function priceForAsset(
  snapshot: WalletValuationSnapshot,
  asset: Asset,
): string | null {
  if (asset.contract === null) return snapshot.native.priceUsd;
  return (
    snapshot.tokens.find(
      (item) => item.contract?.toLowerCase() === asset.contract?.toLowerCase(),
    )?.priceUsd ?? null
  );
}
