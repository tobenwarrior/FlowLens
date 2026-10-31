import type {
  Address,
  TraceProvider,
  TraceQuery,
  Transfer,
  TransferKind,
  TransferPage,
} from "../src/domain/types.ts";
import {
  address,
  boundedJson,
  ProviderError,
  tokenSymbol,
  uint,
  type Row,
} from "./history-provider.ts";

export const HYPURRTRACE_BASE_URL = "https://trace.hypurrscan.io";
const CHAIN_ID = 999;
const API_PREFIX = "/api/v1";
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_CURSOR = 4096;
const MAX_PROVIDER_ROWS = 10_000;
const MAX_PAGE_SIZE = 100;
const MAX_TRACE_FRAMES = 5000;
const MAX_TRACE_DEPTH = 32;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MOVING_CALLS = new Set(["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"]);
const NONMOVING_CALLS = new Set(["DELEGATECALL", "STATICCALL", "CALLCODE"]);
const STREAMS = ["native", "erc20", "internal"] as const;

const SOURCE = `${HYPURRTRACE_BASE_URL}${API_PREFIX}`;
const STATIC_WARNINGS = [
  "HypurrTrace indexed evidence is scoped to HyperEVM chain 999; provider omissions and re-indexing remain possible.",
  "This adapter covers successful native HYPE transactions, indexed ERC-20 Transfer logs, and internal value calls matched against the provider's published full call tree. NFTs, gas fees, zero-value transactions and labels are not covered.",
  "ERC-20 rows come from HypurrTrace's indexed Transfer-log stream without per-transaction hydration; they are provider-indexed evidence, not independent RPC verification.",
  "Internal frames are retained only when their published full call tree confirms the exact frame path and every ancestor succeeded; this is not independent RPC verification.",
  "Gross transfer flows are not buys, sells, profit, unique capital or proof of ownership.",
];

interface Fence {
  chainHead: number;
  lastIndexedBlock: number;
  blocksBehind: number;
  totalTransactions: number;
  totalTokenTransfers: number;
  totalNftTransfers: number;
}
interface OffsetState {
  offset: number;
  seen: number;
  done: boolean;
}
interface InternalState {
  cursor: string | null;
  seen: number;
  done: boolean;
}
interface Cursor {
  v: 1;
  provider: "hypurrtrace-indexed";
  chain: 999;
  address: string;
  size: number;
  fence: Fence;
  native: OffsetState;
  erc20: OffsetState;
  internal: InternalState;
}

type JsonObject = Record<string, unknown>;
const invalid = (message: string) =>
  new ProviderError("INVALID_PROVIDER_DATA", message);

function object(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(message);
  return value as JsonObject;
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(message);
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw invalid("HypurrTrace returned a malformed transaction hash.");
  return value.toLowerCase();
}

function traceHash(value: unknown): string {
  if (typeof value !== "string")
    throw invalid("HypurrTrace returned a malformed trace transaction hash.");
  return hash(/^0x/i.test(value) ? `0x${value.slice(2)}` : `0x${value}`);
}

function block(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw invalid("HypurrTrace returned a malformed non-negative integer.");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string")
    throw invalid("HypurrTrace returned a malformed timestamp.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw invalid("HypurrTrace returned a malformed timestamp.");
  return new Date(parsed).toISOString();
}

function hexQuantity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
  )
    throw invalid("HypurrTrace returned a malformed call value.");
  return BigInt(value).toString();
}

interface TraceFrame {
  path: number[];
  callType: string;
  from: Address;
  to: Address | null;
  value: string;
  success: boolean;
  error: string | null;
}

interface TraceSnapshot {
  blockNumber: number;
  status: true | false;
  frames: TraceFrame[];
}

function traceFrames(value: unknown): TraceFrame[] {
  const root = object(value, "HypurrTrace returned a malformed call tree.");
  const frames: TraceFrame[] = [];
  const stack: { frame: JsonObject; path: number[] }[] = [
    { frame: root, path: [] },
  ];
  while (stack.length) {
    if (frames.length >= MAX_TRACE_FRAMES)
      throw new ProviderError(
        "INTERNAL_TRACE_UNAVAILABLE",
        "HypurrTrace call tree exceeded the frame bound; internal coverage remains unavailable.",
        true,
      );
    const current = stack.pop()!;
    const frame = current.frame;
    const rawCallType =
      typeof frame.call_type === "string" ? frame.call_type.toUpperCase() : "";
    const callType = rawCallType === "SUICIDE" ? "SELFDESTRUCT" : rawCallType;
    if (!callType) throw invalid("HypurrTrace call tree omitted a call type.");
    if (current.path.length > MAX_TRACE_DEPTH)
      throw invalid("HypurrTrace call tree exceeded its depth bound.");
    const calls =
      frame.calls === undefined ? [] : array(frame.calls, "call tree calls");
    if (typeof frame.success !== "boolean")
      throw invalid("HypurrTrace call tree omitted a frame success flag.");
    if (
      frame.error !== null &&
      frame.error !== undefined &&
      typeof frame.error !== "string"
    )
      throw invalid("HypurrTrace call tree returned a malformed frame error.");
    frames.push({
      path: current.path,
      callType,
      from: address(frame.from),
      to:
        frame.to === null || frame.to === undefined ? null : address(frame.to),
      value: hexQuantity(frame.value),
      success: frame.success,
      error: (frame.error as string | null | undefined) ?? null,
    });
    for (let index = calls.length - 1; index >= 0; index--) {
      if (!Number.isSafeInteger(index) || index > Number.MAX_SAFE_INTEGER)
        throw invalid(
          "HypurrTrace call tree returned an invalid child position.",
        );
      stack.push({
        frame: object(
          calls[index],
          "HypurrTrace returned a malformed call frame.",
        ),
        path: [...current.path, index],
      });
    }
  }
  return frames;
}

function traceMatch(
  snapshot: TraceSnapshot,
  candidate: {
    callType: string;
    from: Address;
    to: Address;
    rawAmount: string;
    depth: number;
  },
): { eventIndex: string; reverted: boolean } {
  const family = (value: string) => (value === "CREATE2" ? "CREATE" : value);
  const matches = snapshot.frames.filter(
    (frame) =>
      family(frame.callType) === family(candidate.callType) &&
      frame.from === candidate.from &&
      frame.to === candidate.to &&
      frame.value === candidate.rawAmount,
  );
  if (matches.length !== 1)
    throw new ProviderError(
      "TRACE_MISMATCH",
      "HypurrTrace full call tree did not identify exactly one canonical frame for the indexed internal row; no page was committed.",
      true,
    );
  const frame = matches[0]!;
  if (!frame.path.length || frame.path.length !== candidate.depth)
    throw new ProviderError(
      "TRACE_MISMATCH",
      "HypurrTrace internal depth disagreed with the published call-tree path; no page was committed.",
      true,
    );
  const byPath = new Map(
    snapshot.frames.map((value) => [value.path.join("."), value]),
  );
  let reverted = false;
  for (let depth = 0; depth <= frame.path.length; depth++) {
    const ancestor = byPath.get(frame.path.slice(0, depth).join("."));
    if (!ancestor)
      throw new ProviderError(
        "TRACE_MISMATCH",
        "HypurrTrace full call tree omitted an ancestor for the indexed internal row; no page was committed.",
        true,
      );
    if (!ancestor.success || ancestor.error !== null) reverted = true;
  }
  return { eventIndex: `trace.${frame.path.join(".")}`, reverted };
}

function pageSize(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_PAGE_SIZE
  )
    throw new ProviderError(
      "INVALID_PAGE_SIZE",
      `Live HypurrTrace pages require an integer size from 1 to ${MAX_PAGE_SIZE} rows per stream.`,
    );
  return value as number;
}

function warningFence(fence: Fence): string {
  return `HypurrTrace index fence: last indexed block ${fence.lastIndexedBlock} of chain head ${fence.chainHead} (${fence.blocksBehind} blocks behind); activity indexed later or omitted by the provider needs a new investigation.`;
}

function parseFence(value: unknown): Fence {
  const body = object(
    value,
    "HypurrTrace returned a malformed indexer status.",
  );
  if (body.success !== true)
    throw new ProviderError(
      "PROVIDER_ERROR",
      "HypurrTrace indexer status reported an application error; no page was committed.",
    );
  const chainHead = block(body.chain_head);
  const lastIndexedBlock = block(body.last_indexed_block);
  const blocksBehind = block(body.blocks_behind);
  if (lastIndexedBlock > chainHead)
    throw invalid("HypurrTrace indexer status has an impossible block fence.");
  const totalTransactions = block(body.total_transactions_indexed);
  const totalTokenTransfers = block(body.total_token_transfers_indexed);
  const totalNftTransfers = block(body.total_nft_transfers_indexed);
  return {
    chainHead,
    lastIndexedBlock,
    blocksBehind,
    totalTransactions,
    totalTokenTransfers,
    totalNftTransfers,
  };
}

function offsetState(value: unknown): OffsetState {
  const state = object(value, "HypurrTrace cursor has malformed offset state.");
  if (
    Object.keys(state).length !== 3 ||
    !Number.isSafeInteger(state.offset) ||
    !Number.isSafeInteger(state.seen) ||
    (state.offset as number) < 0 ||
    (state.seen as number) < 0 ||
    (state.offset as number) > MAX_PROVIDER_ROWS ||
    (state.seen as number) > MAX_PROVIDER_ROWS ||
    typeof state.done !== "boolean"
  )
    throw new Error();
  return {
    offset: state.offset as number,
    seen: state.seen as number,
    done: state.done as boolean,
  };
}

function internalState(value: unknown): InternalState {
  const state = object(
    value,
    "HypurrTrace cursor has malformed internal state.",
  );
  if (
    Object.keys(state).length !== 3 ||
    (state.cursor !== null &&
      (typeof state.cursor !== "string" || state.cursor.length > MAX_CURSOR)) ||
    !Number.isSafeInteger(state.seen) ||
    (state.seen as number) < 0 ||
    (state.seen as number) > MAX_PROVIDER_ROWS ||
    typeof state.done !== "boolean"
  )
    throw new Error();
  return {
    cursor: state.cursor as string | null,
    seen: state.seen as number,
    done: state.done as boolean,
  };
}

function decodeCursor(value: string, query: TraceQuery, size: number): Cursor {
  try {
    if (value.length > MAX_CURSOR) throw new Error();
    const decoded = object(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      "Invalid cursor",
    );
    if (
      Object.keys(decoded).length !== 9 ||
      decoded.v !== 1 ||
      decoded.provider !== "hypurrtrace-indexed" ||
      decoded.chain !== CHAIN_ID ||
      decoded.address !== query.address.toLowerCase() ||
      decoded.size !== size
    )
      throw new Error();
    const fence = object(decoded.fence, "Invalid cursor fence.");
    const cursor: Cursor = {
      v: 1,
      provider: "hypurrtrace-indexed",
      chain: CHAIN_ID,
      address: decoded.address as string,
      size,
      fence: {
        chainHead: block(fence.chainHead),
        lastIndexedBlock: block(fence.lastIndexedBlock),
        blocksBehind: block(fence.blocksBehind),
        totalTransactions: block(fence.totalTransactions),
        totalTokenTransfers: block(fence.totalTokenTransfers),
        totalNftTransfers: block(fence.totalNftTransfers),
      },
      native: offsetState(decoded.native),
      erc20: offsetState(decoded.erc20),
      internal: internalState(decoded.internal),
    };
    if (cursor.fence.lastIndexedBlock > cursor.fence.chainHead)
      throw new Error();
    if (cursor.native.done && cursor.erc20.done && cursor.internal.done)
      throw new Error();
    return cursor;
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid cursor or cursor belongs to a different provider, chain, wallet or page size.",
    );
  }
}

function encodeCursor(cursor: Cursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (encoded.length > MAX_CURSOR)
    throw invalid("HypurrTrace pagination state exceeds the cursor budget.");
  return encoded;
}

function transfer(
  kind: TransferKind,
  hashValue: string,
  eventIndex: string,
  from: Address,
  to: Address,
  contract: Address | null,
  decimals: number,
  symbol: string,
  rawAmount: string,
  timestampValue: string,
  blockNumber: number,
  retrievedAtValue: string,
): Transfer {
  return {
    id: `${CHAIN_ID}:${hashValue}:${kind}:${eventIndex}:${contract ?? "native"}`,
    chainId: CHAIN_ID,
    hash: hashValue,
    kind,
    eventIndex,
    from,
    to,
    asset: { chainId: CHAIN_ID, contract, decimals, symbol },
    rawAmount,
    timestamp: timestampValue,
    blockNumber,
    status: "success",
    source: SOURCE,
    retrievedAt: retrievedAtValue,
  };
}

const INTERNAL_UNAVAILABLE = new Set([
  "INTERNAL_TRACE_UNAVAILABLE",
  "NETWORK_ERROR",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_ERROR",
  "RATE_LIMITED",
  "PROVIDER_RESPONSE_TOO_LARGE",
]);

/** Keyless bounded HypurrTrace indexed history for HyperEVM chain 999. */
export function createHypurrtraceProvider(
  options: { fetch?: typeof fetch; intervalMs?: number } = {},
): TraceProvider {
  const fetcher = options.fetch ?? fetch;
  const interval = options.intervalMs ?? 2000;
  if (!Number.isSafeInteger(interval) || interval < 0)
    throw new TypeError("intervalMs must be a non-negative integer.");
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  function request(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const task = queue.then(async () => {
      const wait = Math.max(0, lastCall + interval - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = Date.now();
      const url = new URL(`${HYPURRTRACE_BASE_URL}${path}`);
      try {
        const response = await fetcher(url, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers:
            method === "POST"
              ? {
                  accept: "application/json",
                  "content-type": "application/json",
                }
              : { accept: "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) await response.body?.cancel().catch(() => undefined);
        if (response.status === 429)
          throw new ProviderError(
            "RATE_LIMITED",
            "HypurrTrace rate limit reached; resume later using the saved cursor.",
            true,
          );
        if (response.status === 401 || response.status === 403)
          throw new ProviderError(
            "ACCESS_DENIED",
            `HypurrTrace refused access (HTTP ${response.status}); this is not evidence of no activity.`,
          );
        if (!response.ok)
          throw new ProviderError(
            "PROVIDER_HTTP_ERROR",
            `HypurrTrace returned HTTP ${response.status}; no page was committed.`,
            response.status === 404 || response.status >= 500,
          );
        return await boundedJson(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "NETWORK_ERROR",
          "HypurrTrace request failed or timed out; no page was committed. Resume later.",
          true,
        );
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }

  function responseBody(value: unknown, expected: string): JsonObject {
    const body = object(
      value,
      `HypurrTrace returned a malformed ${expected} response.`,
    );
    if (body.success !== true)
      throw new ProviderError(
        "PROVIDER_ERROR",
        `HypurrTrace ${expected} query reported an application error; no page was committed.`,
      );
    return body;
  }

  async function trace(
    txHash: string,
    blockNumber: number,
  ): Promise<TraceSnapshot> {
    const body = responseBody(
      await request(`${API_PREFIX}/trace`, "POST", { tx_hash: txHash }),
      "transaction trace",
    );
    if (traceHash(body.tx_hash) !== txHash)
      throw new ProviderError(
        "TRACE_MISMATCH",
        "HypurrTrace trace hash disagreed with the indexed row; no page was committed.",
        true,
      );
    if (body.block_number === null || body.block_number === undefined)
      throw new ProviderError(
        "INTERNAL_TRACE_UNAVAILABLE",
        "HypurrTrace trace has no mined block; internal value remains unavailable.",
        true,
      );
    if (block(body.block_number) !== blockNumber)
      throw new ProviderError(
        "TRACE_MISMATCH",
        "HypurrTrace trace block disagreed with the indexed row; no page was committed.",
        true,
      );
    if (body.status === false)
      return { blockNumber, status: false, frames: [] };
    if (
      body.status !== true ||
      body.call_trace === null ||
      body.call_trace === undefined
    )
      throw new ProviderError(
        "INTERNAL_TRACE_UNAVAILABLE",
        "HypurrTrace did not publish a successful full call tree; internal value remains unavailable.",
        true,
      );
    return {
      blockNumber,
      status: true,
      frames: traceFrames(body.call_trace),
    };
  }

  async function fetchPage(query: TraceQuery): Promise<TransferPage> {
    if (query.chainId !== CHAIN_ID)
      throw new ProviderError(
        "UNSUPPORTED_CHAIN",
        "HypurrTrace indexed history covers HyperEVM chain 999 only.",
      );
    const wallet = address(query.address);
    let size: number;
    if (query.cursor && query.pageSize === undefined) {
      try {
        size = pageSize(
          object(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
            "cursor",
          ).size,
        );
      } catch {
        throw new ProviderError(
          "INVALID_CURSOR",
          "Invalid HypurrTrace cursor.",
        );
      }
    } else size = pageSize(query.pageSize ?? 10);
    const cursor = query.cursor
      ? decodeCursor(query.cursor, { ...query, address: wallet }, size)
      : {
          v: 1 as const,
          provider: "hypurrtrace-indexed" as const,
          chain: CHAIN_ID as 999,
          address: wallet,
          size,
          fence: parseFence(
            await request(`${API_PREFIX}/indexer/status`, "GET"),
          ),
          native: { offset: 0, seen: 0, done: false },
          erc20: { offset: 0, seen: 0, done: false },
          internal: { cursor: null, seen: 0, done: false },
        };
    const warnings = [...STATIC_WARNINGS, warningFence(cursor.fence)];
    warnings.push(
      `HypurrTrace indexer status totals (global provider counts): ${cursor.fence.totalTransactions} transactions, ${cursor.fence.totalTokenTransfers} ERC-20 transfers, and ${cursor.fence.totalNftTransfers} NFT transfers; this adapter does not import NFT rows.`,
    );
    const retrievedAt = new Date().toISOString();
    const transfers: Transfer[] = [];
    const streams = new Set<TransferKind>(STREAMS);
    const transferRows = new Map<string, Transfer>();
    const add = (value: Transfer) => {
      const previous = transferRows.get(value.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value))
        throw new ProviderError(
          "CONFLICTING_PROVIDER_DATA",
          "HypurrTrace returned conflicting facts for one canonical event; no page was committed.",
        );
      transferRows.set(value.id, value);
    };

    async function directRows(stream: "native" | "erc20"): Promise<Row[]> {
      const state = cursor[stream];
      if (state.done) return [];
      const path =
        stream === "native"
          ? `${API_PREFIX}/indexed/transactions`
          : `${API_PREFIX}/indexed/erc20-transfers`;
      const body = responseBody(
        await request(path, "POST", {
          address: wallet,
          limit: size,
          offset: state.offset,
          order: "asc",
        }),
        stream === "native" ? "transaction" : "ERC-20",
      );
      const total = block(body.total);
      if (total >= MAX_PROVIDER_ROWS)
        throw new ProviderError(
          "PROVIDER_CAP_REACHED",
          `HypurrTrace ${stream} history reports the provider's ${MAX_PROVIDER_ROWS}-row cap; coverage is partial and not exhausted.`,
        );
      const key = stream === "native" ? "transactions" : "transfers";
      const values = array(
        body[key],
        `HypurrTrace returned malformed ${stream} rows.`,
      );
      if (values.length > size || values.length > MAX_PROVIDER_ROWS)
        throw invalid(
          "HypurrTrace returned more rows than the requested page bound.",
        );
      if (values.length === 0 && state.offset < total)
        throw invalid("HypurrTrace returned an empty non-terminal page.");
      state.offset += values.length;
      state.seen += values.length;
      if (state.seen > MAX_PROVIDER_ROWS)
        throw new ProviderError(
          "PROVIDER_CAP_REACHED",
          "HypurrTrace provider row cap reached; coverage is partial.",
        );
      if (values.length < size && state.offset < total)
        throw invalid("HypurrTrace returned a short non-terminal page.");
      state.done = state.offset >= total;
      return values.map((value) =>
        object(value, `HypurrTrace returned malformed ${stream} row.`),
      );
    }

    const native = await directRows("native");
    for (const record of native) {
      if (typeof record.success !== "boolean")
        throw invalid("HypurrTrace native row omitted its success flag.");
      if (record.success !== true || record.value === "0") continue;
      const hashValue = hash(record.tx_hash);
      const blockNumber = block(record.block_number);
      if (blockNumber > cursor.fence.lastIndexedBlock) {
        warnings.push(
          "A native row newer than the frozen index fence was not consumed.",
        );
        continue;
      }
      const from = address(record.from_address);
      const to = address(record.to_address ?? record.contract_address);
      if (from !== wallet && to !== wallet)
        throw invalid(
          "HypurrTrace returned a native row outside the requested wallet scope.",
        );
      add(
        transfer(
          "native",
          hashValue,
          "0",
          from,
          to,
          null,
          18,
          "HYPE",
          uint(record.value),
          timestamp(record.timestamp),
          blockNumber,
          retrievedAt,
        ),
      );
    }

    const erc20 = await directRows("erc20");
    const erc20Rows: { hash: string; blockNumber: number; value: Transfer }[] =
      [];
    for (const record of erc20) {
      const hashValue = hash(record.tx_hash);
      const blockNumber = block(record.block_number);
      if (blockNumber > cursor.fence.lastIndexedBlock) {
        warnings.push(
          "An ERC-20 row newer than the frozen index fence was not consumed.",
        );
        continue;
      }
      const logIndex = block(record.log_index);
      if (
        record.token_decimals === null ||
        record.token_decimals === undefined
      ) {
        warnings.push(
          "An ERC-20 row without token decimals was omitted; its raw amount remains unnormalizable.",
        );
        continue;
      }
      if (record.timestamp === null || record.timestamp === undefined) {
        warnings.push(
          "An ERC-20 row without a timestamp was omitted; its event remains uncovered.",
        );
        continue;
      }
      const decimals = block(record.token_decimals, 255);
      const contract = address(record.token_address);
      const from = address(record.from_address);
      const to = address(record.to_address);
      if (from !== wallet && to !== wallet)
        throw invalid(
          "HypurrTrace returned an ERC-20 row outside the requested wallet scope.",
        );
      erc20Rows.push({
        hash: hashValue,
        blockNumber,
        value: transfer(
          "erc20",
          hashValue,
          String(logIndex),
          from,
          to,
          contract,
          decimals,
          tokenSymbol(record.token_symbol),
          uint(record.value),
          timestamp(record.timestamp),
          blockNumber,
          retrievedAt,
        ),
      });
    }
    for (const rowValue of erc20Rows) {
      add(rowValue.value);
    }

    const internalBefore = structuredClone(cursor.internal);
    const nonInternalRows = native.length + erc20.length;
    try {
      if (!cursor.internal.done) {
        const body = responseBody(
          await request(`${API_PREFIX}/indexed/internal-calls`, "POST", {
            address: wallet,
            cursor: cursor.internal.cursor,
            limit: size,
            order: "asc",
            pagination: "cursor",
            to_block: cursor.fence.lastIndexedBlock,
          }),
          "internal-call",
        );
        const values = array(
          body.internal_calls,
          "HypurrTrace returned malformed internal-call rows.",
        );
        if (values.length > size || values.length > MAX_PROVIDER_ROWS)
          throw invalid(
            "HypurrTrace returned more internal rows than the requested page bound.",
          );
        const hasMore = body.has_more;
        if (typeof hasMore !== "boolean")
          throw invalid("HypurrTrace omitted internal pagination state.");
        if (
          hasMore &&
          (typeof body.next_cursor !== "string" ||
            body.next_cursor.length > MAX_CURSOR)
        )
          throw invalid(
            "HypurrTrace returned malformed internal pagination state.",
          );
        if (hasMore && body.next_cursor === cursor.internal.cursor)
          throw invalid(
            "HypurrTrace returned a non-progressing internal cursor.",
          );
        if (
          !hasMore &&
          body.next_cursor !== null &&
          body.next_cursor !== undefined
        )
          throw invalid(
            "HypurrTrace returned a cursor after its terminal internal page.",
          );
        cursor.internal.seen += values.length;
        if (cursor.internal.seen >= MAX_PROVIDER_ROWS)
          throw new ProviderError(
            "PROVIDER_CAP_REACHED",
            `HypurrTrace internal history reached the provider's ${MAX_PROVIDER_ROWS}-row bound; coverage is partial and not exhausted.`,
          );
        cursor.internal.cursor = hasMore ? (body.next_cursor as string) : null;
        cursor.internal.done = !hasMore;
        const internalRows: {
          hash: string;
          blockNumber: number;
          callType: string;
          from: Address;
          to: Address;
          rawAmount: string;
          timestamp: string;
          depth: number;
        }[] = [];
        for (const value of values) {
          const record = object(
            value,
            "HypurrTrace returned malformed internal-call row.",
          );
          if (typeof record.success !== "boolean")
            throw invalid("HypurrTrace internal row omitted its success flag.");
          if (
            record.success !== true ||
            (record.error !== null && record.error !== undefined)
          )
            continue;
          const callType =
            typeof record.call_type === "string"
              ? record.call_type.toUpperCase()
              : "";
          if (!MOVING_CALLS.has(callType)) {
            if (!NONMOVING_CALLS.has(callType))
              warnings.push(
                "An unsupported internal call type was not imported.",
              );
            continue;
          }
          if (record.value === "0") continue;
          if (
            typeof record.depth !== "number" ||
            !Number.isSafeInteger(record.depth) ||
            record.depth < 1 ||
            record.depth > MAX_TRACE_DEPTH
          )
            throw new ProviderError(
              "INTERNAL_TRACE_UNAVAILABLE",
              "HypurrTrace internal depth is unavailable or outside the call-tree bound; internal coverage remains unavailable.",
              true,
            );
          const hashValue = hash(record.tx_hash);
          const blockNumber = block(record.block_number);
          if (blockNumber > cursor.fence.lastIndexedBlock) {
            warnings.push(
              "An internal row newer than the frozen index fence was not consumed.",
            );
            continue;
          }
          block(record.call_index);
          const from = address(record.from_address);
          if (record.to_address === null || record.to_address === undefined) {
            warnings.push(
              "An internal value call without a destination address was omitted; no endpoint was invented.",
            );
            continue;
          }
          if (record.timestamp === null || record.timestamp === undefined) {
            warnings.push(
              "An internal value call without a timestamp was omitted; its frame remains uncovered.",
            );
            continue;
          }
          const to = address(record.to_address);
          if (from !== wallet && to !== wallet)
            throw invalid(
              "HypurrTrace returned an internal row outside the requested wallet scope.",
            );
          internalRows.push({
            hash: hashValue,
            blockNumber,
            callType,
            from,
            to,
            rawAmount: uint(record.value),
            timestamp: timestamp(record.timestamp),
            depth: record.depth,
          });
        }
        const traces = new Map<string, TraceSnapshot>();
        const traceFor = async (txHash: string, blockNumber: number) => {
          const existing = traces.get(txHash);
          if (existing) {
            if (existing.blockNumber !== blockNumber)
              throw new ProviderError(
                "TRACE_MISMATCH",
                "HypurrTrace reused one transaction hash at conflicting indexed blocks; no page was committed.",
                true,
              );
            return existing;
          }
          const value = await trace(txHash, blockNumber);
          traces.set(txHash, value);
          return value;
        };
        for (const rowValue of internalRows) {
          const snapshot = await traceFor(rowValue.hash, rowValue.blockNumber);
          if (snapshot.status === false) {
            warnings.push(
              "An internal value call whose parent transaction reverted was excluded; it moved no value.",
            );
            continue;
          }
          const match = traceMatch(snapshot, rowValue);
          if (match.reverted) {
            warnings.push(
              "An internal value call inside a reverted ancestor frame was excluded; it moved no value.",
            );
            continue;
          }
          add(
            transfer(
              "internal",
              rowValue.hash,
              match.eventIndex,
              rowValue.from,
              rowValue.to,
              null,
              18,
              "HYPE",
              rowValue.rawAmount,
              rowValue.timestamp,
              rowValue.blockNumber,
              retrievedAt,
            ),
          );
        }
      }
    } catch (error) {
      if (
        error instanceof ProviderError &&
        INTERNAL_UNAVAILABLE.has(error.code) &&
        error.code !== "TRACE_MISMATCH"
      ) {
        cursor.internal = internalBefore;
        for (const [id, value] of transferRows) {
          if (value.kind === "internal") transferRows.delete(id);
        }
        // If the direct streams are already terminal, returning an unchanged
        // internal cursor would make a caller repeat the same empty page
        // forever. Preserve useful direct rows when present, but surface the
        // provider error once there is no other stream progress to commit.
        if (nonInternalRows === 0 && cursor.native.done && cursor.erc20.done)
          throw error;
        streams.delete("internal");
        warnings.push(
          "HypurrTrace internal coverage is unavailable for this page because the indexed endpoint or published full call tree did not establish a canonical successful frame path; native and ERC-20 coverage remains separate and the internal cursor was not advanced.",
        );
      } else throw error;
    }

    for (const value of transferRows.values()) {
      transfers.push(value);
    }
    const nodes = [
      ...new Set(transfers.flatMap((value) => [value.from, value.to])),
    ].map((value) => ({
      address: value,
      chainId: CHAIN_ID,
    }));
    const exhausted =
      cursor.native.done && cursor.erc20.done && cursor.internal.done;
    return {
      transfers,
      nodes,
      cursor: exhausted ? null : encodeCursor(cursor),
      warnings: [...new Set(warnings)],
      streams: [...streams],
      exhausted,
    };
  }

  return { id: "hypurrtrace-indexed", mode: "live", fetchPage };
}
