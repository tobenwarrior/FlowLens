import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { assetKey, normalizeAddress } from "../src/domain/engine.ts";
import type { PriceQuote } from "../src/domain/pricing.ts";
import type { Address, Asset } from "../src/domain/types.ts";
import { createPublicRpcClient, RpcProviderError } from "./rpc.ts";
import type { RpcClient } from "./rpc.ts";

/**
 * Spot USD prices read from Uniswap V3 pools over the public RPC FlowLens already uses.
 *
 * No new provider, key or account: this calls the same endpoints as the rest of
 * acquisition. What it returns is a *spot* price from a single pool at the current
 * block, which is not a market rate and can be moved by one trade. Quotes therefore
 * carry `confidence: "reported"` and name their pool, and the interface presents USD
 * as an annotation rather than evidence.
 *
 * It is also a price for *now*: applying it to an old transfer values that transfer at
 * today's price, which the UI states rather than implies.
 */

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

const FEE_TIERS = [500, 3000, 10000] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

interface ChainRoute {
  /** Wrapped native token, used to price the chain's native asset. */
  wrapped: Address;
  /** The USD leg every pool is quoted against. */
  usd: Address;
  usdDecimals: number;
  usdSymbol: string;
  factory: Address;
  /** Assets treated as one dollar without a pool read. */
  pegged: Record<string, string>;
}

const ROUTES: Record<number, ChainRoute> = {
  1: {
    wrapped: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    usd: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    usdDecimals: 6,
    usdSymbol: "USDC",
    factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    pegged: {
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
      "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
      "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
    },
  },
  8453: {
    wrapped: "0x4200000000000000000000000000000000000006",
    usd: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    usdDecimals: 6,
    usdSymbol: "USDC",
    factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    pegged: {
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
      "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "USDbC",
    },
  },
  42161: {
    wrapped: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    usd: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    usdDecimals: 6,
    usdSymbol: "USDC",
    factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    pegged: {
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC",
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "USDT",
    },
  },
};

const PRECISION = 10n ** 18n;
const Q192 = 1n << 192n;

/** Decimal string from a value scaled by PRECISION, trimmed of trailing zeros. */
function toDecimal(scaled: bigint): string {
  const whole = scaled / PRECISION;
  const fraction = (scaled % PRECISION)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * USD per whole unit of `token`, from the pool's sqrt price.
 *
 * Uniswap orders a pool's tokens by address, so which side the token sits on is known
 * locally and needs no extra call.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  token: Address,
  tokenDecimals: number,
  usd: Address,
  usdDecimals: number,
): string | null {
  if (sqrtPriceX96 <= 0n) return null;
  const tokenIsFirst = token.toLowerCase() < usd.toLowerCase();
  const [dec0, dec1] = tokenIsFirst
    ? [tokenDecimals, usdDecimals]
    : [usdDecimals, tokenDecimals];
  // token1 per token0, scaled by PRECISION and corrected for each side's decimals.
  const numerator =
    sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(dec0) * PRECISION;
  const oneForZero = numerator / (Q192 * 10n ** BigInt(dec1));
  if (oneForZero <= 0n) return null;
  // When the token is token0 that ratio already is USD per token; otherwise invert.
  const scaled = tokenIsFirst
    ? oneForZero
    : (PRECISION * PRECISION) / oneForZero;
  return scaled <= 0n ? null : toDecimal(scaled);
}

function hexResult(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value))
    throw new RpcProviderError(
      "RPC_INVALID_RESULT",
      "RPC returned a non-hex result.",
    );
  return value as `0x${string}`;
}

export interface PriceLookup {
  quotes: PriceQuote[];
  warnings: string[];
  /** RPC calls actually issued, so callers can see the cost they paid. */
  calls: number;
}

export interface PriceLookupOptions {
  client?: RpcClient;
  /** Hard ceiling on distinct assets priced in one lookup. */
  maxAssets?: number;
  now?: () => string;
}

/**
 * Price the supplied assets for one chain. Bounded and single-pass: every asset costs
 * at most one pool lookup per fee tier plus one slot0 read, nothing is retried, and an
 * asset without a pool is reported in `warnings` rather than guessed at.
 */
export async function fetchOnChainPrices(
  chainId: number,
  assets: Asset[],
  options: PriceLookupOptions = {},
): Promise<PriceLookup> {
  const route = ROUTES[chainId];
  const warnings: string[] = [];
  if (!route)
    return {
      quotes: [],
      warnings: [
        `No on-chain USD route is configured for chain ${chainId}. Supported: ${Object.keys(ROUTES).join(", ")}.`,
      ],
      calls: 0,
    };

  const maxAssets = Math.min(Math.max(options.maxAssets ?? 6, 1), 12);
  const at = options.now?.() ?? new Date().toISOString();

  // One entry per distinct asset on this chain, in a stable order.
  const wanted = new Map<string, Asset>();
  for (const asset of assets) {
    if (asset.chainId !== chainId) continue;
    const key = assetKey(asset);
    if (!wanted.has(key)) wanted.set(key, asset);
  }
  const selected = [...wanted.entries()].slice(0, maxAssets);
  if (wanted.size > selected.length)
    warnings.push(
      `Priced the first ${selected.length} of ${wanted.size} assets on chain ${chainId}; the rest stay unpriced in this bounded lookup.`,
    );
  if (!selected.length) return { quotes: [], warnings, calls: 0 };

  const client =
    options.client ?? createPublicRpcClient(chainId, { maxCalls: 48 });
  const source = `${client.source ?? "Public RPC"} · Uniswap V3 spot`;
  const quotes: PriceQuote[] = [];
  let calls = 0;

  for (const [key, asset] of selected) {
    const token = (
      asset.contract === null ? route.wrapped : normalizeAddress(asset.contract)
    ) as Address;

    const peg = route.pegged[token];
    if (peg) {
      // A peg is an assumption about the issuer, not an observation. Say so.
      quotes.push({
        key,
        usd: "1",
        source: `${peg} treated as one US dollar`,
        retrievedAt: at,
        confidence: "unverified",
      });
      continue;
    }

    let priced = false;
    for (const fee of FEE_TIERS) {
      let pool: string;
      try {
        calls += 1;
        const raw = hexResult(
          await client.request("eth_call", [
            {
              to: route.factory,
              data: encodeFunctionData({
                abi: FACTORY_ABI,
                functionName: "getPool",
                args: [token, route.usd, fee],
              }),
            },
            "latest",
          ]),
        );
        pool = decodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "getPool",
          data: raw,
        }) as string;
      } catch (error) {
        warnings.push(
          `Pool lookup failed for ${asset.symbol} at the ${fee} fee tier: ${
            error instanceof Error ? error.message : "unknown RPC error"
          }`,
        );
        break;
      }
      if (!pool || pool.toLowerCase() === ZERO) continue;

      try {
        calls += 1;
        const raw = hexResult(
          await client.request("eth_call", [
            {
              to: pool,
              data: encodeFunctionData({
                abi: POOL_ABI,
                functionName: "slot0",
              }),
            },
            "latest",
          ]),
        );
        const slot0 = decodeFunctionResult({
          abi: POOL_ABI,
          functionName: "slot0",
          data: raw,
        }) as readonly [bigint, ...unknown[]];
        const usd = priceFromSqrtPriceX96(
          slot0[0],
          token,
          asset.decimals,
          route.usd,
          route.usdDecimals,
        );
        if (!usd) continue;
        quotes.push({
          key,
          usd,
          source: `${source} · ${asset.symbol}/${route.usdSymbol} ${fee / 10_000}% pool ${pool}`,
          retrievedAt: at,
          confidence: "reported",
        });
        priced = true;
        break;
      } catch (error) {
        warnings.push(
          `Pool read failed for ${asset.symbol}: ${
            error instanceof Error ? error.message : "unknown RPC error"
          }`,
        );
        break;
      }
    }

    if (!priced && !route.pegged[token])
      warnings.push(
        `No Uniswap V3 ${route.usdSymbol} pool found for ${asset.symbol} on chain ${chainId}; it stays unpriced.`,
      );
  }

  return { quotes, warnings, calls };
}
