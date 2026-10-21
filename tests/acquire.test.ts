import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { encodeAbiParameters } from "viem";
import {
  acquireProtocolEvidence,
  parseAcquisitionInput,
} from "../server/acquire.ts";
import { RpcProviderError } from "../server/rpc.ts";
import type { RpcClient } from "../server/rpc.ts";

const A = `0x${"1".repeat(40)}`;
const B = `0x${"2".repeat(40)}`;
const HASH = `0x${"a".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;

function internalRpc(traceError?: Error): RpcClient {
  return {
    chainId: 1,
    source: "Injected acquisition RPC",
    async request(method) {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getTransactionByHash")
        return {
          hash: HASH,
          from: A,
          to: B,
          value: "0x0",
          blockNumber: "0x64",
          blockHash: BLOCK,
          transactionIndex: "0x0",
        };
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash: HASH,
          from: A,
          to: B,
          status: "0x1",
          blockNumber: "0x64",
          blockHash: BLOCK,
          logs: [],
          transactionIndex: "0x0",
        };
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x64",
          hash: BLOCK,
          timestamp: "0x67100000",
          transactions: [HASH],
        };
      if (method === "debug_traceTransaction") {
        if (traceError) throw traceError;
        return {
          type: "CALL",
          from: A,
          to: B,
          value: "0x0",
          calls: [{ type: "CALL", from: B, to: A, value: "0x10" }],
        };
      }
      throw new Error("Unexpected fixture method");
    },
  };
}

test("acquisition input is canonical, discriminated and bounded", () => {
  assert.deepEqual(
    parseAcquisitionInput({
      kind: "internal",
      chainId: 1,
      hash: HASH.toUpperCase().replace("0X", "0x"),
      maxTraces: 2,
    }),
    {
      kind: "internal",
      chainId: 1,
      hash: HASH,
      maxCalls: 32,
      maxTraces: 2,
    },
  );
  const safe = parseAcquisitionInput({
    kind: "safe",
    chainId: 42161,
    address: A,
    includeHistory: false,
    blockNumber: 0,
  });
  assert.equal(safe.kind, "safe");
  assert.equal(safe.maxCalls, 32);
  assert.equal(
    parseAcquisitionInput({
      kind: "bridge",
      chainId: 8453,
      hash: HASH,
      maxCalls: 64,
    }).chainId,
    8453,
  );
});

test("invalid or unrelated options are rejected before constructing a transport", async () => {
  let factories = 0;
  const rpcFactory = () => {
    factories++;
    return internalRpc();
  };
  for (const input of [
    null,
    [],
    {},
    { kind: "other", chainId: 1 },
    { kind: "internal", chainId: 56, hash: HASH },
    { kind: "internal", chainId: 1, hash: "0x1" },
    { kind: "internal", chainId: 1, hash: HASH, address: "bad" },
    { kind: "internal", chainId: 1, hash: HASH, maxCalls: 0 },
    { kind: "internal", chainId: 1, hash: HASH, maxCalls: 65 },
    { kind: "internal", chainId: 1, hash: HASH, maxTraces: 2001 },
    { kind: "internal", chainId: 1, hash: HASH, maxLogs: 1 },
    {
      kind: "bridge",
      chainId: 1,
      hash: HASH,
      url: "https://untrusted.invalid",
    },
    { kind: "bridge", chainId: 1, hash: HASH, maxLogs: 0 },
    { kind: "safe", chainId: 8453, address: A },
    { kind: "safe", chainId: 1, address: A, hash: HASH },
    { kind: "safe", chainId: 1, address: A, maxPages: 4 },
    { kind: "safe", chainId: 1, address: A, maxSignatures: 6 },
    { kind: "safe", chainId: 1, address: A, includeHistory: "false" },
    { kind: "safe", chainId: 1, address: A, verifySignatures: 1 },
    {
      kind: "safe",
      chainId: 1,
      address: A,
      includeHistory: false,
      verifySignatures: true,
    },
    { kind: "safe", chainId: 1, address: A, cursor: "x".repeat(2049) },
    {
      kind: "safe",
      chainId: 1,
      address: A,
      cursor: "e30",
      includeHistory: false,
    },
    { kind: "safe", chainId: 1, address: A, blockNumber: -1 },
  ]) {
    await assert.rejects(
      acquireProtocolEvidence(input, { rpcFactory }),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "INVALID_ARGUMENT",
    );
  }
  assert.equal(factories, 0);
});

test("internal acquisition wraps real adapter evidence and analysis without persistence or relabeling", async () => {
  const seen: { chainId: number; maxCalls: number }[] = [];
  const result = await acquireProtocolEvidence(
    { kind: "internal", chainId: 1, hash: HASH, maxCalls: 6 },
    {
      rpcFactory: (chainId, options) => {
        seen.push({ chainId, maxCalls: options.maxCalls });
        return internalRpc();
      },
    },
  );
  assert.deepEqual(seen, [{ chainId: 1, maxCalls: 6 }]);
  assert.equal(result.kind, "internal");
  assert.equal(result.bundle.version, 1);
  assert.equal(result.bundle.mode, "private");
  assert.equal(result.bundle.internal?.traces[1].provenance.synthetic, false);
  assert.equal(result.analysis.internal?.transfers[0].rawAmount, "16");
  assert.equal(result.analysis.internal?.coverage[0].fullWalletHistory, false);
  assert.deepEqual(result.errors, []);
  assert.ok(
    result.warnings.some((w) => /wallet history|complete wallet/i.test(w)),
  );
});

test("internal unavailable method is preserved as a capability and explicit top-level issue", async () => {
  const result = await acquireProtocolEvidence(
    { kind: "internal", chainId: 1, hash: HASH },
    {
      rpcFactory: () =>
        internalRpc(
          new RpcProviderError(
            "RPC_METHOD_UNSUPPORTED",
            "private endpoint",
            false,
            -32601,
          ),
        ),
    },
  );
  assert.equal(result.kind, "internal");
  if (result.kind !== "internal") throw new Error("Wrong dispatch");
  assert.equal(result.acquisition.capability.status, "unsupported");
  assert.equal(result.analysis.internal?.coverage[0].status, "unavailable");
  assert.equal(result.errors[0]?.code, "RPC_METHOD_UNSUPPORTED");
  assert.doesNotMatch(JSON.stringify(result), /private endpoint/);
});

test("Safe snapshot dispatch uses injected RPC and makes no history-service request when excluded", async () => {
  let reads = 0;
  let fetches = 0;
  const result = await acquireProtocolEvidence(
    {
      kind: "safe",
      chainId: 1,
      address: A,
      blockNumber: 100,
      includeHistory: false,
    },
    {
      rpcFactory: () => ({
        chainId: 1,
        async request(method, params) {
          reads++;
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_blockNumber") return "0x64";
          if (method === "eth_getBlockByNumber")
            return { number: "0x64", hash: BLOCK };
          if (method === "eth_getCode") return "0x6000";
          if (method === "eth_call") {
            const data = (params[0] as { data: string }).data;
            if (data.startsWith("0xa0e67e2b"))
              return encodeAbiParameters(
                [{ type: "address[]" }],
                [[B as `0x${string}`]],
              );
            return encodeAbiParameters(
              [{ type: "uint256" }],
              [data.startsWith("0xe75235b8") ? 1n : 0n],
            );
          }
          throw new Error("Unexpected Safe fixture RPC");
        },
      }),
      safeFetch: async () => {
        fetches++;
        throw new Error("Safe history must not be called");
      },
    },
  );
  assert.equal(result.kind, "safe");
  if (result.kind !== "safe") throw new Error("Wrong dispatch");
  assert.equal(result.bundle.safe?.configurations[0].safeAddress, A);
  assert.equal(result.acquisition.history.status, "not-requested");
  assert.equal(result.bundle.mode, "private");
  assert.ok(reads > 0);
  assert.equal(fetches, 0);
});

test("wrong-chain injected transport and unexpected failures cannot make successful empty evidence", async () => {
  let reads = 0;
  await assert.rejects(
    acquireProtocolEvidence(
      { kind: "internal", chainId: 1, hash: HASH },
      {
        rpcFactory: () => ({
          chainId: 8453,
          async request() {
            reads++;
            return "0x1";
          },
        }),
      },
    ),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "RPC_CHAIN_MISMATCH",
  );
  assert.equal(reads, 0);
  await assert.rejects(
    acquireProtocolEvidence(
      { kind: "internal", chainId: 1, hash: HASH },
      {
        rpcFactory: () => {
          throw new Error("secret key in unexpected factory message");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("secret key"),
  );
});

test("bridge dispatch wraps receipt-scoped evidence and its distinct completeness caveat", async () => {
  const methods: string[] = [];
  const client = internalRpc();
  const result = await acquireProtocolEvidence(
    { kind: "bridge", chainId: 1, hash: HASH, maxLogs: 1 },
    {
      rpcFactory: () => ({
        ...client,
        request(method, params) {
          methods.push(method);
          return client.request(method, params);
        },
      }),
    },
  );
  assert.equal(result.kind, "bridge");
  if (result.kind !== "bridge") throw new Error("Wrong dispatch");
  assert.equal(result.acquisition.scope, "transaction");
  assert.equal(result.bundle.bridges?.mode, "private");
  assert.equal(result.analysis.bridges?.completeHistory, false);
  assert.deepEqual(result.acquisition.events, []);
  assert.deepEqual(result.errors, []);
  assert.ok(!methods.includes("debug_traceTransaction"));
});

test("maxCalls limits injected clients and budget failure remains visible in analysis", async () => {
  let calls = 0;
  const client = internalRpc();
  const result = await acquireProtocolEvidence(
    { kind: "internal", chainId: 1, hash: HASH, address: A, maxCalls: 1 },
    {
      rpcFactory: () => ({
        ...client,
        request(method, params) {
          calls++;
          return client.request(method, params);
        },
      }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.kind, "internal");
  assert.equal(result.analysis.internal?.coverage[0].status, "error");
  assert.equal(result.errors[0]?.code, "RPC_BUDGET_EXCEEDED");
  assert.equal(result.errors[0]?.retryable, false);
});

test("concurrent preflight budget exhaustion never orphans an already-started rejection", () => {
  const moduleUrl = new URL("../server/acquire.ts", import.meta.url).href;
  const script = `
    const { acquireProtocolEvidence } = await import(${JSON.stringify(moduleUrl)});
    let unhandled = false;
    process.on('unhandledRejection', () => { unhandled = true; });
    const result = await acquireProtocolEvidence({kind:'internal',chainId:1,hash:${JSON.stringify(HASH)},address:${JSON.stringify(A)},maxCalls:2}, {
      rpcFactory: () => ({chainId:1,async request(method) {
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_getTransactionByHash') return await new Promise((_, reject) => setImmediate(() => reject(new Error('started request later rejected'))));
        throw new Error('Unexpected request');
      }})
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    console.log(JSON.stringify({unhandled,code:result.errors[0]?.code}));
    if (unhandled) process.exitCode = 1;
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    unhandled: false,
    code: "RPC_BUDGET_EXCEEDED",
  });
});

test("bridge transport failures retain their original retryability without exposing provider text", async () => {
  for (const [code, retryable] of [
    ["RPC_NETWORK_ERROR", true],
    ["RPC_RATE_LIMITED", true],
    ["RPC_HTTP_ERROR", true],
    ["RPC_HTTP_ERROR", false],
    ["RPC_ACCESS_DENIED", false],
    ["RPC_METHOD_UNSUPPORTED", false],
  ] as const) {
    const result = await acquireProtocolEvidence(
      { kind: "bridge", chainId: 1, hash: HASH },
      {
        rpcFactory: () => ({
          chainId: 1,
          async request() {
            throw new RpcProviderError(code, "secret provider URL", retryable);
          },
        }),
      },
    );
    assert.equal(result.errors[0]?.code, code);
    assert.equal(result.errors[0]?.retryable, retryable);
    assert.doesNotMatch(JSON.stringify(result), /secret provider URL/);
  }
  const result = await acquireProtocolEvidence(
    { kind: "bridge", chainId: 1, hash: HASH },
    {
      rpcFactory: () => ({
        chainId: 1,
        async request() {
          return "0x2105";
        },
      }),
    },
  );
  assert.equal(result.errors[0]?.code, "BRIDGE_IDENTITY_MISMATCH");
  assert.equal(result.errors[0]?.retryable, false);
});
