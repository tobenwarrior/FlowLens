import test from "node:test";
import assert from "node:assert/strict";
import {
  distinctLookups,
  fetchHistoricalPrices,
  latestSwapAtOrBefore,
  LOG_PAGE_SIZE,
  MAX_LOG_QUERIES_PER_CALL,
  MAX_QUERIES_PER_LOOKUP,
  sqrtPriceFromSwapData,
  SWAP_TOPIC,
} from "../server/historical-price.ts";
import { transferId } from "../src/domain/engine.ts";
import { usdValue, priceBook } from "../src/domain/pricing.ts";
import type { Address, Asset, Transfer } from "../src/domain/types.ts";
import type { PublicRpcOptions } from "../server/rpc.ts";

const ROOT = `0x${"1".repeat(40)}` as Address;
const ALICE = `0x${"2".repeat(40)}` as Address;
const POOL = `0x${"5".repeat(40)}` as Address;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;

const ETH: Asset = { chainId: 1, symbol: "ETH", decimals: 18, contract: null };
const USDC_ASSET: Asset = {
  chainId: 1,
  symbol: "USDC",
  decimals: 6,
  contract: USDC,
};

function transfer(
  block: number,
  asset = ETH,
  amount = "1000000000000000000",
): Transfer {
  const value: Transfer = {
    id: "",
    chainId: 1,
    hash: `0x${block.toString(16).padStart(64, "0")}`,
    kind: asset.contract ? "erc20" : "native",
    eventIndex: "0",
    from: ALICE,
    to: ROOT,
    asset,
    rawAmount: amount,
    timestamp: "2026-05-01T12:00:00.000Z",
    blockNumber: block,
    status: "success",
    source: "Synthetic historical contract",
    retrievedAt: "2026-10-20T12:00:00.000Z",
  };
  value.id = transferId(value);
  return value;
}

/** A Swap payload: amount0, amount1, sqrtPriceX96, liquidity, tick. */
function swapData(sqrtPriceX96: bigint): string {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  return `0x${word(0n)}${word(0n)}${word(sqrtPriceX96)}${word(0n)}${word(0n)}`;
}

function sqrtPriceX96For(rawRatio: number): bigint {
  return BigInt(Math.floor(Math.sqrt(rawRatio) * 2 ** 96));
}

// 1 USDC = 1/2000 ETH, expressed in the pool's raw units.
const ETH_AT_2000 = sqrtPriceX96For(10 ** 18 / 2000 / 10 ** 6);
const ETH_AT_3000 = sqrtPriceX96For(10 ** 18 / 3000 / 10 ** 6);

test("sqrtPriceX96 is read from the third word of the swap payload", () => {
  assert.equal(sqrtPriceFromSwapData(swapData(123456789n)), 123456789n);
});

test("a truncated or empty payload yields nothing rather than a wrong number", () => {
  assert.equal(sqrtPriceFromSwapData("0x"), null);
  assert.equal(sqrtPriceFromSwapData("0x1234"), null);
  assert.equal(sqrtPriceFromSwapData(swapData(0n)), null);
});

test("the latest swap at or before the block wins, and later swaps are ignored", () => {
  const logs = [
    { blockNumber: "0x3e8", data: swapData(100n) },
    { blockNumber: "0x7d0", data: swapData(200n) },
    { blockNumber: "0xbb8", data: swapData(300n) },
  ];
  const picked = latestSwapAtOrBefore(logs, 2000);
  assert.equal(picked?.blockNumber, 2000);
  assert.equal(picked?.sqrtPriceX96, 200n);
});

test("within one block the swap with the highest log index is the latest", () => {
  const logs = [
    // Neither the first nor the last entry of the block is the latest.
    { blockNumber: "0x3e8", logIndex: "0x3", data: swapData(300n) },
    { blockNumber: "0x3e8", logIndex: "0x7", data: swapData(700n) },
    { blockNumber: "0x3e8", logIndex: "0x", data: swapData(100n) },
    { blockNumber: "0x3e7", logIndex: "0x9", data: swapData(900n) },
  ];
  assert.equal(latestSwapAtOrBefore(logs, 1000)?.sqrtPriceX96, 700n);
});

test("a window containing only later swaps yields no price", () => {
  const logs = [{ blockNumber: "0xbb8", data: swapData(300n) }];
  assert.equal(latestSwapAtOrBefore(logs, 1000), null);
});

test("without an Etherscan key it declines and explains, making no calls", async () => {
  const result = await fetchHistoricalPrices(1, [transfer(21_000_000)], {
    key: "",
  });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, 0);
  assert.match(result.warnings[0], /ETHERSCAN_API_KEY/);
  assert.match(result.warnings[0], /spot price/);
});

function stubFetch(
  logsByCall: unknown[][],
  seen: string[] = [],
): { fetch: typeof fetch; seen: string[] } {
  let index = 0;
  const impl = (async (url: URL | string) => {
    seen.push(String(url));
    const result = logsByCall[Math.min(index++, logsByCall.length - 1)];
    return new Response(
      JSON.stringify({ status: result.length ? "1" : "0", result }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, seen };
}

test("a transfer is priced at its own block from the pool's last swap", async () => {
  const { fetch: fetcher, seen } = stubFetch([
    [{ blockNumber: "0x1406f40", data: swapData(ETH_AT_2000) }],
  ]);
  const sent = transfer(21_000_000);
  const result = await fetchHistoricalPrices(1, [sent], {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
  assert.equal(result.quotes.length, 1);
  const quote = result.quotes[0];
  assert.equal(quote.basis, "at-block");
  assert.equal(quote.blockNumber, 21_000_000);
  assert.equal(quote.key, `1:native@${21_000_000}`);
  assert.ok(Math.abs(Number(quote.usd) - 2000) / 2000 < 0.001);
  // The query is scoped to the pool and bounded above by the transfer's block.
  assert.match(seen[0], new RegExp(`address=${POOL}`, "i"));
  assert.match(seen[0], /toBlock=21000000/);
});

test("the resulting quote is what usdValue prefers for that transfer", async () => {
  const { fetch: fetcher } = stubFetch([
    [{ blockNumber: "0x1406f40", data: swapData(ETH_AT_2000) }],
  ]);
  const sent = transfer(21_000_000);
  const result = await fetchHistoricalPrices(1, [sent], {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
  const value = usdValue(sent, priceBook(result.quotes));
  assert.ok(value);
  assert.equal(value.atBlock, true);
  assert.ok(Math.abs(Number(value.amount) - 2000) / 2000 < 0.001);
});

test("many transfers in one block cost one lookup", async () => {
  const { fetch: fetcher, seen } = stubFetch([
    [{ blockNumber: "0x1406f40", data: swapData(ETH_AT_2000) }],
  ]);
  const transfers = Array.from({ length: 20 }, () => transfer(21_000_000));
  const result = await fetchHistoricalPrices(1, transfers, {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
  assert.equal(result.calls, 1);
  assert.equal(seen.length, 1);
  assert.equal(result.quotes.length, 1);
});

test("pegged assets need no historical lookup", async () => {
  const transfers = [transfer(21_000_000, USDC_ASSET, "1000000")];
  assert.equal(distinctLookups(1, transfers), 0);
  const result = await fetchHistoricalPrices(1, transfers, {
    key: "test-key",
    fetch: (() => {
      throw new Error("no call expected");
    }) as unknown as typeof fetch,
    resolvePool: async () => POOL,
  });
  assert.equal(result.calls, 0);
  assert.deepEqual(result.quotes, []);
});

test("a pool with no swaps in the window keeps the spot price and says so", async () => {
  const { fetch: fetcher } = stubFetch([[]]);
  const result = await fetchHistoricalPrices(1, [transfer(21_000_000)], {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
  assert.deepEqual(result.quotes, []);
  assert.match(result.warnings[0], /keeps the spot price/);
});

test("a token with no pool is reported rather than approximated", async () => {
  const result = await fetchHistoricalPrices(1, [transfer(21_000_000)], {
    key: "test-key",
    fetch: (() => {
      throw new Error("no call expected");
    }) as unknown as typeof fetch,
    intervalMs: 0,
    resolvePool: async () => null,
  });
  assert.deepEqual(result.quotes, []);
  assert.match(result.warnings[0], /No known USDC pool/);
});

test("the lookup is bounded and reports what it left on the spot price", async () => {
  const { fetch: fetcher } = stubFetch([
    [{ blockNumber: "0x1406f40", data: swapData(ETH_AT_2000) }],
  ]);
  const transfers = Array.from({ length: 6 }, (_, index) =>
    transfer(21_000_000 + index),
  );
  assert.equal(distinctLookups(1, transfers), 6);
  const result = await fetchHistoricalPrices(1, transfers, {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    maxLookups: 2,
    resolvePool: async () => POOL,
  });
  assert.equal(result.calls, 2);
  assert.match(result.warnings[0], /Priced 2 of 6/);
});

test("a failed pool lookup is reported as a failure, not as a token without a pool", async () => {
  const result = await fetchHistoricalPrices(1, [transfer(21_000_000)], {
    key: "test-key",
    fetch: (() => {
      throw new Error("no log query expected");
    }) as unknown as typeof fetch,
    intervalMs: 0,
    resolvePool: async () => {
      throw new Error("RPC call budget exhausted");
    },
  });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, 0);
  assert.match(result.warnings[0], /Pool lookup failed .*budget exhausted/);
  assert.doesNotMatch(result.warnings[0], /No known/);
});

test("a failed pool lookup is reported once for its token, however many blocks it covers", async () => {
  const result = await fetchHistoricalPrices(
    1,
    [transfer(B), transfer(B + 1), transfer(B + 2)],
    {
      key: "test-key",
      fetch: (() => {
        throw new Error("no log query expected");
      }) as unknown as typeof fetch,
      intervalMs: 0,
      resolvePool: async () => {
        throw new Error("RPC call budget exhausted");
      },
    },
  );
  assert.deepEqual(result.quotes, []);
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0],
    /its 3 asset\/block pairs keep the spot price/,
  );
});

test("the budget warning counts only pairs it cut off, not ones already reported", async () => {
  // Fourteen quiet ETH pairs spend the query budget; a last token without a pool was
  // already reported on its own.
  const token: Asset = {
    chainId: 1,
    symbol: "TKN",
    decimals: 18,
    contract: `0x${"7".repeat(40)}` as Address,
  };
  const { fetch: fetcher } = poolHistory([]);
  const result = await fetchHistoricalPrices(
    1,
    [
      ...Array.from({ length: 14 }, (_, index) => transfer(B + index * 1_000)),
      transfer(B + 20_000, token),
    ],
    {
      key: "test-key",
      fetch: fetcher,
      intervalMs: 0,
      maxLookups: 15,
      resolvePool: async (address) =>
        address === `0x${"7".repeat(40)}` ? null : POOL,
    },
  );
  assert.equal(result.calls, MAX_LOG_QUERIES_PER_CALL);
  assert.match(result.warnings[0], /No known USDC pool for TKN/);
  assert.match(
    result.warnings.at(-1)!,
    /Stopped after 80 log queries; 1 asset\/block pair keeps the spot price/,
  );
});

test("the pool search client gets ceilings sized to the distinct tokens", async () => {
  const { poolSearchLimits } = await import("../server/price-provider.ts");
  let limits: PublicRpcOptions | undefined;
  const token: Asset = {
    chainId: 1,
    symbol: "TKN",
    decimals: 18,
    contract: `0x${"7".repeat(40)}` as Address,
  };
  const { fetch: fetcher } = poolHistory([
    { block: B - 10, sqrtPriceX96: ETH_AT_2000 },
  ]);
  const result = await fetchHistoricalPrices(
    1,
    [transfer(B), transfer(B + 1), transfer(B + 2, token)],
    {
      key: "test-key",
      fetch: fetcher,
      intervalMs: 0,
      createClient: (_chainId, given) => {
        limits = given;
        return {
          chainId: 1,
          source: "Stub RPC",
          async request() {
            // Every factory lookup finds the same pool.
            return `0x${POOL.slice(2).padStart(64, "0")}`;
          },
        };
      },
    },
  );
  assert.deepEqual(limits, poolSearchLimits(2));
  assert.equal(result.quotes.length, 3);
});

test("every pool is found before the first log query", async () => {
  const events: string[] = [];
  const { fetch: history } = poolHistory([
    { block: B - 10, sqrtPriceX96: ETH_AT_2000 },
  ]);
  const fetcher = (async (input: URL | string) => {
    events.push("logs");
    return history(input);
  }) as unknown as typeof fetch;
  const token: Asset = {
    chainId: 1,
    symbol: "TKN",
    decimals: 18,
    contract: `0x${"7".repeat(40)}` as Address,
  };
  const result = await fetchHistoricalPrices(
    1,
    [transfer(B), transfer(B + 1), transfer(B + 2, token)],
    {
      key: "test-key",
      fetch: fetcher,
      intervalMs: 0,
      resolvePool: async (address) => {
        events.push(`pool ${address.slice(0, 6)}`);
        return POOL;
      },
    },
  );
  assert.equal(result.quotes.length, 3);
  assert.deepEqual(events.slice(0, 2), ["pool 0xc02a", "pool 0x7777"]);
  assert.ok(events.slice(2).every((event) => event === "logs"));
});

test("pool search ceilings grow with the tokens and stay within the public client", async () => {
  const { poolSearchLimits } = await import("../server/price-provider.ts");
  const { createPublicRpcClient } = await import("../server/rpc.ts");
  assert.equal(poolSearchLimits(4).maxCalls, 12);
  assert.equal(poolSearchLimits(40).maxCalls, 64);
  assert.ok((poolSearchLimits(4).maxDurationMs ?? 0) >= 12 * 1000);
  assert.doesNotThrow(() => createPublicRpcClient(1, poolSearchLimits(40)));
});

test("a provider failure degrades to the spot price instead of throwing", async () => {
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const result = await fetchHistoricalPrices(1, [transfer(21_000_000)], {
    key: "test-key",
    fetch: failing,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
  assert.deepEqual(result.quotes, []);
  assert.match(result.warnings[0], /Log query failed/);
});

interface PoolSwap {
  block: number;
  logIndex?: number;
  sqrtPriceX96: bigint;
}

/**
 * A pool's Swap history served the way Etherscan serves getLogs: filtered to the
 * requested range, oldest first, cut to one page, and "No records found" when empty.
 */
function poolHistory(swaps: PoolSwap[]): { fetch: typeof fetch; seen: URL[] } {
  const ordered = [...swaps].sort(
    (a, b) => a.block - b.block || (a.logIndex ?? 0) - (b.logIndex ?? 0),
  );
  const seen: URL[] = [];
  const impl = (async (input: URL | string) => {
    const url = new URL(String(input));
    seen.push(url);
    const from = Number(url.searchParams.get("fromBlock"));
    const to = Number(url.searchParams.get("toBlock"));
    const result = ordered
      .filter((swap) => swap.block >= from && swap.block <= to)
      .slice(0, Number(url.searchParams.get("offset")))
      .map((swap) => ({
        blockNumber: `0x${swap.block.toString(16)}`,
        logIndex: `0x${(swap.logIndex ?? 0).toString(16)}`,
        data: swapData(swap.sqrtPriceX96),
      }));
    const body = result.length
      ? { status: "1", message: "OK", result }
      : { status: "0", message: "No records found", result: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, seen };
}

const B = 21_000_000;
const lookup = (fetcher: typeof fetch, block = B) =>
  fetchHistoricalPrices(1, [transfer(block)], {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    resolvePool: async () => POOL,
  });
const range = (url: URL) => [
  Number(url.searchParams.get("fromBlock")),
  Number(url.searchParams.get("toBlock")),
];

test("an active pool is priced from its swap at the transfer's block, not the window's oldest page", async () => {
  // A swap in every block of the window. One query over all 50,000 blocks would return
  // the oldest page, about a week before the transfer.
  const swaps = Array.from({ length: 50_101 }, (_, index) => ({
    block: B - 50_000 + index,
    sqrtPriceX96: ETH_AT_2000,
  }));
  const { fetch: fetcher, seen } = poolHistory(swaps);
  const result = await lookup(fetcher);
  assert.equal(result.quotes.length, 1);
  assert.match(result.quotes[0].source, new RegExp(`last swap at block ${B}$`));
  assert.equal(result.calls, 1);
  for (const url of seen)
    assert.ok(range(url)[1] <= B, "never reads past the transfer");
});

test("a full page narrows the window so the newest swaps are not cut off", async () => {
  // Thirty swaps a block: the first 64-block window holds 1,920, more than a page. The
  // block's last swap is the only one at a different price.
  const swaps: PoolSwap[] = [];
  for (let block = B - 200; block <= B; block++)
    for (let logIndex = 0; logIndex < 30; logIndex++)
      swaps.push({
        block,
        logIndex,
        sqrtPriceX96:
          block === B && logIndex === 29 ? ETH_AT_3000 : ETH_AT_2000,
      });
  const { fetch: fetcher, seen } = poolHistory(swaps);
  const result = await lookup(fetcher);
  assert.equal(result.quotes.length, 1);
  assert.ok(Math.abs(Number(result.quotes[0].usd) - 3000) / 3000 < 0.001);
  assert.equal(result.calls, 2);
  assert.ok(
    range(seen[1])[0] > range(seen[0])[0],
    "narrowed toward the transfer",
  );
  assert.equal(range(seen[1])[1], B);
});

test("a quiet pool steps back through adjoining windows to its last swap", async () => {
  const { fetch: fetcher, seen } = poolHistory([
    { block: B - 40_000, sqrtPriceX96: ETH_AT_2000 },
    { block: B - 3_000, sqrtPriceX96: ETH_AT_3000 },
  ]);
  const result = await lookup(fetcher);
  assert.equal(result.quotes.length, 1);
  assert.match(
    result.quotes[0].source,
    new RegExp(`last swap at block ${B - 3_000}$`),
  );
  assert.ok(Math.abs(Number(result.quotes[0].usd) - 3000) / 3000 < 0.001);
  // It starts at the transfer's block and steps back through windows of 64, 256,
  // 1,024 and 4,096 blocks, each ending just before the previous one began.
  assert.deepEqual(range(seen[0]), [B - 63, B]);
  assert.equal(seen.length, 4);
  for (let index = 1; index < seen.length; index++)
    assert.equal(range(seen[index])[1], range(seen[index - 1])[0] - 1);
});

test("a pool silent for the whole window gets no price and never reads before it", async () => {
  const { fetch: fetcher, seen } = poolHistory([
    { block: B - 60_000, sqrtPriceX96: ETH_AT_2000 },
  ]);
  const result = await lookup(fetcher);
  assert.deepEqual(result.quotes, []);
  assert.match(result.warnings[0], /No swaps found .* keeps the spot price/);
  for (const url of seen) assert.ok(range(url)[0] >= B - 50_000);
  assert.equal(range(seen.at(-1)!)[0], B - 50_000);
});

test("a provider refusal is reported as a refusal, not read as an empty window", async () => {
  const refusing = (async () =>
    new Response(
      JSON.stringify({
        status: "0",
        message: "NOTOK",
        result: "Max rate limit reached",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
  const result = await lookup(refusing);
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, 1, "does not step back past a refusal");
  assert.match(result.warnings[0], /Max rate limit reached/);
  assert.doesNotMatch(result.warnings[0], /No swaps found/);
});

test("one call stops at its total query budget and says how many pairs it left", async () => {
  // A pool with no swaps at all: every lookup steps back through six empty windows.
  const { fetch: fetcher } = poolHistory([]);
  const transfers = Array.from({ length: 20 }, (_, index) =>
    transfer(B + index * 1_000),
  );
  const result = await fetchHistoricalPrices(1, transfers, {
    key: "test-key",
    fetch: fetcher,
    intervalMs: 0,
    maxLookups: 20,
    resolvePool: async () => POOL,
  });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, MAX_LOG_QUERIES_PER_CALL);
  assert.match(
    result.warnings.at(-1)!,
    /Stopped after 80 log queries; 7 asset\/block pairs keep the spot price/,
  );
});

test("a lookup that cannot settle stops at its query budget", async () => {
  // An inconsistent provider: every window wider than one block is full, every single
  // block is empty, so the search never finds its swap.
  const inconsistent = (async (input: URL | string) => {
    const [from, to] = range(new URL(String(input)));
    const result =
      to > from
        ? Array.from({ length: LOG_PAGE_SIZE }, () => ({
            blockNumber: `0x${from.toString(16)}`,
            data: swapData(ETH_AT_2000),
          }))
        : [];
    return new Response(
      JSON.stringify(
        result.length
          ? { status: "1", message: "OK", result }
          : { status: "0", message: "No records found", result: [] },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const result = await lookup(inconsistent);
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, MAX_QUERIES_PER_LOOKUP);
  assert.match(result.warnings[0], /after 10 log queries/);
});

/**
 * Real Swap logs from the Uniswap V3 USDC/ETH 0.05% pool on Ethereum mainnet, read
 * from a block explorer at a moment it reported ETH at $2,467.01. These pin the decode
 * and the price maths to observed chain data rather than to invented numbers.
 */
const OBSERVED = {
  pool: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  referenceUsd: 2467.01,
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address,
  usdc: USDC,
  swaps: [
    { block: 26_241_102, sqrtPriceX96: 1595251720565265189376132684439832n },
    { block: 26_241_094, sqrtPriceX96: 1595280566963801287385552686406223n },
    { block: 26_241_091, sqrtPriceX96: 1595116149247414619783124792191313n },
  ],
};

test("observed mainnet swap prices land on the explorer's own ETH price", async () => {
  const { priceFromSqrtPriceX96 } = await import("../server/price-provider.ts");
  for (const swap of OBSERVED.swaps) {
    const usd = priceFromSqrtPriceX96(
      swap.sqrtPriceX96,
      OBSERVED.weth,
      18,
      OBSERVED.usdc,
      6,
    );
    assert.ok(usd, `block ${swap.block} should price`);
    const drift =
      Math.abs(Number(usd) - OBSERVED.referenceUsd) / OBSERVED.referenceUsd;
    assert.ok(
      drift < 0.005,
      `block ${swap.block} priced at ${usd}, which is ${(drift * 100).toFixed(2)}% from the reference`,
    );
  }
});

test("the swap topic matches the event the pool actually emits", () => {
  // Read from the pool's own logs on a block explorer.
  assert.equal(
    SWAP_TOPIC,
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  );
});

test("a real payload's third word is the sqrt price", () => {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  const amount0 = -11394800251n & ((1n << 256n) - 1n);
  const data =
    "0x" +
    word(amount0) +
    word(4621618971867185939n) +
    word(OBSERVED.swaps[1].sqrtPriceX96) +
    word(2225911573494438565n) +
    word(198214n);
  assert.equal(sqrtPriceFromSwapData(data), OBSERVED.swaps[1].sqrtPriceX96);
});
