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
 *
 * Etherscan returns logs oldest first, one page at a time, so a single query over the
 * whole window would hand back the window's oldest swaps: on an active pool, a price from
 * days before the transfer. The lookup searches backward from the transfer's block
 * instead. It starts with a small window ending there, narrows it when a page comes back
 * full because the newest swaps may lie past that page, and steps further back, widening,
 * while windows are empty.
 */

const ENDPOINT = "https://api.etherscan.io/v2/api";
/** keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") */
export const SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** How far back to look for the pool's last trade before the transfer. */
const DEFAULT_WINDOW = 50_000;
/** The first window, ending at the transfer's block; an active pool's swaps fit one page. */
const FIRST_WINDOW = 64;
/** Etherscan's largest log page. A full page means the window may hold more. */
export const LOG_PAGE_SIZE = 1000;
/** Log queries one lookup may spend narrowing and stepping back through its window. */
export const MAX_QUERIES_PER_LOOKUP = 10;
/** Log queries one call may spend across all its lookups. */
export const MAX_LOG_QUERIES_PER_CALL = 80;

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
  /** Position within the block; -1 when the provider did not say. */
  logIndex: number;
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
  if (typeof value !== "string") return null;
  // Etherscan writes a zero quantity as a bare "0x".
  if (value === "0x") return 0;
  try {
    const parsed = value.startsWith("0x")
      ? Number(BigInt(value))
      : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Latest swap at or before `block`, from an Etherscan log page. Within one block the
 * highest log index is the latest; pages arrive oldest first, so without an index a later
 * entry wins.
 */
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
    const logIndex = toNumber(record.logIndex) ?? -1;
    if (
      !best ||
      blockNumber > best.blockNumber ||
      (blockNumber === best.blockNumber && logIndex >= best.logIndex)
    )
      best = { blockNumber, logIndex, sqrtPriceX96 };
  }
  return best;
}

type LogPage =
  | { kind: "logs"; logs: unknown[] }
  | { kind: "empty" }
  | { kind: "refused"; reason: string };

/**
 * Etherscan answers "no records found" and a refusal (bad key, rate limit) with the same
 * status "0"; only the result tells them apart. Taking a refusal for an empty window
 * would send the search further back and price the transfer from an older swap.
 */
function readLogPage(payload: unknown): LogPage {
  const body = (payload && typeof payload === "object" ? payload : {}) as {
    status?: unknown;
    message?: unknown;
    result?: unknown;
  };
  if (Array.isArray(body.result)) {
    if (!body.result.length) return { kind: "empty" };
    if (body.status === "1") return { kind: "logs", logs: body.result };
  }
  const reason =
    typeof body.result === "string" && body.result
      ? body.result
      : typeof body.message === "string" && body.message
        ? body.message
        : "unexpected response";
  return { kind: "refused", reason: reason.slice(0, 200) };
}

type SwapSearch =
  | { kind: "found"; swap: SwapLog }
  | { kind: "none" }
  | { kind: "unusable" }
  | { kind: "refused"; reason: string }
  | { kind: "exhausted" }
  | { kind: "spent" };

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
  // Etherscan's free tier allows three calls a second and one lookup can take several
  // queries, so stay under that limit.
  const interval = options.intervalMs ?? 400;
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

  const queryLogs = async (
    pool: Address,
    fromBlock: number,
    toBlock: number,
  ): Promise<LogPage> => {
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
      fromBlock: String(fromBlock),
      toBlock: String(toBlock),
      page: "1",
      offset: String(LOG_PAGE_SIZE),
    }).toString();

    calls += 1;
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
      return readLogPage(await response.json());
    } catch (error) {
      return {
        kind: "refused",
        reason: error instanceof Error ? error.message : "unknown error",
      };
    }
  };

  /** Walk back from `block` until the newest swap at or before it is in hand. */
  const lastSwapBefore = async (
    pool: Address,
    block: number,
  ): Promise<SwapSearch> => {
    const lowest = Math.max(0, block - windowBlocks);
    let hi = block;
    let span = FIRST_WINDOW;
    let narrowed = false;
    for (let query = 0; query < MAX_QUERIES_PER_LOOKUP; query++) {
      if (hi < lowest) return { kind: "none" };
      if (calls >= MAX_LOG_QUERIES_PER_CALL) return { kind: "spent" };
      const lo = Math.max(lowest, hi - span + 1);
      const page = await queryLogs(pool, lo, hi);
      if (page.kind === "refused") return page;
      if (page.kind === "logs") {
        if (page.logs.length >= LOG_PAGE_SIZE && hi > lo) {
          // The newest swaps in this window may lie past the first page.
          span = Math.ceil((hi - lo + 1) / 2);
          narrowed = true;
          continue;
        }
        const swap = latestSwapAtOrBefore(page.logs, hi);
        return swap ? { kind: "found", swap } : { kind: "unusable" };
      }
      // Nothing here: step back past this window. Once a page has filled, the pool is
      // busy enough that the window stays narrow.
      hi = lo - 1;
      if (!narrowed) span *= 4;
    }
    return hi < lowest ? { kind: "none" } : { kind: "exhausted" };
  };

  const unpriced = (search: SwapSearch, symbol: string, block: number) => {
    switch (search.kind) {
      case "refused":
        return `Log query failed for ${symbol} at block ${block}: ${search.reason}; it keeps the spot price.`;
      case "exhausted":
        return `Stopped looking for the last ${symbol} swap before block ${block} after ${MAX_QUERIES_PER_LOOKUP} log queries; it keeps the spot price.`;
      case "unusable":
        return `No usable swap price for ${symbol} at block ${block}; it keeps the spot price.`;
      default:
        return `No swaps found for ${symbol} within ${windowBlocks} blocks before ${block}; it keeps the spot price.`;
    }
  };

  for (const [index, [id, { asset, block }]] of selected.entries()) {
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

    const search = await lastSwapBefore(pool, block);
    if (search.kind === "spent") {
      warnings.push(
        `Stopped after ${MAX_LOG_QUERIES_PER_CALL} log queries; ${selected.length - index} asset/block pairs keep the spot price.`,
      );
      break;
    }
    if (search.kind !== "found") {
      warnings.push(unpriced(search, asset.symbol, block));
      continue;
    }
    const { swap } = search;

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
