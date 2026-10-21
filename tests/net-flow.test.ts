import test from "node:test";
import assert from "node:assert/strict";
import { transferId } from "../src/domain/engine.ts";
import { priceBook } from "../src/domain/pricing.ts";
import { netFlowSeries } from "../src/domain/net-flow.ts";
import type { Address, Asset, Transfer } from "../src/domain/types.ts";

const ROOT = `0x${"1".repeat(40)}` as Address;
const ALICE = `0x${"2".repeat(40)}` as Address;
const USDC: Asset = {
  chainId: 1,
  symbol: "USDC",
  decimals: 6,
  contract: `0x${"a".repeat(40)}` as Address,
};
const WETH: Asset = {
  chainId: 1,
  symbol: "WETH",
  decimals: 18,
  contract: `0x${"b".repeat(40)}` as Address,
};

const BOOK = priceBook([
  {
    key: "1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    usd: "1",
    source: "Synthetic price fixture",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    confidence: "synthetic",
  },
]);

function transfer(
  day: number,
  from: Address,
  to: Address,
  amount: string,
  asset = USDC,
): Transfer {
  const value: Transfer = {
    id: "",
    chainId: asset.chainId,
    hash: `0x${day.toString(16).padStart(64, "0")}`,
    kind: "erc20",
    eventIndex: "0",
    from,
    to,
    asset,
    rawAmount: amount,
    timestamp: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    blockNumber: day,
    status: "success",
    source: "Synthetic net-flow contract",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    synthetic: true,
  };
  value.id = transferId(value);
  return value;
}

test("the series accumulates in and out over time rather than reporting a balance", () => {
  const series = netFlowSeries(
    [
      transfer(1, ALICE, ROOT, "100000000"), // +100
      transfer(2, ROOT, ALICE, "40000000"), // -40
      transfer(3, ALICE, ROOT, "10000000"), // +10
    ],
    ROOT,
    BOOK,
  );
  assert.equal(series.measure, "cumulative-net-flow");
  assert.equal(series.scope, "loaded-evidence");
  assert.deepEqual(
    series.points.map((point) => point.value),
    [100, 60, 70],
  );
  assert.equal(series.max, 100);
  assert.equal(series.min, 0);
});

test("points come back in chronological order whatever order evidence arrived in", () => {
  const series = netFlowSeries(
    [
      transfer(3, ALICE, ROOT, "10000000"),
      transfer(1, ALICE, ROOT, "100000000"),
      transfer(2, ROOT, ALICE, "40000000"),
    ],
    ROOT,
    BOOK,
  );
  assert.deepEqual(
    series.points.map((point) => point.timestamp.slice(8, 10)),
    ["01", "02", "03"],
  );
});

test("net flow can go negative, because it is not a balance", () => {
  const series = netFlowSeries(
    [
      transfer(1, ROOT, ALICE, "50000000"), // -50
      transfer(2, ROOT, ALICE, "25000000"), // -75
    ],
    ROOT,
    BOOK,
  );
  assert.deepEqual(
    series.points.map((point) => point.value),
    [-50, -75],
  );
  assert.equal(series.min, -75);
});

test("with no prices it falls back to the most-loaded asset and says which", () => {
  const series = netFlowSeries(
    [
      transfer(1, ALICE, ROOT, "1000000000000000000", WETH),
      transfer(2, ALICE, ROOT, "2000000000000000000", WETH),
      transfer(3, ALICE, ROOT, "5000000", USDC),
    ],
    ROOT,
    // No quotes at all.
    { quotes: {} },
  );
  assert.equal(series.unit?.kind, "asset");
  assert.equal(
    series.unit && series.unit.kind === "asset" ? series.unit.symbol : null,
    "WETH",
  );
  // The lone USDC transfer is excluded rather than added to a WETH total.
  assert.deepEqual(
    series.points.map((point) => point.value),
    [1, 3],
  );
  assert.equal(series.excluded, 1);
});

test("unpriced transfers are excluded from a USD series instead of counted as zero", () => {
  const series = netFlowSeries(
    [
      transfer(1, ALICE, ROOT, "100000000", USDC),
      transfer(2, ALICE, ROOT, "9000000000000000000", WETH),
    ],
    ROOT,
    BOOK,
  );
  assert.equal(series.unit?.kind, "usd");
  assert.deepEqual(
    series.points.map((point) => point.value),
    [100],
  );
  assert.equal(series.excluded, 1);
});

test("a self-transfer moves nothing but still counts as observed evidence", () => {
  const series = netFlowSeries(
    [
      transfer(1, ALICE, ROOT, "100000000"),
      transfer(2, ROOT, ROOT, "50000000"),
    ],
    ROOT,
    BOOK,
  );
  assert.deepEqual(
    series.points.map((point) => point.value),
    [100, 100],
  );
  assert.equal(series.points.at(-1)?.transferCount, 2);
});

test("evidence that does not involve the focus wallet is ignored", () => {
  const other = `0x${"9".repeat(40)}` as Address;
  const series = netFlowSeries(
    [transfer(1, ALICE, other, "100000000")],
    ROOT,
    BOOK,
  );
  assert.deepEqual(series.points, []);
  assert.equal(series.unit, null);
});
