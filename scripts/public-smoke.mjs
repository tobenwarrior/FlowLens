import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";
import { inspectDerive } from "../server/derive-provider.ts";
import {
  createEtherscanMcpProvider,
  createEtherscanMcpV2Provider,
} from "../server/etherscan-mcp.ts";
import { operationSchema } from "../server/schema.ts";
import { createAgentService } from "../server/agent.ts";

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

const archiveFixture = await mkdtemp(
  join(tmpdir(), "flowlens-public-archive-"),
);
try {
  const logs = join(archiveFixture, "Logs");
  const split = join(logs, "Split");
  const outside = join(archiveFixture, "outside.md");
  const alias = join(archiveFixture, "Alias");
  const controller = "0x1234567890abcdef1234567890abcdef12345678";
  await mkdir(split, { recursive: true });
  await writeFile(
    join(split, "Prior investigation.md"),
    `# Synthetic log\r\nController: [${controller.toUpperCase()}](https://example.invalid/)\r\n`,
  );
  await writeFile(join(logs, "Different.md"), `0x1234\n${controller}a\n`);
  await writeFile(outside, `${controller}\n`);
  await symlink(outside, join(logs, "Alias.md"));
  await symlink(logs, alias);
  const archiveSearch = (address, directory = logs) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["server/cli.ts", "archive-search", "--address", address],
        {
          encoding: "utf8",
          env: { ...process.env, FLOWLENS_VAULT_LOG_DIR: directory },
        },
      ),
    );
  assert.equal(archiveSearch(controller, "").status, "unconfigured");
  assert.equal(archiveSearch(controller, outside).status, "unavailable");
  assert.equal(archiveSearch(controller, `${alias}/`).status, "unavailable");
  const result = archiveSearch(controller);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.matches, [
    { path: "Split/Prior investigation.md", line: 2 },
  ]);
  assert.deepEqual(archiveSearch(DEMO_ROOT).matches, []);
  await writeFile(join(logs, "Oversized.md"), Buffer.alloc(257 * 1024));
  assert.equal(archiveSearch(controller).status, "partial");
} finally {
  await rm(archiveFixture, { recursive: true, force: true });
}

const listStore = await mkdtemp("flowlens-public-list-");
try {
  const listService = createAgentService({
    dataDir: listStore,
    labelFile: join(listStore, "labels.json"),
    providers: { demo: demoProvider, live: new Map() },
  });
  await listService.call("import", { investigation });
  const matching = await listService.call("list", { address: DEMO_ROOT });
  assert.equal(matching.length, 1);
  assert.equal(matching[0].root, DEMO_ROOT);
  const absent = await listService.call("list", {
    address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  assert.deepEqual(absent, []);
  const missingStore = join(listStore, "missing");
  const missingService = createAgentService({
    dataDir: missingStore,
    labelFile: join(listStore, "missing-labels.json"),
    providers: { demo: demoProvider, live: new Map() },
  });
  assert.deepEqual(
    await missingService.call("list", { address: DEMO_ROOT }),
    [],
  );
  await assert.rejects(
    access(missingStore),
    (error) => error?.code === "ENOENT",
  );
} finally {
  await rm(listStore, { recursive: true, force: true });
}

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
const mcpTools = [];
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
  mcpTools.push(name);
  const result =
    name === "get_block_by_timestamp"
      ? "4660"
      : name === "get_transactions" || name === "get_internal_transactions"
        ? []
        : name === "get_token_transfers"
          ? body.params.arguments.page > 1
            ? []
            : [
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

// Public clones exercise the v2 pagination contract without a live provider.
// An empty internal index must not trigger metadata or trace RPC calls.
const ambientFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("An empty synthetic internal index must not query an RPC.");
};
try {
  const v2 = createEtherscanMcpV2Provider({ fetch: mcpFetch, intervalMs: 0 });
  const streams = new Set();
  let cursor = null;
  let exhausted = false;
  const ids = new Set();
  for (let page = 0; page < 4 && !exhausted; page++) {
    const result = await v2.fetchPage({
      address: MCP_ROOT,
      chainId: 8453,
      pageSize: 1,
      cursor,
    });
    result.streams.forEach((stream) => streams.add(stream));
    result.transfers.forEach((transfer) => ids.add(transfer.id));
    cursor = result.cursor;
    exhausted = result.exhausted;
  }
  assert.equal(exhausted, true);
  assert.equal(cursor, null);
  assert.equal(ids.size, 1);
  assert.deepEqual([...streams].sort(), ["erc20", "internal", "native"]);
  assert.ok(mcpTools.includes("get_internal_transactions"));

  const blockHash = `0x${"22".repeat(32)}`;
  const tx = {
    hash: MCP_HASH,
    chainId: "0x2105",
    blockHash,
    blockNumber: "0x1234",
    transactionIndex: "0x0",
    from: MCP_SENDER,
    to: MCP_TOKEN,
    value: "0x0",
  };
  const receipt = {
    transactionHash: MCP_HASH,
    blockHash,
    blockNumber: "0x1234",
    transactionIndex: "0x0",
    from: MCP_SENDER,
    to: MCP_TOKEN,
    contractAddress: null,
    status: "0x1",
    logs: [],
  };
  const syntheticRpc = () => ({
    chainId: 8453,
    source: "Public synthetic Base RPC",
    async request(method) {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getTransactionByHash") return tx;
      if (method === "eth_getTransactionReceipt") return receipt;
      if (method === "eth_getBlockByNumber")
        return {
          hash: blockHash,
          number: "0x1234",
          timestamp: `0x${(1735757265).toString(16)}`,
          transactions: [MCP_HASH],
        };
      if (method === "debug_traceTransaction")
        return {
          type: "CALL",
          from: MCP_SENDER,
          to: MCP_TOKEN,
          value: "0x0",
          calls: [
            { type: "CALL", from: MCP_TOKEN, to: MCP_ROOT, value: "0x2a" },
          ],
        };
      throw new Error(`Unexpected synthetic RPC method: ${method}`);
    },
  });
  const traced = createEtherscanMcpV2Provider({
    intervalMs: 0,
    internalRpcFactory: syntheticRpc,
    request: async (_chain, params) => {
      let result;
      if (params.action === "eth_blockNumber") result = "0x1234";
      else if (params.action === "txlist" || params.action === "tokentx")
        result = [];
      else if (params.action === "eth_getTransactionByHash") result = tx;
      else if (params.action === "eth_getTransactionReceipt") result = receipt;
      else if (params.action === "txlistinternal")
        result =
          params.page === "1"
            ? [
                {
                  hash: MCP_HASH,
                  blockNumber: "4660",
                  timeStamp: "1735757265",
                  from: MCP_TOKEN,
                  to: MCP_ROOT,
                  value: "42",
                  type: "call",
                  traceId: "7_9",
                  isError: "0",
                },
              ]
            : [];
      else
        throw new Error(`Unexpected synthetic index action: ${params.action}`);
      return { status: "1", result };
    },
  });
  const internalTransfers = [];
  cursor = null;
  exhausted = false;
  for (let page = 0; page < 4 && !exhausted; page++) {
    const result = await traced.fetchPage({
      address: MCP_ROOT,
      chainId: 8453,
      pageSize: 1,
      cursor,
    });
    internalTransfers.push(...result.transfers);
    cursor = result.cursor;
    exhausted = result.exhausted;
  }
  assert.equal(exhausted, true);
  assert.equal(internalTransfers.length, 1);
  assert.equal(internalTransfers[0].kind, "internal");
  assert.equal(internalTransfers[0].eventIndex, "trace.0");
  assert.equal(internalTransfers[0].rawAmount, "42");
  assert.equal(internalTransfers[0].from, MCP_TOKEN);
  assert.equal(internalTransfers[0].to, MCP_ROOT);
} finally {
  globalThis.fetch = ambientFetch;
}
console.log(
  "Public synthetic smoke checks passed (Base internal-stream pagination).",
);
