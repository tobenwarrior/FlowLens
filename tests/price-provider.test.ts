import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult, parseAbi } from "viem";
import {
  fetchOnChainPrices,
  MAX_SPOT_ASSETS,
  priceFromSqrtPriceX96,
  spotCallBudget,
} from "../server/price-provider.ts";
import {
  createPublicRpcClient,
  DEFAULT_RPC_INTERVAL_MS,
} from "../server/rpc.ts";
import type { PublicRpcOptions, RpcClient } from "../server/rpc.ts";
import type { Address, Asset } from "../src/domain/types.ts";

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7" as Address;
// Sorts before USDC, so it lands on token0 and exercises the non-inverted branch.
const LOW = `0x${"1".repeat(40)}` as Address;
const POOL = `0x${"5".repeat(40)}` as Address;

const ETH: Asset = { chainId: 1, symbol: "ETH", decimals: 18, contract: null };
const LOW_TOKEN: Asset = {
  chainId: 1,
  symbol: "LOW",
  decimals: 18,
  contract: LOW,
};
const USDC_ASSET: Asset = {
  chainId: 1,
  symbol: "USDC",
  decimals: 6,
  contract: USDC,
};

/** sqrtPriceX96 for a raw token1-per-token0 ratio. */
function sqrtPriceX96For(rawRatio: number): bigint {
  return BigInt(Math.floor(Math.sqrt(rawRatio) * 2 ** 96));
}

function near(actual: string, expected: number, tolerance = 0.001) {
  const value = Number(actual);
  assert.ok(
    Math.abs(value - expected) / expected < tolerance,
    `expected ~${expected}, received ${value}`,
  );
}

test("a token quoted as pool token1 inverts to USD per token", () => {
  // USDC (0xa0…) sorts below WETH (0xc0…), so the pool is USDC/WETH and the raw
  // ratio is wei per USDC-unit: 1 USDC = 1/2000 ETH at $2000.
  const raw = 10 ** 18 / 2000 / 10 ** 6;
  const price = priceFromSqrtPriceX96(sqrtPriceX96For(raw), WETH, 18, USDC, 6);
  assert.ok(price);
  near(price, 2000);
});

test("a token quoted as pool token0 needs no inversion", () => {
  // LOW (0x11…) sorts below USDC, so raw is USDC-units per LOW-unit. At $3:
  const raw = (3 * 10 ** 6) / 10 ** 18;
  const price = priceFromSqrtPriceX96(sqrtPriceX96For(raw), LOW, 18, USDC, 6);
  assert.ok(price);
  near(price, 3);
});

test("an uninitialised pool yields no price rather than zero", () => {
  assert.equal(priceFromSqrtPriceX96(0n, WETH, 18, USDC, 6), null);
});

function stubClient(
  handler: (method: string, params: unknown[]) => unknown,
  counter = { calls: 0 },
): RpcClient & { counter: { calls: number } } {
  return {
    chainId: 1,
    source: "Stub RPC",
    counter,
    async request(method: string, params: unknown[]) {
      counter.calls += 1;
      return handler(method, params);
    },
  };
}

function poolResponses(sqrtPriceX96: bigint, feeWithPool = 500) {
  return (_method: string, params: unknown[]) => {
    const call = (params[0] ?? {}) as { to?: string; data?: string };
    const to = (call.to ?? "").toLowerCase();
    if (to.endsWith("31f984") || to.endsWith("f6fdfd")) {
      // Only one fee tier has a pool; the data encodes the tier in its last bytes.
      const data = call.data ?? "";
      const fee = Number(BigInt(`0x${data.slice(-64)}`));
      return encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "getPool",
        result: (fee === feeWithPool
          ? POOL
          : "0x0000000000000000000000000000000000000000") as Address,
      });
    }
    return encodeFunctionResult({
      abi: POOL_ABI,
      functionName: "slot0",
      result: [sqrtPriceX96, 0, 0, 1, 1, 0, true],
    });
  };
}

test("a pegged stablecoin is priced at one dollar without a pool read, and says it is an assumption", async () => {
  const client = stubClient(() => {
    throw new Error("no RPC call should be made for a pegged asset");
  });
  const result = await fetchOnChainPrices(1, [USDC_ASSET], { client });
  assert.equal(result.calls, 0);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].usd, "1");
  assert.match(result.quotes[0].source, /one US dollar/);
  // A peg is an issuer promise, not an observation.
  assert.equal(result.quotes[0].confidence, "unverified");
});

test("the native asset is priced through its wrapped token", async () => {
  const raw = 10 ** 18 / 2000 / 10 ** 6;
  const client = stubClient(poolResponses(sqrtPriceX96For(raw)));
  const result = await fetchOnChainPrices(1, [ETH], { client });
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].key, "1:native");
  near(result.quotes[0].usd, 2000);
  assert.equal(result.quotes[0].confidence, "reported");
  assert.match(result.quotes[0].source, /Uniswap V3 spot/);
});

test("the quote names the pool it came from, so a spot price can be checked", async () => {
  const raw = 10 ** 18 / 2000 / 10 ** 6;
  const client = stubClient(poolResponses(sqrtPriceX96For(raw), 3000));
  const result = await fetchOnChainPrices(1, [ETH], { client });
  assert.match(result.quotes[0].source, new RegExp(POOL));
  assert.match(result.quotes[0].source, /0\.3% pool/);
});

test("an asset with no pool is reported as unpriced rather than guessed", async () => {
  const client = stubClient((_method, params) => {
    const call = (params[0] ?? {}) as { to?: string };
    if ((call.to ?? "").toLowerCase().endsWith("31f984"))
      return encodeFunctionResult({
        abi: FACTORY_ABI,
        functionName: "getPool",
        result: "0x0000000000000000000000000000000000000000" as Address,
      });
    throw new Error("unexpected pool read");
  });
  const result = await fetchOnChainPrices(1, [LOW_TOKEN], { client });
  assert.deepEqual(result.quotes, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /No Uniswap V3 USDC pool/);
  // Three fee tiers tried, then it stops.
  assert.equal(result.calls, 3);
});

test("an unsupported chain returns a warning and makes no calls", async () => {
  const result = await fetchOnChainPrices(999, [
    { ...USDC_ASSET, chainId: 999 },
  ]);
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, 0);
  assert.match(result.warnings[0], /No on-chain USD route/);
});

test("the lookup is bounded and says what it left unpriced", async () => {
  const assets: Asset[] = Array.from({ length: 5 }, (_, index) => ({
    chainId: 1,
    symbol: `T${index}`,
    decimals: 18,
    contract: `0x${String(index + 2).repeat(40)}` as Address,
  }));
  const client = stubClient(poolResponses(sqrtPriceX96For(1e-12)));
  const result = await fetchOnChainPrices(1, assets, {
    client,
    maxAssets: 2,
  });
  assert.equal(result.quotes.length, 2);
  assert.match(result.warnings[0], /Priced the first 2 of 5/);
});

/** Every fee tier has a pool but only the last is initialised: the worst case per asset. */
function worstCase(_method: string, params: unknown[]) {
  const poolForFee = (fee: number) =>
    `0x${fee.toString(16).padStart(40, "0")}` as Address;
  const call = (params[0] ?? {}) as { to?: string; data?: string };
  const to = (call.to ?? "").toLowerCase();
  if (to.endsWith("31f984")) {
    const fee = Number(BigInt(`0x${(call.data ?? "").slice(-64)}`));
    return encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "getPool",
      result: poolForFee(fee),
    });
  }
  return encodeFunctionResult({
    abi: POOL_ABI,
    functionName: "slot0",
    result: [
      to === poolForFee(10_000) ? sqrtPriceX96For(1e-12) : 0n,
      0,
      0,
      1,
      1,
      0,
      true,
    ],
  });
}

/** A client that refuses any call past the ceiling it was built with, as the public RPC does. */
function ceilingClient(limits: PublicRpcOptions) {
  let calls = 0;
  return stubClient((method, params) => {
    calls += 1;
    if (calls > (limits.maxCalls ?? 0))
      throw new Error("call ceiling exceeded");
    return worstCase(method, params);
  });
}

const pooledAssets = (count: number): Asset[] =>
  Array.from({ length: count }, (_, index) => ({
    chainId: 1,
    symbol: `T${index}`,
    decimals: 18,
    contract: `0x${(index + 0x20).toString(16).repeat(20)}` as Address,
  }));

test("at the worst case every selected asset prices within the ceilings its client is given", async () => {
  // Ten assets that all need a pool: 60 calls, more than the 48 the client used to allow.
  let limits: PublicRpcOptions | undefined;
  const result = await fetchOnChainPrices(1, pooledAssets(12), {
    maxAssets: 12,
    createClient: (_chainId, given) => {
      limits = given;
      return ceilingClient(given);
    },
  });
  assert.match(result.warnings[0], /Priced the first 10 of 12/);
  assert.equal(result.quotes.length, MAX_SPOT_ASSETS);
  assert.equal(result.calls, spotCallBudget(MAX_SPOT_ASSETS));
  assert.equal(limits?.maxCalls, spotCallBudget(MAX_SPOT_ASSETS));
  // The public RPC spaces calls a second apart, so the time allowed must cover them all.
  assert.ok(
    (limits?.maxDurationMs ?? 0) >=
      spotCallBudget(MAX_SPOT_ASSETS) * DEFAULT_RPC_INTERVAL_MS,
  );
  // And the real client accepts those ceilings.
  assert.doesNotThrow(() => createPublicRpcClient(1, limits));
});

test("pegged stablecoins cost no calls, so they do not raise the ceiling", async () => {
  const pegged: Asset[] = [
    USDC_ASSET,
    { chainId: 1, symbol: "USDT", decimals: 6, contract: USDT },
  ];
  let limits: PublicRpcOptions | undefined;
  const result = await fetchOnChainPrices(1, [...pegged, ...pooledAssets(3)], {
    createClient: (_chainId, given) => {
      limits = given;
      return ceilingClient(given);
    },
  });
  assert.equal(result.quotes.length, 5);
  assert.equal(limits?.maxCalls, spotCallBudget(3));
  assert.equal(result.calls, spotCallBudget(3));
  // A small lookup still gets the client's default 45 seconds, not less.
  assert.equal(limits?.maxDurationMs, 45_000);
});

test("assets from another chain are ignored rather than priced on this one", async () => {
  const client = stubClient(poolResponses(sqrtPriceX96For(1e-12)));
  const result = await fetchOnChainPrices(
    1,
    [{ ...USDC_ASSET, chainId: 8453 }],
    { client },
  );
  assert.deepEqual(result.quotes, []);
  assert.equal(result.calls, 0);
});

test("every supported chain treats its own USDT or USDC as pegged", async () => {
  const client = stubClient(() => {
    throw new Error("no RPC call expected");
  });
  const result = await fetchOnChainPrices(
    1,
    [{ chainId: 1, symbol: "USDT", decimals: 6, contract: USDT }],
    { client },
  );
  assert.equal(result.quotes[0].usd, "1");
});
