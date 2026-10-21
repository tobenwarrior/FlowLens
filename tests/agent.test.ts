import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentService, AgentOperationError } from "../server/agent.ts";
import {
  createSyntheticProtocolEvidence,
  parseProtocolEvidence,
  analyzeProtocolEvidence,
} from "../src/domain/protocols.ts";
import { parseInvestigation } from "../src/domain/engine.ts";
import { createInvestigation } from "../src/domain/engine.ts";
import { demoProvider } from "../src/domain/demo.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";

async function withService(
  run: (service: ReturnType<typeof createAgentService>) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "flowlens-agent-"));
  try {
    await run(
      createAgentService({
        dataDir: directory,
        providers: {
          demo: demoProvider,
          live: demoProvider,
          liveEnabled: false,
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("agent workflow creates, resumes, inspects and exports the same durable evidence", () =>
  withService(async (service) => {
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as any;
    assert.equal(created.transfers.length, 16);
    const expanded = (await service.call("expand", {
      caseId: created.id,
      address: DEMO_ROOT,
      chainId: 1,
      maxPages: 1,
      pageSize: 8,
    })) as any;
    assert.equal(expanded.transfers.length, 22);
    assert.equal(
      ((await service.call("inspect", { caseId: created.id })) as any)
        .evidenceCount,
      22,
    );
    const exported = await service.call("export", { caseId: created.id });
    assert.equal(parseInvestigation(exported).transfers.length, 22);
    assert.equal(
      (
        (await service.call("evidence", {
          caseId: created.id,
          evidenceId: expanded.transfers[0].id,
        })) as any
      ).id,
      expanded.transfers[0].id,
    );
  }));
test("synthetic protocol replay persists separately from indexed history and roundtrips", () =>
  withService(async (service) => {
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as any;
    const replay = (await service.call("replay", {
      caseId: created.id,
      fixture: "protocols-v1",
    })) as any;
    assert.equal(replay.mode, "synthetic");
    assert.ok(replay.analysis.safe);
    assert.ok(replay.analysis.bridges);
    assert.ok(replay.analysis.internal);
    const exported = (await service.call("export", {
      caseId: created.id,
    })) as any;
    assert.equal(exported.protocolEvidence.mode, "synthetic");
    assert.equal(exported.transfers.length, 16);
    assert.deepEqual(
      analyzeProtocolEvidence(parseProtocolEvidence(exported.protocolEvidence)),
      replay.analysis,
    );
    assert.deepEqual(
      parseInvestigation(exported).protocolEvidence,
      exported.protocolEvidence,
    );
  }));
test("replay and import enforce mode separation, bounded input and unknown-field stripping", () =>
  withService(async (service) => {
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as any;
    const fixture = createSyntheticProtocolEvidence();
    assert.throws(() => parseProtocolEvidence({ ...fixture, mode: "private" }));
    await assert.rejects(
      service.call("replay", {
        caseId: created.id,
        fixture: "protocols-v1",
        bundle: fixture,
      }),
      /exactly one/i,
    );
    await assert.rejects(
      service.call("expand", {
        caseId: created.id,
        address: DEMO_ROOT,
        chainId: 1,
        maxPages: 100,
      }),
      AgentOperationError,
    );
    await assert.rejects(
      service.call("export", { caseId: "../../outside" }),
      AgentOperationError,
    );
    const restored = (await service.call("import", {
      investigation: { ...created, secret: "discard" },
    })) as any;
    assert.equal(restored.secret, undefined);
    const exported = (await service.call("export", {
      caseId: created.id,
    })) as any;
    assert.equal(exported.transfers.length, 16);
  }));
test("agent errors are coded and missing live access is never empty success", () =>
  withService(async (service) => {
    await assert.rejects(
      service.call("create", { root: DEMO_ROOT, mode: "live" }),
      (e: unknown) =>
        e instanceof AgentOperationError &&
        e.code === "KEY_REQUIRED" &&
        !e.retryable,
    );
    await assert.rejects(
      service.call("inspect", { caseId: "missing" }),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "CASE_NOT_FOUND",
    );
    await assert.rejects(
      service.call("unknown", {}),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "UNKNOWN_OPERATION",
    );
  }));

test("agent imports cannot relabel private transfers as demo or change case root", () =>
  withService(async (service) => {
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as any;
    assert.throws(
      () =>
        parseInvestigation({
          ...created,
          transfers: created.transfers.map((t: any) => ({
            ...t,
            synthetic: false,
          })),
        }),
      /synthetic/,
    );
    await assert.rejects(
      service.call("import", {
        investigation: {
          ...created,
          root: "0x9999999999999999999999999999999999999999",
        },
      }),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "CASE_IDENTITY_CONFLICT",
    );
    const unchanged = (await service.call("export", {
      caseId: created.id,
    })) as any;
    assert.equal(unchanged.root, DEMO_ROOT);
  }));

test("private replay works without a live key and never accepts the synthetic fixture", () =>
  withService(async (service) => {
    const empty = createInvestigation(
      DEMO_ROOT,
      "live",
      "Empty private replay test",
    );
    await service.call("import", { investigation: empty });
    const bundle = {
      version: 1,
      mode: "private",
      internal: { version: 1, mode: "private", traces: [], coverage: [] },
    };
    const result = (await service.call("replay", {
      caseId: empty.id,
      bundle,
    })) as any;
    assert.equal(result.mode, "private");
    assert.equal(result.analysis.internal.transfers.length, 0);
    await assert.rejects(
      service.call("replay", { caseId: empty.id, fixture: "protocols-v1" }),
      /private/,
    );
    const exported = (await service.call("export", {
      caseId: empty.id,
    })) as any;
    assert.equal(exported.protocolEvidence.mode, "private");
    assert.equal(exported.transfers.length, 0);
  }));
