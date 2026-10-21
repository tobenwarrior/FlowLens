import test from "node:test";
import assert from "node:assert/strict";
import {
  createInvestigation,
  assetKey,
  nodeKey,
  transferId,
} from "../src/domain/engine.ts";
import { walletFlows, visibleTransfers } from "../src/domain/wallet-flows.ts";
import type {
  Address,
  Asset,
  Investigation,
  Transfer,
} from "../src/domain/types.ts";

const ROOT = `0x${"1".repeat(40)}` as Address;
const ALICE = `0x${"2".repeat(40)}` as Address;
const BOB = `0x${"3".repeat(40)}` as Address;
const CAROL = `0x${"4".repeat(40)}` as Address;
const TOKEN = `0x${"a".repeat(40)}` as Address;
const USD: Asset = { chainId: 1, symbol: "DEMO", decimals: 6, contract: TOKEN };
function transfer(
  index: number,
  from: Address,
  to: Address,
  amount: string,
  asset = USD,
): Transfer {
  const value: Transfer = {
    id: "",
    chainId: asset.chainId,
    hash: `0x${index.toString(16).padStart(64, "0")}`,
    kind: asset.contract ? "erc20" : "native",
    eventIndex: "0",
    from,
    to,
    asset,
    rawAmount: amount,
    timestamp: "2026-10-10T12:00:00.000Z",
    blockNumber: index,
    status: "success",
    source: "Synthetic wallet-flow contract",
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

test("selected-wallet flows include its counterparties rather than the investigation root's unrelated evidence", () => {
  const value = investigation([
    transfer(1, ROOT, ALICE, "100"),
    transfer(2, BOB, ALICE, "500"),
    transfer(3, ALICE, CAROL, "200"),
    transfer(4, ROOT, CAROL, "999"),
    transfer(5, ALICE, ALICE, "50"),
  ]);
  const before = JSON.stringify(value);
  const result = walletFlows(value, { address: ALICE, chainId: 1 });
  assert.equal(result.scope, "loaded-evidence");
  assert.equal(result.address, ALICE);
  assert.deepEqual(result.flows, [
    { asset: USD, inflow: "650", outflow: "250", net: "400" },
  ]);
  assert.deepEqual(result.counts, {
    transfers: 4,
    visibleTransfers: 4,
    inflows: 3,
    outflows: 2,
  });
  assert.equal(result.counterparties.length, 4);
  assert.equal(
    result.counterparties.find((row) => row.address === BOB)?.flows[0].inflow,
    "500",
  );
  assert.equal(
    result.counterparties.find((row) => row.address === CAROL)?.flows[0]
      .outflow,
    "200",
  );
  assert.equal(JSON.stringify(value), before);
});

test("a self transfer is one row and one counterparty with both gross columns and zero net", () => {
  const value = investigation([transfer(1, ALICE, ALICE, "7500000000000")]);
  const result = walletFlows(value, { address: ALICE });
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].direction, "self");
  assert.equal(result.counterparties.length, 1);
  assert.equal(result.counterparties[0].transferCount, 1);
  assert.equal(result.counterparties[0].inflowCount, 1);
  assert.equal(result.counterparties[0].outflowCount, 1);
  assert.equal(result.flows[0].inflow, "7500000000000");
  assert.equal(result.flows[0].outflow, "7500000000000");
  assert.equal(result.flows[0].net, "0");
});

test("identical symbols on different contracts or chains never share totals or counterparty scope", () => {
  const otherToken: Asset = { ...USD, contract: `0x${"b".repeat(40)}` };
  const base: Asset = { ...USD, chainId: 8453 };
  const value = investigation([
    transfer(1, BOB, ALICE, "100", USD),
    transfer(2, BOB, ALICE, "200", otherToken),
    transfer(3, BOB, ALICE, "300", base),
  ]);
  const result = walletFlows(value, { address: ALICE });
  assert.equal(result.flows.length, 3);
  assert.deepEqual(
    result.flows.map((row) => assetKey(row.asset)),
    [...result.flows.map((row) => assetKey(row.asset))].sort(),
  );
  assert.equal(result.counterparties.length, 2);
  assert.equal(
    result.counterparties.find((row) => row.chainId === 1)?.flows.length,
    2,
  );
  const scoped = walletFlows(value, { address: ALICE, chainId: 8453 });
  assert.equal(scoped.flows.length, 1);
  assert.equal(scoped.flows[0].inflow, "300");
});

test("filters use the selected wallet's direction, contract and inclusive time range", () => {
  const inbound = transfer(1, BOB, ALICE, "100");
  const value = investigation([
    inbound,
    transfer(2, ALICE, BOB, "50"),
    transfer(3, BOB, ROOT, "900"),
  ]);
  const result = walletFlows(value, {
    address: ALICE,
    filter: {
      direction: "in",
      asset: assetKey(USD),
      from: "2026-10-10",
      to: "2026-10-10",
    },
  });
  assert.deepEqual(
    result.transfers.map((row) => row.transfer.id),
    [inbound.id],
  );
  assert.equal(result.flows[0].outflow, "0");
  assert.equal(
    walletFlows(value, { address: ALICE, filter: { to: "2026-10-09" } }).counts
      .transfers,
    0,
  );
});

test("graph visibility is a projection and never changes loaded totals or source evidence", () => {
  const a = transfer(1, BOB, ALICE, "100"),
    b = transfer(2, BOB, ALICE, "200"),
    c = transfer(3, ALICE, CAROL, "50");
  const value = investigation([a, b, c]);
  value.hiddenTransfers = [a.id];
  let result = walletFlows(value, { address: ALICE });
  assert.equal(result.counts.visibleTransfers, 2);
  assert.equal(
    result.counterparties.find((row) => row.address === BOB)?.visibility,
    "some",
  );
  assert.equal(result.flows[0].inflow, "300");
  value.hidden = [nodeKey(1, CAROL)];
  assert.deepEqual(
    visibleTransfers(value).map((t) => t.id),
    [b.id],
  );
  result = walletFlows(value, { address: ALICE });
  assert.equal(
    result.counterparties.find((row) => row.address === CAROL)?.visible,
    false,
  );
  assert.equal(
    result.counterparties.find((row) => row.address === CAROL)?.visibility,
    "none",
  );
  assert.equal(result.flows[0].outflow, "50");
  assert.equal(value.transfers.length, 3);
  assert.deepEqual(visibleTransfers(value, [a, b, b]), [b]);
});

test("pagination is deterministic across source order with whole-scope totals on every page", () => {
  const rows = [
    transfer(3, BOB, ALICE, "3"),
    transfer(1, BOB, ALICE, "1"),
    transfer(2, ALICE, CAROL, "2"),
  ];
  const value = investigation(rows);
  const first = walletFlows(value, { address: ALICE, pageSize: 2 });
  assert.deepEqual(
    first.transfers.map((row) => row.transfer.id),
    [rows[1].id, rows[2].id],
  );
  assert.deepEqual(first.page, {
    offset: 0,
    pageSize: 2,
    total: 3,
    nextOffset: 2,
    previousOffset: null,
  });
  const second = walletFlows(value, {
    address: ALICE,
    offset: first.page.nextOffset!,
    pageSize: 2,
  });
  assert.deepEqual(
    second.transfers.map((row) => row.transfer.id),
    [rows[0].id],
  );
  assert.deepEqual(second.flows, first.flows);
  assert.equal(second.page.nextOffset, null);
  assert.equal(second.page.previousOffset, 0);
  assert.deepEqual(
    walletFlows(
      { ...value, transfers: [...rows].reverse() },
      { address: ALICE, pageSize: 2 },
    ),
    first,
  );
});

test("latest transfers sort before older evidence and canonical identities break timestamp ties", () => {
  const older = transfer(1, BOB, ALICE, "1"),
    latest = {
      ...transfer(2, BOB, ALICE, "2"),
      timestamp: "2026-10-11T12:00:00.000Z",
    };
  const result = walletFlows(investigation([older, latest]), {
    address: ALICE,
  });
  assert.deepEqual(
    result.transfers.map((row) => row.transfer.id),
    [latest.id, older.id],
  );
});

test("exact duplicate observations never inflate rows, counterparties or amount totals", () => {
  const one = transfer(1, BOB, ALICE, "100");
  const value = investigation([one, one]);
  const result = walletFlows(value, { address: ALICE });
  assert.equal(result.counts.transfers, 1);
  assert.equal(result.counterparties[0].transferCount, 1);
  assert.equal(result.flows[0].inflow, "100");
  assert.throws(
    () =>
      walletFlows(investigation([one, { ...one, rawAmount: "999" }]), {
        address: ALICE,
      }),
    /conflicting evidence/i,
  );
});

test("coverage stays wallet/chain scoped and empty unknown wallets stay empty rather than complete", () => {
  const value = investigation([transfer(1, ROOT, ALICE, "100")]);
  value.coverage = [
    {
      key: `synthetic:${nodeKey(1, ALICE)}`,
      address: ALICE,
      chainId: 1,
      provider: "synthetic",
      status: "partial",
      pagesLoaded: 1,
      cursor: "resume",
      streams: ["erc20"],
      warnings: ["Synthetic; internal transfers unavailable"],
      updatedAt: value.updatedAt,
    },
  ];
  const result = walletFlows(value, { address: ALICE, chainId: 1 });
  assert.equal(result.coverage[0].cursor, "resume");
  assert.equal(result.coverage[0].status, "partial");
  const unknown = walletFlows(value, { address: CAROL });
  assert.deepEqual(unknown.coverage, []);
  assert.deepEqual(unknown.flows, []);
  assert.equal(unknown.counts.transfers, 0);
});

test("query bounds and contradictory chain scopes fail before generating a view", () => {
  const value = investigation([]);
  for (const query of [
    { address: "invalid" },
    { address: ALICE, pageSize: 0 },
    { address: ALICE, pageSize: 101 },
    { address: ALICE, offset: -1 },
    { address: ALICE, chainId: 0 },
    { address: ALICE, chainId: 1, filter: { chainId: 8453 } },
  ])
    assert.throws(() => walletFlows(value, query));
});
