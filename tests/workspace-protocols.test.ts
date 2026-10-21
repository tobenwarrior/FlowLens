import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Investigation } from "../src/domain/types.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";

const label = {
  text: "Synthetic reviewed entity",
  source: "Local synthetic review",
  sourceUrl: "https://example.org/synthetic-evidence",
  kind: "entity",
  confidence: "unverified",
  claimType: "hypothesis",
  observedAt: "2026-10-20T12:00:00.000Z",
  retrievedAt: "2026-10-21T12:00:00.000Z",
};
function cli(args: string[]) {
  return spawnSync(process.execPath, [resolve("server/cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ETHERSCAN_API_KEY: "", FLOWLENS_BLOCKSCOUT: "off" },
  });
}
function result(value: { isError?: boolean; structuredContent?: unknown }) {
  assert.equal(
    value.isError,
    undefined,
    JSON.stringify(value.structuredContent),
  );
  return (value.structuredContent as { result: Investigation }).result;
}

test("CLI annotations and visibility preserve exact evidence and reject stale mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-cli-"));
  try {
    const file = join(dir, "case.json"),
      labelFile = join(dir, "label.json");
    assert.equal(cli(["create", "--mode", "demo", "--file", file]).status, 0);
    const initial = JSON.parse(await readFile(file, "utf8")) as Investigation;
    await writeFile(labelFile, JSON.stringify(label));
    const annotated = cli([
      "annotate",
      "--file",
      file,
      "--chain",
      "1",
      "--address",
      DEMO_ROOT,
      "--label-file",
      labelFile,
      "--expected-revision",
      initial.updatedAt,
    ]);
    assert.equal(annotated.status, 0, annotated.stderr);
    const updated = JSON.parse(annotated.stdout) as Investigation;
    assert.equal(
      updated.nodes.find((n) => n.chainId === 1 && n.address === DEMO_ROOT)
        ?.label?.text,
      label.text,
    );
    assert.deepEqual(updated.transfers, initial.transfers);
    const stale = cli([
      "annotate",
      "--file",
      file,
      "--chain",
      "1",
      "--address",
      DEMO_ROOT,
      "--remove",
      "true",
      "--expected-revision",
      initial.updatedAt,
    ]);
    assert.equal(stale.status, 1);
    assert.equal(JSON.parse(stale.stderr).error.code, "CASE_CONFLICT");
    const unboundPage = cli([
      "wallet",
      "--file",
      file,
      "--address",
      DEMO_ROOT,
      "--offset",
      "3",
    ]);
    assert.equal(unboundPage.status, 1);
    assert.equal(JSON.parse(unboundPage.stderr).error.code, "INVALID_CURSOR");
    const stalePage = cli([
      "wallet",
      "--file",
      file,
      "--address",
      DEMO_ROOT,
      "--offset",
      "3",
      "--expected-revision",
      initial.updatedAt,
    ]);
    assert.equal(stalePage.status, 1);
    assert.equal(JSON.parse(stalePage.stderr).error.code, "CURSOR_STALE");
    assert.equal(JSON.parse(stalePage.stderr).error.retryable, true);
    const walletRead = cli([
      "wallet",
      "--file",
      file,
      "--address",
      DEMO_ROOT,
      "--page-size",
      "3",
      "--offset",
      "3",
      "--expected-revision",
      updated.updatedAt,
    ]);
    assert.equal(walletRead.status, 0, walletRead.stderr);
    const walletPage = JSON.parse(walletRead.stdout);
    assert.equal(walletPage.scope, "loaded-evidence");
    assert.equal(walletPage.caseId, updated.id);
    assert.equal(walletPage.revision, updated.updatedAt);
    assert.equal(walletPage.transfers.length, 3);
    assert.equal(walletPage.page.nextOffset, 6);
    const graphBefore = cli(["graph", "--file", file]);
    assert.equal(graphBefore.status, 0, graphBefore.stderr);
    const hidden = cli([
      "visibility",
      "--file",
      file,
      "--transfer-ids",
      JSON.stringify([initial.transfers[0].id]),
      "--visible",
      "false",
    ]);
    assert.equal(hidden.status, 0, hidden.stderr);
    const saved = JSON.parse(await readFile(file, "utf8")) as Investigation;
    assert.deepEqual(saved.hiddenTransfers, [initial.transfers[0].id]);
    assert.deepEqual(saved.transfers, initial.transfers);
    const graphAfter = cli(["graph", "--file", file]);
    assert.equal(graphAfter.status, 0, graphAfter.stderr);
    const beforeGraph = JSON.parse(graphBefore.stdout),
      afterGraph = JSON.parse(graphAfter.stdout);
    assert.deepEqual(afterGraph.transfers, beforeGraph.transfers);
    assert.deepEqual(afterGraph.flows, beforeGraph.flows);
    assert.ok(
      afterGraph.edges.every((edge: { transfers: { id: string }[] }) =>
        edge.transfers.every((t) => t.id !== initial.transfers[0].id),
      ),
    );
    assert.ok(Array.isArray(afterGraph.visibleTransferIds));
    assert.ok(!afterGraph.visibleTransferIds.includes(initial.transfers[0].id));
    assert.deepEqual(afterGraph.hidden.transferIds, [initial.transfers[0].id]);
    assert.match(
      afterGraph.visibilityNote,
      /gross\/net remain all filtered loaded evidence/,
    );
    const removed = cli([
      "annotate",
      "--file",
      file,
      "--chain",
      "1",
      "--address",
      DEMO_ROOT,
      "--remove",
      "true",
    ]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(
      (JSON.parse(removed.stdout) as Investigation).nodes.find(
        (n) => n.chainId === 1 && n.address === DEMO_ROOT,
      )?.label,
      undefined,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI validates booleans and bounded local label JSON before changing a case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-invalid-"));
  try {
    const file = join(dir, "case.json"),
      badLabel = join(dir, "bad.json");
    assert.equal(cli(["create", "--mode", "demo", "--file", file]).status, 0);
    const before = await readFile(file, "utf8");
    await writeFile(
      badLabel,
      JSON.stringify({
        ...label,
        sourceUrl: "https://dummy:example@example.test",
      }),
    );
    assert.equal(
      cli([
        "annotate",
        "--file",
        file,
        "--chain",
        "1",
        "--address",
        DEMO_ROOT,
        "--label-file",
        badLabel,
      ]).status,
      1,
    );
    assert.equal(
      cli([
        "visibility",
        "--file",
        file,
        "--node-keys",
        "[]",
        "--visible",
        "yes",
      ]).status,
      1,
    );
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("official MCP client discovers and uses typed local annotation and visibility operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/mcp.ts")],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      FLOWLENS_DATA_DIR: dir,
      ETHERSCAN_API_KEY: "",
      FLOWLENS_BLOCKSCOUT: "off",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "flowlens-workspace-test",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ["flowlens_annotate", "flowlens_visibility"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.ok(tool.outputSchema);
    }
    const created = result(
      await client.callTool({
        name: "flowlens_create",
        arguments: { root: DEMO_ROOT, mode: "demo" },
      }),
    );
    const walletPage = await client.callTool({
      name: "flowlens_wallet",
      arguments: { caseId: created.id, address: DEMO_ROOT, pageSize: 3 },
    });
    assert.ok(
      !walletPage.isError,
      JSON.stringify(walletPage.structuredContent),
    );
    const wallet = (
      walletPage.structuredContent as {
        result: {
          caseId: string;
          revision: string;
          scope: string;
          transfers: unknown[];
          page: { nextOffset: number };
          counts: { transfers: number };
        };
      }
    ).result;
    assert.equal(wallet.scope, "loaded-evidence");
    assert.equal(wallet.caseId, created.id);
    assert.equal(wallet.revision, created.updatedAt);
    assert.equal(wallet.transfers.length, 3);
    assert.equal(wallet.page.nextOffset, 3);
    assert.equal(wallet.counts.transfers, created.transfers.length);
    const annotated = result(
      await client.callTool({
        name: "flowlens_annotate",
        arguments: {
          caseId: created.id,
          chainId: 1,
          address: DEMO_ROOT,
          label,
          expectedRevision: created.updatedAt,
        },
      }),
    );
    assert.equal(
      annotated.nodes.find((n) => n.chainId === 1 && n.address === DEMO_ROOT)
        ?.label?.source,
      label.source,
    );
    const unboundPage = await client.callTool({
      name: "flowlens_wallet",
      arguments: {
        caseId: created.id,
        address: DEMO_ROOT,
        offset: 3,
        pageSize: 3,
      },
    });
    assert.equal(unboundPage.isError, true);
    const stalePage = await client.callTool({
      name: "flowlens_wallet",
      arguments: {
        caseId: created.id,
        address: DEMO_ROOT,
        offset: 3,
        pageSize: 3,
        expectedRevision: created.updatedAt,
      },
    });
    assert.equal(stalePage.isError, true);
    assert.equal(
      (
        stalePage.structuredContent as {
          error: { code: string; retryable: boolean };
        }
      ).error.code,
      "CURSOR_STALE",
    );
    assert.equal(
      (
        stalePage.structuredContent as {
          error: { code: string; retryable: boolean };
        }
      ).error.retryable,
      true,
    );
    const nextPage = await client.callTool({
      name: "flowlens_wallet",
      arguments: {
        caseId: created.id,
        address: DEMO_ROOT,
        offset: 3,
        pageSize: 3,
        expectedRevision: annotated.updatedAt,
      },
    });
    assert.ok(!nextPage.isError, JSON.stringify(nextPage.structuredContent));
    const hidden = result(
      await client.callTool({
        name: "flowlens_visibility",
        arguments: {
          caseId: created.id,
          transferIds: [created.transfers[0].id],
          visible: false,
          expectedRevision: annotated.updatedAt,
        },
      }),
    );
    assert.deepEqual(hidden.hiddenTransfers, [created.transfers[0].id]);
    const invalid = await client.callTool({
      name: "flowlens_annotate",
      arguments: {
        caseId: created.id,
        chainId: 1,
        address: DEMO_ROOT,
        label: { ...label, claimType: "certain-owner" },
      },
    });
    assert.equal(invalid.isError, true);
    const exported = result(
      await client.callTool({
        name: "flowlens_export",
        arguments: { caseId: created.id },
      }),
    );
    assert.deepEqual(exported.transfers, created.transfers);
    assert.deepEqual(exported.hiddenTransfers, hidden.hiddenTransfers);
  } finally {
    await client.close();
    await transport.close();
    await rm(dir, { recursive: true, force: true });
  }
});
