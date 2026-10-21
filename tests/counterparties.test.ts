import test from "node:test";
import assert from "node:assert/strict";
import { priceBook } from "../src/domain/pricing.ts";
import { rankCounterparties } from "../src/domain/counterparties.ts";
import type { WalletCounterparty } from "../src/domain/wallet-flows.ts";
import type { Address, Asset } from "../src/domain/types.ts";

const USDC: Asset = {
  chainId: 1,
  symbol: "USDC",
  decimals: 6,
  contract: `0x${"a".repeat(40)}` as Address,
};
const OBSCURE: Asset = {
  chainId: 1,
  symbol: "OBS",
  decimals: 18,
  contract: `0x${"c".repeat(40)}` as Address,
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

function party(
  name: string,
  inflow: string,
  outflow: string,
  transferCount: number,
  asset = USDC,
): WalletCounterparty {
  return {
    key: `1:${name}`,
    address: `0x${name.repeat(40).slice(0, 40)}` as Address,
    chainId: 1,
    flows: [
      {
        asset,
        inflow,
        outflow,
        net: (BigInt(inflow) - BigInt(outflow)).toString(),
      },
    ],
    transferIds: [],
    transferCount,
    inflowCount: 0,
    outflowCount: 0,
    visible: true,
    visibility: "all",
  };
}

test("counterparties rank by USD moved in both directions, not by net", () => {
  // Churn: sent and received a lot, nets to nothing.
  const churn = party("1", "500000000", "500000000", 2);
  // Received a little, never sent.
  const small = party("2", "9000000", "0", 9);
  const result = rankCounterparties([small, churn], BOOK);
  assert.equal(result.basis, "usd-volume");
  assert.equal(result.rows[0].counterparty.key, "1:1");
  assert.equal(result.rows[0].usdVolume, 1000);
  assert.equal(result.rows[1].usdVolume, 9);
});

test("in and out stay separate on each row", () => {
  const result = rankCounterparties(
    [party("1", "300000000", "100000000", 3)],
    BOOK,
  );
  assert.equal(result.rows[0].usdIn, 300);
  assert.equal(result.rows[0].usdOut, 100);
  assert.equal(result.rows[0].usdVolume, 400);
});

test("an unpriced counterparty reports no USD rather than zero", () => {
  const result = rankCounterparties(
    [party("1", "5000000000000000000", "0", 4, OBSCURE)],
    BOOK,
  );
  assert.equal(result.rows[0].usdIn, null);
  assert.equal(result.rows[0].usdVolume, null);
  assert.equal(result.unpriced, 1);
});

test("unpriced counterparties sort after priced ones instead of ranking as worthless", () => {
  const unpriced = party("1", "9000000000000000000", "0", 50, OBSCURE);
  const tiny = party("2", "1000000", "0", 1);
  const result = rankCounterparties([unpriced, tiny], BOOK);
  // The unpriced wallet has far more transfers, but no value to compare on.
  assert.equal(result.rows[0].counterparty.key, "1:2");
  assert.equal(result.rows[1].counterparty.key, "1:1");
  assert.equal(result.basis, "usd-volume");
  assert.equal(result.unpriced, 1);
});

test("with no prices at all the ranking falls back to transfer count and says so", () => {
  const result = rankCounterparties(
    [
      party("1", "1000000", "0", 2, OBSCURE),
      party("2", "1000000", "0", 7, OBSCURE),
    ],
    { quotes: {} },
  );
  assert.equal(result.basis, "transfer-count");
  assert.equal(result.rows[0].counterparty.transferCount, 7);
});

test("the list is bounded and reports what it left out", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    party(String(index % 9), `${(index + 1) * 1000000}`, "0", index + 1),
  );
  const result = rankCounterparties(many, BOOK, 5);
  assert.equal(result.rows.length, 5);
  assert.equal(result.omitted, 7);
});

test("ties resolve the same way on every read", () => {
  const a = party("1", "1000000", "0", 3);
  const b = party("2", "1000000", "0", 3);
  const first = rankCounterparties([a, b], BOOK).rows.map(
    (r) => r.counterparty.key,
  );
  const second = rankCounterparties([b, a], BOOK).rows.map(
    (r) => r.counterparty.key,
  );
  assert.deepEqual(first, second);
});

test("no counterparties yields an empty ranking rather than failing", () => {
  const result = rankCounterparties([], BOOK);
  assert.deepEqual(result.rows, []);
  assert.equal(result.basis, "transfer-count");
  assert.equal(result.omitted, 0);
});
