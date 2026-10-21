import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFlows,
  assetKey,
  buildEdges,
  createInvestigation,
  expandInvestigation,
  filterTransfers,
  formatUnits,
  nodeKey,
  normalizeAddress,
  parseInvestigation,
  transferId,
} from "../src/domain/engine.ts";
import {
  DEMO_ROOT,
  createDemoInvestigation,
  demoProvider,
} from "../src/domain/demo.ts";
import type { Address, TraceProvider, Transfer } from "../src/domain/types.ts";

const ROOT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
function transfer(change: Partial<Transfer> = {}): Transfer {
  const t: Transfer = {
    id: "",
    chainId: 1,
    hash: `0x${"1".repeat(64)}`,
    kind: "erc20",
    eventIndex: "0",
    from: OTHER,
    to: ROOT,
    asset: { chainId: 1, symbol: "USDC", decimals: 6, contract: TOKEN },
    rawAmount: "123456789012345678901",
    timestamp: "2026-10-10T12:00:00.000Z",
    blockNumber: 10,
    status: "success",
    source: "test source",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    ...change,
  };
  t.id = transferId(t);
  return t;
}
function provider(fetchPage: TraceProvider["fetchPage"]): TraceProvider {
  return { id: "test", mode: "demo", fetchPage };
}

test("normalizes EVM addresses and rejects invalid input", () => {
  assert.equal(
    normalizeAddress(" 0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa "),
    TOKEN,
  );
  assert.throws(() => normalizeAddress("0x123"), "40 hexadecimal");
});
test("identities keep chain, event, kind and asset contracts distinct", () => {
  const t = transfer();
  assert.notEqual(t.id, transferId({ ...t, chainId: 8453 }));
  assert.notEqual(t.id, transferId({ ...t, eventIndex: "1" }));
  assert.notEqual(t.id, transferId({ ...t, kind: "internal" }));
  assert.notEqual(assetKey(t.asset), assetKey({ ...t.asset, chainId: 8453 }));
  assert.equal(nodeKey(1, TOKEN.toUpperCase() as Address), `1:${TOKEN}`);
});
test("formats integer token units without floating point loss", () => {
  assert.equal(
    formatUnits("123456789012345678901", 6),
    "123456789012345.678901",
  );
  assert.equal(formatUnits("-5", 6), "-0.000005");
  assert.equal(formatUnits("999999", 6, 3), "0.999");
  assert.equal(formatUnits("1000000", 6), "1");
  assert.throws(() => formatUnits("1.2", 6));
});
test("gross inflow and outflow remain distinct from net for each contract", () => {
  const a = transfer({ rawAmount: "1000000" }),
    b = transfer({
      from: ROOT,
      to: OTHER,
      rawAmount: "700000",
      eventIndex: "1",
    });
  const c = transfer({
    rawAmount: "9000000",
    asset: { ...a.asset, contract: OTHER },
    eventIndex: "2",
  });
  const flows = aggregateFlows([a, b, c], ROOT);
  assert.equal(flows.length, 2);
  assert.deepEqual(flows[0], {
    asset: a.asset,
    inflow: "1000000",
    outflow: "700000",
    net: "300000",
  });
});
test("equal 7.5 million token inflow and outflow retain both gross amounts with zero net", () => {
  const raw = "7500000000000000000000000";
  const inbound = transfer({
    rawAmount: raw,
    asset: { chainId: 1, symbol: "DEMO", decimals: 18, contract: TOKEN },
  });
  const outbound = transfer({
    from: ROOT,
    to: OTHER,
    rawAmount: raw,
    eventIndex: "1",
    asset: inbound.asset,
  });
  const flow = aggregateFlows([inbound, outbound], ROOT)[0];
  assert.equal(flow.inflow, raw);
  assert.equal(flow.outflow, raw);
  assert.equal(flow.net, "0");
  assert.equal(formatUnits(flow.inflow, flow.asset.decimals), "7500000");
  assert.equal(formatUnits(flow.outflow, flow.asset.decimals), "7500000");
});
test("self transfers count in both gross columns and contribute zero net", () => {
  const self = transfer({ from: ROOT, to: ROOT, rawAmount: "100" });
  assert.deepEqual(aggregateFlows([self], ROOT)[0], {
    asset: self.asset,
    inflow: "100",
    outflow: "100",
    net: "0",
  });
});
test("duplicate evidence never inflates totals or graph edges", () => {
  const t = transfer();
  assert.equal(aggregateFlows([t, t], ROOT)[0].inflow, t.rawAmount);
  assert.equal(buildEdges([t, t])[0].transfers.length, 1);
  assert.equal(
    buildEdges([t, transfer({ from: ROOT, to: OTHER, eventIndex: "1" })])
      .length,
    2,
  );
});
test("an evidence ID cannot silently replace an observed amount", async () => {
  let calls = 0;
  const p = provider(async () => ({
    transfers: [transfer({ rawAmount: calls++ ? "999" : "100" })],
    nodes: [],
    cursor: "next",
    warnings: [],
    streams: ["erc20"],
    exhausted: false,
  }));
  const first = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  const retry = await expandInvestigation(first, p, {
    address: ROOT,
    chainId: 1,
    cursor: null,
  });
  assert.equal(retry.transfers[0].rawAmount, "100");
  assert.equal(retry.coverage[0].status, "error");
  assert.match(retry.coverage[0].error!, /conflicting evidence/i);
});
test("conflicting asset decimals never produce a misleading aggregate", () => {
  const t = transfer();
  assert.throws(
    () =>
      aggregateFlows(
        [t, transfer({ eventIndex: "1", asset: { ...t.asset, decimals: 18 } })],
        ROOT,
      ),
    /decimals/i,
  );
});
test("filters enforce chain, contract, root direction and inclusive date-only ranges", () => {
  const inbound = transfer(),
    out = transfer({ eventIndex: "1", from: ROOT, to: OTHER });
  const base = transfer({
    chainId: 8453,
    asset: { ...inbound.asset, chainId: 8453 },
    eventIndex: "2",
  });
  assert.deepEqual(
    filterTransfers([inbound, out, base], ROOT, {
      chainId: 1,
      direction: "in",
      asset: assetKey(inbound.asset),
      from: "2026-10-10",
      to: "2026-10-10",
    }),
    [inbound],
  );
  assert.equal(
    filterTransfers([inbound], ROOT, { to: "2026-10-09" }).length,
    0,
  );
  assert.throws(() => filterTransfers([inbound], ROOT, { from: "bad-date" }));
});
test("bounded expansion resumes its cursor and retries without duplicates", async () => {
  const seen: (string | null | undefined)[] = [];
  const p = provider(async (q) => {
    seen.push(q.cursor);
    return {
      transfers: [transfer()],
      nodes: [],
      cursor: q.cursor === "second" ? null : "second",
      warnings: [],
      streams: ["erc20"],
      exhausted: q.cursor === "second",
    };
  });
  const first = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  const next = await expandInvestigation(first, p, {
    address: ROOT,
    chainId: 1,
  });
  assert.deepEqual(seen, [null, "second"]);
  assert.equal(next.transfers.length, 1);
  assert.equal(next.coverage[0].pagesLoaded, 2);
  assert.equal(next.coverage[0].status, "exhausted");
  assert(next.coverage[0].warnings.some((w) => w.includes("internal")));
  assert.equal(
    first.transfers.length,
    1,
    "does not mutate the input investigation",
  );
});
test("explicit restart retains already loaded evidence and does not refetch exhausted cursor implicitly", async () => {
  let calls = 0;
  const p = provider(async () => {
    calls++;
    return {
      transfers: [transfer()],
      nodes: [],
      cursor: null,
      warnings: [],
      streams: ["erc20"],
      exhausted: true,
    };
  });
  const first = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  await expandInvestigation(first, p, { address: ROOT, chainId: 1 });
  assert.equal(calls, 1);
  const retry = await expandInvestigation(first, p, {
    address: ROOT,
    chainId: 1,
    cursor: null,
  });
  assert.equal(calls, 2);
  assert.equal(retry.transfers.length, 1);
});
test("provider failures retain last successful cursor and evidence", async () => {
  let calls = 0;
  const p = provider(async () => {
    if (calls++) throw new Error("rate limited");
    return {
      transfers: [transfer()],
      nodes: [],
      cursor: "resume",
      warnings: [],
      streams: ["erc20"],
      exhausted: false,
    };
  });
  const first = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  const failed = await expandInvestigation(first, p, {
    address: ROOT,
    chainId: 1,
  });
  assert.equal(failed.transfers.length, 1);
  assert.equal(failed.coverage[0].cursor, "resume");
  assert.equal(failed.coverage[0].status, "error");
  assert.equal(failed.coverage[0].error, "rate limited");
  assert.equal(failed.coverage[0].pagesLoaded, 1);
});
test("a non-progressing cursor is rejected across separate one-page operations", async () => {
  const p = provider(async () => ({
    transfers: [transfer()],
    nodes: [],
    cursor: "stuck",
    warnings: [],
    streams: ["erc20"],
    exhausted: false,
  }));
  const first = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  const retry = await expandInvestigation(first, p, {
    address: ROOT,
    chainId: 1,
  });
  assert.equal(retry.coverage[0].status, "error");
  assert.equal(retry.coverage[0].pagesLoaded, 1);
  assert.equal(retry.coverage[0].cursor, "stuck");
});
test("node budget refuses a page atomically and preserves its cursor", async () => {
  const p = provider(async () => ({
    transfers: [transfer()],
    nodes: [],
    cursor: "next",
    warnings: [],
    streams: ["erc20"],
    exhausted: false,
  }));
  const c = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
    { maxPages: 1, maxNodes: 1 },
  );
  assert.equal(c.transfers.length, 0);
  assert.equal(c.coverage[0].cursor, null);
  assert.equal(c.coverage[0].status, "error");
  assert.match(c.coverage[0].error!, /node budget/i);
});
test("page budget is bounded and repeating cursors stop looping", async () => {
  let calls = 0;
  const p = provider(async () => {
    calls++;
    return {
      transfers: [transfer()],
      nodes: [],
      cursor: "same",
      warnings: [],
      streams: ["erc20"],
      exhausted: false,
    };
  });
  const c = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
    { maxPages: 3, maxNodes: 10 },
  );
  assert.equal(calls, 2);
  assert.equal(c.coverage[0].status, "error");
  assert.match(c.coverage[0].error!, /cursor/i);
  await assert.rejects(
    expandInvestigation(
      c,
      p,
      { address: ROOT, chainId: 1 },
      { maxPages: 11, maxNodes: 10 },
    ),
  );
});
test("mode mismatch never mixes fixture evidence into a live case", async () => {
  await assert.rejects(
    expandInvestigation(createInvestigation(ROOT, "live"), demoProvider, {
      address: ROOT,
      chainId: 1,
    }),
    /mode/i,
  );
});
test("counterparty expansion retains the original investigation root", async () => {
  const c = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    provider(async () => ({
      transfers: [transfer()],
      nodes: [],
      cursor: null,
      warnings: [],
      streams: ["erc20"],
      exhausted: true,
    })),
    { address: OTHER, chainId: 1 },
  );
  assert.equal(c.root, ROOT);
  assert(c.expanded.includes(nodeKey(1, OTHER)));
});
test("snapshot roundtrip retains provenance, cursors, notes and original strings", async () => {
  const c = await createDemoInvestigation();
  c.notes = "An investigative hypothesis, not a conclusion.";
  const restored = parseInvestigation(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(restored, c);
  assert(restored.nodes.some((n) => n.label?.confidence === "synthetic"));
  assert(restored.coverage.some((c) => c.cursor));
});
test("all imported timestamp fields normalize offsets to sortable UTC instants", async () => {
  const c = await createDemoInvestigation();
  const offset = "2026-10-11T00:30:00+02:00",
    utc = "2026-10-10T22:30:00.000Z";
  c.createdAt = offset;
  c.updatedAt = offset;
  c.transfers[0].timestamp = offset;
  c.transfers[0].retrievedAt = offset;
  c.transfers[1].timestamp = "2026-10-10T23:00:00Z";
  c.nodes[0].label!.retrievedAt = offset;
  c.coverage[0].updatedAt = offset;
  const restored = parseInvestigation(c);
  assert.equal(restored.createdAt, utc);
  assert.equal(restored.updatedAt, utc);
  assert.equal(restored.transfers[0].timestamp, utc);
  assert.equal(restored.transfers[0].retrievedAt, utc);
  assert.equal(restored.nodes[0].label!.retrievedAt, utc);
  assert.equal(restored.coverage[0].updatedAt, utc);
  const sorted = restored.transfers
    .slice(0, 2)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  assert.equal(sorted[0].timestamp, utc);
  assert.equal(sorted[1].timestamp, "2026-10-10T23:00:00.000Z");
});
test("timestamp imports reject invalid calendar dates, rollover times and missing timezone", () => {
  const c = createInvestigation(ROOT, "demo");
  for (const invalid of [
    "2026-02-30T12:00:00Z",
    "2026-10-10T24:00:00Z",
    "2026-10-10T12:60:00Z",
    "2026-10-10T12:00:00",
    "not-a-time",
  ]) {
    assert.throws(
      () => parseInvestigation({ ...c, createdAt: invalid }),
      /timestamp/i,
      invalid,
    );
  }
});
test("snapshot boundary rejects malicious and inconsistent data and drops unknown fields", () => {
  const c = createInvestigation(ROOT, "demo");
  assert.throws(() => parseInvestigation({ ...c, version: 2 }));
  assert.throws(() => parseInvestigation({ ...c, root: "bad" }));
  assert.throws(() =>
    parseInvestigation({ ...c, transfers: [transfer({ rawAmount: "1.2" })] }),
  );
  assert.throws(() =>
    parseInvestigation({ ...c, transfers: [{ ...transfer(), id: "spoofed" }] }),
  );
  assert.throws(() =>
    parseInvestigation({
      ...c,
      nodes: [
        {
          address: ROOT,
          chainId: 1,
          label: {
            text: "x",
            source: "x",
            kind: "user",
            confidence: "unverified",
            retrievedAt: c.createdAt,
            sourceUrl: "javascript:alert(1)",
          },
        },
      ],
    }),
  );
  assert(
    !("apiKey" in parseInvestigation({ ...c, apiKey: "do-not-preserve" })),
  );
});
test("synthetic fixture is deterministic, expandable and never claims live history", async () => {
  const initial = await createDemoInvestigation();
  assert.equal(initial.root, DEMO_ROOT);
  assert.equal(initial.mode, "demo");
  assert.equal(initial.transfers.length, 16);
  assert(initial.transfers.every((t) => t.synthetic));
  assert(
    initial.coverage.every((c) => c.warnings.some((w) => /synthetic/i.test(w))),
  );
  const eth = await expandInvestigation(initial, demoProvider, {
    address: ROOT,
    chainId: 1,
  });
  assert(eth.transfers.length > initial.transfers.length);
  await assert.rejects(
    demoProvider.fetchPage({
      address: OTHER,
      chainId: 1,
      cursor: initial.coverage[0].cursor,
    }),
    /cursor/i,
  );
});

test("provider error code and retryability survive snapshots and clear after a successful resume", async () => {
  let calls = 0;
  const seen: (string | null | undefined)[] = [];
  const p = provider(async (query) => {
    seen.push(query.cursor);
    if (calls++ === 1)
      throw Object.assign(new Error("Provider rate limit reached"), {
        code: "RATE_LIMITED",
        retryable: true,
      });
    const resumed = calls === 3;
    return {
      transfers: [transfer({ eventIndex: resumed ? "1" : "0" })],
      nodes: [],
      cursor: resumed ? null : "resume",
      warnings: [],
      streams: ["erc20"],
      exhausted: resumed,
    };
  });
  const initial = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  const failed = await expandInvestigation(initial, p, {
    address: ROOT,
    chainId: 1,
  });
  assert.equal(failed.coverage[0].errorCode, "RATE_LIMITED");
  assert.equal(failed.coverage[0].retryable, true);
  assert.equal(failed.coverage[0].cursor, "resume");
  assert.equal(failed.transfers.length, 1);
  const restored = parseInvestigation(JSON.parse(JSON.stringify(failed)));
  assert.equal(restored.coverage[0].errorCode, "RATE_LIMITED");
  assert.equal(restored.coverage[0].retryable, true);
  const resumed = await expandInvestigation(restored, p, {
    address: ROOT,
    chainId: 1,
  });
  assert.deepEqual(seen, [null, "resume", "resume"]);
  assert.equal(resumed.transfers.length, 2);
  assert.equal(resumed.coverage[0].pagesLoaded, 2);
  assert.equal(resumed.coverage[0].status, "exhausted");
  assert.equal(resumed.coverage[0].error, undefined);
  assert.equal(resumed.coverage[0].errorCode, undefined);
  assert.equal(resumed.coverage[0].retryable, undefined);
});
test("malformed external error codes become a safe fallback and retryability requires boolean true", async () => {
  const p = provider(async () => {
    throw Object.assign(new Error("Provider error"), {
      code: "secret=invalid code",
      retryable: "true",
    });
  });
  const failed = await expandInvestigation(
    createInvestigation(ROOT, "demo"),
    p,
    { address: ROOT, chainId: 1 },
  );
  assert.equal(failed.coverage[0].errorCode, "EXPANSION_FAILED");
  assert.equal(failed.coverage[0].retryable, false);
  assert.throws(
    () =>
      parseInvestigation({
        ...failed,
        coverage: [{ ...failed.coverage[0], errorCode: "bad code" }],
      }),
    /error code/i,
  );
  assert.throws(
    () =>
      parseInvestigation({
        ...failed,
        coverage: [{ ...failed.coverage[0], retryable: "true" }],
      }),
    /retryable/i,
  );
});
