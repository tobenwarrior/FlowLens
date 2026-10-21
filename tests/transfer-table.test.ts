import test from "node:test";
import assert from "node:assert/strict";
import {
  createInvestigation,
  nodeKey,
  transferId,
} from "../src/domain/engine.ts";
import {
  formatCompact,
  formatUsd,
  priceBook,
  usdValue,
} from "../src/domain/pricing.ts";
import { deriveSwaps } from "../src/domain/swaps.ts";
import { buildTransferTable } from "../src/domain/transfer-table.ts";
import type {
  Address,
  Asset,
  Investigation,
  Transfer,
} from "../src/domain/types.ts";

const ROOT = `0x${"1".repeat(40)}` as Address;
const ALICE = `0x${"2".repeat(40)}` as Address;
const ROUTER = `0x${"3".repeat(40)}` as Address;
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
  {
    key: "1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    usd: "2000",
    source: "Synthetic price fixture",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    confidence: "synthetic",
  },
]);

function transfer(
  index: number,
  from: Address,
  to: Address,
  amount: string,
  asset = USDC,
  hash = index,
  eventIndex = "0",
): Transfer {
  const value: Transfer = {
    id: "",
    chainId: asset.chainId,
    hash: `0x${hash.toString(16).padStart(64, "0")}`,
    kind: asset.contract ? "erc20" : "native",
    eventIndex,
    from,
    to,
    asset,
    rawAmount: amount,
    timestamp: `2026-10-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
    blockNumber: index,
    status: "success",
    source: "Synthetic transfer-table contract",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    synthetic: true,
  };
  value.id = transferId(value);
  return value;
}

function investigation(transfers: Transfer[]): Investigation {
  const value = createInvestigation(ROOT, "demo");
  value.transfers = transfers;
  const nodes = new Map(
    transfers.flatMap((t) =>
      [t.from, t.to].map(
        (address) =>
          [
            nodeKey(t.chainId, address),
            { chainId: t.chainId, address },
          ] as const,
      ),
    ),
  );
  value.nodes = [...nodes.values()];
  return value;
}

test("USD annotation derives from raw amount and decimals without touching the exact value", () => {
  const sent = transfer(1, ROOT, ALICE, "48023000000");
  const value = usdValue(sent, BOOK);
  assert.ok(value);
  assert.equal(Number(value.amount), 48023);
  assert.equal(value.quote.confidence, "synthetic");
  // The transfer itself is untouched: exactness is the engine's, not the display's.
  assert.equal(sent.rawAmount, "48023000000");
});

test("an asset with no quote reports no USD rather than zero", () => {
  const unpriced: Asset = {
    ...USDC,
    contract: `0x${"c".repeat(40)}` as Address,
  };
  assert.equal(usdValue(transfer(1, ROOT, ALICE, "100", unpriced), BOOK), null);
  assert.equal(formatUsd(null), "—");
});

test("compact magnitudes match the reference table's rendering", () => {
  assert.equal(formatCompact(48023), "48.023K");
  assert.equal(formatCompact(2_000_000), "2M");
  assert.equal(formatCompact(180_000), "180K");
  assert.equal(formatCompact(49.517), "49.517");
  assert.equal(formatCompact(100), "100");
  assert.equal(
    formatUsd({
      amount: "2180000",
      quote: BOOK.quotes["1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }),
    "$2.18M",
  );
});

test("sub-dollar amounts keep significant digits instead of collapsing to zero", () => {
  assert.equal(formatCompact(0.0049), "0.0049");
  assert.notEqual(formatCompact(0.0000031), "0");
});

test("two opposing legs in one transaction derive a swap with its shared venue", () => {
  const hash = 77;
  const rows = deriveSwaps(
    [
      transfer(1, ROOT, ROUTER, "1000000000", USDC, hash, "0"),
      transfer(2, ROUTER, ROOT, "500000000000000000", WETH, hash, "1"),
    ],
    ROOT,
    BOOK,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sold.asset.symbol, "USDC");
  assert.equal(rows[0].bought.asset.symbol, "WETH");
  assert.equal(rows[0].venue, ROUTER);
  assert.equal(Number(rows[0].usd?.amount), 1000);
});

test("a same-asset pass-through in one transaction is not a swap", () => {
  const hash = 88;
  const rows = deriveSwaps(
    [
      transfer(1, ROOT, ROUTER, "1000000000", USDC, hash, "0"),
      transfer(2, ROUTER, ROOT, "999000000", USDC, hash, "1"),
    ],
    ROOT,
    BOOK,
  );
  assert.deepEqual(rows, []);
});

test("a one-sided transaction is not a swap", () => {
  const rows = deriveSwaps([transfer(1, ROOT, ALICE, "100")], ROOT, BOOK);
  assert.deepEqual(rows, []);
});

test("inflow and outflow tabs partition the transfers tab", () => {
  const value = investigation([
    transfer(1, ALICE, ROOT, "100000000"),
    transfer(2, ROOT, ALICE, "200000000"),
    transfer(3, ALICE, ROOT, "300000000"),
  ]);
  const all = buildTransferTable(value, { address: ROOT, book: BOOK });
  assert.equal(all.counts.transfers, 3);
  assert.equal(all.counts.inflow, 2);
  assert.equal(all.counts.outflow, 1);

  const inflow = buildTransferTable(value, {
    address: ROOT,
    tab: "inflow",
    book: BOOK,
  });
  assert.ok(inflow.rows.every((row) => row.direction !== "out"));
  const outflow = buildTransferTable(value, {
    address: ROOT,
    tab: "outflow",
    book: BOOK,
  });
  assert.ok(outflow.rows.every((row) => row.direction !== "in"));
});

test("the USD floor chip drops rows below it, including unpriced rows", () => {
  const unpriced: Asset = {
    ...USDC,
    contract: `0x${"d".repeat(40)}` as Address,
  };
  const value = investigation([
    transfer(1, ALICE, ROOT, "5000000"), // $5
    transfer(2, ALICE, ROOT, "500000"), // $0.50
    transfer(3, ALICE, ROOT, "9000000", unpriced), // no quote
  ]);
  const result = buildTransferTable(value, {
    address: ROOT,
    filter: { minUsd: 1 },
    book: BOOK,
  });
  assert.equal(result.counts.transfers, 1);
  assert.equal(Number(result.rows[0].usd?.amount), 5);
});

test("value sorts by token magnitude while USD sorts by worth, and paging stays deterministic", () => {
  const value = investigation([
    transfer(1, ALICE, ROOT, "1000000", USDC), // 1 USDC = $1
    transfer(2, ALICE, ROOT, "2000000000000000000", WETH), // 2 WETH = $4000
    transfer(3, ALICE, ROOT, "5000000", USDC), // 5 USDC = $5
  ]);
  // VALUE is the token column: it ranks what that column displays, across decimals.
  const byValue = buildTransferTable(value, {
    address: ROOT,
    sort: { field: "value", direction: "desc" },
    book: BOOK,
  });
  assert.deepEqual(
    byValue.rows.map((row) => row.transfer.rawAmount),
    ["5000000", "2000000000000000000", "1000000"],
  );
  // USD is the comparable column: 2 WETH outranks 5 USDC.
  const byUsd = buildTransferTable(value, {
    address: ROOT,
    sort: { field: "usd", direction: "desc" },
    book: BOOK,
  });
  assert.deepEqual(
    byUsd.rows.map((row) => row.transfer.asset.symbol),
    ["WETH", "USDC", "USDC"],
  );

  const first = buildTransferTable(value, {
    address: ROOT,
    pageSize: 2,
    book: BOOK,
  });
  const second = buildTransferTable(value, {
    address: ROOT,
    pageSize: 2,
    offset: 2,
    book: BOOK,
  });
  assert.equal(first.rows.length, 2);
  assert.equal(second.rows.length, 1);
  assert.equal(first.page.pageCount, 2);
  const ids = [...first.rows, ...second.rows].map((row) => row.id);
  assert.equal(new Set(ids).size, 3, "paging must not repeat or drop a row");
});

test("an empty table reports loaded-evidence scope rather than implying no history exists", () => {
  const result = buildTransferTable(investigation([]), {
    address: ROOT,
    book: BOOK,
  });
  assert.equal(result.scope, "loaded-evidence");
  assert.equal(result.page.total, 0);
  assert.equal(result.page.pageCount, 1);
});
