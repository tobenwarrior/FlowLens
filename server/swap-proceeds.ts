import type { Address } from "../src/domain/types.ts";
import { decimalProduct } from "./telegram-valuation.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const V2_SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export type SwapVersion = "v2" | "v3";

export interface ReceiptLog {
  address: Address;
  topics: readonly string[];
  data: string;
  logIndex: number;
  removed?: boolean;
}

export interface SwapReceipt {
  transactionHash: `0x${string}`;
  blockNumber: number;
  blockHash?: `0x${string}`;
  status?: string;
  logs: readonly ReceiptLog[];
}

/** Route evidence must already have verified the canonical pool and input leg. */
export interface ReceiptSwapLeg {
  pool: Address;
  version: SwapVersion;
  token: Address;
  poolAmount: string;
  swapLogIndex: number;
  /** When set, require the Swap event's `to` recipient to match. */
  outputRecipient?: Address;
  /** Set only after an exact downstream transfer or internal-trace join to the wallet. */
  walletProceedsVerified?: boolean;
}

export interface ReceiptSwapRoute {
  transactionHash: `0x${string}`;
  blockNumber: number;
  legs: readonly ReceiptSwapLeg[];
}

export interface CanonicalPoolTokens {
  token0: Address;
  token1: Address;
}

export interface SwapProceeds {
  transactionHash: `0x${string}`;
  blockNumber: number;
  pool: Address;
  version: SwapVersion;
  inputToken: Address;
  inputRawAmount: string;
  outputToken: Address;
  outputRawAmount: string;
  swapLogIndex: number;
  /** The Swap event's `to` matched the route evidence; this is not wallet custody. */
  swapRecipientVerified: boolean;
  /** Separate downstream evidence joined the output to the watched wallet. */
  walletProceedsVerified: boolean;
}

export interface SwapAsset {
  contract: Address;
  symbol: string;
  decimals: number;
}

export interface SwapQuote {
  contract: Address;
  usdPerToken: string | null;
  scope: "historical" | "spot-indicative";
  observedAt: string;
  source: string;
}

export type SwapValueKind =
  "realized" | "spot-indicative" | "pool-output" | "unavailable";

export interface ValuedSwapProceeds extends SwapProceeds {
  symbol: string;
  amount: string;
  valueUsd: string | null;
  valueKind: SwapValueKind;
  quoteObservedAt: string | null;
  quoteSource: string | null;
}

function normalizedAddress(value: string): Address | null {
  return ADDRESS.test(value) ? (value.toLowerCase() as Address) : null;
}

function topicAddress(value: string): Address | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return `0x${value.slice(-40)}`.toLowerCase() as Address;
}

function word(data: string, index: number): bigint | null {
  if (!HEX.test(data)) return null;
  const start = 2 + index * 64;
  const end = start + 64;
  if (data.length < end) return null;
  try {
    return BigInt(`0x${data.slice(start, end)}`);
  } catch {
    return null;
  }
}

function signedWord(data: string, index: number): bigint | null {
  const value = word(data, index);
  if (value === null) return null;
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

function successfulReceipt(receipt: SwapReceipt): boolean {
  return (
    receipt.status === undefined ||
    (/^0x[0-9a-fA-F]+$/.test(receipt.status) && BigInt(receipt.status) === 1n)
  );
}

function validRawAmount(value: string): bigint | null {
  if (!UINT.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function poolTokens(
  pools: ReadonlyMap<Address, CanonicalPoolTokens>,
  pool: Address,
): CanonicalPoolTokens | null {
  return pools.get(pool.toLowerCase() as Address) ?? pools.get(pool) ?? null;
}

function outputForV2(
  data: string,
  inputIndex: 0 | 1,
): { input: bigint; output: bigint } | null {
  if (!/^0x[0-9a-fA-F]{256}$/.test(data)) return null;
  const amount0In = word(data, 0);
  const amount1In = word(data, 1);
  const amount0Out = word(data, 2);
  const amount1Out = word(data, 3);
  if (
    amount0In === null ||
    amount1In === null ||
    amount0Out === null ||
    amount1Out === null
  )
    return null;
  return inputIndex === 0
    ? { input: amount0In, output: amount1Out }
    : { input: amount1In, output: amount0Out };
}

function outputForV3(
  data: string,
  inputIndex: 0 | 1,
): { input: bigint; output: bigint } | null {
  if (!/^0x[0-9a-fA-F]{320}$/.test(data)) return null;
  const amount0 = signedWord(data, 0);
  const amount1 = signedWord(data, 1);
  if (amount0 === null || amount1 === null) return null;
  const input = inputIndex === 0 ? amount0 : amount1;
  const outputDelta = inputIndex === 0 ? amount1 : amount0;
  if (outputDelta >= 0n) return null;
  return { input, output: -outputDelta };
}

/**
 * Decode only the output amount emitted by a previously verified V2/V3 route.
 * The result is pool output. A separate downstream receipt/trace join is required
 * before calling it wallet-realized proceeds. No price or balance is inferred here.
 */
export function extractReceiptSwapProceeds(
  receipt: SwapReceipt,
  route: ReceiptSwapRoute,
  pools: ReadonlyMap<Address, CanonicalPoolTokens>,
): SwapProceeds[] {
  if (
    !HASH.test(receipt.transactionHash) ||
    !HASH.test(route.transactionHash) ||
    receipt.transactionHash.toLowerCase() !==
      route.transactionHash.toLowerCase() ||
    receipt.blockNumber !== route.blockNumber ||
    !successfulReceipt(receipt) ||
    route.legs.length > 32
  )
    return [];

  const results: SwapProceeds[] = [];
  for (const leg of route.legs) {
    const pool = normalizedAddress(leg.pool);
    const inputToken = normalizedAddress(leg.token);
    const expectedAmount = validRawAmount(leg.poolAmount);
    const pair = pool && inputToken ? poolTokens(pools, pool) : null;
    if (!pool || !inputToken || expectedAmount === null || !pair) continue;
    const token0 = normalizedAddress(pair.token0);
    const token1 = normalizedAddress(pair.token1);
    if (!token0 || !token1 || token0 === token1) continue;
    const inputIndex =
      token0 === inputToken ? 0 : token1 === inputToken ? 1 : null;
    if (inputIndex === null) continue;
    const log = receipt.logs.find(
      (item) =>
        !item.removed &&
        item.address.toLowerCase() === pool &&
        item.logIndex === leg.swapLogIndex,
    );
    if (!log || log.topics.length < 3) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (
      (leg.version === "v2" && topic !== V2_SWAP_TOPIC) ||
      (leg.version === "v3" && topic !== V3_SWAP_TOPIC)
    )
      continue;
    const decoded =
      leg.version === "v2"
        ? outputForV2(log.data, inputIndex)
        : outputForV3(log.data, inputIndex);
    if (!decoded || decoded.input !== expectedAmount || decoded.output <= 0n)
      continue;
    const recipient = topicAddress(log.topics[2]);
    const swapRecipientVerified =
      leg.outputRecipient !== undefined &&
      recipient !== null &&
      recipient === leg.outputRecipient.toLowerCase();
    results.push({
      transactionHash: route.transactionHash,
      blockNumber: route.blockNumber,
      pool,
      version: leg.version,
      inputToken,
      inputRawAmount: decoded.input.toString(),
      outputToken: inputIndex === 0 ? token1 : token0,
      outputRawAmount: decoded.output.toString(),
      swapLogIndex: leg.swapLogIndex,
      swapRecipientVerified,
      walletProceedsVerified:
        leg.walletProceedsVerified === true && swapRecipientVerified,
    });
  }
  return results;
}

function formatUnits(raw: string, decimals: number): string {
  if (!UINT.test(raw) || !Number.isInteger(decimals) || decimals < 0)
    throw new Error("Invalid swap output amount");
  const digits = BigInt(raw).toString();
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Apply an output-token quote without confusing current spot with realized USD.
 * A historical quote plus a downstream wallet join is `realized`; a current quote
 * remains `spot-indicative`, and an unjoined output remains `pool-output`.
 */
export function valueSwapProceeds(
  proceeds: SwapProceeds,
  asset: SwapAsset,
  quote: SwapQuote | null,
): ValuedSwapProceeds {
  const outputToken = normalizedAddress(proceeds.outputToken);
  const assetToken = normalizedAddress(asset.contract);
  const raw = validRawAmount(proceeds.outputRawAmount);
  if (
    !outputToken ||
    !assetToken ||
    outputToken !== assetToken ||
    raw === null ||
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > 255
  )
    throw new Error("Swap output asset does not match proceeds");
  const matchingQuote =
    quote &&
    normalizedAddress(quote.contract) === outputToken &&
    quote.usdPerToken !== null &&
    /^\d+(?:\.\d+)?$/.test(quote.usdPerToken)
      ? quote
      : null;
  const quoteUsd = matchingQuote?.usdPerToken ?? null;
  const valueUsd =
    quoteUsd === null
      ? null
      : decimalProduct(raw.toString(), asset.decimals, quoteUsd);
  const valueKind: SwapValueKind =
    valueUsd === null
      ? "unavailable"
      : !proceeds.walletProceedsVerified
        ? "pool-output"
        : matchingQuote?.scope === "historical"
          ? "realized"
          : "spot-indicative";
  return {
    ...proceeds,
    symbol: asset.symbol,
    amount: formatUnits(raw.toString(), asset.decimals),
    valueUsd,
    valueKind,
    quoteObservedAt: matchingQuote?.observedAt ?? null,
    quoteSource: matchingQuote?.source ?? null,
  };
}
