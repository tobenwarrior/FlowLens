import assert from "node:assert/strict";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";
import { inspectDerive } from "../server/derive-provider.ts";
import { createEtherscanMcpProvider } from "../server/etherscan-mcp.ts";
import { operationSchema } from "../server/schema.ts";

for (const operation of ["create", "expand"]) {
  const description = operationSchema.contracts[operation].description;
  assert.match(description, /Etherscan MCP/i);
  assert.match(description, /FLOWLENS_ETHERSCAN_MCP=off/);
}

const investigation = await createDemoInvestigation();
assert.equal(investigation.mode, "demo");
assert.equal(investigation.root, DEMO_ROOT);
assert.ok(investigation.transfers.length > 0);
assert.ok(investigation.transfers.every((transfer) => transfer.synthetic));
assert.ok(
  investigation.nodes.every((node) => node.label?.confidence === "synthetic"),
);

const firstPage = await demoProvider.fetchPage({
  address: DEMO_ROOT,
  chainId: 1,
  pageSize: 5,
});
assert.equal(firstPage.transfers.length, 5);
assert.ok(firstPage.cursor);
assert.ok(firstPage.transfers.every((transfer) => transfer.synthetic));

const secondPage = await demoProvider.fetchPage({
  address: DEMO_ROOT,
  chainId: 1,
  pageSize: 5,
  cursor: firstPage.cursor,
});
assert.equal(secondPage.transfers.length, 5);
assert.notEqual(secondPage.cursor, firstPage.cursor);
assert.ok(
  secondPage.transfers.every(
    (transfer) =>
      !firstPage.transfers.some((first) => first.id === transfer.id),
  ),
);
console.log(
  "Public synthetic smoke checks passed (offline demo and pagination).",
);

let deriveRequests = 0;
const deriveResult = await inspectDerive(
  { kind: "account", wallet: DEMO_ROOT },
  {
    fetch: async (url, init) => {
      deriveRequests++;
      assert.equal(url, "https://api.derive.xyz/v3/public/get_subaccounts");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { wallet: DEMO_ROOT });
      return new globalThis.Response(
        JSON.stringify({
          result: { wallet: DEMO_ROOT, subaccount_ids: [123] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  },
);
assert.equal(deriveRequests, 1);
assert.equal(deriveResult.kind, "account");
assert.deepEqual(deriveResult.data.subaccount_ids, [123]);
assert.equal(deriveResult.coverage.status, "complete");

console.log("Public synthetic smoke checks passed (demo and injected Derive).");

const MCP_ROOT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MCP_SENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MCP_TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc";
const MCP_HASH = `0x${"11".repeat(32)}`;
const MCP_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const mcpTopicAddress = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
const mcpCalls = [];
const mcpResponse = (id, result) =>
  new globalThis.Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "public-smoke-session",
    },
  });
const mcpFetch = async (_input, init) => {
  const body = JSON.parse(init.body);
  mcpCalls.push(init.method);
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  if (body.method === "initialize")
    return mcpResponse(body.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "public-smoke", version: "1" },
    });
  if (body.method === "notifications/initialized")
    return new globalThis.Response(null, { status: 200 });
  const name = body.params.name;
  const result =
    name === "get_block_by_timestamp"
      ? "4660"
      : name === "get_transactions"
        ? []
        : name === "get_token_transfers"
          ? [
              {
                hash: MCP_HASH,
                blockNumber: "4660",
                timeStamp: "1735757265",
                contractAddress: MCP_TOKEN,
                tokenDecimal: "6",
                tokenSymbol: "USDC",
              },
            ]
          : {
              transactionHash: MCP_HASH,
              blockNumber: "0x1234",
              status: "0x1",
              logs: [
                {
                  address: MCP_TOKEN,
                  transactionHash: MCP_HASH,
                  blockNumber: "0x1234",
                  logIndex: "0x2a",
                  topics: [
                    MCP_TOPIC,
                    mcpTopicAddress(MCP_SENDER),
                    mcpTopicAddress(MCP_ROOT),
                  ],
                  data: "0x2a",
                },
              ],
            };
  return mcpResponse(body.id, {
    structuredContent: { data: { ok: true, status: "1", result } },
    content: [],
  });
};
const mcpProvider = createEtherscanMcpProvider({
  fetch: mcpFetch,
  intervalMs: 0,
});
const mcpPage = await mcpProvider.fetchPage({
  address: MCP_ROOT,
  chainId: 8453,
  pageSize: 1,
});
assert.equal(mcpPage.transfers.length, 1);
assert.equal(mcpPage.transfers[0].eventIndex, "42");
assert.equal(mcpPage.transfers[0].rawAmount, "42");
assert.ok(mcpCalls.every((method) => method === "POST"));
console.log("Public synthetic smoke checks passed (keyless Etherscan MCP).");
