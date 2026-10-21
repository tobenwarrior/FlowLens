import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Investigation } from "../src/domain/types.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";
import { createMcpServer } from "../server/mcp.ts";
import { InMemoryTransport } from "@modelcontextprotocol/server";

type Envelope = {
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
};
function envelope(result: CallToolResult): Envelope {
  const content = result.content.find((item) => item.type === "text");
  assert.ok(
    content && content.type === "text",
    "Every tool response has a JSON text fallback",
  );
  const value = JSON.parse(content.text) as Envelope;
  assert.deepEqual(
    result.structuredContent,
    value,
    "Structured and text views carry identical evidence",
  );
  return value;
}
function successful<T>(result: CallToolResult): T {
  assert.ok(!result.isError, JSON.stringify(result));
  const value = envelope(result);
  assert.ok("result" in value);
  assert.ok(!value.error);
  return value.result as T;
}
async function withClient(
  run: (
    client: Client,
    directory: string,
    stderr: () => string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "flowlens-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/mcp.ts")],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      FLOWLENS_DATA_DIR: directory,
      ETHERSCAN_API_KEY: "",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "flowlens-e2e", version: "1.0.0" });
  try {
    await client.connect(transport);
    await run(client, directory, () => stderr);
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("official MCP client discovers typed tools, bounded expansion and safe annotations over stdio", async () => {
  await withClient(async (client, _directory, stderr) => {
    const list = await client.listTools();
    assert.deepEqual(
      list.tools.map((tool) => tool.name).sort(),
      [
        "status",
        "schema",
        "list",
        "create",
        "inspect",
        "expand",
        "evidence",
        "graph",
        "export",
        "import",
        "replay",
        "acquire",
        "annotate",
        "prices",
        "prices_at_blocks",
        "label_put",
        "label_search",
        "label_forget",
        "visibility",
        "wallet",
      ]
        .map((op) => `flowlens_${op}`)
        .sort(),
    );
    const expand = list.tools.find((tool) => tool.name === "flowlens_expand")!;
    const schema = expand.inputSchema as {
      properties: Record<string, { maximum?: number }>;
    };
    assert.equal(schema.properties.maxPages.maximum, 3);
    assert.ok(expand.outputSchema);
    assert.equal(
      (expand.outputSchema as { properties: { result: { $ref: string } } })
        .properties.result.$ref,
      "#/$defs/Investigation",
    );
    const evidence = list.tools.find(
      (tool) => tool.name === "flowlens_evidence",
    )!;
    assert.equal(
      (evidence.outputSchema as { properties: { result: { $ref: string } } })
        .properties.result.$ref,
      "#/$defs/Transfer",
    );
    assert.equal(expand.annotations?.destructiveHint, false);
    assert.equal(expand.annotations?.readOnlyHint, false);
    assert.equal(
      list.tools.find((tool) => tool.name === "flowlens_evidence")?.annotations
        ?.readOnlyHint,
      true,
    );
    const status = successful<Record<string, unknown>>(
      await client.callTool({ name: "flowlens_status", arguments: {} }),
    );
    assert.equal(status.liveAvailable, false);
    const contract = successful<Record<string, unknown>>(
      await client.callTool({ name: "flowlens_schema", arguments: {} }),
    );
    assert.ok(contract.operations);
    assert.equal(stderr(), "");
  });
});

test("MCP workflow creates, resumes, inspects and exports the same durable evidence without UI clicks", async () => {
  await withClient(async (client, directory) => {
    const created = successful<Investigation>(
      await client.callTool({
        name: "flowlens_create",
        arguments: {
          root: DEMO_ROOT,
          mode: "demo",
          title: "MCP synthetic replay",
        },
      }),
    );
    assert.equal(created.transfers.length, 16);
    assert.equal(created.mode, "demo");
    const summary = successful<Record<string, unknown>>(
      await client.callTool({
        name: "flowlens_inspect",
        arguments: { caseId: created.id },
      }),
    );
    assert.equal(summary.id, created.id);
    assert.ok(Array.isArray(summary.coverage));
    await client
      .callTool({
        name: "flowlens_expand",
        arguments: {
          caseId: created.id,
          address: DEMO_ROOT,
          chainId: 1,
          maxPages: 1,
        },
      })
      .then(successful);
    const exported = successful<Investigation>(
      await client.callTool({
        name: "flowlens_export",
        arguments: { caseId: created.id },
      }),
    );
    assert.equal(exported.transfers.length, 24);
    assert.equal(new Set(exported.transfers.map((t) => t.id)).size, 24);
    assert.equal(exported.root, DEMO_ROOT);
    assert.ok(
      exported.coverage.every((c) =>
        c.warnings.some((w) => /synthetic/i.test(w)),
      ),
    );
    const record = successful<Investigation["transfers"][number]>(
      await client.callTool({
        name: "flowlens_evidence",
        arguments: { caseId: created.id, evidenceId: exported.transfers[0].id },
      }),
    );
    assert.equal(record.id, exported.transfers[0].id);
    assert.equal(record.synthetic, true);
    const graph = successful<{
      transfers: unknown[];
      flows: unknown[];
      coverage: unknown[];
    }>(
      await client.callTool({
        name: "flowlens_graph",
        arguments: { caseId: created.id, chainId: 1, direction: "in" },
      }),
    );
    assert.ok(graph.transfers.length > 0);
    assert.ok(graph.flows.length > 0);
    assert.ok(graph.coverage.length > 0);
    const imported = successful<Investigation>(
      await client.callTool({
        name: "flowlens_import",
        arguments: { investigation: { ...exported, id: "mcp-roundtrip" } },
      }),
    );
    assert.equal(imported.transfers.length, 24);
    assert.equal(imported.coverage[0].cursor, exported.coverage[0].cursor);
    const cases = successful<unknown[]>(
      await client.callTool({ name: "flowlens_list", arguments: {} }),
    );
    assert.equal(cases.length, 2);
    assert.ok(
      (await readdir(directory)).some((name) => name === `${created.id}.json`),
    );
  });
});

test("MCP errors are structured and bounded; invalid budgets do not advance persisted cursors", async () => {
  await withClient(async (client) => {
    const created = successful<Investigation>(
      await client.callTool({
        name: "flowlens_create",
        arguments: { root: DEMO_ROOT, mode: "demo" },
      }),
    );
    const bad = await client.callTool({
      name: "flowlens_expand",
      arguments: {
        caseId: created.id,
        address: DEMO_ROOT,
        chainId: 1,
        maxPages: 99,
      },
    });
    assert.equal(bad.isError, true);
    assert.equal(envelope(bad).error?.code, "INVALID_ARGUMENT");
    assert.equal(envelope(bad).error?.retryable, false);
    const after = successful<Investigation>(
      await client.callTool({
        name: "flowlens_export",
        arguments: { caseId: created.id },
      }),
    );
    assert.deepEqual(after.coverage, created.coverage);
    assert.deepEqual(after.transfers, created.transfers);
    for (const args of [{ caseId: "../outside" }, { caseId: "missing_case" }]) {
      const invalid = await client.callTool({
        name: "flowlens_export",
        arguments: args,
      });
      assert.equal(invalid.isError, true);
      assert.match(
        envelope(invalid).error!.code,
        /INVALID_ARGUMENT|CASE_NOT_FOUND/,
      );
    }
    const missingKey = await client.callTool({
      name: "flowlens_create",
      arguments: { root: DEMO_ROOT, mode: "live" },
    });
    assert.equal(missingKey.isError, true);
    assert.equal(envelope(missingKey).error?.code, "KEY_REQUIRED");
    assert.ok(JSON.stringify(missingKey).length < 4000);
  });
});

test("MCP synthetic protocol replay returns scoped analyses and never implies live evidence", async () => {
  await withClient(async (client) => {
    const replay = successful<{
      mode: string;
      analysis: Record<string, unknown>;
    }>(
      await client.callTool({
        name: "flowlens_replay",
        arguments: { fixture: "protocols-v1" },
      }),
    );
    assert.equal(replay.mode, "synthetic");
    assert.ok(replay.analysis.safe);
    assert.ok(replay.analysis.bridges);
    assert.ok(replay.analysis.internal);
    const serialized = JSON.stringify(replay).toLowerCase();
    assert.match(serialized, /signature/);
    assert.match(serialized, /unmatched|unobserved/);
    assert.match(serialized, /coverage/);
    const invalid = await client.callTool({
      name: "flowlens_replay",
      arguments: { fixture: "protocols-v1", bundle: { version: 1 } },
    });
    assert.equal(invalid.isError, true);
    assert.equal(envelope(invalid).error?.code, "INVALID_ARGUMENT");
  });
});

test("MCP graph cursors page deterministically and reject a changed case revision", async () => {
  await withClient(async (client) => {
    const created = successful<Investigation>(
      await client.callTool({
        name: "flowlens_create",
        arguments: { root: DEMO_ROOT, mode: "demo" },
      }),
    );
    type Page = {
      transfers: { id: string }[];
      page: {
        nextCursor: string | null;
        totalMatching: number;
        returned: number;
      };
      edgeScope: string;
      flowScope: string;
    };
    const first = successful<Page>(
      await client.callTool({
        name: "flowlens_graph",
        arguments: { caseId: created.id, limit: 3 },
      }),
    );
    assert.equal(first.transfers.length, 3);
    assert.equal(first.page.totalMatching, 16);
    assert.match(first.edgeScope, /page/i);
    assert.match(first.flowScope, /filtered loaded/i);
    const ids = first.transfers.map((t) => t.id);
    let cursor = first.page.nextCursor;
    while (cursor) {
      const next = successful<Page>(
        await client.callTool({
          name: "flowlens_graph",
          arguments: { caseId: created.id, limit: 3, cursor },
        }),
      );
      ids.push(...next.transfers.map((t) => t.id));
      cursor = next.page.nextCursor;
    }
    assert.equal(ids.length, 16);
    assert.equal(new Set(ids).size, 16);
    successful(
      await client.callTool({
        name: "flowlens_expand",
        arguments: {
          caseId: created.id,
          address: DEMO_ROOT,
          chainId: 1,
          maxPages: 1,
        },
      }),
    );
    const stale = await client.callTool({
      name: "flowlens_graph",
      arguments: {
        caseId: created.id,
        limit: 3,
        cursor: first.page.nextCursor,
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(envelope(stale).error?.code, "CURSOR_STALE");
    assert.equal(envelope(stale).error?.retryable, true);
  });
});

test("MCP attached replay persists separately from indexed transfer history", async () => {
  await withClient(async (client) => {
    const created = successful<Investigation>(
      await client.callTool({
        name: "flowlens_create",
        arguments: { root: DEMO_ROOT, mode: "demo" },
      }),
    );
    const replay = successful<{
      mode: string;
      caseId: string;
      indexedHistoryChanged: boolean;
    }>(
      await client.callTool({
        name: "flowlens_replay",
        arguments: { caseId: created.id, fixture: "protocols-v1" },
      }),
    );
    assert.equal(replay.mode, "synthetic");
    assert.equal(replay.caseId, created.id);
    assert.equal(replay.indexedHistoryChanged, false);
    const saved = successful<
      Investigation & { protocolEvidence: { mode: string } }
    >(
      await client.callTool({
        name: "flowlens_export",
        arguments: { caseId: created.id },
      }),
    );
    assert.equal(saved.protocolEvidence.mode, "synthetic");
    assert.deepEqual(saved.transfers, created.transfers);
    const inspected = successful<Record<string, unknown>>(
      await client.callTool({
        name: "flowlens_inspect",
        arguments: { caseId: created.id },
      }),
    );
    assert.ok(inspected.protocolAnalysis);
  });
});

test("MCP process restart resumes the durable cursor without losing or duplicating evidence", async () => {
  await withClient(async (client, directory) => {
    const created = successful<Investigation>(
      await client.callTool({
        name: "flowlens_create",
        arguments: { root: DEMO_ROOT, mode: "demo" },
      }),
    );
    await client.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/mcp.ts")],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        FLOWLENS_DATA_DIR: directory,
        ETHERSCAN_API_KEY: "",
      },
      stderr: "pipe",
    });
    const resumed = new Client({ name: "flowlens-restart", version: "1.0.0" });
    try {
      await resumed.connect(transport);
      const restored = successful<Investigation>(
        await resumed.callTool({
          name: "flowlens_export",
          arguments: { caseId: created.id },
        }),
      );
      assert.deepEqual(restored.coverage, created.coverage);
      assert.deepEqual(restored.transfers, created.transfers);
      const next = successful<Investigation>(
        await resumed.callTool({
          name: "flowlens_expand",
          arguments: {
            caseId: created.id,
            address: DEMO_ROOT,
            chainId: 8453,
            maxPages: 1,
          },
        }),
      );
      assert.equal(next.transfers.length, 22);
      assert.equal(new Set(next.transfers.map((t) => t.id)).size, 22);
      assert.equal(next.root, created.root);
    } finally {
      await resumed.close();
      await transport.close();
    }
  });
});

test("MCP refuses oversized responses without truncation and redacts coded errors", async () => {
  let calls = 0;
  const server = createMcpServer({
    async call(operation) {
      calls++;
      if (operation === "schema") return { large: "x".repeat(3_000_000) };
      throw Object.assign(
        new Error(
          "Provider rejected apikey=secret-123 and Bearer secret-token",
        ),
        {
          code: "SOURCE_ERROR",
          retryable: true,
          details: { coverage: [{ error: "Bearer secret-token" }] },
        },
      );
    },
  });
  const client = new Client({ name: "flowlens-memory", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const oversized = await client.callTool({
      name: "flowlens_schema",
      arguments: {},
    });
    assert.equal(oversized.isError, true);
    const output = envelope(oversized);
    assert.equal(output.error?.code, "OUTPUT_TOO_LARGE");
    assert.match(
      output.error!.message,
      /not returned|No evidence was truncated/,
    );
    assert.equal(
      (output.error!.details as { mayHaveCommitted: boolean }).mayHaveCommitted,
      false,
    );
    const invalid = await client.callTool({
      name: "flowlens_import",
      arguments: { investigation: { notes: "x".repeat(5_000_001) } },
    });
    assert.equal(invalid.isError, true);
    assert.equal(envelope(invalid).error?.code, "INPUT_TOO_LARGE");
    assert.equal(calls, 1);
    const coded = await client.callTool({
      name: "flowlens_status",
      arguments: {},
    });
    assert.equal(coded.isError, true);
    assert.equal(envelope(coded).error?.code, "SOURCE_ERROR");
    assert.equal(envelope(coded).error?.retryable, true);
    assert.doesNotMatch(JSON.stringify(coded), /secret-123|secret-token/);
    assert.match(JSON.stringify(coded), /redacted/);
    const unknown = await client.callTool({
      name: "flowlens_missing",
      arguments: {},
    });
    assert.equal(envelope(unknown).error?.code, "UNKNOWN_TOOL");
  } finally {
    await client.close();
    await server.close();
  }
});
