import type {
  Address,
  TraceProvider,
  TraceQuery,
  Transfer,
  TransferKind,
  TransferPage,
} from "../src/domain/types.ts";
import { keccak256, stringToHex } from "viem";
import {
  address,
  boundedJson,
  integer,
  ProviderError,
  row,
  tokenSymbol,
  type Row,
} from "./history-provider.ts";

export const ALCHEMY_CHAINS = [8453] as const;
const CHAIN_ID = 8453;
const ENDPOINT = "https://base-mainnet.g.alchemy.com/v2/";
const PROVIDER_ID = "alchemy-transfers";
const SOURCE = "Alchemy Transfers API (Base)";
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_PROVIDER_ROWS = 1000;
const MAX_CURSOR = 4096;
const MAX_RECEIPT_LOGS = 2000;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,128}$/;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const INTERNAL_UNAVAILABLE = new Set([
  "TRACE_UNAVAILABLE",
  "PROVIDER_ERROR",
  "ACCESS_DENIED",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "PROVIDER_HTTP_ERROR",
]);
const WARNINGS = [
  "Alchemy Transfers API results are indexed provider evidence, not independent chain verification; reorganizations and indexing gaps remain possible.",
  "NFTs, gas fees, bridge matches and labels are not covered by this adapter.",
  "ERC-20 event identities are checked against transaction receipts; internal value transfers are checked against successful callTracer frames.",
  "Gross transfer flows are not buys, sells, profit, unique capital or proof of ownership.",
];

type Direction = "from" | "to";
type Category = "external" | "erc20" | "internal";
type Stream = "native" | "erc20" | "internal";

interface DirectionState {
  upper: number;
  boundaryBlock: number | null;
  boundaryIds: string[];
  done: boolean;
}

interface Cursor {
  v: 1;
  provider: typeof PROVIDER_ID;
  chain: typeof CHAIN_ID;
  address: string;
  size: number;
  end: number;
  nativeFrom: DirectionState;
  nativeTo: DirectionState;
  erc20From: DirectionState;
  erc20To: DirectionState;
  internalFrom: DirectionState;
  internalTo: DirectionState;
}

interface ParsedRecord {
  raw: Row;
  hash: string;
  from: Address;
  to: Address;
  blockNumber: number;
  rawAmount: string;
  timestamp: string;
  candidateId: string;
  contract: Address | null;
  decimals: number;
  symbol: string;
  direction: Direction;
  kind: Stream;
}

interface Receipt {
  transactionHash: string;
  blockNumber: number;
  status: "0x0" | "0x1";
  logs: Row[];
}

const invalid = (message: string) =>
  new ProviderError("INVALID_PROVIDER_DATA", message);

function hexNumber(value: unknown, message: string): number {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value))
    throw invalid(message);
  try {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    return Number(parsed);
  } catch {
    throw invalid(message);
  }
}

function hexAmount(value: unknown): string {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value))
    throw invalid("Alchemy returned a malformed raw transfer amount.");
  try {
    return BigInt(value).toString();
  } catch {
    throw invalid("Alchemy returned a malformed raw transfer amount.");
  }
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw invalid("Alchemy returned a malformed transaction hash.");
  return value.toLowerCase();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string")
    throw invalid("Alchemy returned a transfer without a block timestamp.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw invalid("Alchemy returned a malformed block timestamp.");
  return new Date(parsed).toISOString();
}

function quantity(value: unknown, message: string): number {
  if (typeof value === "string" && HEX_QUANTITY.test(value))
    return hexNumber(value, message);
  if (typeof value === "string" && /^\d+$/.test(value))
    return integer(value, 255);
  throw invalid(message);
}

function categoryFor(kind: Stream): Category {
  return kind === "native" ? "external" : kind;
}

function stateKey(kind: Stream, direction: Direction): keyof Cursor {
  return `${kind}${direction === "from" ? "From" : "To"}` as keyof Cursor;
}

function freshState(end: number): DirectionState {
  return { upper: end, boundaryBlock: null, boundaryIds: [], done: false };
}

function decodeState(value: unknown): DirectionState {
  const state = row(value);
  if (
    Object.keys(state).length !== 4 ||
    !Number.isSafeInteger(state.upper) ||
    (state.upper as number) < 0 ||
    (state.boundaryBlock !== null &&
      (!Number.isSafeInteger(state.boundaryBlock) ||
        (state.boundaryBlock as number) < 0)) ||
    !Array.isArray(state.boundaryIds) ||
    state.boundaryIds.length > MAX_PROVIDER_ROWS ||
    !state.boundaryIds.every(
      (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
    ) ||
    typeof state.done !== "boolean"
  )
    throw new Error();
  return {
    upper: state.upper as number,
    boundaryBlock: state.boundaryBlock as number | null,
    boundaryIds: [...new Set(state.boundaryIds as string[])],
    done: state.done as boolean,
  };
}

function decodeCursor(value: string, query: TraceQuery, size: number): Cursor {
  try {
    if (value.length > MAX_CURSOR) throw new Error();
    const parsed = row(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (
      Object.keys(parsed).length !== 12 ||
      parsed.v !== 1 ||
      parsed.provider !== PROVIDER_ID ||
      parsed.chain !== CHAIN_ID ||
      parsed.address !== query.address.toLowerCase() ||
      parsed.size !== size ||
      !Number.isSafeInteger(parsed.end) ||
      (parsed.end as number) < 0
    )
      throw new Error();
    const cursor: Cursor = {
      v: 1,
      provider: PROVIDER_ID,
      chain: CHAIN_ID,
      address: parsed.address as string,
      size,
      end: parsed.end as number,
      nativeFrom: decodeState(parsed.nativeFrom),
      nativeTo: decodeState(parsed.nativeTo),
      erc20From: decodeState(parsed.erc20From),
      erc20To: decodeState(parsed.erc20To),
      internalFrom: decodeState(parsed.internalFrom),
      internalTo: decodeState(parsed.internalTo),
    };
    if (
      cursor.end < 0 ||
      [
        cursor.nativeFrom,
        cursor.nativeTo,
        cursor.erc20From,
        cursor.erc20To,
        cursor.internalFrom,
        cursor.internalTo,
      ].every((state) => state.done)
    )
      throw new Error();
    for (const state of [
      cursor.nativeFrom,
      cursor.nativeTo,
      cursor.erc20From,
      cursor.erc20To,
      cursor.internalFrom,
      cursor.internalTo,
    ]) {
      if (
        state.upper > cursor.end ||
        (state.boundaryBlock !== null &&
          (state.boundaryBlock > state.upper ||
            state.boundaryBlock > cursor.end)) ||
        (state.boundaryBlock === null && state.boundaryIds.length > 0) ||
        (state.boundaryBlock !== null && state.boundaryIds.length === 0)
      )
        throw new Error();
    }
    return cursor;
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid cursor or cursor belongs to a different provider, address, chain or page size.",
    );
  }
}

function keyFor(record: ParsedRecord, raw: Row): string {
  const unique = raw.uniqueId;
  if (typeof unique !== "string" || unique.length === 0 || unique.length > 256)
    throw invalid(
      "Alchemy returned a transfer without a bounded unique event identity.",
    );
  return keccak256(stringToHex(`${record.hash}:${record.kind}:${unique}`));
}

function uniqueLogIndex(raw: Row): number | null {
  const unique = raw.uniqueId;
  if (typeof unique !== "string") return null;
  const suffix = unique.slice(unique.lastIndexOf(":") + 1);
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(suffix)) return null;
  try {
    const value = BigInt(suffix);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  } catch {
    return null;
  }
}

function receiptLogAddress(topic: unknown): Address {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic))
    throw invalid("Alchemy returned a malformed indexed transfer address.");
  return address(`0x${topic.slice(-40)}`);
}

function parseReceipt(value: unknown): Receipt {
  const record = row(value);
  const transactionHash = hash(record.transactionHash);
  const status = record.status;
  if (status !== "0x0" && status !== "0x1")
    throw invalid("Alchemy returned a receipt without a valid status.");
  const logs = record.logs;
  if (!Array.isArray(logs) || logs.length > MAX_RECEIPT_LOGS)
    throw new ProviderError(
      "RECEIPT_TOO_LARGE",
      "A Base transaction receipt exceeds the bounded log budget; no page was committed.",
    );
  return {
    transactionHash,
    blockNumber: hexNumber(
      record.blockNumber,
      "Alchemy returned a malformed receipt block.",
    ),
    status,
    logs: logs.map(row),
  };
}

function candidateLog(record: ParsedRecord, receipt: Receipt): Row {
  const candidates = receipt.logs.filter((log) => {
    const topics = log.topics;
    if (
      !Array.isArray(topics) ||
      topics.length < 3 ||
      topics[0] !== TRANSFER_TOPIC
    )
      return false;
    try {
      return (
        address(log.address) === record.contract &&
        receiptLogAddress(topics[1]) === record.from &&
        receiptLogAddress(topics[2]) === record.to &&
        hexAmount(log.data) === record.rawAmount
      );
    } catch {
      return false;
    }
  });
  const knownIndex = uniqueLogIndex(record.raw);
  if (knownIndex !== null) {
    const selected = candidates.find(
      (candidate) =>
        quantity(
          candidate.logIndex,
          "Alchemy returned a malformed ERC-20 log index.",
        ) === knownIndex,
    );
    if (selected) return selected;
    throw new ProviderError(
      "RECEIPT_MISMATCH",
      "The ERC-20 event index in Alchemy's unique identity disagrees with the receipt; no page was committed.",
      true,
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length !== 1)
    throw new ProviderError(
      "RECEIPT_MISMATCH",
      "A Base ERC-20 transfer could not be matched to one canonical receipt log; no page was committed.",
      true,
    );
  return candidates[0];
}

function frameError(frame: Row): boolean {
  return (
    frame.error != null || frame.revertReason != null || frame.failed === true
  );
}

interface TraceMatch {
  path: string;
  from: Address;
  to: Address;
  value: string;
}

function traceMatches(value: unknown, record: ParsedRecord): TraceMatch[] {
  const matches: TraceMatch[] = [];
  let frames = 0;
  function walk(
    frameValue: unknown,
    path: string,
    failedParent: boolean,
    depth: number,
  ): void {
    if (depth > 32)
      throw new ProviderError(
        "TRACE_UNAVAILABLE",
        "Base call trace exceeds the bounded depth; the internal stream remains uncovered.",
        true,
      );
    if (++frames > 5000)
      throw new ProviderError(
        "TRACE_UNAVAILABLE",
        "Base call trace exceeds the bounded frame budget; the internal stream remains uncovered.",
        true,
      );
    const frame = row(frameValue);
    const failed = failedParent || frameError(frame);
    const type =
      typeof frame.type === "string" ? frame.type.toLowerCase() : "call";
    if (type === "call" && frame.value !== undefined) {
      let valueAmount: string;
      try {
        valueAmount = hexAmount(frame.value);
      } catch {
        throw new ProviderError(
          "TRACE_MISMATCH",
          "Alchemy returned a malformed value in a Base call trace; no page was committed.",
          true,
        );
      }
      let from: Address;
      let to: Address;
      try {
        from = address(frame.from);
        to = address(frame.to);
      } catch {
        throw new ProviderError(
          "TRACE_MISMATCH",
          "Alchemy returned a malformed call frame in a Base trace; no page was committed.",
          true,
        );
      }
      if (valueAmount !== "0") {
        if (
          !failed &&
          path !== "trace" &&
          valueAmount === record.rawAmount &&
          from === record.from &&
          to === record.to
        )
          matches.push({ path, from, to, value: valueAmount });
      }
    }
    if (frame.calls !== undefined && !Array.isArray(frame.calls))
      throw new ProviderError(
        "TRACE_MISMATCH",
        "Alchemy returned malformed child calls in a Base trace; no page was committed.",
        true,
      );
    if (Array.isArray(frame.calls))
      frame.calls.forEach((child, index) =>
        walk(child, `${path}.${index}`, failed, depth + 1),
      );
  }
  walk(value, "trace", false, 0);
  return matches;
}

/** Bounded Base Transfers API provider. The API key stays in the request URL only. */
export function createAlchemyProvider(
  options: { apiKey?: string; fetch?: typeof fetch; intervalMs?: number } = {},
): TraceProvider {
  const fetcher = options.fetch ?? fetch;
  const apiKey = (options.apiKey ?? process.env.ALCHEMY_API_KEY ?? "").trim();
  const interval = options.intervalMs ?? 250;
  if (!Number.isSafeInteger(interval) || interval < 0)
    throw new TypeError("intervalMs must be a non-negative integer.");
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  async function request(method: string, params: unknown[]): Promise<unknown> {
    const task = queue.then(async () => {
      const wait = Math.max(0, lastCall + interval - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = Date.now();
      const url = `${ENDPOINT}${encodeURIComponent(apiKey)}`;
      try {
        const response = await fetcher(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (response.status === 429)
          throw new ProviderError(
            "RATE_LIMITED",
            "Alchemy rate limit reached; resume later using the saved cursor.",
            true,
          );
        if (response.status === 401 || response.status === 403)
          throw new ProviderError(
            "ACCESS_DENIED",
            "Alchemy denied access for this key or Base plan; this is not evidence of no activity.",
          );
        if (!response.ok)
          throw new ProviderError(
            "PROVIDER_HTTP_ERROR",
            `Alchemy returned HTTP ${response.status}; no page was committed.`,
            response.status >= 500,
          );
        const root = row(await boundedJson(response, MAX_RESPONSE_BYTES));
        const error = row(root.error);
        if (Object.keys(error).length) {
          const detail = String(error.message ?? "").toLowerCase();
          if (
            method === "debug_traceTransaction" &&
            /method|not supported|trace|debug/.test(detail)
          )
            throw new ProviderError(
              "TRACE_UNAVAILABLE",
              "Alchemy did not provide a call trace for this Base transaction; internal coverage remains explicit.",
              true,
            );
          if (/rate limit|too many/.test(detail))
            throw new ProviderError(
              "RATE_LIMITED",
              "Alchemy rate limit reached; resume later using the saved cursor.",
              true,
            );
          if (
            /api key|unauthorized|forbidden|not authorized|access/.test(detail)
          )
            throw new ProviderError(
              "ACCESS_DENIED",
              "Alchemy denied access for this key or Base plan; this is not evidence of no activity.",
            );
          throw new ProviderError(
            "PROVIDER_ERROR",
            "Alchemy rejected this request; no page was committed.",
          );
        }
        return root.result;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "NETWORK_ERROR",
          "Alchemy request failed or timed out; no page was committed. Resume later.",
          true,
        );
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }

  async function receipt(
    txHash: string,
    receiptCache: Map<string, Receipt>,
  ): Promise<Receipt> {
    const cached = receiptCache.get(txHash);
    if (cached) return cached;
    const parsed = parseReceipt(
      await request("eth_getTransactionReceipt", [txHash]),
    );
    if (parsed.transactionHash !== txHash)
      throw new ProviderError(
        "RECEIPT_MISMATCH",
        "Alchemy returned a receipt for a different transaction; no page was committed.",
        true,
      );
    receiptCache.set(txHash, parsed);
    return parsed;
  }

  async function trace(
    txHash: string,
    traceCache: Map<string, unknown>,
  ): Promise<unknown> {
    const cached = traceCache.get(txHash);
    if (cached !== undefined) return cached;
    const value = await request("debug_traceTransaction", [
      txHash,
      { tracer: "callTracer" },
    ]);
    traceCache.set(txHash, value);
    return value;
  }

  function parseRecord(
    raw: Row,
    kind: Stream,
    direction: Direction,
    wallet: Address,
  ): ParsedRecord {
    const hashValue = hash(raw.hash);
    const from = address(raw.from);
    const to = address(raw.to);
    if ((direction === "from" ? from : to) !== wallet)
      throw invalid(
        "Alchemy returned a transfer outside the requested wallet direction.",
      );
    const blockNumber = hexNumber(
      raw.blockNum,
      "Alchemy returned a malformed transfer block.",
    );
    const rawContract = row(raw.rawContract);
    const amount = hexAmount(rawContract.value);
    const metadata = row(raw.metadata);
    const parsed: ParsedRecord = {
      raw,
      hash: hashValue,
      from,
      to,
      blockNumber,
      rawAmount: amount,
      timestamp: timestamp(metadata.blockTimestamp),
      candidateId: "",
      contract: null,
      decimals: 18,
      symbol: "ETH",
      direction,
      kind,
    };
    if (kind === "erc20") {
      parsed.contract = address(rawContract.address);
      parsed.decimals = quantity(
        rawContract.decimal,
        "Alchemy returned an ERC-20 transfer without decimals.",
      );
      parsed.symbol = tokenSymbol(raw.asset);
    }
    parsed.candidateId = keyFor(parsed, raw);
    return parsed;
  }

  async function transferFromRecord(
    record: ParsedRecord,
    retrievedAt: string,
    receiptCache: Map<string, Receipt>,
    traceCache: Map<string, unknown>,
  ): Promise<Transfer | null> {
    if (record.rawAmount === "0") return null;
    if (record.kind === "erc20") {
      const receiptValue = await receipt(record.hash, receiptCache);
      if (receiptValue.blockNumber !== record.blockNumber)
        throw new ProviderError(
          "RECEIPT_MISMATCH",
          "Alchemy ERC-20 receipt block does not match the transfer index; no page was committed.",
          true,
        );
      if (receiptValue.status === "0x0") return null;
      const log = candidateLog(record, receiptValue);
      const logIndex = hexNumber(
        log.logIndex,
        "Alchemy returned an ERC-20 log without an index.",
      );
      return {
        id: `${CHAIN_ID}:${record.hash}:erc20:${logIndex}:${record.contract}`,
        chainId: CHAIN_ID,
        hash: record.hash,
        kind: "erc20",
        eventIndex: String(logIndex),
        from: record.from,
        to: record.to,
        asset: {
          chainId: CHAIN_ID,
          contract: record.contract,
          decimals: record.decimals,
          symbol: record.symbol,
        },
        rawAmount: record.rawAmount,
        timestamp: record.timestamp,
        blockNumber: record.blockNumber,
        status: "success",
        source: SOURCE,
        retrievedAt,
      };
    }
    if (record.kind === "internal") {
      const receiptValue = await receipt(record.hash, receiptCache);
      if (receiptValue.blockNumber !== record.blockNumber)
        throw new ProviderError(
          "RECEIPT_MISMATCH",
          "Alchemy internal receipt block does not match the transfer index; no page was committed.",
          true,
        );
      if (receiptValue.status === "0x0") return null;
      const matches = traceMatches(
        await trace(record.hash, traceCache),
        record,
      );
      if (matches.length !== 1)
        throw new ProviderError(
          "TRACE_MISMATCH",
          "Alchemy call trace does not identify one canonical successful internal frame; no page was committed.",
          true,
        );
      const match = matches[0];
      return {
        id: `${CHAIN_ID}:${record.hash}:internal:${match.path}:native`,
        chainId: CHAIN_ID,
        hash: record.hash,
        kind: "internal",
        eventIndex: match.path,
        from: record.from,
        to: record.to,
        asset: {
          chainId: CHAIN_ID,
          contract: null,
          decimals: 18,
          symbol: "ETH",
        },
        rawAmount: record.rawAmount,
        timestamp: record.timestamp,
        blockNumber: record.blockNumber,
        status: "success",
        source: SOURCE,
        retrievedAt,
      };
    }
    const receiptValue = await receipt(record.hash, receiptCache);
    if (receiptValue.blockNumber !== record.blockNumber)
      throw new ProviderError(
        "RECEIPT_MISMATCH",
        "Alchemy native receipt block does not match the transfer index; no page was committed.",
        true,
      );
    if (receiptValue.status === "0x0") return null;
    return {
      id: `${CHAIN_ID}:${record.hash}:native:0:native`,
      chainId: CHAIN_ID,
      hash: record.hash,
      kind: "native",
      eventIndex: "0",
      from: record.from,
      to: record.to,
      asset: { chainId: CHAIN_ID, contract: null, decimals: 18, symbol: "ETH" },
      rawAmount: record.rawAmount,
      timestamp: record.timestamp,
      blockNumber: record.blockNumber,
      status: "success",
      source: SOURCE,
      retrievedAt,
    };
  }

  async function fetchDirection(
    state: DirectionState,
    kind: Stream,
    direction: Direction,
    wallet: Address,
    size: number,
  ): Promise<ParsedRecord[]> {
    if (state.done) return [];
    const params: Row = {
      fromBlock: "0x0",
      toBlock: `0x${state.upper.toString(16)}`,
      maxCount: "0x3e8",
      excludeZeroValue: true,
      withMetadata: true,
      category: [categoryFor(kind)],
      [direction === "from" ? "fromAddress" : "toAddress"]: wallet,
      order: "desc",
    };
    const result = row(await request("alchemy_getAssetTransfers", [params]));
    const values = result.transfers;
    if (!Array.isArray(values) || values.length > MAX_PROVIDER_ROWS)
      throw invalid("Alchemy returned an invalid transfer page.");
    const pageKey = result.pageKey;
    const providerHasMore =
      pageKey !== undefined && pageKey !== null && pageKey !== "";
    if (providerHasMore && typeof pageKey !== "string")
      throw invalid("Alchemy returned malformed pagination state.");
    const parsed = values.map((value) =>
      parseRecord(row(value), kind, direction, wallet),
    );
    const expectedCategory = categoryFor(kind);
    for (const value of parsed) {
      if (value.raw.category !== expectedCategory)
        throw invalid(
          "Alchemy returned a transfer outside the requested category.",
        );
      if (value.blockNumber > state.upper)
        throw invalid(
          "Alchemy returned a transfer beyond the frozen Base history window.",
        );
    }
    if (
      parsed.some(
        (value, index) =>
          index > 0 && value.blockNumber > parsed[index - 1].blockNumber,
      )
    )
      throw invalid(
        "Alchemy returned transfer rows out of order; no page was committed.",
      );
    const unseen = parsed.filter(
      (value) =>
        !(
          state.boundaryBlock === value.blockNumber &&
          state.boundaryIds.includes(value.candidateId)
        ),
    );
    if (unseen.length === 0) {
      if (!providerHasMore && parsed.length < MAX_PROVIDER_ROWS) {
        state.done = true;
        return [];
      }
      throw new ProviderError(
        "PAGINATION_LIMIT",
        "Alchemy returned a full page already consumed at one block boundary; the short-lived page key was intentionally not persisted, so this stream stopped without skipping events.",
      );
    }
    const selected = unseen.slice(0, size);
    const last = selected[selected.length - 1];
    if (!last) throw invalid("Alchemy returned an unusable transfer page.");
    state.upper = last.blockNumber;
    if (state.boundaryBlock === last.blockNumber)
      state.boundaryIds = [
        ...new Set([
          ...state.boundaryIds,
          ...selected
            .filter((value) => value.blockNumber === last.blockNumber)
            .map((value) => value.candidateId),
        ]),
      ];
    else {
      state.boundaryBlock = last.blockNumber;
      state.boundaryIds = selected
        .filter((value) => value.blockNumber === last.blockNumber)
        .map((value) => value.candidateId);
    }
    if (
      !providerHasMore &&
      parsed.length < MAX_PROVIDER_ROWS &&
      unseen.length <= size
    )
      state.done = true;
    return selected;
  }

  async function fetchPage(query: TraceQuery): Promise<TransferPage> {
    if (!apiKey)
      throw new ProviderError(
        "KEY_REQUIRED",
        "Set ALCHEMY_API_KEY in the local server environment to enable Base history.",
      );
    if (query.chainId !== CHAIN_ID)
      throw new ProviderError(
        "UNSUPPORTED_CHAIN",
        "Alchemy history is enabled only for Base (8453) in this adapter.",
      );
    const wallet = address(query.address);
    let size = query.pageSize ?? 10;
    if (query.cursor && query.pageSize === undefined) {
      try {
        size = Number(
          JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
            .size,
        );
      } catch {
        /* decodeCursor reports the boundary error below. */
      }
    }
    if (!Number.isSafeInteger(size) || size < 1 || size > 10)
      throw new ProviderError(
        "INVALID_PAGE_SIZE",
        "Live page size must be an integer from 1 to 10 rows per stream.",
      );
    const anchor = query.cursor ? null : await request("eth_blockNumber", []);
    const end = anchor
      ? hexNumber(anchor, "Alchemy did not return a valid Base block anchor.")
      : 0;
    const cursor: Cursor = query.cursor
      ? decodeCursor(query.cursor, query, size)
      : {
          v: 1,
          provider: PROVIDER_ID,
          chain: CHAIN_ID,
          address: wallet,
          size,
          end,
          nativeFrom: freshState(end),
          nativeTo: freshState(end),
          erc20From: freshState(end),
          erc20To: freshState(end),
          internalFrom: freshState(end),
          internalTo: freshState(end),
        };
    const retrievedAt = new Date().toISOString();
    const warnings = [
      ...WARNINGS,
      `Frozen Base history window: block 0 through ${cursor.end}; newer activity requires a new investigation.`,
    ];
    const transfers = new Map<string, Transfer>();
    const receiptCache = new Map<string, Receipt>();
    const traceCache = new Map<string, unknown>();
    const streams: TransferKind[] = [];
    const directKinds: Stream[] = ["native", "erc20"];
    for (const kind of directKinds) {
      let hadRows = false;
      for (const direction of ["from", "to"] as Direction[]) {
        const state = cursor[stateKey(kind, direction)] as DirectionState;
        const records = await fetchDirection(
          state,
          kind,
          direction,
          wallet,
          size,
        );
        if (records.length) hadRows = true;
        for (const record of records) {
          const transfer = await transferFromRecord(
            record,
            retrievedAt,
            receiptCache,
            traceCache,
          );
          if (transfer) transfers.set(transfer.id, transfer);
        }
      }
      if (
        hadRows ||
        (["from", "to"] as Direction[]).some(
          (direction) =>
            !(cursor[stateKey(kind, direction)] as DirectionState).done,
        )
      )
        streams.push(kind);
    }
    const directTransferIds = new Set(transfers.keys());
    const internalBefore = {
      from: structuredClone(cursor.internalFrom),
      to: structuredClone(cursor.internalTo),
    };
    try {
      let hadRows = false;
      for (const direction of ["from", "to"] as Direction[]) {
        const state = cursor[stateKey("internal", direction)] as DirectionState;
        const records = await fetchDirection(
          state,
          "internal",
          direction,
          wallet,
          size,
        );
        if (records.length) hadRows = true;
        for (const record of records) {
          const transfer = await transferFromRecord(
            record,
            retrievedAt,
            receiptCache,
            traceCache,
          );
          if (transfer) transfers.set(transfer.id, transfer);
        }
      }
      if (
        hadRows ||
        (["from", "to"] as Direction[]).some(
          (direction) =>
            !(cursor[stateKey("internal", direction)] as DirectionState).done,
        )
      )
        streams.push("internal");
    } catch (error) {
      if (
        !(error instanceof ProviderError) ||
        !INTERNAL_UNAVAILABLE.has(error.code) ||
        directTransferIds.size === 0
      )
        throw error;
      for (const id of transfers.keys())
        if (!directTransferIds.has(id)) transfers.delete(id);
      cursor.internalFrom = internalBefore.from;
      cursor.internalTo = internalBefore.to;
      warnings.push(
        "Base internal-transfer coverage was unavailable for this page; native and ERC-20 rows were retained and the internal cursor was left unchanged for a later resume.",
      );
    }
    const states = [
      cursor.nativeFrom,
      cursor.nativeTo,
      cursor.erc20From,
      cursor.erc20To,
      cursor.internalFrom,
      cursor.internalTo,
    ];
    const exhausted = states.every((state) => state.done);
    if (exhausted)
      warnings.push(
        "Configured Base streams returned terminal pages; this does not establish complete wallet history.",
      );
    const next = exhausted
      ? null
      : Buffer.from(JSON.stringify(cursor)).toString("base64url");
    if (next && next.length > MAX_CURSOR)
      throw new ProviderError(
        "PAGINATION_LIMIT",
        "Alchemy pagination state reached the bounded cursor budget; the stream stopped without skipping events.",
      );
    const nodes = [
      ...new Set(
        [...transfers.values()].flatMap((value) => [value.from, value.to]),
      ),
    ].map((address) => ({ address, chainId: CHAIN_ID }));
    return {
      transfers: [...transfers.values()],
      nodes,
      cursor: next,
      warnings: [...new Set(warnings)],
      streams,
      exhausted,
    };
  }

  return { id: PROVIDER_ID, mode: "live", fetchPage };
}
