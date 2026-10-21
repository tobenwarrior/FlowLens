import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { nodeKey, normalizeAddress, parseLabel } from "../src/domain/engine.ts";
import type { Address, Label, WalletNode } from "../src/domain/types.ts";
import { readBoundedJsonFile, withFileLock } from "./store.ts";

/**
 * Attribution that outlives a single investigation.
 *
 * The point of this store is that naming a wallet once makes every later trace start
 * better informed. It holds the user's own attributions and the ones an agent proposed
 * over MCP — never a third party's label set, which carries its own licensing.
 *
 * Provenance travels with every entry: `kind` separates a person's claim from a model's,
 * and the engine refuses an AI label that tries to assert verified ownership.
 */
export interface StoredLabel {
  chainId: number;
  address: Address;
  label: Label;
  updatedAt: string;
}

export interface LabelSearch {
  /** Case-insensitive substring over label text. */
  query?: string;
  chainId?: number;
  address?: string;
  kind?: Label["kind"];
  limit?: number;
}

const MAX_ENTRIES = 50_000;

function entryKey(chainId: number, address: string): string {
  return nodeKey(chainId, address);
}

function parseEntry(input: unknown): StoredLabel {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Label entry must be an object");
  const value = input as Record<string, unknown>;
  const chainId = value.chainId;
  if (!Number.isSafeInteger(chainId) || (chainId as number) < 1)
    throw new Error("Label entry requires a positive integer chain ID");
  const address = normalizeAddress(value.address as string);
  const label = parseLabel(value.label);
  const updatedAt =
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt))
      ? value.updatedAt
      : new Date().toISOString();
  return { chainId: chainId as number, address, label, updatedAt };
}

export class LabelStore {
  path: string;
  constructor(path: string) {
    this.path = path;
  }

  /** Missing file means "nothing named yet", not an error. */
  async read(): Promise<Map<string, StoredLabel>> {
    const raw = await readBoundedJsonFile(this.path, "Label store").catch(
      (error: unknown) => {
        const code = (error as { code?: string } | null)?.code;
        if (code === "ENOENT") return null;
        throw error;
      },
    );
    const entries = new Map<string, StoredLabel>();
    if (!raw) return entries;
    const list = (raw as { labels?: unknown }).labels;
    if (!Array.isArray(list)) return entries;
    for (const item of list.slice(0, MAX_ENTRIES)) {
      // One malformed entry must not cost the user every other label they have saved.
      try {
        const entry = parseEntry(item);
        entries.set(entryKey(entry.chainId, entry.address), entry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  private async write(entries: Map<string, StoredLabel>): Promise<void> {
    const payload = JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      labels: [...entries.values()],
    });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** Insert or replace one attribution. Last write wins for a given chain and address. */
  async put(input: {
    chainId: number;
    address: string;
    label: unknown;
  }): Promise<StoredLabel> {
    const entry = parseEntry({
      chainId: input.chainId,
      address: input.address,
      label: input.label,
      updatedAt: new Date().toISOString(),
    });
    return withFileLock(this.path, async () => {
      const entries = await this.read();
      if (
        entries.size >= MAX_ENTRIES &&
        !entries.has(entryKey(entry.chainId, entry.address))
      )
        throw new Error(
          `Label store holds its maximum of ${MAX_ENTRIES} entries`,
        );
      entries.set(entryKey(entry.chainId, entry.address), entry);
      await this.write(entries);
      return entry;
    });
  }

  async remove(chainId: number, address: string): Promise<boolean> {
    return withFileLock(this.path, async () => {
      const entries = await this.read();
      const removed = entries.delete(entryKey(chainId, address));
      if (removed) await this.write(entries);
      return removed;
    });
  }

  async search(query: LabelSearch = {}): Promise<StoredLabel[]> {
    const entries = [...(await this.read()).values()];
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const text = query.query?.trim().toLowerCase();
    const address = query.address ? normalizeAddress(query.address) : null;
    return entries
      .filter((entry) => {
        if (query.chainId !== undefined && entry.chainId !== query.chainId)
          return false;
        if (address && entry.address !== address) return false;
        if (query.kind && entry.label.kind !== query.kind) return false;
        if (text && !entry.label.text.toLowerCase().includes(text))
          return false;
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /**
   * Apply stored attributions to nodes that carry none.
   *
   * A label already on the node wins: whatever the current investigation recorded is
   * closer to the evidence in hand than a remembered guess.
   */
  async resolve(nodes: WalletNode[]): Promise<WalletNode[]> {
    const entries = await this.read();
    if (!entries.size) return nodes;
    return nodes.map((node) => {
      if (node.label) return node;
      const entry = entries.get(entryKey(node.chainId, node.address));
      return entry ? { ...node, label: entry.label } : node;
    });
  }
}
