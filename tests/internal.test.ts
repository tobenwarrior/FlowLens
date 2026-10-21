import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeInternalEvidence,
  createSyntheticInternalEvidence,
  parseInternalEvidence,
} from "../src/domain/internal.ts";

const root = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;
const provenance = {
  source: "Synthetic trace fixture",
  retrievedAt: "2026-10-21T12:00:00.000Z",
  synthetic: true,
};
function trace(path: number[], change: Record<string, unknown> = {}) {
  return {
    id: `1:${hash}:trace:${path.length ? path.join(".") : "root"}`,
    chainId: 1,
    hash,
    blockNumber: 100,
    timestamp: "2026-10-20T08:00:00.000Z",
    traceAddress: path,
    type: "CALL",
    from: root,
    to: other,
    rawValue: "1000000000000000001",
    success: true,
    transactionSuccess: true,
    nativeAsset: { symbol: "ETH", decimals: 18 },
    provenance,
    ...change,
  };
}
function bundle(traces: unknown[], change: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "synthetic",
    traces,
    coverage: [
      {
        id: "trace-scope",
        chainId: 1,
        address: root,
        provider: "fixture-trace",
        traceProvider: true,
        blockFrom: 100,
        blockTo: 100,
        status: "exhausted",
        cursor: null,
        recordsObserved: traces.length,
        warnings: [],
        provenance,
      },
    ],
    ...change,
  };
}

test("only effective internal balance movements become distinct exact transfer events", () => {
  const input = bundle([
    trace([]),
    trace([0]),
    trace([1], { type: "CREATE2", rawValue: "700" }),
    trace([2], { type: "SELFDESTRUCT", rawValue: "50" }),
    trace([3], { type: "DELEGATECALL" }),
    trace([4], { type: "STATICCALL" }),
    trace([5], { type: "CALLCODE" }),
    trace([6], { rawValue: "0" }),
  ]);
  const parsed = parseInternalEvidence(input, "synthetic");
  const result = analyzeInternalEvidence(parsed);
  assert.equal(result.transfers.length, 3);
  assert.deepEqual(
    result.transfers.map((t) => t.rawAmount),
    ["1000000000000000001", "700", "50"],
  );
  assert.equal(result.transfers[0].eventIndex, "trace.0");
  assert.equal(result.transfers[0].kind, "internal");
  assert.equal(result.transfers[0].synthetic, true);
  assert.equal(new Set(result.transfers.map((t) => t.id)).size, 3);
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":root"))?.reason,
    "root-transaction",
  );
  assert.ok(
    result.excluded.some((e) => e.reason === "inherited-or-nonmoving-call"),
  );
  assert.equal(result.coverage[0].status, "supplied-scope-exhausted");
  assert.equal(result.coverage[0].fullWalletHistory, false);
});

test("failed transactions, failed ancestors and unknown ancestor paths never inflate funding", () => {
  const parsed = parseInternalEvidence(
    bundle([
      trace([]),
      trace([0], { success: false }),
      trace([0, 0]),
      trace([1, 0]),
      trace([2], { type: "DELEGATECALL" }),
      trace([2, 0]),
    ]),
    "synthetic",
  );
  const result = analyzeInternalEvidence(parsed);
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].eventIndex, "trace.2.0");
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":0.0"))?.reason,
    "failed-ancestor",
  );
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":1.0"))?.reason,
    "missing-ancestor",
  );
  assert.equal(result.coverage[0].status, "partial");
  const reverted = parseInternalEvidence(
    bundle([trace([0], { transactionSuccess: false })]),
    "synthetic",
  );
  assert.equal(analyzeInternalEvidence(reverted).transfers.length, 0);
});

test("exhausted cursor alone cannot establish internal coverage without a trace provider and bounded window", () => {
  const value = bundle([trace([0])]);
  value.coverage[0].traceProvider = false;
  const result = analyzeInternalEvidence(
    parseInternalEvidence(value, "synthetic"),
  );
  assert.equal(result.coverage[0].status, "unavailable");
  assert.ok(result.warnings.some((w) => /trace provider/i.test(w)));
  const unknown = bundle([trace([0])]);
  const coverage = unknown.coverage[0] as Record<string, unknown>;
  coverage.blockFrom = null;
  coverage.blockTo = null;
  assert.equal(
    analyzeInternalEvidence(parseInternalEvidence(unknown, "synthetic"))
      .coverage[0].status,
    "partial",
  );
});

test("an asserted value movement beneath STATICCALL cannot escape static execution context", () => {
  const parsed = parseInternalEvidence(
    bundle([
      trace([]),
      trace([0], { type: "STATICCALL" }),
      trace([0, 0], { type: "DELEGATECALL" }),
      trace([0, 0, 0]),
    ]),
    "synthetic",
  );
  const result = analyzeInternalEvidence(parsed);
  assert.equal(result.transfers.length, 0);
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":0.0.0"))?.reason,
    "static-ancestor",
  );
  assert.equal(result.coverage[0].status, "partial");
});

test("SELFDESTRUCT terminates its frame so supplied descendants are excluded as inconsistent", () => {
  const result = analyzeInternalEvidence(
    parseInternalEvidence(
      bundle([
        trace([]),
        trace([0], { type: "SELFDESTRUCT", rawValue: "500" }),
        trace([0, 0], { rawValue: "200" }),
        trace([0, 1], { rawValue: "0" }),
      ]),
      "synthetic",
    ),
  );
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].eventIndex, "trace.0");
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":0.0"))?.reason,
    "terminal-ancestor",
  );
  assert.equal(
    result.excluded.find((e) => e.traceId.endsWith(":0.1"))?.reason,
    "terminal-ancestor",
  );
  assert.equal(result.coverage[0].status, "partial");
  assert.ok(
    result.warnings.some((w) =>
      /SELFDESTRUCT.*descendant|descendant.*SELFDESTRUCT/i.test(w),
    ),
  );
  const terminalRoot = analyzeInternalEvidence(
    parseInternalEvidence(
      bundle([trace([], { type: "SELFDESTRUCT" }), trace([0])]),
      "synthetic",
    ),
  );
  assert.equal(terminalRoot.transfers.length, 0);
  assert.equal(
    terminalRoot.excluded.find((e) => e.traceId.endsWith(":0"))?.reason,
    "terminal-ancestor",
  );
});

test("duplicates, wrong modes and conflicting transaction facts reject at the replay boundary", () => {
  assert.throws(
    () => parseInternalEvidence(bundle([trace([0]), trace([0])]), "synthetic"),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseInternalEvidence(
        bundle([trace([0]), trace([1], { blockNumber: 101 })]),
        "synthetic",
      ),
    /Conflicting/,
  );
  assert.throws(
    () => parseInternalEvidence(bundle([trace([0])]), "private"),
    /mode/,
  );
  const value = bundle([trace([0])]);
  (value.traces[0] as Record<string, unknown>).provenance = {
    ...provenance,
    synthetic: false,
  };
  assert.throws(() => parseInternalEvidence(value, "synthetic"), /synthetic/);
  assert.throws(
    () => parseInternalEvidence(bundle([trace([-1])]), "synthetic"),
    /trace address/i,
  );
  assert.throws(
    () =>
      parseInternalEvidence(
        bundle([trace([0], { rawValue: "1.2" })]),
        "synthetic",
      ),
    /integer/,
  );
  assert.throws(
    () =>
      parseInternalEvidence(
        bundle([trace([0], { timestamp: "2026-02-30T08:00:00Z" })]),
        "synthetic",
      ),
    /timestamp/,
  );
});

test("private replay strips unknown fields and canonicalizes supplied timestamps without fetching anything", () => {
  const input = bundle([trace([0])], {
    mode: "private",
    apiKey: "do-not-keep",
  });
  for (const t of input.traces as Record<string, unknown>[])
    t.provenance = { ...provenance, synthetic: false };
  input.coverage[0].provenance = { ...provenance, synthetic: false };
  (input.traces[0] as Record<string, unknown>).timestamp =
    "2026-10-20T08:00:00+09:00";
  const parsed = parseInternalEvidence(input, "private");
  assert.equal(parsed.traces[0].timestamp, "2026-10-19T23:00:00.000Z");
  assert.equal("apiKey" in parsed, false);
  assert.equal(analyzeInternalEvidence(parsed).transfers[0].synthetic, false);
});

test("synthetic fixture is reproducible and discloses excluded inherited values and missing coverage", () => {
  const a = createSyntheticInternalEvidence(),
    b = createSyntheticInternalEvidence();
  assert.deepEqual(a, b);
  const analysis = analyzeInternalEvidence(
    parseInternalEvidence(a, "synthetic"),
  );
  assert.ok(analysis.transfers.length > 0);
  assert.ok(analysis.excluded.some((e) => e.reason === "failed-ancestor"));
  assert.ok(analysis.warnings.some((w) => /synthetic/i.test(w)));
  assert.ok(analysis.coverage.every((c) => c.fullWalletHistory === false));
});
