import { assetKey, normalizeAddress } from "../src/domain/engine.ts";
import { blockQuoteKey } from "../src/domain/pricing.ts";
import type { PriceQuote } from "../src/domain/pricing.ts";
import type { Address, Asset, Transfer } from "../src/domain/types.ts";
import {
  findPool,
  poolRoute,
  priceFromSqrtPriceX96,
  routedToken,
} from "./price-provider.ts";
import { createPublicRpcClient } from "./rpc.ts";

/**
 * Prices read at the block a transfer actually settled on.
 *
 * Uniswap V3 pools publish `sqrtPriceX96` in every Swap event, so a historical price is
 * a log query rather than an archive-state read. That distinction is what makes this
 * possible at all: the public RPC this project uses refuses archive requests, while
 * Etherscan — whose key the project already expects you to supply — serves historical
 * logs.
 *
 * The price returned is the last swap at or before the transfer's block, so it is the
 * most recent trade the pool had seen by then. A pool with no swap in the search window
 * yields nothing rather than a guess.
 */

const ENDPOINT = "https://api.etherscan.io/v2/api";
/** keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") */
export const SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** How far back to look for the pool's last trade before the transfer. */
const DEFAULT_WINDOW = 50_000;

export class HistoricalPriceError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "HistoricalPriceError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SwapLog {
  blockNumber: number;
  sqrtPriceX96: bigint;
}

/**
 * `sqrtPriceX96` is the third non-indexed word of the Swap payload, after the two
 * signed amounts. Slicing it keeps this independent of any ABI decoder.
 */
export function sqrtPriceFromSwapData(data: string): bigint | null {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length < 192) return null;
  const word = body.slice(128, 192);
  try {
    const value = BigInt(`0x${word}`);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = value.startsWith("0x")
      ? Number(BigInt(value))
      : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Latest swap at or before `block`, from an Etherscan log page. */
export function latestSwapAtOrBefore(
  logs: unknown,
  block: number,
): SwapLog | null {
  if (!Array.isArray(logs)) return null;
  let best: SwapLog | null = null;
  for (const entry of logs) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const blockNumber = toNumber(record.blockNumber);
    if (blockNumber === null || blockNumber > block) continue;
    const sqrtPriceX96 = sqrtPriceFromSwapData(String(record.data ?? ""));
    if (sqrtPriceX96 === null) continue;
    if (!best || blockNumber > best.blockNumber)
      best = { blockNumber, sqrtPriceX96 };
  }
  return best;
}

export interface HistoricalLookup {
  quotes: PriceQuote[];
  warnings: string[];
  /** Provider requests actually issued. */
  calls: number;
}

export interface HistoricalOptions {
  key?: string;
  fetch?: typeof fetch;
  /** Hard ceiling on distinct asset/block pairs priced in one call. */
  maxLookups?: number;
  /** Blocks to search back for the pool's last trade. */
  windowBlocks?: number;
  intervalMs?: number;
  now?: () => string;
  /**
   * Resolve the pool for a token. Defaults to a current-state factory lookup over the
   * public RPC, which serves it; only the historical *logs* need Etherscan.
   */
  resolvePool?: (token: Address) => Promise<Address | null>;
}

/**
 * Price the supplied transfers at their own blocks.
 *
 * Distinct (asset, block) pairs are deduplicated first, so a hundred transfers in one
 * block cost one lookup. Bounded and single-pass: nothing is retried, and a pair that
 * cannot be priced is reported rather than approximated.
 */
export async function fetchHistoricalPrices(
  chainId: number,
  transfers: Transfer[],
  options: HistoricalOptions = {},
): Promise<HistoricalLookup> {
  const warnings: string[] = [];
  const key = options.key ?? process.env.ETHERSCAN_API_KEY ?? "";
  if (!key)
    return {
      quotes: [],
      warnings: [
        "Historical prices need ETHERSCAN_API_KEY in the local server environment. The public RPC refuses archive requests, so without it transfers keep the spot price.",
      ],
      calls: 0,
    };

  const route = poolRoute(chainId);
  if (!route)
    return {
      quotes: [],
      warnings: [`No pool route is configured for chain ${chainId}.`],
      calls: 0,
    };

  const maxLookups = Math.min(Math.max(options.maxLookups ?? 12, 1), 40);
  const windowBlocks = Math.min(
    Math.max(options.windowBlocks ?? DEFAULT_WINDOW, 1),
    500_000,
  );
  const interval = options.intervalMs ?? 250;
  const fetcher = options.fetch ?? fetch;
  const at = options.now?.() ?? new Date().toISOString();

  // One lookup per distinct asset and block, not per transfer.
  const pairs = new Map<string, { asset: Asset; block: number }>();
  for (const transfer of transfers) {
    if (transfer.chainId !== chainId) continue;
    const token =
      transfer.asset.contract === null
        ? route.wrapped
        : normalizeAddress(transfer.asset.contract);
    // A pegged asset needs no lookup; the spot book already carries its dollar.
    if (route.pegged[token]) continue;
    const id = blockQuoteKey(transfer.asset, transfer.blockNumber);
    if (!pairs.has(id))
      pairs.set(id, { asset: transfer.asset, block: transfer.blockNumber });
  }

  const selected = [...pairs.entries()].slice(0, maxLookups);
  if (pairs.size > selected.length)
    warnings.push(
      `Priced ${selected.length} of ${pairs.size} asset/block pairs; the rest keep the spot price in this bounded lookup.`,
    );
  if (!selected.length) return { quotes: [], warnings, calls: 0 };

  const quotes: PriceQuote[] = [];
  let calls = 0;
  let lastCall = 0;

  // One factory lookup per token, shared across every block that token appears in.
  const poolCache = new Map<string, Address | null>();
  const rpc =
    options.resolvePool ??
    (() => {
      const client = createPublicRpcClient(chainId, { maxCalls: 48 });
      return (token: Address) =>
        findPool(client, route, token).then((found) => found?.pool ?? null);
    })();

  for (const [id, { asset, block }] of selected) {
    const token = routedToken(route, asset);
    if (!poolCache.has(token)) {
      poolCache.set(token, await rpc(token).catch(() => null));
    }
    const pool = poolCache.get(token) ?? null;
    if (!pool) {
      warnings.push(
        `No known ${route.usdSymbol} pool for ${asset.symbol} on chain ${chainId}; it keeps the spot price.`,
      );
      continue;
    }

    const wait = Math.max(0, lastCall + interval - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();

    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      chainid: String(chainId),
      apikey: key,
      module: "logs",
      action: "getLogs",
      address: pool,
      topic0: SWAP_TOPIC,
      fromBlock: String(Math.max(0, block - windowBlocks)),
      toBlock: String(block),
      page: "1",
      offset: "100",
    }).toString();

    calls += 1;
    let payload: { status?: unknown; message?: unknown; result?: unknown };
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok)
        throw new HistoricalPriceError(
          "PROVIDER_HTTP_ERROR",
          `Provider returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      warnings.push(
        `Log query failed for ${asset.symbol} at block ${block}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      continue;
    }

    // Etherscan reports "no records found" as a non-error status.
    if (payload.status !== "1") {
      warnings.push(
        `No swaps found for ${asset.symbol} within ${windowBlocks} blocks before ${block}; it keeps the spot price.`,
      );
      continue;
    }

    const swap = latestSwapAtOrBefore(payload.result, block);
    if (!swap) {
      warnings.push(
        `No usable swap price for ${asset.symbol} at block ${block}; it keeps the spot price.`,
      );
      continue;
    }

    const usd = priceFromSqrtPriceX96(
      swap.sqrtPriceX96,
      token,
      asset.decimals,
      route.usd,
      route.usdDecimals,
    );
    if (!usd) {
      warnings.push(
        `Unusable pool price for ${asset.symbol} at block ${block}.`,
      );
      continue;
    }

    quotes.push({
      key: id,
      usd,
      source: `Etherscan logs · ${asset.symbol}/${route.usdSymbol} pool ${pool} · last swap at block ${swap.blockNumber}`,
      retrievedAt: at,
      confidence: "reported",
      basis: "at-block",
      blockNumber: block,
    });
  }

  return { quotes, warnings, calls };
}

/** Exposed so callers can report what a lookup would cost before paying for it. */
export function distinctLookups(
  chainId: number,
  transfers: Transfer[],
): number {
  const route = poolRoute(chainId);
  if (!route) return 0;
  const pairs = new Set<string>();
  for (const transfer of transfers) {
    if (transfer.chainId !== chainId) continue;
    const token =
      transfer.asset.contract === null
        ? route.wrapped
        : normalizeAddress(transfer.asset.contract);
    if (route.pegged[token]) continue;
    pairs.add(`${assetKey(transfer.asset)}@${transfer.blockNumber}`);
  }
  return pairs.size;
}
