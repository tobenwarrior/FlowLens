import test from "node:test";
import assert from "node:assert/strict";
import { acquireInternalTraceEvidence } from "../server/trace-provider.ts";
import { analyzeInternalEvidence } from "../src/domain/internal.ts";
import type { RpcClient } from "../server/rpc.ts";

const A = `0x${"1".repeat(40)}`;
const B = `0x${"2".repeat(40)}`;
const C = `0x${"3".repeat(40)}`;
const HASH = `0x${"a".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;
const OTHER = `0x${"c".repeat(64)}`;
const input = { chainId: 1, hash: HASH, address: B };

function frame(change: Record<string, unknown> = {}) {
  return { type: "CALL", from: B, to: C, value: "0x1", ...change };
}
function fixture(change: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    eth_chainId: "0x1",
    eth_getTransactionByHash: {
      hash: HASH,
      chainId: "0x1",
      from: A,
      to: B,
      value: "0x10",
      blockHash: BLOCK,
      blockNumber: "0x64",
      transactionIndex: "0x0",
    },
    eth_getTransactionReceipt: {
      transactionHash: HASH,
      from: A,
      to: B,
      contractAddress: null,
      status: "0x1",
      blockHash: BLOCK,
      blockNumber: "0x64",
      transactionIndex: "0x0",
    },
    eth_getBlockByNumber: {
      hash: BLOCK,
      number: "0x64",
      timestamp: "0x67100000",
      transactions: [HASH],
    },
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [frame()],
    }),
    ...change,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: RpcClient = {
    chainId: 1,
    async request(method, params) {
      calls.push({ method, params });
      const response = responses[method];
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
  };
  return { responses, calls, rpc };
}

test("callTracer acquisition verifies identity before tracing and retains exact paths and private provenance", async () => {
  const f = fixture();
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "available");
  assert.equal(result.capability.scope, "transaction");
  assert.equal(result.capability.fullWalletHistory, false);
  assert.equal(result.capability.completeTree, true);
  assert.equal(result.bundle.mode, "private");
  assert.deepEqual(
    result.bundle.traces.map((t) => t.traceAddress),
    [[], [0]],
  );
  assert.equal(result.bundle.traces[0].rawValue, "16");
  assert.equal(result.bundle.traces[1].provenance.synthetic, false);
  assert.match(
    result.bundle.traces[1].provenance.source,
    /debug_traceTransaction.*callTracer/,
  );
  const analysis = analyzeInternalEvidence(result.bundle);
  assert.deepEqual(
    analysis.transfers.map((t) => t.rawAmount),
    ["1"],
  );
  assert.equal(analysis.coverage[0].status, "partial");
  assert.equal(analysis.coverage[0].fullWalletHistory, false);
  assert.equal(f.calls.at(-1)?.method, "debug_traceTransaction");
  assert.deepEqual(f.calls.at(-1)?.params, [
    HASH,
    {
      tracer: "callTracer",
      timeout: "5s",
      tracerConfig: { onlyTopCall: false, withLog: false },
    },
  ]);
});

test("reverted ancestors, inherited call values and zero/static values cannot inflate funding", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [
        frame({ error: "execution reverted", calls: [frame()] }),
        frame({
          type: "DELEGATECALL",
          value: "0x99",
          calls: [frame({ value: "0x2" })],
        }),
        frame({ type: "CALLCODE", value: "0x99" }),
        frame({ type: "STATICCALL", value: undefined }),
        frame({ value: "0x0" }),
      ],
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  const analysis = analyzeInternalEvidence(result.bundle);
  assert.deepEqual(
    analysis.transfers.map((t) => [t.eventIndex, t.rawAmount]),
    [["trace.1.0", "2"]],
  );
  assert.ok(analysis.excluded.some((e) => e.reason === "failed-ancestor"));
  assert.ok(
    analysis.excluded.some((e) => e.reason === "inherited-or-nonmoving-call"),
  );
});

test("receipt failure excludes otherwise successful children", async () => {
  const f = fixture();
  (f.responses.eth_getTransactionReceipt as Record<string, unknown>).status =
    "0x0";
  (f.responses.debug_traceTransaction as Record<string, unknown>).error =
    "execution reverted";
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "available");
  assert.equal(analyzeInternalEvidence(result.bundle).transfers.length, 0);
  assert.equal(result.bundle.traces[1].transactionSuccess, false);
});

test("CREATE without an observed destination omits its subtree instead of inventing a recipient", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [
        frame({
          type: "CREATE",
          to: undefined,
          error: "out of gas",
          calls: [frame()],
        }),
        frame({ type: "CREATE2", to: C, value: "0x123" }),
      ],
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.completeTree, false);
  assert.deepEqual(
    result.bundle.traces.map((t) => t.traceAddress),
    [[], [1]],
  );
  assert.deepEqual(
    analyzeInternalEvidence(result.bundle).transfers.map((t) => t.rawAmount),
    ["291"],
  );
  assert.match(
    result.bundle.coverage[0].warnings.join(" "),
    /omitted|destination/i,
  );
});

test("SELFDESTRUCT preserves observed refund movement and warns about fork-dependent semantics", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [
        frame({ type: "SELFDESTRUCT", value: "0x12" }),
        frame({ type: "SUICIDE", value: "0x13" }),
        frame({ type: "SELFDESTRUCT", from: B, to: B, value: "0x14" }),
      ],
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.deepEqual(
    analyzeInternalEvidence(result.bundle).transfers.map((t) => t.rawAmount),
    ["18", "19"],
  );
  assert.match(result.bundle.coverage[0].warnings.join(" "), /EIP-6780|fork/i);
  assert.equal(result.capability.completeTree, false);
});

test("unknown or missing root fields cannot authorize child movements", async () => {
  for (const root of [
    null,
    [],
    { calls: [frame()] },
    frame({ from: C, calls: [frame()] }),
    frame({ from: A, to: B, value: "0x10", calls: null }),
    frame({
      from: A,
      to: B,
      value: "0x10",
      error: "execution reverted",
      calls: [frame()],
    }),
  ]) {
    const f = fixture({ debug_traceTransaction: root });
    const result = await acquireInternalTraceEvidence(input, f);
    assert.equal(result.capability.status, "error");
    assert.equal(result.bundle.traces.length, 0);
    assert.equal(result.bundle.coverage[0].status, "error");
  }
});

test("explicit unsupported RPC method remains unavailable and is never retried through another adapter", async () => {
  const error = Object.assign(new Error("contains private endpoint and key"), {
    code: "RPC_METHOD_UNSUPPORTED",
    retryable: false,
  });
  const f = fixture({ debug_traceTransaction: error });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "unsupported");
  assert.equal(result.bundle.coverage[0].status, "unavailable");
  assert.equal(result.bundle.coverage[0].traceProvider, false);
  assert.equal(result.bundle.traces.length, 0);
  assert.equal(
    f.calls.filter((c) => c.method === "debug_traceTransaction").length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(result), /private endpoint|key/);
});

test("provider failures are explicit errors and never become empty success", async () => {
  const f = fixture({
    debug_traceTransaction: Object.assign(new Error("secret endpoint"), {
      code: "RPC_RATE_LIMITED",
      retryable: true,
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "error");
  assert.equal(result.capability.retryable, true);
  assert.equal(result.bundle.coverage[0].status, "error");
  assert.doesNotMatch(JSON.stringify(result), /secret endpoint/);
});

test("chain, transaction, receipt, block and status contradictions stop before trace RPC", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.responses.eth_chainId = "0x2105";
    },
    (f: ReturnType<typeof fixture>) => {
      (f.responses.eth_getTransactionByHash as Record<string, unknown>).hash =
        OTHER;
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionByHash as Record<string, unknown>
      ).chainId = "0x2105";
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionReceipt as Record<string, unknown>
      ).transactionHash = OTHER;
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionReceipt as Record<string, unknown>
      ).blockHash = OTHER;
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionReceipt as Record<string, unknown>
      ).blockNumber = "0x65";
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionReceipt as Record<string, unknown>
      ).status = "0x2";
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getTransactionReceipt as Record<string, unknown>
      ).contractAddress = C;
    },
    (f: ReturnType<typeof fixture>) => {
      (f.responses.eth_getBlockByNumber as Record<string, unknown>).hash =
        OTHER;
    },
    (f: ReturnType<typeof fixture>) => {
      (
        f.responses.eth_getBlockByNumber as Record<string, unknown>
      ).transactions = [OTHER];
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    const result = await acquireInternalTraceEvidence(input, f);
    assert.equal(result.capability.status, "error");
    assert.equal(result.bundle.traces.length, 0);
    assert.equal(
      analyzeInternalEvidence(result.bundle).coverage[0].status,
      "error",
    );
    assert.ok(!f.calls.some((c) => c.method === "debug_traceTransaction"));
  }
});

test("missing transaction or receipt is explicit unavailable evidence, not an empty trace", async () => {
  for (const method of [
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
  ]) {
    const f = fixture({ [method]: null });
    const result = await acquireInternalTraceEvidence(input, f);
    assert.equal(result.capability.status, "unavailable");
    assert.equal(result.bundle.coverage[0].status, "unavailable");
    assert.equal(result.capability.retryable, true);
    assert.ok(!f.calls.some((c) => c.method === "debug_traceTransaction"));
  }
});

test("trace count and depth caps preserve ancestors while reporting omitted data", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [frame({ calls: [frame()] }), frame()],
    }),
  });
  const result = await acquireInternalTraceEvidence(
    { ...input, maxTraces: 2 },
    f,
  );
  assert.deepEqual(
    result.bundle.traces.map((t) => t.traceAddress),
    [[], [0]],
  );
  assert.equal(result.capability.completeTree, false);
  assert.equal(result.bundle.coverage[0].status, "partial");
  let nested = frame();
  for (let i = 0; i < 40; i++) nested = frame({ calls: [nested] });
  const deep = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [nested],
    }),
  });
  const bounded = await acquireInternalTraceEvidence(input, deep);
  assert.equal(bounded.capability.completeTree, false);
  assert.ok(bounded.bundle.traces.every((t) => t.traceAddress.length <= 32));
  assert.ok(
    !analyzeInternalEvidence(bounded.bundle).excluded.some(
      (e) => e.reason === "missing-ancestor",
    ),
  );
});

test("malformed moving values and unrecognized call types omit subtrees without renumbering siblings", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [
        frame({ value: undefined, calls: [frame()] }),
        frame({ type: "UNRECOGNIZED", calls: [frame()] }),
        frame({ value: "0x10000000000000001" }),
      ],
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.deepEqual(
    result.bundle.traces.map((t) => t.traceAddress),
    [[], [2]],
  );
  assert.equal(result.bundle.traces[1].rawValue, "18446744073709551617");
  assert.equal(result.capability.completeTree, false);
});

test("invalid bounds, unknown native-asset chains and client chain mismatches make no requests", async () => {
  for (const change of [
    { maxTraces: 0 },
    { maxTraces: 2001 },
    { hash: "0x123" },
    { chainId: 56 },
    { address: "invalid" },
  ]) {
    const f = fixture();
    await assert.rejects(
      acquireInternalTraceEvidence({ ...input, ...change }, f),
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.rpc.chainId = 8453;
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "error");
  assert.equal(f.calls.length, 0);
});

test("optional coverage address defaults to verified transaction sender and never invents one on missing evidence", async () => {
  const f = fixture();
  const result = await acquireInternalTraceEvidence(
    { chainId: 1, hash: HASH },
    f,
  );
  assert.equal(result.bundle.coverage[0].address, A);
  const missing = fixture({ eth_getTransactionByHash: null });
  const unavailable = await acquireInternalTraceEvidence(
    { chainId: 1, hash: HASH },
    missing,
  );
  assert.equal(unavailable.capability.status, "unavailable");
  assert.deepEqual(unavailable.bundle.coverage, []);
});

test("top-level contract creation must agree with its receipt and preserves no guessed failed destination", async () => {
  const f = fixture();
  const tx = f.responses.eth_getTransactionByHash as Record<string, unknown>;
  const receipt = f.responses.eth_getTransactionReceipt as Record<
    string,
    unknown
  >;
  tx.to = null;
  receipt.to = null;
  receipt.contractAddress = B;
  f.responses.debug_traceTransaction = frame({
    type: "CREATE",
    from: A,
    to: B,
    value: "0x10",
    calls: [frame()],
  });
  const result = await acquireInternalTraceEvidence(input, f);
  assert.equal(result.capability.status, "available");
  assert.equal(result.bundle.traces[0].type, "CREATE");
  assert.equal(analyzeInternalEvidence(result.bundle).transfers.length, 1);
  receipt.contractAddress = C;
  const contradiction = await acquireInternalTraceEvidence(input, f);
  assert.equal(contradiction.capability.status, "error");
  assert.equal(contradiction.bundle.traces.length, 0);
  receipt.contractAddress = null;
  receipt.status = "0x0";
  f.responses.debug_traceTransaction = frame({
    type: "CREATE",
    from: A,
    to: undefined,
    value: "0x10",
    error: "out of gas",
    calls: [frame()],
  });
  const failed = await acquireInternalTraceEvidence(input, f);
  assert.equal(failed.capability.status, "available");
  assert.equal(failed.capability.completeTree, false);
  assert.equal(failed.bundle.traces.length, 0);
});

test("impossible static and terminal ancestors remain excluded by the domain analyzer", async () => {
  const f = fixture({
    debug_traceTransaction: frame({
      from: A,
      to: B,
      value: "0x10",
      calls: [
        frame({ type: "STATICCALL", value: undefined, calls: [frame()] }),
        frame({ type: "SELFDESTRUCT", calls: [frame()] }),
      ],
    }),
  });
  const result = await acquireInternalTraceEvidence(input, f);
  const analysis = analyzeInternalEvidence(result.bundle);
  assert.deepEqual(
    analysis.transfers.map((t) => t.eventIndex),
    ["trace.1"],
  );
  assert.ok(analysis.excluded.some((e) => e.reason === "static-ancestor"));
  assert.ok(analysis.excluded.some((e) => e.reason === "terminal-ancestor"));
});
