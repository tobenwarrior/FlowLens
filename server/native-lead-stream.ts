import type { Address } from "../src/domain/types.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_REPLAY_TASKS = 250;

export interface NativeCursor {
  lastBlock: number | null;
  lastHash: `0x${string}` | null;
}

export interface NativeLeadFunding {
  candidate: Address;
  blockNumber: number;
  transactionIndex?: number;
}

export interface NativeLeadReplayTask {
  key: string;
  candidate: Address;
  fundingBlock: number;
  fundingTransactionIndex?: number;
  fromBlock: number;
  targetBlock: number;
  attempts: number;
  createdRevision: number;
}

export interface NativeLeadStreamState {
  version: 1;
  revision: number;
  cursor: NativeCursor;
  replayTasks: readonly NativeLeadReplayTask[];
}

export interface NativeReplayWindow {
  key: string;
  candidate: Address;
  fromBlock: number;
  toBlock: number;
  fundingBlock: number;
  fundingTransactionIndex?: number;
}

export interface NativeLeadScanSnapshot {
  revision: number;
  cursor: NativeCursor;
  replayTasks: readonly NativeLeadReplayTask[];
  replayWindows: readonly NativeReplayWindow[];
}

export interface NativeLeadScanCommit {
  success: boolean;
  cursor?: NativeCursor;
  completedReplayWindows?: readonly {
    key: string;
    toBlock: number;
  }[];
}

export class NativeLeadStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeLeadStreamError";
    this.code = code;
  }
}

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new Error(`Invalid ${label}.`);
  return value.toLowerCase() as Address;
}

function normalizeHash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !HASH.test(value))
    throw new Error(`Invalid ${label}.`);
  return value.toLowerCase() as `0x${string}`;
}

function block(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid ${label}.`);
  return value as number;
}

function normalizeCursor(value: NativeCursor): NativeCursor {
  if (!value || typeof value !== "object")
    throw new Error("Invalid native cursor.");
  const lastBlock =
    value.lastBlock === null ? null : block(value.lastBlock, "cursor block");
  const lastHash =
    value.lastHash === null
      ? null
      : normalizeHash(value.lastHash, "cursor hash");
  if ((lastBlock === null) !== (lastHash === null))
    throw new Error("Native cursor block and hash must be set together.");
  return { lastBlock, lastHash };
}

function taskKey(candidate: Address): string {
  return candidate.toLowerCase();
}

function normalizeTask(value: NativeLeadReplayTask): NativeLeadReplayTask {
  const candidate = normalizeAddress(value.candidate, "replay candidate");
  if (typeof value.key !== "string" || value.key !== taskKey(candidate))
    throw new Error("Invalid native replay key.");
  const fundingBlock = block(value.fundingBlock, "funding block");
  const fromBlock = block(value.fromBlock, "replay start");
  const targetBlock = block(value.targetBlock, "replay target");
  if (
    fromBlock < fundingBlock ||
    targetBlock < fundingBlock ||
    fromBlock > targetBlock
  )
    throw new Error("Native replay window is outside its funding range.");
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0)
    throw new Error("Invalid native replay attempts.");
  if (!Number.isSafeInteger(value.createdRevision) || value.createdRevision < 0)
    throw new Error("Invalid native replay revision.");
  const transactionIndex = value.fundingTransactionIndex;
  if (
    transactionIndex !== undefined &&
    (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0)
  )
    throw new Error("Invalid funding transaction index.");
  return {
    ...value,
    key: taskKey(candidate),
    candidate,
    fundingBlock,
    fromBlock,
    targetBlock,
    ...(transactionIndex === undefined
      ? {}
      : { fundingTransactionIndex: transactionIndex }),
  };
}

export function createNativeLeadStreamState(
  cursor: NativeCursor = { lastBlock: null, lastHash: null },
): NativeLeadStreamState {
  return {
    version: 1,
    revision: 0,
    cursor: normalizeCursor(cursor),
    replayTasks: [],
  };
}

export function normalizeNativeLeadStreamState(
  value: NativeLeadStreamState,
  maxTasks = MAX_REPLAY_TASKS,
): NativeLeadStreamState {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error("Invalid native lead stream state.");
  if (
    !Number.isSafeInteger(maxTasks) ||
    maxTasks < 1 ||
    maxTasks > MAX_REPLAY_TASKS
  )
    throw new Error("Invalid native replay task bound.");
  if (!Array.isArray(value.replayTasks))
    throw new Error("Invalid native replay tasks.");
  const tasks: NativeLeadReplayTask[] = [];
  const seen = new Set<string>();
  for (const raw of value.replayTasks) {
    const task = normalizeTask(raw);
    if (seen.has(task.key)) continue;
    seen.add(task.key);
    if (tasks.length >= maxTasks)
      throw new NativeLeadStreamError(
        "REPLAY_CAP",
        `Native replay task state exceeds the bound of ${maxTasks}.`,
      );
    tasks.push(task);
  }
  return {
    version: 1,
    revision: value.revision,
    cursor: normalizeCursor(value.cursor),
    replayTasks: tasks,
  };
}

/** Queue one bounded replay from each new lead's funding block to the current cursor. */
export function queueNativeLeadReplays(
  input: NativeLeadStreamState,
  leads: readonly NativeLeadFunding[],
  targetBlock: number,
  maxTasks = MAX_REPLAY_TASKS,
): NativeLeadStreamState {
  const state = normalizeNativeLeadStreamState(input, maxTasks);
  const target = block(targetBlock, "replay target");
  if (!leads.length) return state;
  const byKey = new Map(state.replayTasks.map((task) => [task.key, task]));
  let changed = false;
  const nextRevision = state.revision + 1;
  for (const lead of leads) {
    const candidate = normalizeAddress(lead.candidate, "lead candidate");
    const fundingBlock = block(lead.blockNumber, "lead funding block");
    if (fundingBlock > target) continue;
    const key = taskKey(candidate);
    const existing = byKey.get(key);
    if (existing) {
      if (
        target > existing.targetBlock ||
        (existing.fundingTransactionIndex === undefined &&
          lead.transactionIndex !== undefined)
      ) {
        byKey.set(key, {
          ...existing,
          targetBlock: target,
          ...(lead.transactionIndex === undefined ||
          existing.fundingTransactionIndex !== undefined
            ? {}
            : { fundingTransactionIndex: lead.transactionIndex }),
          createdRevision: nextRevision,
        });
        changed = true;
      }
      continue;
    }
    byKey.set(key, {
      key,
      candidate,
      fundingBlock,
      ...(lead.transactionIndex === undefined
        ? {}
        : { fundingTransactionIndex: lead.transactionIndex }),
      fromBlock: fundingBlock,
      targetBlock: target,
      attempts: 0,
      createdRevision: nextRevision,
    });
    changed = true;
  }
  if (byKey.size > maxTasks)
    throw new NativeLeadStreamError(
      "REPLAY_CAP",
      `Native replay task queue would exceed the bound of ${maxTasks}.`,
    );
  if (!changed) return state;
  return { ...state, revision: nextRevision, replayTasks: [...byKey.values()] };
}

export function beginNativeLeadScan(
  input: NativeLeadStreamState,
  maxBlockSpan: number,
): NativeLeadScanSnapshot {
  const state = normalizeNativeLeadStreamState(input);
  if (
    !Number.isSafeInteger(maxBlockSpan) ||
    maxBlockSpan < 1 ||
    maxBlockSpan > 200
  )
    throw new Error("Invalid native scan block span.");
  const replayWindows = state.replayTasks.map((task) => ({
    key: task.key,
    candidate: task.candidate,
    fromBlock: task.fromBlock,
    toBlock: Math.min(task.targetBlock, task.fromBlock + maxBlockSpan - 1),
    fundingBlock: task.fundingBlock,
    ...(task.fundingTransactionIndex === undefined
      ? {}
      : { fundingTransactionIndex: task.fundingTransactionIndex }),
  }));
  return {
    revision: state.revision,
    cursor: state.cursor,
    replayTasks: state.replayTasks.map((task) => ({ ...task })),
    replayWindows,
  };
}

/** Commit only a successful scan; tasks queued while the snapshot was running survive. */
export function commitNativeLeadScan(
  input: NativeLeadStreamState,
  snapshot: NativeLeadScanSnapshot,
  result: NativeLeadScanCommit,
): NativeLeadStreamState {
  const state = normalizeNativeLeadStreamState(input);
  if (snapshot.revision > state.revision)
    throw new NativeLeadStreamError(
      "SNAPSHOT_FUTURE",
      "Native scan snapshot is from the future.",
    );
  if (!result.success) {
    const snapshotKeys = new Set(snapshot.replayTasks.map((task) => task.key));
    return {
      ...state,
      revision: state.revision + 1,
      replayTasks: state.replayTasks.map((task) =>
        snapshotKeys.has(task.key) && task.createdRevision <= snapshot.revision
          ? { ...task, attempts: task.attempts + 1 }
          : task,
      ),
    };
  }
  const cursor =
    result.cursor === undefined ? state.cursor : normalizeCursor(result.cursor);
  if (
    state.cursor.lastBlock !== null &&
    (cursor.lastBlock === null || cursor.lastBlock < state.cursor.lastBlock)
  )
    throw new NativeLeadStreamError(
      "CURSOR_REGRESSION",
      "A successful native scan cannot move the cursor backwards.",
    );
  if (
    state.cursor.lastBlock !== null &&
    cursor.lastBlock === state.cursor.lastBlock &&
    cursor.lastHash !== state.cursor.lastHash
  )
    throw new NativeLeadStreamError(
      "CURSOR_CONFLICT",
      "A successful native scan changed the hash at the current cursor block.",
    );
  const snapshotKeys = new Set(snapshot.replayTasks.map((task) => task.key));
  const completed = new Map<string, number>();
  for (const window of result.completedReplayWindows ?? []) {
    if (!snapshotKeys.has(window.key))
      throw new NativeLeadStreamError(
        "UNEXPECTED_REPLAY_KEY",
        `Replay completion ${window.key} was not present in the scan snapshot.`,
      );
    if (!Number.isSafeInteger(window.toBlock) || window.toBlock < 0)
      throw new NativeLeadStreamError(
        "INVALID_REPLAY_WINDOW",
        `Replay completion ${window.key} has an invalid block.`,
      );
    const previous = completed.get(window.key);
    if (previous !== undefined && previous !== window.toBlock)
      throw new NativeLeadStreamError(
        "INVALID_REPLAY_WINDOW",
        `Replay completion ${window.key} was supplied more than once.`,
      );
    completed.set(window.key, window.toBlock);
  }
  const tasks = state.replayTasks.flatMap((task) => {
    const toBlock = completed.get(task.key);
    if (toBlock === undefined || task.createdRevision > snapshot.revision)
      return [task];
    if (toBlock < task.fromBlock || toBlock > task.targetBlock)
      throw new NativeLeadStreamError(
        "INVALID_REPLAY_WINDOW",
        `Replay completion ${task.key} is outside its bounded window.`,
      );
    return toBlock >= task.targetBlock
      ? []
      : [
          {
            ...task,
            fromBlock: toBlock + 1,
            attempts: 0,
            createdRevision: state.revision + 1,
          },
        ];
  });
  return {
    ...state,
    revision: state.revision + 1,
    cursor,
    replayTasks: tasks,
  };
}
