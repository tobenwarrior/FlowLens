import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInvestigation, transferId } from "../src/domain/engine.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";
import type { Transfer } from "../src/domain/types.ts";
import {
  readSnapshot,
  writeSnapshot,
  readBoundedJsonFile,
} from "../server/store.ts";

test("every accepted near-limit investigation can be written and reopened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-store-boundary-"));
  try {
    const value = createInvestigation(DEMO_ROOT, "demo");
    value.transfers = Array.from({ length: 7000 }, (_, i) => {
      const t: Transfer = {
        id: "",
        chainId: 1,
        hash: `0x${i.toString(16).padStart(64, "0")}`,
        kind: "native",
        eventIndex: "0",
        from: DEMO_ROOT,
        to: "0x2222222222222222222222222222222222222222",
        asset: { chainId: 1, symbol: "ETH", decimals: 18, contract: null },
        rawAmount: "1000000000000000000",
        timestamp: "2026-10-20T12:00:00.000Z",
        blockNumber: i,
        status: "success",
        source: "Synthetic storage boundary contract",
        retrievedAt: "2026-10-21T12:00:00.000Z",
        synthetic: true,
      };
      t.id = transferId(t);
      return t;
    });
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 5_000_000);
    assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) > 5_000_000);
    const path = join(dir, "case.json");
    await writeSnapshot(path, value);
    assert.ok((await stat(path)).size <= 5_000_000);
    assert.deepEqual(await readSnapshot(path), value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("oversized on-disk imports are refused before JSON parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-store-import-"));
  try {
    const path = join(dir, "case.json");
    await writeFile(path, " ".repeat(5_000_001));
    await assert.rejects(readSnapshot(path), /5 MB/);
    await assert.rejects(readSnapshot(dir), /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded JSON reader accepts generic JSON and refuses non-regular files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-json-file-"));
  try {
    const path = join(dir, "input.json");
    await writeFile(path, JSON.stringify({ version: 1, private: true }));
    assert.deepEqual(await readBoundedJsonFile(path), {
      version: 1,
      private: true,
    });
    await assert.rejects(
      readBoundedJsonFile(dir),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_INPUT_FILE",
    );
    if (process.platform !== "win32")
      await assert.rejects(readBoundedJsonFile("/dev/null"), /regular file/);
    await writeFile(path, " ".repeat(5000001));
    await assert.rejects(
      readBoundedJsonFile(path, "Protocol evidence"),
      /5 MB/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
