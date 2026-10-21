import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDemoInvestigation,
  demoProvider,
  DEMO_ROOT,
} from "../src/domain/demo.ts";
import {
  aggregateFlows,
  nodeKey,
  parseInvestigation,
} from "../src/domain/engine.ts";
import {
  annotateWallet,
  setVisibility,
  refreshWorkspace,
} from "../src/domain/workspace.ts";
import { createAgentService, AgentOperationError } from "../server/agent.ts";
import { createApiServer } from "../server/api.ts";
import type { Investigation, Label } from "../src/domain/types.ts";

const label = {
  text: "Example local hypothesis",
  source: "Investigator observation",
  sourceUrl: "https://example.com/evidence",
  kind: "user",
  confidence: "unverified",
  retrievedAt: "2026-10-21T00:00:00Z",
  observedAt: "2026-10-20T00:00:00Z",
  claimType: "hypothesis",
} as Label;

test("visibility preserves evidence and exact totals while toggling loaded targets", async () => {
  const original = await createDemoInvestigation();
  const n = original.nodes.find((v) => v.address !== original.root)!;
  const target = nodeKey(n.chainId, n.address);
  const id = original.transfers[0].id;
  const hidden = setVisibility(original, {
    nodeKeys: [target],
    transferIds: [id],
    visible: false,
  });
  assert.ok(hidden.hidden.includes(target));
  assert.deepEqual(hidden.hiddenTransfers, [id]);
  assert.equal(original.hidden.includes(target), false);
  assert.equal(original.hiddenTransfers, undefined);
  assert.deepEqual(hidden.transfers, original.transfers);
  assert.deepEqual(
    aggregateFlows(hidden.transfers, hidden.root),
    aggregateFlows(original.transfers, original.root),
  );
  const restored = setVisibility(hidden, {
    nodeKeys: [target],
    transferIds: [id],
    visible: true,
  });
  assert.deepEqual(restored.hidden, []);
  assert.deepEqual(restored.hiddenTransfers, []);
  assert.deepEqual(
    setVisibility(hidden, { transferIds: [id], visible: false })
      .hiddenTransfers,
    [id],
  );
  assert.deepEqual(parseInvestigation(hidden).hiddenTransfers, [id]);
});

test("visibility rejects root hiding, unknown identities and empty scopes atomically", async () => {
  const c = await createDemoInvestigation();
  for (const request of [
    { nodeKeys: [nodeKey(1, c.root)], visible: false },
    {
      nodeKeys: [nodeKey(1, "0x9999999999999999999999999999999999999999")],
      visible: false,
    },
    { transferIds: ["1:missing"], visible: false },
    { nodeKeys: [], transferIds: [], visible: true },
    { transferIds: [c.transfers[0].id], visible: "false" },
  ])
    assert.throws(() => setVisibility(c, request));
  assert.equal(c.hidden.length, 0);
  assert.equal(c.hiddenTransfers, undefined);
  assert.throws(
    () => parseInvestigation({ ...c, hiddenTransfers: ["unknown"] }),
    /hidden transfer|evidence/i,
  );
  assert.throws(
    () =>
      parseInvestigation({
        ...c,
        hiddenTransfers: [c.transfers[0].id, c.transfers[0].id],
      }),
    /duplicate/i,
  );
});

test("annotation is chain-address scoped, editable, removable and preserves explicit claim provenance", async () => {
  const c = await createDemoInvestigation();
  const address = c.nodes.find((n) => n.address !== c.root)!.address;
  const originalOther = c.nodes.find(
    (n) => n.address === address && n.chainId !== 1,
  );
  const next = annotateWallet(c, {
    chainId: 1,
    address: address.toUpperCase().replace("0X", "0x"),
    label,
  });
  const saved = next.nodes.find(
    (n) => n.address === address && n.chainId === 1,
  )!.label!;
  assert.equal(saved.claimType, "hypothesis");
  assert.equal(saved.observedAt, "2026-10-20T00:00:00.000Z");
  assert.equal(saved.retrievedAt, "2026-10-21T00:00:00.000Z");
  assert.deepEqual(
    next.nodes.find((n) => n.address === address && n.chainId !== 1),
    originalOther,
  );
  const edited = annotateWallet(next, {
    chainId: 1,
    address,
    label: { ...label, text: "Revised local claim" },
  });
  assert.equal(
    edited.nodes.find((n) => n.address === address && n.chainId === 1)!.label!
      .text,
    "Revised local claim",
  );
  const removed = annotateWallet(edited, { chainId: 1, address, label: null });
  assert.equal(
    removed.nodes.find((n) => n.address === address && n.chainId === 1)!.label,
    undefined,
  );
  assert.deepEqual(next.transfers, c.transfers);
  assert.notEqual(
    c.nodes.find((n) => n.address === address && n.chainId === 1)!.label?.text,
    label.text,
  );
});

test("new annotations require explicit claim provenance and cannot smuggle credentials in URLs", async () => {
  const c = await createDemoInvestigation();
  const scope = { chainId: 1, address: c.root };
  for (const bad of [
    { ...label, claimType: undefined },
    { ...label, observedAt: undefined },
    { ...label, observedAt: "2026-02-31T00:00:00Z" },
    { ...label, claimType: "verified-evidence" },
    { ...label, confidence: "verified" },
    { ...label, sourceUrl: "https://dummy:example@example.test" },
    { ...label, sourceUrl: "https://example.test/evidence?api_key=dummy" },
    { ...label, sourceUrl: "https://example.test/evidence#token=dummy" },
    { ...label, sourceUrl: "javascript:alert(1)" },
    { ...label, text: "   " },
    { ...label, source: "   " },
  ])
    assert.throws(() => annotateWallet(c, { ...scope, label: bad }));
  assert.throws(
    () =>
      annotateWallet(c, {
        ...scope,
        address: "0x9999999999999999999999999999999999999999",
        label,
      }),
    /node|wallet|scope/i,
  );
  const verified = annotateWallet(c, {
    ...scope,
    label: {
      ...label,
      claimType: "verified-evidence",
      evidenceNote: "Supplied evidence; independently assess the claim.",
    },
  });
  assert.equal(
    verified.nodes.find((n) => n.address === c.root && n.chainId === 1)!.label!
      .claimType,
    "verified-evidence",
  );
  const live = {
    ...c,
    mode: "live" as const,
    nodes: c.nodes.map(({ label, ...node }) => node),
    transfers: c.transfers.map(({ synthetic, ...t }) => t),
  };
  assert.throws(
    () =>
      annotateWallet(live, {
        ...scope,
        label: { ...label, confidence: "synthetic" },
      }),
    /synthetic/i,
  );
});

test("legacy snapshots remain loadable and unknown annotation fields are stripped", async () => {
  const c = await createDemoInvestigation();
  assert.equal(parseInvestigation(c).hiddenTransfers, undefined);
  const n = c.nodes.find((v) => v.label)!;
  const annotated = annotateWallet(c, {
    chainId: n.chainId,
    address: n.address,
    label: { ...label, unknownSecret: "discard" },
  });
  assert.equal(
    (
      annotated.nodes.find(
        (v) => v.address === n.address && v.chainId === n.chainId,
      )!.label as any
    ).unknownSecret,
    undefined,
  );
});

test("durable agent annotation and visibility enforce revisions and preserve non-target state across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-"));
  const options = {
    dataDir: dir,
    providers: { demo: demoProvider, live: new Map() },
  };
  try {
    const service = createAgentService(options);
    const c = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as Investigation;
    const annotated = (await service.call("annotate", {
      caseId: c.id,
      chainId: 1,
      address: c.root,
      label,
      expectedRevision: c.updatedAt,
    })) as Investigation;
    assert.notEqual(annotated.updatedAt, c.updatedAt);
    await assert.rejects(
      service.call("visibility", {
        caseId: c.id,
        transferIds: [c.transfers[0].id],
        visible: false,
        expectedRevision: c.updatedAt,
      }),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "CASE_CONFLICT",
    );
    const hidden = (await service.call("visibility", {
      caseId: c.id,
      transferIds: [c.transfers[0].id],
      visible: false,
      expectedRevision: annotated.updatedAt,
    })) as Investigation;
    const resumed = (await createAgentService(options).call("export", {
      caseId: c.id,
    })) as Investigation;
    assert.deepEqual(resumed.hiddenTransfers, [c.transfers[0].id]);
    assert.deepEqual(resumed.transfers, c.transfers);
    assert.equal(
      resumed.nodes.find((n) => n.address === c.root && n.chainId === 1)!.label!
        .text,
      label.text,
    );
    assert.equal(resumed.updatedAt, hidden.updatedAt);
    await assert.rejects(
      service.call("annotate", {
        caseId: c.id,
        chainId: 999,
        address: c.root,
        label,
      }),
    );
    assert.deepEqual(await service.call("export", { caseId: c.id }), resumed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local HTTP workspace mutations share the agent boundary and report conflicts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-api-"));
  const server = createApiServer({
    dataDir: dir,
    providers: { demo: demoProvider, live: new Map() },
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/investigations`;
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const c = (await (
      await post(base, { root: DEMO_ROOT, mode: "demo" })
    ).json()) as Investigation;
    const response = await post(`${base}/${c.id}/annotate`, {
      chainId: 1,
      address: c.root,
      label,
      expectedRevision: c.updatedAt,
    });
    assert.equal(response.status, 200);
    const annotated = (await response.json()) as Investigation;
    const visibility = await post(`${base}/${c.id}/visibility`, {
      transferIds: [c.transfers[0].id],
      visible: false,
      expectedRevision: annotated.updatedAt,
    });
    assert.equal(visibility.status, 200);
    const conflict = await post(`${base}/${c.id}/annotate`, {
      chainId: 1,
      address: c.root,
      label: null,
      expectedRevision: c.updatedAt,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "CASE_CONFLICT");
    const exported = await (await fetch(`${base}/${c.id}`)).json();
    assert.deepEqual(exported.hiddenTransfers, [c.transfers[0].id]);
    assert.equal(
      exported.nodes.find((n: any) => n.address === c.root && n.chainId === 1)
        .label.text,
      label.text,
    );
    const graphResponse = await fetch(`${base}/${c.id}/graph`);
    const graph = await graphResponse.json();
    assert.equal(graphResponse.status, 200);
    assert.ok(graph.transfers.some((t: any) => t.id === c.transfers[0].id));
    assert.ok(
      !graph.edges.some((edge: any) =>
        edge.transfers.some((t: any) => t.id === c.transfers[0].id),
      ),
    );
    assert.deepEqual(graph.hidden.transferIds, [c.transfers[0].id]);
    const walletResponse = await fetch(
      `${base}/${c.id}/wallet?address=${c.root}&chainId=1&pageSize=3`,
    );
    assert.equal(walletResponse.status, 200);
    const wallet = await walletResponse.json();
    assert.equal(wallet.scope, "loaded-evidence");
    assert.equal(wallet.transfers.length, 3);
    assert.equal(wallet.page.nextOffset, 3);
    const missingRevision = await fetch(
      `${base}/${c.id}/wallet?address=${c.root}&offset=3`,
    );
    assert.equal(missingRevision.status, 400);
    assert.equal((await missingRevision.json()).error.code, "INVALID_CURSOR");
    const nextPage = await fetch(
      `${base}/${c.id}/wallet?address=${c.root}&offset=3&expectedRevision=${encodeURIComponent(wallet.revision)}`,
    );
    assert.equal(nextPage.status, 200);
    const stalePage = await fetch(
      `${base}/${c.id}/wallet?address=${c.root}&offset=3&expectedRevision=${encodeURIComponent(c.updatedAt)}`,
    );
    assert.equal(stalePage.status, 400);
    assert.equal((await stalePage.json()).error.code, "CURSOR_STALE");
    const invalidPage = await fetch(
      `${base}/${c.id}/wallet?address=${c.root}&pageSize=101`,
    );
    assert.equal(invalidPage.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent wallet view exposes selected-address flow totals and stable loaded-evidence pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-workspace-wallet-"));
  try {
    const service = createAgentService({
      dataDir: dir,
      providers: { demo: demoProvider, live: new Map() },
    });
    const c = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as Investigation;
    const first = (await service.call("wallet", {
      caseId: c.id,
      address: c.root,
      chainId: 1,
      pageSize: 2,
    })) as any;
    assert.equal(first.scope, "loaded-evidence");
    assert.equal(first.page.pageSize, 2);
    assert.equal(first.transfers.length, 2);
    assert.ok(first.page.nextOffset !== null);
    await assert.rejects(
      service.call("wallet", {
        caseId: c.id,
        address: c.root,
        pageSize: 2,
        offset: 2,
      }),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "INVALID_CURSOR",
    );
    const second = (await service.call("wallet", {
      caseId: c.id,
      address: c.root,
      chainId: 1,
      pageSize: 2,
      offset: first.page.nextOffset,
      expectedRevision: first.revision,
    })) as any;
    assert.ok(
      !first.transfers.some((r: any) =>
        second.transfers.some((n: any) => r.transfer.id === n.transfer.id),
      ),
    );
    assert.deepEqual(first.flows, second.flows);
    const cp = first.counterparties[0];
    const counterpart = (await service.call("wallet", {
      caseId: c.id,
      address: cp.address,
      chainId: cp.chainId,
    })) as any;
    assert.equal(counterpart.address, cp.address);
    assert.deepEqual(
      counterpart.flows,
      aggregateFlows(
        c.transfers.filter((t) => t.chainId === cp.chainId),
        cp.address,
      ),
    );
    const graphBefore = (await service.call("graph", {
      caseId: c.id,
      chainId: 1,
    })) as any;
    await service.call("visibility", {
      caseId: c.id,
      transferIds: [first.transfers[0].transfer.id],
      visible: false,
    });
    const graphAfter = (await service.call("graph", {
      caseId: c.id,
      chainId: 1,
    })) as any;
    assert.deepEqual(graphAfter.transfers, graphBefore.transfers);
    assert.deepEqual(graphAfter.flows, graphBefore.flows);
    assert.ok(
      !graphAfter.edges.some((edge: any) =>
        edge.transfers.some(
          (t: any) => t.id === first.transfers[0].transfer.id,
        ),
      ),
    );
    assert.ok(
      !graphAfter.visibleTransferIds.includes(first.transfers[0].transfer.id),
    );
    assert.deepEqual(graphAfter.hidden.transferIds, [
      first.transfers[0].transfer.id,
    ]);
    await assert.rejects(
      service.call("wallet", {
        caseId: c.id,
        address: c.root,
        pageSize: 2,
        offset: 2,
        expectedRevision: first.revision,
      }),
      (e: unknown) =>
        e instanceof AgentOperationError && e.code === "CURSOR_STALE",
    );
    const hidden = (await service.call("wallet", {
      caseId: c.id,
      address: c.root,
      chainId: 1,
      pageSize: 2,
    })) as any;
    assert.equal(
      hidden.counts.visibleTransfers,
      first.counts.visibleTransfers - 1,
    );
    assert.deepEqual(hidden.flows, first.flows);
    await assert.rejects(
      service.call("wallet", { caseId: c.id, address: c.root, pageSize: 101 }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live snapshot import rejects synthetic or demo attribution independently of transfer mode", async () => {
  const demo = await createDemoInvestigation();
  const live = {
    ...demo,
    mode: "live" as const,
    transfers: demo.transfers.map(({ synthetic, ...t }) => t),
  };
  assert.throws(() => parseInvestigation(live), /synthetic|demo/i);
  const ordinary = {
    ...live,
    nodes: live.nodes.map(({ label, ...node }) => ({
      ...node,
      label: {
        text: "Private hypothesis",
        source: "Local review",
        kind: "user" as const,
        confidence: "unverified" as const,
        retrievedAt: "2026-10-21T00:00:00Z",
      },
    })),
  };
  assert.equal(parseInvestigation(ordinary).mode, "live");
  assert.throws(
    () =>
      annotateWallet(ordinary, {
        chainId: 1,
        address: ordinary.root,
        label: { ...label, kind: "demo" },
      }),
    /synthetic|demo/i,
  );
});

test("refresh adopts authoritative shared evidence, labels and selections while retaining only unsaved notes and pins", async () => {
  const initial = await createDemoInvestigation();
  const counterparty = initial.nodes.find((n) => n.address !== initial.root)!;
  const key = nodeKey(counterparty.chainId, counterparty.address);
  const local = {
    ...initial,
    notes: "Unsaved local investigation note",
    pinned: [key],
    hidden: [key],
    hiddenTransfers: [initial.transfers[0].id],
  };
  const latest = annotateWallet(initial, {
    chainId: counterparty.chainId,
    address: counterparty.address,
    label,
  });
  latest.hidden = [];
  latest.hiddenTransfers = [initial.transfers[1].id];
  latest.notes = "Server note";
  latest.pinned = [];
  latest.title = "Latest authoritative title";
  const merged = refreshWorkspace(local, latest);
  assert.deepEqual(merged, {
    ...latest,
    notes: local.notes,
    pinned: local.pinned,
  });
  assert.equal(merged.updatedAt, latest.updatedAt);
  assert.equal(
    merged.nodes.find((n) => nodeKey(n.chainId, n.address) === key)!.label!
      .text,
    label.text,
  );
  assert.deepEqual(merged.hidden, []);
  assert.deepEqual(merged.hiddenTransfers, [initial.transfers[1].id]);
  assert.deepEqual(local.hidden, [key]);
  assert.equal(latest.notes, "Server note");
  merged.pinned.push(nodeKey(1, initial.root));
  assert.deepEqual(local.pinned, [key]);
  assert.deepEqual(latest.pinned, []);
});

test("refresh refuses identity changes and invalid snapshots instead of mixing cases", async () => {
  const initial = await createDemoInvestigation();
  for (const latest of [
    { ...initial, id: "another-case" },
    { ...initial, root: "0x9999999999999999999999999999999999999999" },
    { ...initial, mode: "live", transfers: [], nodes: [], coverage: [] },
  ])
    assert.throws(
      () => refreshWorkspace(initial, latest as Investigation),
      /identity|different/i,
    );
  assert.throws(
    () =>
      refreshWorkspace({ ...initial, hiddenTransfers: ["missing"] }, initial),
    /hidden transfer|evidence/i,
  );
  assert.throws(
    () =>
      refreshWorkspace(initial, { ...initial, hiddenTransfers: ["missing"] }),
    /hidden transfer|evidence/i,
  );
});
