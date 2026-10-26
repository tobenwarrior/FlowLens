import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseInvestigation } from "../src/domain/engine.ts";
import type { Investigation } from "../src/domain/types.ts";

export function validCaseId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
export class CaseBusyError extends Error {
  code = "CASE_BUSY";
  constructor() {
    super(
      "Investigation is busy or has an existing lock file. No changes were made.",
    );
  }
}
export function nextRevision(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}
/** Shared by API and CLI so atomic renames cannot overwrite another writer's page. */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(`${path}.lock`, "wx", 0o600).catch((error) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    )
      throw new CaseBusyError();
    throw error;
  });
  try {
    return await operation();
  } finally {
    await file.close();
    await unlink(`${path}.lock`);
  }
}
export class JsonFileError extends Error {
  code: "INVALID_INPUT_FILE" | "INPUT_TOO_LARGE" | "INVALID_JSON";
  retryable = false;
  constructor(code: JsonFileError["code"], message: string) {
    super(message);
    this.name = "JsonFileError";
    this.code = code;
  }
}
/** Nonblocking open also lets the handle check reject FIFOs/devices before any read. */
export async function readBoundedJsonFile(
  path: string,
  label = "Investigation",
): Promise<unknown> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile())
      throw new JsonFileError(
        "INVALID_INPUT_FILE",
        `${label} must be a regular file`,
      );
    if (info.size > 5_000_000)
      throw new JsonFileError(
        "INPUT_TOO_LARGE",
        `${label} exceeds the 5 MB import limit`,
      );
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65_536, 5_000_001 - bytes));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > 5_000_000)
        throw new JsonFileError(
          "INPUT_TOO_LARGE",
          `${label} exceeds the 5 MB import limit`,
        );
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    } catch {
      throw new JsonFileError(
        "INVALID_JSON",
        `${label} must contain valid JSON`,
      );
    }
  } finally {
    await file.close();
  }
}
export async function readSnapshot(path: string): Promise<Investigation> {
  return parseInvestigation(await readBoundedJsonFile(path));
}
export async function writeSnapshot(
  path: string,
  investigation: Investigation,
): Promise<void> {
  const clean = parseInvestigation(investigation);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(clean), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
export class CaseStore {
  directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  path(id: string): string {
    if (!validCaseId(id)) throw new Error("Invalid investigation ID");
    return join(this.directory, `${id}.json`);
  }
  read(id: string): Promise<Investigation> {
    return readSnapshot(this.path(id));
  }
  save(value: Investigation): Promise<void> {
    return writeSnapshot(this.path(value.id), value);
  }
  async list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory))
      .filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name))
      .slice(0, 1000);
    // Read one bounded snapshot at a time; a thousand 5 MB cases must not coexist in memory.
    const values = [];
    for (const name of names) {
      const v = await readSnapshot(join(this.directory, name)).catch(
        () => null,
      );
      if (!v) continue;
      values.push({
        id: v.id,
        title: v.title,
        root: v.root,
        mode: v.mode,
        updatedAt: v.updatedAt,
        transferCount: v.transfers.length,
      });
    }
    return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
