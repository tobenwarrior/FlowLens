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
  integer,
  ProviderError,
  row,
  tokenSymbol,
  uint,
  type Row,
} from "./history-provider.ts";

// Hosts confirmed to answer a plain server request without a key: eth.blockscout.com on 21 October
// 2026, explorer.derive.xyz on 23 October 2026. base.blockscout.com and arbitrum.blockscout.com
// answered with a browser challenge and stay out. `pageSize` marks explorers that honour items_count.
const EXPLORERS: Record<
  number,
  { api: string; native: string; pageSize: boolean; warning?: string }
> = {
  1: {
    api: "https://eth.blockscout.com/api/v2",
    native: "ETH",
    pageSize: false,
  },
  // v12.0.3 honours items_count; its rows carry calldata of up to ~130 KB, so pages ask for only the rows kept.
  957: {
    api: "https://explorer.derive.xyz/api/v2",
    native: "ETH",
    pageSize: true,
    warning:
      "Derive Chain subaccounts and their collateral, positions and trades are records inside Derive's own contracts, not wallet transfers; this history shows only native, ERC20 and internal transfers that touch the address.",
  },
};
export const BLOCKSCOUT_CHAINS = Object.keys(EXPLORERS).map(Number);
// Pre-v12 explorers ignore page-size requests and return 50 full rows, so the budget is above Etherscan's.
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_ROWS = 100;
const MAX_FRAMES = 5000;
const MAX_CURSOR = 4096;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_TEXT = /^[0-9A-Za-z_.:+-]{1,100}$/;
const STREAMS = ["native", "erc20", "internal"] as const;
type Stream = (typeof STREAMS)[number];
const PATHS: Record<Stream, string> = {
  native: "transactions",
  erc20: "token-transfers",
  internal: "internal-transactions",
};
// Blockscout lists each stream newest first by these fields; every page is checked against that order.
const ORDER: Record<Stream, string[]> = {
  native: ["block_number", "position"],
  erc20: ["block_number", "log_index"],
  internal: ["block_number", "transaction_index", "index"],
};
// Availability failures, as opposed to bad data, that leave the other streams usable.
const UNAVAILABLE = new Set([
  "NETWORK_ERROR",
  "PROVIDER_HTTP_ERROR",
  "RATE_LIMITED",
  "TRACE_UNAVAILABLE",
]);
const MOVING = new Set(["call", "create", "create2", "selfdestruct"]);
const NONMOVING = new Set(["delegatecall", "staticcall", "callcode"]);
const WARNINGS = [
  "NFTs, fees, bridge matches and labels are not covered by this adapter. Blockscout names, tags and token metadata are not imported as labels.",
  "Results are indexed Blockscout evidence, not independent chain verification. Reorganizations and indexing gaps remain possible.",
  "Internal transfers are Blockscout call frames, each checked against its transaction's full Blockscout call trace; value inside reverted calls is excluded.",
  "Gross transfer flows are not buys, sells, profit, unique capital or proof of ownership.",
];
type Params = Record<string, string | number | boolean>;
interface StreamState {
  params: Params | null;
  after: number[] | null;
  done: boolean;
}
interface Cursor {
  v: 1;
  provider: "blockscout-v2";
  chain: number;
  address: string;
  size: number;
  end: number;
  native: StreamState;
  erc20: StreamState;
  internal: StreamState;
}
type Frame = { eventIndex: string } | { omitted: string };
const invalid = (message: string) =>
  new ProviderError("INVALID_PROVIDER_DATA", message);
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
/** next_page_params is provider data: only flat, short, plain values go back into a request. */
function pageParams(value: unknown): Params {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("Provider returned malformed pagination state.");
  const entries = Object.entries(value);
  if (
    !entries.length ||
    entries.length > 12 ||
    entries.some(
      ([key, v]) =>
        !PARAM_KEY.test(key) ||
        !(
          typeof v === "boolean" ||
          (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
          (typeof v === "string" && PARAM_TEXT.test(v))
        ),
    )
  )
    throw invalid("Provider returned malformed pagination state.");
  return Object.fromEntries(entries) as Params;
}
function sortKey(stream: Stream, record: Row): number[] | null {
  const key = ORDER[stream].map((field) => record[field]);
  return key.every((v) => Number.isSafeInteger(v) && (v as number) >= 0)
    ? (key as number[])
    : null;
}
function streamState(value: unknown, stream: Stream): StreamState {
  const state = row(value);
  const after = state.after;
  if (
    Object.keys(state).length !== 3 ||
    typeof state.done !== "boolean" ||
    (after !== null &&
      (!Array.isArray(after) ||
        after.length !== ORDER[stream].length ||
        !after.every((v) => Number.isSafeInteger(v) && v >= 0)))
  )
    throw new Error();
  return {
    params: state.params === null ? null : pageParams(state.params),
    after: after as number[] | null,
    done: state.done,
  };
}
function decodeCursor(value: string, query: TraceQuery, size: number): Cursor {
  try {
    if (value.length > MAX_CURSOR) throw new Error();
    const c = row(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (
      Object.keys(c).length !== 9 ||
      c.v !== 1 ||
      c.provider !== "blockscout-v2" ||
      c.chain !== query.chainId ||
      c.address !== query.address.toLowerCase() ||
      c.size !== size ||
      !Number.isSafeInteger(c.end) ||
      (c.end as number) < 0
    )
      throw new Error();
    const cursor: Cursor = {
      v: 1,
      provider: "blockscout-v2",
      chain: query.chainId,
      address: c.address,
      size,
      end: c.end as number,
      native: streamState(c.native, "native"),
      erc20: streamState(c.erc20, "erc20"),
      internal: streamState(c.internal, "internal"),
    };
    if (STREAMS.every((stream) => cursor[stream].done)) throw new Error();
    return cursor;
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid cursor or cursor belongs to a different provider, address, chain or page size.",
    );
  }
}
const party = (value: unknown): Address => address(row(value).hash);
const txHash = (value: unknown): string => {
  if (typeof value !== "string" || !HASH.test(value))
    throw invalid("Provider returned a malformed transaction hash.");
  return value.toLowerCase();
};
const traceMismatch = () =>
  new ProviderError(
    "TRACE_MISMATCH",
    "A Blockscout call trace does not match its internal transaction listing; no page was committed. Resume after provider indexing stabilizes.",
    true,
  );
/** One frame of a transaction's full call trace, whichever tracer the explorer runs. Fields are unvalidated. */
interface TraceFrame {
  path: unknown;
  failed: boolean;
  /** call, delegatecall, staticcall, callcode, create, create2 or selfdestruct. */
  type: unknown;
  from: unknown;
  to: unknown;
  value: unknown;
}
/**
 * A raw-trace response as frames in Blockscout's internal-transaction index order, or null above the
 * frame budget. eth.blockscout.com serves a flat Parity list; explorer.derive.xyz serves a nested Geth
 * callTracer tree, whose pre-order walk matched Blockscout's indexes on 23 October 2026.
 */
function traceFrames(value: unknown): TraceFrame[] | null {
  const unavailable = () =>
    new ProviderError(
      "TRACE_UNAVAILABLE",
      "Blockscout has no call trace yet for a listed internal transfer; no page was committed. Resume later using the saved cursor.",
      true,
    );
  if (Array.isArray(value)) {
    if (!value.length) throw unavailable();
    if (value.length > MAX_FRAMES) return null;
    return value.map((item): TraceFrame => {
      const frame = row(item),
        action = row(frame.action);
      const common = { path: frame.traceAddress, failed: frame.error != null };
      if (frame.type === "call")
        return {
          ...common,
          type: action.callType,
          from: action.from,
          to: action.to,
          value: action.value,
        };
      if (frame.type === "create" || frame.type === "create2")
        return {
          ...common,
          type: frame.type,
          from: action.from,
          to: row(frame.result).address,
          value: action.value,
        };
      if (frame.type === "suicide" || frame.type === "selfdestruct")
        return {
          ...common,
          type: "selfdestruct",
          from: action.address,
          to: action.refundAddress,
          value: action.balance,
        };
      return { ...common, type: frame.type, from: null, to: null, value: null };
    });
  }
  const root = row(value);
  if (!Object.keys(root).length) throw unavailable();
  const frames: TraceFrame[] = [];
  const stack: { frame: Row; path: number[] }[] = [{ frame: root, path: [] }];
  while (stack.length) {
    if (frames.length === MAX_FRAMES) return null;
    const { frame, path } = stack.pop()!;
    const calls = frame.calls ?? [];
    if (!Array.isArray(calls)) throw traceMismatch();
    frames.push({
      path,
      failed: frame.error != null,
      type:
        typeof frame.type === "string" ? frame.type.toLowerCase() : frame.type,
      from: frame.from,
      to: frame.to,
      value: frame.value,
    });
    for (let i = calls.length - 1; i >= 0; i--)
      stack.push({ frame: row(calls[i]), path: [...path, i] });
  }
  return frames;
}
/** Match one listed internal transfer to its frame in the transaction's full call trace. */
function checkFrame(
  frames: TraceFrame[],
  listed: {
    index: number;
    type: string;
    from: Address;
    to: Address;
    value: string;
  },
): Frame {
  const byPath = new Map<string, TraceFrame>();
  for (const frame of frames) {
    const path = frame.path;
    if (
      !Array.isArray(path) ||
      path.length > 32 ||
      !path.every((i) => Number.isSafeInteger(i) && i >= 0) ||
      byPath.has(path.join("."))
    )
      throw traceMismatch();
    byPath.set(path.join("."), frame);
  }
  const frame = frames[listed.index];
  if (!frame || frame.failed) throw traceMismatch();
  const path = frame.path as number[];
  // Tracers do not agree on whether a CREATE2 frame says create2, so either creation type matches.
  const family = (type: unknown) => (type === "create2" ? "create" : type);
  try {
    if (
      !path.length ||
      family(frame.type) !== family(listed.type) ||
      typeof frame.value !== "string" ||
      !QUANTITY.test(frame.value) ||
      BigInt(frame.value).toString() !== listed.value ||
      address(frame.from) !== listed.from ||
      address(frame.to) !== listed.to
    )
      throw new Error();
  } catch {
    throw traceMismatch();
  }
  for (let depth = 0; depth < path.length; depth++) {
    const ancestor = byPath.get(path.slice(0, depth).join("."));
    if (!ancestor) throw traceMismatch();
    if (ancestor.failed)
      return {
        omitted:
          "An internal call Blockscout lists as successful sits inside a reverted transaction or parent call; it moved no value and was excluded.",
      };
  }
  const eventIndex = `trace.${path.join(".")}`;
  return eventIndex.length > 100
    ? {
        omitted:
          "An internal transfer deeper than the canonical trace identity bound was omitted; it remains uncovered.",
      }
    : { eventIndex };
}

/** Keyless Blockscout API v2 history. Every request goes to the fixed explorer host of the queried chain. */
export function createBlockscoutProvider(
  options: { fetch?: typeof fetch; intervalMs?: number } = {},
): TraceProvider {
  const fetcher = options.fetch ?? fetch;
  // Both explorers advertised 180 keyless requests per minute; one queue at two per second stays below either.
  const interval = options.intervalMs ?? 500;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;
  function request(
    api: string,
    path: string,
    params: Params | null,
    fixed: Record<string, string> = {},
  ): Promise<unknown> {
    const task = queue.then(async () => {
      const wait = Math.max(0, lastCall + interval - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = Date.now();
      const url = new URL(`${api}/${path}`);
      for (const [key, value] of Object.entries({ ...params, ...fixed }))
        url.searchParams.set(key, String(value));
      try {
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(15000),
          redirect: "error",
          headers: { accept: "application/json" },
        });
        if (!response.ok) await response.body?.cancel().catch(() => undefined);
        if (response.status === 429)
          throw new ProviderError(
            "RATE_LIMITED",
            "Provider rate limit reached; resume later using the saved cursor.",
            true,
          );
        if (response.status === 401 || response.status === 403)
          throw new ProviderError(
            "ACCESS_DENIED",
            `Blockscout refused keyless access (HTTP ${response.status}). The explorer may now require a browser check or an API key; this is not evidence of no activity.`,
          );
        if (response.status === 422)
          throw new ProviderError(
            "PROVIDER_ERROR",
            "Provider rejected this request; no page was committed.",
          );
        if (!response.ok)
          throw new ProviderError(
            "PROVIDER_HTTP_ERROR",
            `Provider returned HTTP ${response.status}; no page was committed.`,
            // A missing trace or transaction can be indexing lag.
            response.status >= 500 || response.status === 404,
          );
        return await boundedJson(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "NETWORK_ERROR",
          "Provider request failed or timed out; no page was committed. Resume later.",
          true,
        );
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }
  async function fetchPage(query: TraceQuery): Promise<TransferPage> {
    const explorer = EXPLORERS[query.chainId];
    if (!explorer)
      throw new ProviderError(
        "UNSUPPORTED_CHAIN",
        "Keyless Blockscout history covers Ethereum (1) and Derive Chain (957) only. Other Blockscout hosts are not enabled until they are confirmed to answer without a browser check.",
      );
    const source = `Blockscout API v2 (${new URL(explorer.api).host})`;
    const wallet = address(query.address);
    let size = query.pageSize ?? 10;
    if (query.cursor && query.pageSize === undefined) {
      try {
        size = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        ).size;
      } catch {
        /* decodeCursor reports the boundary error below. */
      }
    }
    if (!Number.isInteger(size) || size < 1 || size > 10)
      throw new ProviderError(
        "INVALID_PAGE_SIZE",
        "Live page size must be an integer from 1 to 10 rows per stream.",
      );
    const fresh = (): StreamState => ({
      params: null,
      after: null,
      done: false,
    });
    const cursor: Cursor = query.cursor
      ? decodeCursor(query.cursor, query, size)
      : {
          v: 1,
          provider: "blockscout-v2",
          chain: query.chainId,
          address: wallet,
          size,
          end: 0,
          native: fresh(),
          erc20: fresh(),
          internal: fresh(),
        };
    const warnings = explorer.warning
      ? [...WARNINGS, explorer.warning]
      : [...WARNINGS];
    const transfers: Transfer[] = [];
    const pending = STREAMS.filter((stream) => !cursor[stream].done);
    // A stream that starts after the first page, such as an internal stream that was
    // unavailable then, stays inside the first page's window instead of reading newer rows.
    const windowEnd = query.cursor ? cursor.end : 0;
    const retrievedAt = new Date().toISOString();
    let newest = 0;
    const read = async (stream: Stream): Promise<Row[]> => {
      const state = cursor[stream];
      const body = row(
        await request(
          explorer.api,
          `addresses/${wallet}/${PATHS[stream]}`,
          state.params,
          // next_page_params does not echo items_count on v12, so every request repeats it.
          {
            ...(stream === "erc20" ? { type: "ERC-20" } : {}),
            ...(explorer.pageSize ? { items_count: String(size) } : {}),
          },
        ),
      );
      if (
        !Array.isArray(body.items) ||
        body.items.length > MAX_ROWS ||
        body.next_page_params === undefined
      )
        throw invalid("Provider returned an invalid history page.");
      const next =
        body.next_page_params === null
          ? null
          : pageParams(body.next_page_params);
      if (stream === "internal" && row(body.meta).status === 2)
        warnings.push(
          "Blockscout reports internal transactions for this wallet are still being indexed; the internal stream may be incomplete.",
        );
      const rows: { key: number[]; record: Row }[] = [];
      for (const item of body.items) {
        const record = row(item),
          key = sortKey(stream, record);
        if (key) rows.push({ key, record });
        else
          warnings.push(
            "A pending or malformed provider row without a block position was omitted.",
          );
      }
      if (rows.some((r, i) => i > 0 && compare(rows[i - 1].key, r.key) <= 0))
        throw invalid(
          "Provider returned history rows out of order; no page was committed.",
        );
      newest = Math.max(newest, rows[0]?.key[0] ?? 0);
      // Re-reading a provider page resumes strictly after the last consumed row, so newly indexed rows cannot shift it.
      const after = state.after;
      const remaining = rows.filter(
        (r) =>
          (!after || compare(r.key, after) < 0) &&
          (!windowEnd || r.key[0] <= windowEnd),
      );
      const slice = remaining.slice(0, size);
      if (slice.length) state.after = slice[slice.length - 1].key;
      if (remaining.length <= size) {
        if (next) state.params = next;
        else state.done = true;
      }
      return slice.map((r) => r.record);
    };
    const make = (
      record: Row,
      kind: TransferKind,
      hash: string,
      eventIndex: string,
      amount: string,
      contract: Address | null,
      decimals: number,
      symbol: string,
      from: Address,
      to: Address,
    ): Transfer => {
      const time =
        typeof record.timestamp === "string"
          ? Date.parse(record.timestamp)
          : NaN;
      if (!Number.isFinite(time))
        throw invalid("Provider returned a malformed timestamp.");
      return {
        id: `${query.chainId}:${hash}:${kind}:${eventIndex}:${contract ?? "native"}`,
        chainId: query.chainId,
        hash,
        kind,
        eventIndex,
        from,
        to,
        asset: { chainId: query.chainId, contract, decimals, symbol },
        rawAmount: amount,
        timestamp: new Date(time).toISOString(),
        blockNumber: record.block_number as number,
        status: "success",
        source,
        retrievedAt,
      };
    };
    if (!cursor.native.done) {
      for (const record of await read("native")) {
        // Failed transactions moved no value; zero-value calls are not transfers.
        if (record.status === "error" || record.value === "0") continue;
        try {
          if (record.status !== "ok") throw new Error();
          const from = party(record.from);
          const to = party(record.to ?? record.created_contract);
          if (from !== wallet && to !== wallet) throw new Error();
          transfers.push(
            make(
              record,
              "native",
              txHash(record.hash),
              "0",
              uint(record.value),
              null,
              18,
              explorer.native,
              from,
              to,
            ),
          );
        } catch {
          warnings.push(
            "A malformed or unconfirmed native provider row was omitted.",
          );
        }
      }
    }
    if (!cursor.erc20.done) {
      for (const record of await read("erc20")) {
        try {
          const token = row(record.token),
            total = row(record.total);
          if (
            record.token_type !== "ERC-20" ||
            token.type !== "ERC-20" ||
            typeof token.decimals !== "string" ||
            !/^\d{1,3}$/.test(token.decimals) ||
            (total.decimals != null && total.decimals !== token.decimals) ||
            !Number.isSafeInteger(record.log_index)
          )
            throw new Error();
          const from = party(record.from),
            to = party(record.to);
          if (from !== wallet && to !== wallet) throw new Error();
          transfers.push(
            make(
              record,
              "erc20",
              txHash(record.transaction_hash),
              String(record.log_index),
              uint(total.value),
              address(token.address_hash),
              integer(token.decimals, 255),
              tokenSymbol(token.symbol),
              from,
              to,
            ),
          );
        } catch {
          warnings.push("A malformed ERC20 provider row was omitted.");
        }
      }
    }
    // Blockscout's internal-transaction listing is its slowest endpoint and the one that
    // goes down on its own. When only it is unavailable, the page keeps its native and
    // ERC-20 rows and the internal cursor stays where it was, so a resume asks again.
    // Integrity failures, such as a trace that disagrees with the listing, still fail the page.
    const streams: TransferKind[] = ["native", "erc20", "internal"];
    if (!cursor.internal.done) {
      const before = {
        state: structuredClone(cursor.internal),
        warnings: warnings.length,
        newest,
      };
      try {
        const found: Transfer[] = [];
        const listed: {
          record: Row;
          hash: string;
          index: number;
          type: string;
          from: Address;
          to: Address;
          value: string;
        }[] = [];
        for (const record of await read("internal")) {
          // Index 0 is the transaction's own call, already the native stream's evidence.
          if (
            record.index === 0 ||
            record.value === "0" ||
            record.success === false ||
            NONMOVING.has(record.type as string)
          )
            continue;
          try {
            if (
              record.success !== true ||
              record.error != null ||
              !MOVING.has(record.type as string)
            )
              throw new Error();
            const from = party(record.from);
            const to = party(record.to ?? record.created_contract);
            if (from !== wallet && to !== wallet) throw new Error();
            listed.push({
              record,
              hash: txHash(record.transaction_hash),
              index: record.index as number,
              type: record.type as string,
              from,
              to,
              value: uint(record.value),
            });
          } catch {
            warnings.push("A malformed internal provider row was omitted.");
          }
        }
        // One bounded trace read per transaction on this page; there is no recursive fanout.
        const traces = new Map<string, TraceFrame[] | null>();
        for (const hash of new Set(listed.map((l) => l.hash))) {
          let frames: TraceFrame[] | null;
          try {
            frames = traceFrames(
              await request(
                explorer.api,
                `transactions/${hash}/raw-trace`,
                null,
              ),
            );
          } catch (error) {
            if (
              !(error instanceof ProviderError) ||
              error.code !== "PROVIDER_RESPONSE_TOO_LARGE"
            )
              throw error;
            frames = null;
          }
          traces.set(hash, frames);
        }
        for (const entry of listed) {
          const frames = traces.get(entry.hash);
          const checked: Frame = frames
            ? checkFrame(frames, entry)
            : {
                omitted:
                  "An internal transfer whose call trace exceeds the response budget was omitted; it remains uncovered.",
              };
          if ("omitted" in checked) {
            warnings.push(checked.omitted);
            continue;
          }
          found.push(
            make(
              entry.record,
              "internal",
              entry.hash,
              checked.eventIndex,
              entry.value,
              null,
              18,
              explorer.native,
              entry.from,
              entry.to,
            ),
          );
        }
        transfers.push(...found);
      } catch (error) {
        if (
          !(error instanceof ProviderError) ||
          !UNAVAILABLE.has(error.code) ||
          pending.length === 1
        )
          throw error;
        cursor.internal = before.state;
        warnings.length = before.warnings;
        newest = before.newest;
        streams.pop();
        warnings.push(
          "Blockscout's internal-transaction stream did not answer for one page, which kept only its native and ERC-20 transfers; the internal stream continues from where it stopped on the next page.",
        );
      }
    }
    // Set by the first page that sees any row, so a resumed stream has a window to stay inside.
    if (!cursor.end) cursor.end = newest;
    warnings.push(
      `History window: each stream starts at the newest rows Blockscout returned for the first page (through block ${cursor.end}); activity indexed later needs a new investigation.`,
    );
    const exhausted = STREAMS.every((stream) => cursor[stream].done);
    if (exhausted)
      warnings.push(
        "Configured history streams returned terminal pages; omitted streams remain uncovered. This does not establish complete wallet history.",
      );
    const observed = new Map<string, Transfer>();
    for (const transfer of transfers) {
      const previous = observed.get(transfer.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(transfer))
        throw invalid(
          "Provider returned conflicting facts for one canonical event; no page was committed.",
        );
      observed.set(transfer.id, transfer);
    }
    const unique = [...observed.values()];
    const nodes = [...new Set(unique.flatMap((t) => [t.from, t.to]))].map(
      (address) => ({ address, chainId: query.chainId }),
    );
    const next = exhausted
      ? null
      : Buffer.from(JSON.stringify(cursor)).toString("base64url");
    if (next && next.length > MAX_CURSOR)
      throw invalid(
        "Provider pagination state exceeds the cursor budget; no page was committed.",
      );
    return {
      transfers: unique,
      nodes,
      cursor: next,
      warnings: [...new Set(warnings)],
      streams,
      exhausted,
    };
  }
  return { id: "blockscout-v2", mode: "live", fetchPage };
}
