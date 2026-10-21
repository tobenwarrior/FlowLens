import test from "node:test";
import assert from "node:assert/strict";
import {
  distinctLookups,
  fetchHistoricalPrices,
  latestSwapAtOrBefore,
  sqrtPriceFromSwapData,
  SWAP_TOPIC,
} from "../server/historical-price.ts";
import { transferId } from "../src/domain/engine.ts";
import { usdValue, priceBook } from "../src/domain/pricing.ts";
import type { Address, Asset, Transfer } from "../src/domain/types.ts";

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
