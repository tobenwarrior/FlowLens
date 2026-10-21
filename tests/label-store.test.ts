import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabelStore } from "../server/label-store.ts";
import { parseLabel } from "../src/domain/engine.ts";
import type { Address, WalletNode } from "../src/domain/types.ts";

const ALICE = `0x${"2".repeat(40)}` as Address;
const BOB = `0x${"3".repeat(40)}` as Address;

function label(text: string, kind: "ai" | "user" = "ai") {
  return {
    text,
    source: kind === "ai" ? "Agent hypothesis via MCP" : "Analyst note",
    kind,
    confidence: "unverified" as const,
    retrievedAt: "2026-10-21T12:00:00.000Z",
    claimType: "hypothesis" as const,
    observedAt: "2026-10-21T12:00:00.000Z",
  };
}

async function store(): Promise<{
  value: LabelStore;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "flowlens-labels-"));
  return {
    value: new LabelStore(join(directory, "labels.json")),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("an unwritten store reads as empty rather than failing", async () => {
  const { value, cleanup } = await store();
  try {
    assert.equal((await value.read()).size, 0);
    assert.deepEqual(await value.search(), []);
  } finally {
    await cleanup();
  }
});

test("a label survives the store and is found again by text", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({
      chainId: 1,
      address: ALICE,
      label: label("Northstar Exchange"),
    });
    const reopened = new LabelStore(value.path);
    const found = await reopened.search({ query: "northstar" });
    assert.equal(found.length, 1);
    assert.equal(found[0].address, ALICE);
    assert.equal(found[0].label.kind, "ai");
  } finally {
    await cleanup();
  }
});

test("the same wallet on two chains keeps two separate attributions", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({
      chainId: 1,
      address: ALICE,
      label: label("Mainnet desk"),
    });
    await value.put({
      chainId: 8453,
      address: ALICE,
      label: label("Base desk"),
    });
    assert.equal((await value.read()).size, 2);
  } finally {
    await cleanup();
  }
});

test("writing the same wallet twice replaces rather than duplicates", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({
      chainId: 1,
      address: ALICE,
      label: label("First guess"),
    });
    await value.put({
      chainId: 1,
      address: ALICE,
      label: label("Better guess"),
    });
    const entries = await value.search({ address: ALICE });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].label.text, "Better guess");
  } finally {
    await cleanup();
  }
});

test("stored labels fill in unlabelled nodes but never overwrite the case's own", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({ chainId: 1, address: ALICE, label: label("Remembered") });
    await value.put({
      chainId: 1,
      address: BOB,
      label: label("Also remembered"),
    });
    const nodes: WalletNode[] = [
      { chainId: 1, address: ALICE },
      {
        chainId: 1,
        address: BOB,
        label: parseLabel(label("Already named", "user")),
      },
    ];
    const resolved = await value.resolve(nodes);
    assert.equal(resolved[0].label?.text, "Remembered");
    assert.equal(resolved[1].label?.text, "Already named");
    assert.equal(resolved[1].label?.kind, "user");
  } finally {
    await cleanup();
  }
});

test("an AI label cannot assert verified ownership", async () => {
  const { value, cleanup } = await store();
  try {
    await assert.rejects(
      value.put({
        chainId: 1,
        address: ALICE,
        label: { ...label("Definitely Binance"), confidence: "verified" },
      }),
      /hypotheses/,
    );
    await assert.rejects(
      value.put({
        chainId: 1,
        address: ALICE,
        label: {
          ...label("Definitely Binance"),
          claimType: "verified-evidence",
          evidenceNote: "trust me",
        },
      }),
      /hypotheses/,
    );
  } finally {
    await cleanup();
  }
});

test("a corrupted entry does not cost the user their other labels", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({ chainId: 1, address: ALICE, label: label("Good entry") });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      value.path,
      JSON.stringify({
        version: 1,
        labels: [
          { chainId: "not-a-chain", address: BOB, label: label("Broken") },
          {
            chainId: 1,
            address: ALICE,
            label: label("Good entry"),
            updatedAt: "2026-10-21T12:00:00.000Z",
          },
        ],
      }),
    );
    const entries = await value.read();
    assert.equal(entries.size, 1);
    assert.equal([...entries.values()][0].label.text, "Good entry");
  } finally {
    await cleanup();
  }
});

test("removing a label reports whether anything was there", async () => {
  const { value, cleanup } = await store();
  try {
    await value.put({ chainId: 1, address: ALICE, label: label("Temporary") });
    assert.equal(await value.remove(1, ALICE), true);
    assert.equal(await value.remove(1, ALICE), false);
  } finally {
    await cleanup();
  }
});
