import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentService } from "../server/agent.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";
import type { Investigation } from "../src/domain/types.ts";

const NORTHSTAR = `0x${"2".repeat(40)}`;

function aiLabel(text: string) {
  return {
    text,
    source: "Agent hypothesis via MCP",
    kind: "ai" as const,
    confidence: "unverified" as const,
    retrievedAt: "2026-10-21T12:00:00.000Z",
    claimType: "hypothesis" as const,
    observedAt: "2026-10-21T12:00:00.000Z",
  };
}

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "flowlens-memory-"));
  const service = createAgentService({
    dataDir: join(directory, "cases"),
    labelFile: join(directory, "labels.json"),
  });
  return {
    service,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/**
 * The synthetic fixture labels every node it supplies, and a label already on the case
 * always wins, so these tests clear that label first to exercise the unlabelled case —
 * which is what a live trace actually looks like.
 */
async function demoCase(service: ReturnType<typeof createAgentService>) {
  const created = (await service.call("create", {
    root: DEMO_ROOT,
    mode: "demo",
  })) as Investigation;
  await service.call("expand", {
    caseId: created.id,
    address: DEMO_ROOT,
    chainId: 1,
    maxPages: 1,
  });
  await service.call("annotate", {
    caseId: created.id,
    chainId: 1,
    address: NORTHSTAR,
    label: null,
  });
  return created.id;
}

function northstar(value: Investigation) {
  return value.nodes.find(
    (entry) => entry.address.toLowerCase() === NORTHSTAR && entry.chainId === 1,
  );
}

test("a remembered label is applied to a wallet the investigation has not named", async () => {
  const { service, cleanup } = await workspace();
  try {
    const caseId = await demoCase(service);
    await service.call("label_put", {
      chainId: 1,
      address: NORTHSTAR,
      label: aiLabel("Northstar Exchange · hot wallet"),
    });

    const expanded = (await service.call("expand", {
      caseId,
      address: DEMO_ROOT,
      chainId: 8453,
      maxPages: 1,
    })) as Investigation;

    const node = northstar(expanded);
    assert.ok(node, "the counterparty should still be a loaded node");
    assert.equal(node.label?.text, "Northstar Exchange · hot wallet");
    assert.equal(node.label?.kind, "ai");
    assert.equal(node.label?.confidence, "unverified");
  } finally {
    await cleanup();
  }
});

test("a label the investigation already carries is never overwritten by a remembered one", async () => {
  const { service, cleanup } = await workspace();
  try {
    await service.call("label_put", {
      chainId: 1,
      address: NORTHSTAR,
      label: aiLabel("Remembered guess"),
    });
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as Investigation;
    const expanded = (await service.call("expand", {
      caseId: created.id,
      address: DEMO_ROOT,
      chainId: 1,
      maxPages: 1,
    })) as Investigation;
    // The fixture named this wallet; the evidence in hand outranks a remembered guess.
    assert.equal(northstar(expanded)?.label?.kind, "demo");
  } finally {
    await cleanup();
  }
});

test("labelling a wallet inside a case also remembers it outside the case", async () => {
  const { service, cleanup } = await workspace();
  try {
    const created = (await service.call("create", {
      root: DEMO_ROOT,
      mode: "demo",
    })) as Investigation;
    await service.call("expand", {
      caseId: created.id,
      address: DEMO_ROOT,
      chainId: 1,
      maxPages: 1,
    });
    await service.call("annotate", {
      caseId: created.id,
      chainId: 1,
      address: NORTHSTAR,
      label: {
        text: "Named by hand",
        source: "Analyst note",
        kind: "user",
        confidence: "reported",
        retrievedAt: "2026-10-21T12:00:00.000Z",
        claimType: "hypothesis",
        observedAt: "2026-10-21T12:00:00.000Z",
      },
    });

    const found = (await service.call("label_search", {
      query: "named by hand",
    })) as { labels: { address: string; label: { kind: string } }[] };
    assert.equal(found.labels.length, 1);
    assert.equal(found.labels[0].label.kind, "user");
  } finally {
    await cleanup();
  }
});

test("the store refuses an AI label that claims verified ownership", async () => {
  const { service, cleanup } = await workspace();
  try {
    await assert.rejects(
      service.call("label_put", {
        chainId: 1,
        address: NORTHSTAR,
        label: { ...aiLabel("Certainly Binance"), confidence: "verified" },
      }),
    );
  } finally {
    await cleanup();
  }
});

test("forgetting a label stops it reaching later investigations", async () => {
  const { service, cleanup } = await workspace();
  try {
    const caseId = await demoCase(service);
    await service.call("label_put", {
      chainId: 1,
      address: NORTHSTAR,
      label: aiLabel("Temporary guess"),
    });
    const removed = (await service.call("label_forget", {
      chainId: 1,
      address: NORTHSTAR,
    })) as { removed: boolean };
    assert.equal(removed.removed, true);

    const expanded = (await service.call("expand", {
      caseId,
      address: DEMO_ROOT,
      chainId: 8453,
      maxPages: 1,
    })) as Investigation;
    assert.equal(northstar(expanded)?.label, undefined);
  } finally {
    await cleanup();
  }
});
