import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeAddress } from "../src/domain/engine.ts";

const MAX_ENTRIES = 10_000;
const MAX_NOTE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_MATCHES = 100;

/** Offline locator only. Paths come from the operator and note text never leaves this function. */
export async function searchVaultLogs(
  value: string,
  directory = process.env.FLOWLENS_VAULT_LOG_DIR,
) {
  const address = normalizeAddress(value);
  const matches: { path: string; line: number }[] = [];
  const limits = new Set<string>();
  let notesSearched = 0;
  function result(
    status: "unconfigured" | "unavailable" | "complete" | "partial",
  ) {
    return {
      address,
      status,
      notesSearched,
      matches,
      limits: [...limits].sort(),
    };
  }
  if (!directory) return result("unconfigured");
  let root: string;
  try {
    if (!isAbsolute(directory)) return result("unavailable");
    const configured = resolve(directory);
    if (!(await lstat(configured)).isDirectory()) return result("unavailable");
    root = await realpath(configured);
  } catch {
    return result("unavailable");
  }

  // Reject a prefix of a longer hex identifier such as a transaction hash.
  const exact = new RegExp(`(?<![a-z0-9])${address}(?![a-z0-9])`, "i");
  let entries = 0;
  let remainingBytes = MAX_TOTAL_BYTES;
  function atScanLimit() {
    if (entries >= MAX_ENTRIES) limits.add("entry-limit");
    if (remainingBytes <= 0) limits.add("total-byte-limit");
    return entries >= MAX_ENTRIES || remainingBytes <= 0;
  }

  async function readNote(path: string) {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      const current = await lstat(path);
      if (
        !info.isFile() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        (await realpath(path)) !== path
      ) {
        limits.add("unreadable-entry");
        return;
      }
      const budget = Math.min(MAX_NOTE_BYTES, remainingBytes);
      if (info.size > budget) {
        limits.add(
          info.size > MAX_NOTE_BYTES ? "note-byte-limit" : "total-byte-limit",
        );
        return;
      }
      const buffer = Buffer.alloc(Math.min(info.size + 1, budget));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.length - offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        remainingBytes -= bytesRead;
      }
      if (
        offset !== info.size ||
        (await file.stat()).mtimeMs !== info.mtimeMs
      ) {
        limits.add("unreadable-entry");
        return;
      }
      const lines = buffer.subarray(0, offset).toString("utf8").split(/\r?\n/);
      const notePath = relative(root, path).split(sep).join("/");
      notesSearched++;
      for (const [index, line] of lines.entries()) {
        if (!exact.test(line)) continue;
        if (matches.length === MAX_MATCHES) {
          limits.add("match-limit");
          break;
        }
        matches.push({ path: notePath, line: index + 1 });
      }
    } finally {
      await file.close();
    }
  }

  async function scan(path: string, depth: number): Promise<void> {
    const before = await lstat(path);
    if (!before.isDirectory() || (await realpath(path)) !== path) {
      limits.add("unreadable-entry");
      return;
    }
    const dir = await opendir(path);
    const children = [];
    try {
      const current = await lstat(path);
      if (
        !current.isDirectory() ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        (await realpath(path)) !== path
      ) {
        limits.add("unreadable-entry");
        return;
      }
      for (let entry = await dir.read(); entry; entry = await dir.read()) {
        if (atScanLimit()) break;
        entries++;
        if (!entry.name.startsWith(".")) children.push(entry);
      }
    } finally {
      await dir.close();
    }
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      if (remainingBytes <= 0) {
        limits.add("total-byte-limit");
        break;
      }
      const next = join(path, child.name);
      try {
        if (child.isDirectory()) {
          if (depth >= MAX_DEPTH) limits.add("depth-limit");
          else if (!atScanLimit()) await scan(next, depth + 1);
        } else if (child.isFile() && /\.md$/i.test(child.name)) {
          await readNote(next);
        }
      } catch {
        limits.add("unreadable-entry");
      }
    }
  }

  try {
    await scan(root, 0);
  } catch {
    return result("unavailable");
  }
  return result(limits.size ? "partial" : "complete");
}
