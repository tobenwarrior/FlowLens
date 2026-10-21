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

// Hosts confirmed to answer a plain server request without a key on 21 October 2026.
// base.blockscout.com and arbitrum.blockscout.com answered with a browser challenge and stay out.
const EXPLORERS: Record<number, { api: string; native: string }> = {
  1: { api: "https://eth.blockscout.com/api/v2", native: "ETH" },
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
/** Match one listed internal transfer to its frame in the transaction's full call trace. */
function checkFrame(
  frames: Row[],
  listed: {
    index: number;
    type: string;
    from: Address;
    to: Address;
    value: string;
  },
): Frame {
  const byPath = new Map<string, Row>();
  for (const frame of frames) {
    const path = frame.traceAddress;
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
  if (!frame || frame.error != null) throw traceMismatch();
  const action = row(frame.action),
    path = frame.traceAddress as number[];
  const [from, to, value] =
    listed.type === "call"
      ? frame.type === "call" && action.callType === "call"
        ? [action.from, action.to, action.value]
        : []
      : listed.type === "selfdestruct"
        ? frame.type === "suicide" || frame.type === "selfdestruct"
          ? [action.address, action.refundAddress, action.balance]
          : []
        : frame.type === "create" || frame.type === "create2"
          ? [action.from, row(frame.result).address, action.value]
          : [];
  try {
    if (
      !path.length ||
      typeof value !== "string" ||
      !QUANTITY.test(value) ||
      BigInt(value).toString() !== listed.value ||
      address(from) !== listed.from ||
      address(to) !== listed.to
    )
      throw new Error();
  } catch {
    throw traceMismatch();
  }
  for (let depth = 0; depth < path.length; depth++) {
    const ancestor = byPath.get(path.slice(0, depth).join("."));
    if (!ancestor) throw traceMismatch();
    if (ancestor.error != null)
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

/** Keyless Blockscout API v2 history. Every request goes to a fixed explorer host. */
export function createBlockscoutProvider(
  options: { fetch?: typeof fetch; intervalMs?: number } = {},
): TraceProvider {
  const fetcher = options.fetch ?? fetch;
  // eth.blockscout.com advertised 180 keyless requests per minute; two per second stays below it.
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
        "Keyless Blockscout history covers Ethereum (1) only. Other Blockscout hosts are not enabled until they are confirmed to answer without a browser check.",
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
    const warnings = [...WARNINGS];
    const transfers: Transfer[] = [];
    const retrievedAt = new Date().toISOString();
    let newest = 0;
    const read = async (stream: Stream): Promise<Row[]> => {
      const state = cursor[stream];
      const body = row(
        await request(
          explorer.api,
          `addresses/${wallet}/${PATHS[stream]}`,
          state.params,
          stream === "erc20" ? { type: "ERC-20" } : {},
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
      const remaining = after
        ? rows.filter((r) => compare(r.key, after) < 0)
        : rows;
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
    if (!cursor.internal.done) {
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
      const traces = new Map<string, Row[] | null>();
      for (const hash of new Set(listed.map((l) => l.hash))) {
        let frames: unknown;
        try {
          frames = await request(
            explorer.api,
            `transactions/${hash}/raw-trace`,
            null,
          );
        } catch (error) {
          if (
            !(error instanceof ProviderError) ||
            error.code !== "PROVIDER_RESPONSE_TOO_LARGE"
          )
            throw error;
          traces.set(hash, null);
          continue;
        }
        if (!Array.isArray(frames) || !frames.length)
          throw new ProviderError(
            "TRACE_UNAVAILABLE",
            "Blockscout has no call trace yet for a listed internal transfer; no page was committed. Resume later using the saved cursor.",
            true,
          );
        traces.set(hash, frames.length > MAX_FRAMES ? null : frames.map(row));
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
        transfers.push(
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
    }
    if (!query.cursor) cursor.end = newest;
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
      streams: ["native", "erc20", "internal"],
      exhausted,
    };
  }
  return { id: "blockscout-v2", mode: "live", fetchPage };
}
