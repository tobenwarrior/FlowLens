import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createAgentService } from "../server/agent.ts";
import { createApiServer } from "../server/api.ts";
import { createMcpServer } from "../server/mcp.ts";
import { acquireProtocolEvidence } from "../server/acquire.ts";
import { AcquisitionError } from "../server/acquire.ts";
import type { Acquirer } from "../server/acquire.ts";
import type { RpcClient } from "../server/rpc.ts";
import type { Investigation } from "../src/domain/types.ts";
import { demoProvider, DEMO_ROOT } from "../src/domain/demo.ts";

// All RPC responses are invented contract fixtures; these tests never query a public provider.
const A = DEMO_ROOT,
  B = `0x${"2".repeat(40)}`,
  H = `0x${"a".repeat(64)}`,
  BLOCK = `0x${"b".repeat(64)}`;
const providers = {
  demo: demoProvider,
  live: new Map(),
};
function contracts() {
  let calls = 0,
    fail = false;
  const rpc: RpcClient = {
    chainId: 1,
    source: "Synthetic workflow contract RPC",
    async request(method) {
      calls++;
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getTransactionByHash")
        return {
          hash: H,
          from: A,
          to: B,
          value: "0x0",
          blockHash: BLOCK,
          blockNumber: "0x64",
          transactionIndex: "0x0",
        };
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash: H,
          from: A,
          to: B,
          status: "0x1",
          blockHash: fail ? H : BLOCK,
          blockNumber: "0x64",
          transactionIndex: "0x0",
        };
      if (method === "eth_getBlockByNumber")
        return {
          hash: BLOCK,
          number: "0x64",
          timestamp: "0x67100000",
          transactions: [H],
        };
      if (method === "debug_traceTransaction")
        return {
          type: "CALL",
          from: A,
          to: B,
          value: "0x0",
          calls: [{ type: "CALL", from: B, to: A, value: "0x10" }],
        };
      throw new Error("Unexpected fixture method");
    },
  };
  const acquirer: Acquirer = (input) =>
    acquireProtocolEvidence(input, { rpcFactory: () => rpc });
  return {
    acquirer,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
  };
}
async function workspace(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-acquisition-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const query = { kind: "internal", chainId: 1, hash: H, address: A };

test("specific acquisition failures preserve their machine code and retryability", () =>
  workspace(async (dataDir) => {
    const service = createAgentService({
      dataDir,
      providers,
      acquirer: async () => {
        throw new AcquisitionError(
          "RPC_RATE_LIMITED",
          "Public provider is rate limited.",
          true,
        );
      },
    });
    await assert.rejects(
      service.call("acquire", query),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "RPC_RATE_LIMITED" &&
        "retryable" in error &&
        error.retryable === true,
    );
  }));

test("CLI evidence-only setup and malformed Safe cursors need no provider call", () =>
  workspace(async (dataDir) => {
    const file = join(dataDir, "cli.json");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["server/cli.ts", ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ETHERSCAN_API_KEY: "",
          FLOWLENS_BLOCKSCOUT: "off",
        },
      });
    const created = run([
      "create",
      "--mode",
      "live",
      "--history-mode",
      "evidence-only",
      "--address",
      A,
      "--file",
      file,
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(
      JSON.parse(created.stdout).coverage[0].provider,
      "evidence-only",
    );
    const invalid = run([
      "acquire",
      "--kind",
      "safe",
      "--chain",
      "1",
      "--address",
      A,
      "--cursor",
      "e30",
      "--file",
      file,
    ]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, "INVALID_SAFE_CURSOR");
    const exported = run(["export", "--file", file]);
    assert.equal(JSON.parse(exported.stdout).protocolEvidence, undefined);
  }));

test("agent acquisition preserves durable evidence through retries and preflight errors", () =>
  workspace(async (dataDir) => {
    const f = contracts(),
      service = createAgentService({
        dataDir,
        providers,
        acquirer: f.acquirer,
      });
    const created = (await service.call("create", {
      root: A,
      mode: "live",
      historyMode: "evidence-only",
    })) as Investigation;
    assert.equal(f.calls(), 0);
    const result = (await service.call("acquire", {
      ...query,
      caseId: created.id,
    })) as any;
    assert.equal(result.mode, "private");
    assert.equal(result.indexedHistoryChanged, false);
    assert.equal(result.analysis.internal.transfers[0].rawAmount, "16");
    const saved = (await service.call("export", {
      caseId: created.id,
    })) as Investigation;
    assert.equal(saved.transfers.length, 0);
    assert.equal(saved.protocolEvidence!.internal!.traces.length, 2);
    await service.call("acquire", { ...query, caseId: created.id });
    const retried = (await service.call("export", {
      caseId: created.id,
    })) as Investigation;
    assert.equal(retried.protocolEvidence!.internal!.traces.length, 2);
    f.fail();
    const failed = (await service.call("acquire", {
      ...query,
      caseId: created.id,
    })) as any;
    assert.ok(failed.errors.length > 0);
    assert.equal(failed.acquisition.capability.status, "error");
    const restarted = createAgentService({
      dataDir,
      providers,
      acquirer: f.acquirer,
    });
    const restored = (await restarted.call("export", {
      caseId: created.id,
    })) as Investigation;
    assert.equal(restored.protocolEvidence!.internal!.traces.length, 2);
    assert.equal(restored.transfers.length, 0);
    assert.equal(restored.coverage[0].status, "unsupported");
  }));

test("demo, missing cases, unsupported options and excessive budgets fail before outbound acquisition", () =>
  workspace(async (dataDir) => {
    const f = contracts(),
      service = createAgentService({
        dataDir,
        providers,
        acquirer: f.acquirer,
      });
    const demo = (await service.call("create", {
      root: A,
      mode: "demo",
    })) as Investigation;
    for (const input of [
      { ...query, caseId: demo.id },
      { ...query, caseId: "missing" },
      { ...query, maxCalls: 65 },
      { ...query, url: "https://untrusted.invalid" },
    ])
      await assert.rejects(service.call("acquire", input));
    assert.equal(f.calls(), 0);
  }));

test("acquisition merges against the latest case and retains edits made during an external read", () =>
  workspace(async (dataDir) => {
    const f = contracts();
    let begin!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
        begin = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
    const service = createAgentService({
      dataDir,
      providers,
      acquirer: async (input) => {
        begin();
        await gate;
        return f.acquirer(input);
      },
    });
    const value = (await service.call("create", {
      root: A,
      mode: "live",
      historyMode: "evidence-only",
    })) as Investigation;
    const pending = service.call("acquire", { ...query, caseId: value.id });
    await started;
    await service.call("import", {
      investigation: { ...value, notes: "Retain this concurrent note" },
    });
    finish();
    await pending;
    const current = (await service.call("export", {
      caseId: value.id,
    })) as Investigation;
    assert.equal(current.notes, "Retain this concurrent note");
    assert.equal(current.protocolEvidence!.internal!.traces.length, 2);
  }));

test("official MCP client acquires and exports private protocol evidence without UI or public requests", () =>
  workspace(async (dataDir) => {
    const f = contracts(),
      service = createAgentService({
        dataDir,
        providers,
        acquirer: f.acquirer,
      });
    const server = createMcpServer(service),
      client = new Client({ name: "acquisition-contract", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const unwrap = (result: any) => {
        assert.ok(!result.isError, JSON.stringify(result));
        return result.structuredContent.result;
      };
      const value = unwrap(
        await client.callTool({
          name: "flowlens_create",
          arguments: { root: A, mode: "live", historyMode: "evidence-only" },
        }),
      );
      const result = unwrap(
        await client.callTool({
          name: "flowlens_acquire",
          arguments: { ...query, caseId: value.id, maxCalls: 6 },
        }),
      );
      assert.equal(result.bundle.internal.mode, "private");
      assert.equal(
        result.analysis.internal.coverage[0].fullWalletHistory,
        false,
      );
      const exported = unwrap(
        await client.callTool({
          name: "flowlens_export",
          arguments: { caseId: value.id },
        }),
      );
      assert.equal(exported.protocolEvidence.internal.traces.length, 2);
      const before = f.calls();
      const invalid = await client.callTool({
        name: "flowlens_acquire",
        arguments: { ...query, maxCalls: 65 },
      });
      assert.equal(invalid.isError, true);
      assert.equal(f.calls(), before);
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("local HTTP acquisition persists the same model and rejects demo network queries", () =>
  workspace(async (dataDir) => {
    const f = contracts(),
      server = createApiServer({ dataDir, providers, acquirer: f.acquirer });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const created = await (
        await post("/api/investigations", {
          root: A,
          mode: "live",
          historyMode: "evidence-only",
        })
      ).json();
      const acquired = await post(
        `/api/investigations/${created.id}/acquire`,
        query,
      );
      assert.equal(acquired.status, 200);
      assert.equal(
        (await acquired.json()).analysis.internal.transfers[0].rawAmount,
        "16",
      );
      const saved = await (
        await fetch(`${base}/api/investigations/${created.id}`)
      ).json();
      assert.equal(saved.protocolEvidence.internal.traces.length, 2);
      assert.equal(saved.transfers.length, 0);
      const demo = await (
        await post("/api/investigations", { root: A, mode: "demo" })
      ).json();
      const before = f.calls();
      assert.equal(
        (await post("/api/acquire", { ...query, caseId: demo.id })).status,
        400,
      );
      assert.equal(f.calls(), before);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }));

test("CLI protocol imports reject directories and devices with a structured file error", () =>
  workspace(async (dataDir) => {
    const paths = [
      dataDir,
      ...(process.platform === "win32" ? [] : ["/dev/null"]),
    ];
    for (const path of paths) {
      const result = spawnSync(
        process.execPath,
        ["server/cli.ts", "replay", "--protocol-file", path],
        {
          encoding: "utf8",
          timeout: 2000,
          env: {
            PATH: process.env.PATH,
            ETHERSCAN_API_KEY: "",
            FLOWLENS_BLOCKSCOUT: "off",
          },
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const failure = JSON.parse(result.stderr).error;
      assert.equal(failure.code, "INVALID_INPUT_FILE");
      assert.equal(failure.retryable, false);
      assert.match(failure.message, /regular file/);
    }
  }));
