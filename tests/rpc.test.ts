import test from "node:test";
import assert from "node:assert/strict";
import { createPublicRpcClient, RpcProviderError } from "../server/rpc.ts";

test("public RPC pins endpoint, IDs, chain and permits only read methods", async () => {
  const requests: Record<string, unknown>[] = [];
  const rpc = createPublicRpcClient(1, {
    intervalMs: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://ethereum-rpc.publicnode.com");
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "eth_chainId" ? "0x1" : "0x20",
      });
    },
  });
  assert.equal(await rpc.request("eth_chainId", []), "0x1");
  assert.equal(await rpc.request("eth_blockNumber", []), "0x20");
  await assert.rejects(
    rpc.request("eth_sendRawTransaction", ["0xdead"]),
    (e) => e instanceof RpcProviderError && e.code === "RPC_METHOD_DENIED",
  );
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].id, requests[1].id);
});
test("public RPC budgets and response identity fail before misleading evidence", async () => {
  let calls = 0;
  const rpc = createPublicRpcClient(1, {
    intervalMs: 0,
    maxCalls: 1,
    fetch: async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
    },
  });
  await rpc.request("eth_chainId", []);
  await assert.rejects(
    rpc.request("eth_blockNumber", []),
    (e) => e instanceof RpcProviderError && e.code === "RPC_BUDGET_EXCEEDED",
  );
  assert.equal(calls, 1);
  const wrong = createPublicRpcClient(1, {
    intervalMs: 0,
    fetch: async () =>
      Response.json({ jsonrpc: "2.0", id: 999, result: "0x1" }),
  });
  await assert.rejects(wrong.request("eth_chainId", []), /identity/);
});
test("public RPC distinguishes unsupported access and throttling without raw secrets", async () => {
  for (const [status, body, code] of [
    [
      200,
      { error: { code: -32601, message: "secret-key-value method missing" } },
      "RPC_METHOD_UNSUPPORTED",
    ],
    [403, {}, "RPC_ACCESS_DENIED"],
    [429, {}, "RPC_RATE_LIMITED"],
  ] as const) {
    const rpc = createPublicRpcClient(1, {
      intervalMs: 0,
      fetch: async (_url, options) =>
        Response.json(
          { jsonrpc: "2.0", id: JSON.parse(String(options?.body)).id, ...body },
          { status },
        ),
    });
    await assert.rejects(
      rpc.request("debug_traceTransaction", []),
      (e) =>
        e instanceof RpcProviderError &&
        e.code === code &&
        !e.message.includes("secret-key-value"),
    );
  }
});
test("public RPC enforces response bytes and valid JSON-RPC results", async () => {
  const rpc = createPublicRpcClient(1, {
    intervalMs: 0,
    maxResponseBytes: 1024,
    fetch: async () => new Response("x".repeat(1100)),
  });
  await assert.rejects(
    rpc.request("eth_chainId", []),
    (e) => e instanceof RpcProviderError && e.code === "RPC_RESPONSE_TOO_LARGE",
  );
  const absent = createPublicRpcClient(1, {
    intervalMs: 0,
    fetch: async (_u, o) =>
      Response.json({ jsonrpc: "2.0", id: JSON.parse(String(o?.body)).id }),
  });
  await assert.rejects(
    absent.request("eth_chainId", []),
    (e) => e instanceof RpcProviderError && e.code === "RPC_INVALID_RESPONSE",
  );
  assert.throws(() => createPublicRpcClient(999), /supported/);
});
