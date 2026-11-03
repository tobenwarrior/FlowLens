import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import {
  createEtherscanProvider,
  ProviderError,
  type EtherscanActionRequest,
} from "./etherscan.ts";
import {
  baseInternalTraceProvider,
  createBaseInternalRpcClient,
  internalRecordFingerprint,
  parseBaseInternalRecord,
  parseBaseReceiptMetadata,
  parseBaseTransactionMetadata,
  traceBaseInternalRecord,
} from "./base-internal.ts";
import type { RpcClient } from "./rpc.ts";
import { row, type Row } from "./history-provider.ts";
import type {
  TraceQuery,
  Transfer,
  TransferKind,
} from "../src/domain/types.ts";

export const ETHERSCAN_MCP_ENDPOINT =
  "https://mcp-keyless.etherscan.io/mcp" as const;
export const ETHERSCAN_MCP_CHAIN = 8453 as const;
export const ETHERSCAN_MCP_PROVIDER_ID = "etherscan-mcp-keyless-v1" as const;
export const ETHERSCAN_MCP_V2_PROVIDER_ID = "etherscan-mcp-keyless-v2" as const;
const MAX_RESPONSE_BYTES = 8_000_000;
const REQUEST_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;
type Pacer = { intervalMs: number; lastCallAt: number };

type CallTool = (
  name: string,
  arguments_: Record<string, unknown>,
) => Promise<unknown>;

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return MAX_RESPONSE_BYTES + 1;
  }
}

function responseTooLarge(): ProviderError {
  return new ProviderError(
    "PROVIDER_RESPONSE_TOO_LARGE",
    `Keyless Etherscan provider response exceeds the ${MAX_RESPONSE_BYTES / 1_000_000} MB byte budget; no page was committed.`,
  );
}

function withInternalCause<T extends ProviderError>(
  error: T,
  cause: unknown,
): T {
  Object.defineProperty(error, "cause", {
    value: cause,
    configurable: true,
    enumerable: false,
  });
  return error;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function boundedBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let settled = false;
  let onAbort: (() => void) | undefined;
  const removeAbortListener = () => {
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    onAbort = undefined;
  };
  const cancelReader = async (reason?: unknown) => {
    if (settled) return;
    settled = true;
    removeAbortListener();
    await reader.cancel(reason).catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settled = true;
          removeAbortListener();
          reader.releaseLock();
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await cancelReader();
          controller.error(responseTooLarge());
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        await cancelReader(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelReader(reason);
    },
  });
  if (signal) {
    onAbort = () => {
      void cancelReader(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return stream;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function pace(
  pacer: Pacer,
  signal: AbortSignal | undefined,
): Promise<void> {
  const wait = Math.max(0, pacer.lastCallAt + pacer.intervalMs - Date.now());
  if (wait) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Request aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  pacer.lastCallAt = Date.now();
}

function isToolCall(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== "string") return false;
  try {
    return row(JSON.parse(init.body)).method === "tools/call";
  } catch {
    return false;
  }
}

function fixedUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function httpFailure(status: number): ProviderError {
  if (status === 429)
    return new ProviderError(
      "RATE_LIMITED",
      "Keyless Etherscan provider rate limit reached; resume later using the saved cursor.",
      true,
    );
  if (status === 401 || status === 402 || status === 403)
    return new ProviderError(
      "ACCESS_DENIED",
      "Keyless Etherscan provider denied this request; this is not evidence of no activity.",
    );
  if (status >= 300 && status < 400)
    return new ProviderError(
      "NETWORK_ERROR",
      "Keyless Etherscan provider returned a redirect; no page was committed.",
      true,
    );
  return new ProviderError(
    "PROVIDER_HTTP_ERROR",
    `Keyless Etherscan provider returned HTTP ${status}; no page was committed.`,
    status >= 500,
  );
}

function boundedFetch(
  baseFetch: Fetcher,
  timeoutMs: number,
  pacer?: Pacer,
): Fetcher {
  return async (input, init) => {
    let url: URL;
    try {
      url = fixedUrl(input);
    } catch {
      throw new ProviderError(
        "NETWORK_ERROR",
        "Keyless Etherscan provider request URL was invalid; no page was committed.",
        true,
      );
    }
    const endpoint = new URL(ETHERSCAN_MCP_ENDPOINT);
    if (url.href !== endpoint.href) {
      throw new ProviderError(
        "NETWORK_ERROR",
        "Keyless Etherscan provider request URL is outside the fixed official endpoint.",
        true,
      );
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST")
      // Streamable HTTP may probe an SSE GET; FlowLens deliberately does not subscribe.
      return new Response(null, { status: 405 });
    if (pacer && isToolCall(init)) await pace(pacer, init?.signal ?? undefined);
    const requestInit: RequestInit = {
      ...init,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    };
    const response = await baseFetch(input, requestInit);
    if (!response.ok) {
      await cancelBody(response);
      throw httpFailure(response.status);
    }
    const declared = response.headers.get("content-length");
    if (
      declared &&
      Number.isFinite(Number(declared)) &&
      Number(declared) > MAX_RESPONSE_BYTES
    ) {
      await cancelBody(response);
      throw responseTooLarge();
    }
    if (!response.body) return response;
    return new Response(
      boundedBody(response.body, requestInit.signal ?? undefined),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

function parseTextPayload(result: CallToolResult): unknown {
  const content = row(result).content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const block = row(item);
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      return JSON.parse(block.text);
    } catch {
      // The structured result below is preferred; a non-JSON text block is not data.
    }
  }
  return undefined;
}

function payloadOf(result: unknown): unknown {
  const value = row(result);
  const structured = value.structuredContent;
  const structuredValue = row(structured);
  const candidate =
    structuredValue.data !== undefined
      ? structuredValue.data
      : structured !== undefined
        ? structured
        : parseTextPayload(value as CallToolResult);
  const candidateRow = row(candidate);
  return candidateRow.data !== undefined ? candidateRow.data : candidate;
}

function detailOf(value: unknown): string {
  const candidate = payloadOf(value);
  const body = row(candidate ?? value);
  const result = body.result;
  return `${body.message ?? ""} ${body.error ?? ""} ${typeof result === "string" ? result : ""}`.toLowerCase();
}

function providerFailure(value: unknown): ProviderError {
  const detail = detailOf(value);
  if (detail.includes("rate limit") || detail.includes("too many requests"))
    return new ProviderError(
      "RATE_LIMITED",
      "Keyless Etherscan provider rate limit reached; resume later using the saved cursor.",
      true,
    );
  if (
    detail.includes("unauthorized") ||
    detail.includes("access denied") ||
    detail.includes("not supported") ||
    detail.includes("upgrade")
  )
    return new ProviderError(
      "ACCESS_DENIED",
      "Keyless Etherscan provider denied this chain or operation; this is not evidence of no activity.",
    );
  return new ProviderError(
    "PROVIDER_ERROR",
    "Keyless Etherscan provider rejected this request; no page was committed.",
  );
}

function normalizeBody(value: unknown): Record<string, unknown> {
  if (row(value).isError === true) throw providerFailure(value);
  const payload = payloadOf(value);
  if (Array.isArray(payload)) return { status: "1", result: payload };
  const body = row(payload);
  if (body.ok === false || body.isError === true) throw providerFailure(value);
  if (body.status === "0") {
    const detail = detailOf(body);
    if (
      detail.includes("no transactions found") ||
      detail.includes("no records found")
    )
      return { status: "1", result: [] };
    throw providerFailure(body);
  }
  if (body.result !== undefined) return body;
  return { status: "1", result: body };
}

function blockNumber(value: unknown): string {
  const body = row(value);
  const nested = row(body.result);
  const candidate =
    body.blockNumber ??
    body.block_number ??
    body.block ??
    nested.blockNumber ??
    nested.block_number ??
    nested.block ??
    body.result;
  if (typeof candidate !== "number" && typeof candidate !== "string")
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Keyless Etherscan provider did not return a valid block anchor.",
    );
  try {
    const parsed = BigInt(candidate);
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error();
    return `0x${parsed.toString(16)}`;
  } catch {
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Keyless Etherscan provider did not return a valid block anchor.",
    );
  }
}

function actionArgs(
  parameters: Record<string, string>,
): Record<string, unknown> {
  const chainid = parameters.chainid ?? String(ETHERSCAN_MCP_CHAIN);
  const common = {
    address: parameters.address,
    chainid,
    startblock: Number(parameters.startblock ?? "0"),
    endblock: Number(parameters.endblock ?? "0"),
    page: Number(parameters.page ?? "1"),
    offset: Number(parameters.offset ?? "10"),
    sort: parameters.sort ?? "desc",
  };
  return common;
}

export function createEtherscanMcpRequest(options: {
  callTool: CallTool;
}): EtherscanActionRequest {
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const result = await options.callTool(name, arguments_);
    if (jsonSize(result) > MAX_RESPONSE_BYTES) throw responseTooLarge();
    return result;
  };
  return async (chainId, parameters) => {
    if (chainId !== ETHERSCAN_MCP_CHAIN)
      throw new ProviderError(
        "UNSUPPORTED_CHAIN",
        "The keyless Etherscan MCP route supports Base (8453) only.",
      );
    const module = parameters.module;
    const action = parameters.action;
    if (module === "proxy" && action === "eth_blockNumber") {
      const result = await call("get_block_by_timestamp", {
        chainid: String(chainId),
        timestamp: Math.floor(Date.now() / 1000),
        closest: "before",
      });
      const body = normalizeBody(result);
      return { status: "1", result: blockNumber(body) };
    }
    if (module === "account" && action === "txlist") {
      const result = await call("get_transactions", actionArgs(parameters));
      return normalizeBody(result);
    }
    if (module === "account" && action === "txlistinternal") {
      const result = await call(
        "get_internal_transactions",
        actionArgs(parameters),
      );
      return normalizeBody(result);
    }
    if (module === "account" && action === "tokentx") {
      const result = await call("get_token_transfers", {
        ...actionArgs(parameters),
        standard: "erc20",
      });
      return normalizeBody(result);
    }
    if (module === "proxy" && action === "eth_getTransactionReceipt") {
      const result = await call("get_transaction_receipt", {
        chainid: String(chainId),
        txhash: parameters.txhash,
      });
      const body = normalizeBody(result);
      return { status: "1", result: body.result };
    }
    if (module === "proxy" && action === "eth_getTransactionByHash") {
      const result = await call("get_transaction_by_hash", {
        chainid: String(chainId),
        txhash: parameters.txhash,
      });
      const body = normalizeBody(result);
      return { status: "1", result: body.result };
    }
    throw new ProviderError(
      "UNSUPPORTED_OPERATION",
      "The keyless Etherscan MCP route does not expose this history operation.",
    );
  };
}

type SdkCallTool = CallTool & { close: () => Promise<void> };

function createSdkCallTool(options: {
  fetch?: Fetcher;
  timeoutMs: number;
  signal: AbortSignal;
  pacer: Pacer;
}): SdkCallTool {
  let session: Promise<{ client: Client }> | undefined;
  const connect = async () => {
    const client = new Client({ name: "flowlens", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(ETHERSCAN_MCP_ENDPOINT),
      {
        fetch: boundedFetch(
          options.fetch ?? fetch,
          options.timeoutMs,
          options.pacer,
        ),
        redirectPolicy: "same-origin",
        reconnectionOptions: {
          maxReconnectionDelay: 0,
          initialReconnectionDelay: 0,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
        requestInit: { redirect: "error", signal: options.signal },
      },
    );
    await client.connect(transport, {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxTotalTimeout: options.timeoutMs,
    });
    return { client };
  };
  const close = async () => {
    const active = await session?.catch(() => undefined);
    session = undefined;
    await active?.client.close().catch(() => undefined);
  };
  let queue: Promise<unknown> = Promise.resolve();
  const callTool: CallTool = (name, arguments_) => {
    const task = queue.then(async () => {
      const active = (session ??= connect());
      try {
        const { client } = await active;
        const result = await client.callTool(
          { name, arguments: arguments_ },
          {
            signal: options.signal,
            timeout: options.timeoutMs,
            maxTotalTimeout: options.timeoutMs,
          },
        );
        if (jsonSize(result) > MAX_RESPONSE_BYTES) throw responseTooLarge();
        if (result.isError === true) throw providerFailure(result);
        return result;
      } catch (error) {
        await close();
        if (error instanceof ProviderError) throw error;
        throw withInternalCause(
          new ProviderError(
            "NETWORK_ERROR",
            "Keyless Etherscan provider request failed or timed out; no page was committed. Resume later.",
            true,
          ),
          error,
        );
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };
  return Object.assign(callTool, { close });
}

export function createEtherscanMcpProvider(
  options: {
    request?: EtherscanActionRequest;
    fetch?: Fetcher;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  if (options.request)
    return createEtherscanProvider({
      request: options.request,
      chains: [ETHERSCAN_MCP_CHAIN],
      id: ETHERSCAN_MCP_PROVIDER_ID,
      source: "Etherscan MCP keyless",
      cursorProvider: ETHERSCAN_MCP_PROVIDER_ID,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxReceiptLogs: 10_000,
    });
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs >= 1
      ? Math.floor(options.timeoutMs)
      : REQUEST_TIMEOUT_MS;
  const pacer: Pacer = { intervalMs, lastCallAt: 0 };
  let pageQueue: Promise<unknown> = Promise.resolve();
  const fetchPage = (query: TraceQuery) => {
    const task = pageQueue.then(async () => {
      const pageController = new AbortController();
      const timeout = setTimeout(() => pageController.abort(), PAGE_TIMEOUT_MS);
      const callTool = createSdkCallTool({
        fetch: options.fetch,
        timeoutMs,
        signal: pageController.signal,
        pacer,
      });
      const request = createEtherscanMcpRequest({ callTool });
      const provider = createEtherscanProvider({
        request,
        chains: [ETHERSCAN_MCP_CHAIN],
        id: ETHERSCAN_MCP_PROVIDER_ID,
        source: "Etherscan MCP keyless",
        cursorProvider: ETHERSCAN_MCP_PROVIDER_ID,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxReceiptLogs: 10_000,
      });
      try {
        return await provider.fetchPage(query);
      } finally {
        clearTimeout(timeout);
        pageController.abort();
        await callTool.close();
      }
    });
    pageQueue = task.catch(() => undefined);
    return task;
  };
  return {
    id: ETHERSCAN_MCP_PROVIDER_ID,
    mode: "live" as const,
    fetchPage,
  };
}

type V2Cursor = {
  v: 2;
  provider: typeof ETHERSCAN_MCP_V2_PROVIDER_ID;
  chain: typeof ETHERSCAN_MCP_CHAIN;
  address: string;
  size: number;
  end: number;
  phase: "root" | "internal";
  root: string | null;
  rootDone: boolean;
  internalPage: number;
  internalDone: boolean;
  traceProvider: "blockmachine" | "publicnode";
  internalLast: { block: number; fingerprint: string } | null;
};

export interface EtherscanMcpV2Options {
  request?: EtherscanActionRequest;
  fetch?: Fetcher;
  intervalMs?: number;
  timeoutMs?: number;
  internalRpc?: RpcClient;
  internalRpcFactory?: () => RpcClient;
}

const INTERNAL_PAGE_SIZE = 1;
const MAX_INTERNAL_PAGES = 10_000;
const MAX_V2_CURSOR = 4096;
const MIN_INTERNAL_RPC_MS = 1_000;

/** The abort timer is advisory; the elapsed deadline remains authoritative. */
export function basePageDeadlineExpired(
  startedAt: number,
  now = Date.now(),
): boolean {
  return now - startedAt >= PAGE_TIMEOUT_MS;
}

function validBlockAnchor(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Keyless Etherscan provider did not return a valid Base block anchor.",
    );
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error();
    return Number(parsed);
  } catch {
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Keyless Etherscan provider did not return a valid Base block anchor.",
    );
  }
}

function encodeV2Cursor(cursor: V2Cursor): string {
  const value = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (value.length > MAX_V2_CURSOR)
    throw new ProviderError(
      "PAGINATION_LIMIT",
      "Base history pagination state exceeds the bounded cursor budget; no page was committed.",
    );
  return value;
}

function decodeV2Cursor(
  value: string,
  query: TraceQuery,
  size: number,
): V2Cursor {
  try {
    if (value.length > MAX_V2_CURSOR) throw new Error();
    const parsed = row(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    const internalLast =
      parsed.internalLast === null ? null : row(parsed.internalLast);
    if (
      parsed.v !== 2 ||
      parsed.provider !== ETHERSCAN_MCP_V2_PROVIDER_ID ||
      parsed.chain !== ETHERSCAN_MCP_CHAIN ||
      parsed.address !== query.address.toLowerCase() ||
      parsed.size !== size ||
      !Number.isSafeInteger(parsed.end) ||
      (parsed.end as number) < 0 ||
      (parsed.phase !== "root" && parsed.phase !== "internal") ||
      (parsed.root !== null && typeof parsed.root !== "string") ||
      (parsed.root !== null && parsed.root.length > 1024) ||
      typeof parsed.rootDone !== "boolean" ||
      !Number.isSafeInteger(parsed.internalPage) ||
      (parsed.internalPage as number) < 1 ||
      (parsed.internalPage as number) > MAX_INTERNAL_PAGES + 1 ||
      typeof parsed.internalDone !== "boolean" ||
      (parsed.traceProvider !== "blockmachine" &&
        parsed.traceProvider !== "publicnode") ||
      (internalLast !== null &&
        (!Number.isSafeInteger(internalLast.block) ||
          (internalLast.block as number) < 0 ||
          typeof internalLast.fingerprint !== "string" ||
          (internalLast.fingerprint as string).length > 512)) ||
      parsed.traceProvider !== baseInternalTraceProvider() ||
      (parsed.rootDone && parsed.root !== null) ||
      (!parsed.rootDone && parsed.root === null) ||
      (parsed.phase === "root" && parsed.rootDone) ||
      (parsed.phase === "root" && !parsed.internalDone) ||
      (parsed.phase === "internal" && parsed.internalDone)
    )
      throw new Error();
    if (!parsed.rootDone) {
      const nested = row(
        JSON.parse(
          Buffer.from(parsed.root as string, "base64url").toString("utf8"),
        ),
      );
      if (
        nested.v !== 1 ||
        nested.provider !== ETHERSCAN_MCP_PROVIDER_ID ||
        nested.chain !== ETHERSCAN_MCP_CHAIN ||
        nested.address !== parsed.address ||
        nested.size !== parsed.size ||
        !Number.isSafeInteger(nested.end) ||
        nested.end !== parsed.end
      )
        throw new Error();
    }
    return {
      v: 2,
      provider: ETHERSCAN_MCP_V2_PROVIDER_ID,
      chain: ETHERSCAN_MCP_CHAIN,
      address: parsed.address as string,
      size: parsed.size as number,
      end: parsed.end as number,
      phase: parsed.phase as "root" | "internal",
      root: parsed.root as string | null,
      rootDone: parsed.rootDone as boolean,
      internalPage: parsed.internalPage as number,
      internalDone: parsed.internalDone as boolean,
      traceProvider: parsed.traceProvider as "blockmachine" | "publicnode",
      internalLast: internalLast as {
        block: number;
        fingerprint: string;
      } | null,
    };
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid Base cursor or cursor belongs to a different provider, address, chain or page size.",
    );
  }
}

function resultObject(value: Row, message: string): Row {
  const result = value.result;
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new ProviderError("INVALID_PROVIDER_DATA", message);
  return result as Row;
}

function resultRows(value: Row): Row[] {
  if (!Array.isArray(value.result) || value.result.length > INTERNAL_PAGE_SIZE)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Keyless Etherscan internal history returned an invalid page.",
    );
  return value.result.map(row);
}

function mergeWarnings(values: string[]): string[] {
  return [
    ...new Set(
      values.filter((value) => !value.startsWith("Internal transfers")),
    ),
  ];
}

/**
 * Base history provider v2. It keeps the v1 indexed streams intact, then
 * advances a separate bounded internal stream using official metadata and a
 * fixed callTracer lane.
 */
export function createEtherscanMcpV2Provider(
  options: EtherscanMcpV2Options = {},
) {
  const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs >= 1
      ? Math.floor(options.timeoutMs)
      : REQUEST_TIMEOUT_MS;
  const pacer: Pacer = { intervalMs, lastCallAt: 0 };
  let pageQueue: Promise<unknown> = Promise.resolve();

  const fetchPage = (query: TraceQuery) => {
    const task = pageQueue.then(async () => {
      if (query.chainId !== ETHERSCAN_MCP_CHAIN)
        throw new ProviderError(
          "UNSUPPORTED_CHAIN",
          "The keyless Etherscan provider supports Base (8453) only.",
        );
      const wallet = query.address.toLowerCase();
      let size = query.pageSize ?? 10;
      if (query.cursor && query.pageSize === undefined) {
        try {
          size = Number(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
              .size,
          );
        } catch {
          /* decodeV2Cursor reports the bounded cursor error below. */
        }
      }
      if (!Number.isSafeInteger(size) || size < 1 || size > 10)
        throw new ProviderError(
          "INVALID_PAGE_SIZE",
          "Live Base page size must be an integer from 1 to 10 rows per stream.",
        );

      const controller = new AbortController();
      const pageStartedAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
      const ensurePageBudget = () => {
        const remaining = PAGE_TIMEOUT_MS - (Date.now() - pageStartedAt);
        if (
          controller.signal.aborted ||
          basePageDeadlineExpired(pageStartedAt) ||
          remaining < MIN_INTERNAL_RPC_MS
        )
          throw new ProviderError(
            "RPC_BUDGET_EXCEEDED",
            "Base history page time budget expired before the next bounded operation; no page was committed.",
            true,
          );
        return remaining;
      };
      let request: EtherscanActionRequest;
      let close: () => Promise<void> = async () => undefined;
      let anchorForRoot: string | undefined;
      try {
        if (options.request) request = options.request;
        else {
          const callTool = createSdkCallTool({
            fetch: options.fetch,
            timeoutMs,
            signal: controller.signal,
            pacer,
          });
          request = createEtherscanMcpRequest({ callTool });
          close = callTool.close;
        }
        let cursor: V2Cursor;
        if (query.cursor) {
          cursor = decodeV2Cursor(query.cursor, query, size);
        } else {
          const anchor = await request(ETHERSCAN_MCP_CHAIN, {
            module: "proxy",
            action: "eth_blockNumber",
          });
          anchorForRoot = `0x${validBlockAnchor(anchor.result).toString(16)}`;
          cursor = {
            v: 2,
            provider: ETHERSCAN_MCP_V2_PROVIDER_ID,
            chain: ETHERSCAN_MCP_CHAIN,
            address: wallet,
            size,
            end: validBlockAnchor(anchor.result),
            phase: "root",
            root: null,
            rootDone: false,
            internalPage: 1,
            internalDone: false,
            traceProvider: baseInternalTraceProvider(),
            internalLast: null,
          };
        }
        const warnings = [
          "Base native and ERC-20 rows are indexed Etherscan MCP evidence; receipt identities are checked, but provider omissions and reorganizations remain possible.",
          "NFTs, fees, bridge matches and labels are not covered by this adapter.",
          "Gross transfer flows are not buys, sells, profit, unique capital or proof of ownership.",
          `Frozen Base history window: block 0 through ${cursor.end}; newer activity requires a new investigation.`,
        ];
        const transfers: Transfer[] = [];
        let streams: TransferKind[] = [];
        if (cursor.phase === "root") {
          if (cursor.rootDone)
            throw new ProviderError(
              "INVALID_CURSOR",
              "Base cursor entered the root phase after the root stream was exhausted.",
            );
          const rootRequest: EtherscanActionRequest = async (
            chainId,
            parameters,
          ) => {
            if (
              anchorForRoot !== undefined &&
              parameters.module === "proxy" &&
              parameters.action === "eth_blockNumber"
            ) {
              const value = anchorForRoot;
              anchorForRoot = undefined;
              return { status: "1", result: value };
            }
            return request(chainId, parameters);
          };
          const rootProvider = createEtherscanMcpProvider({
            request: rootRequest,
          });
          const rootPage = await rootProvider.fetchPage({
            address: query.address,
            chainId: ETHERSCAN_MCP_CHAIN,
            cursor: cursor.root,
            pageSize: size,
          });
          transfers.push(...rootPage.transfers);
          streams = rootPage.streams;
          warnings.push(...mergeWarnings(rootPage.warnings));
          cursor.root = rootPage.cursor;
          cursor.rootDone = rootPage.exhausted;
          cursor.phase = cursor.internalDone ? "root" : "internal";
        } else {
          if (cursor.internalDone)
            throw new ProviderError(
              "INVALID_CURSOR",
              "Base cursor entered the internal phase after the internal stream was exhausted.",
            );
          if (cursor.internalPage > MAX_INTERNAL_PAGES)
            throw new ProviderError(
              "HISTORY_WINDOW_LIMIT",
              "Base internal history reached the bounded 10,000-row provider window; remaining internal history is unknown.",
            );
          const body = await request(ETHERSCAN_MCP_CHAIN, {
            module: "account",
            action: "txlistinternal",
            address: wallet,
            startblock: "0",
            endblock: String(cursor.end),
            page: String(cursor.internalPage),
            offset: String(INTERNAL_PAGE_SIZE),
            sort: "desc",
          });
          const rows = resultRows(body);
          const records = rows.map((raw) =>
            parseBaseInternalRecord(raw, wallet),
          );
          if (
            records.some((record) => record.blockNumber > cursor.end) ||
            records.some(
              (record, index) =>
                index > 0 &&
                record.blockNumber > records[index - 1]!.blockNumber,
            )
          )
            throw new ProviderError(
              "INVALID_PROVIDER_DATA",
              "Keyless Etherscan internal history returned rows outside the frozen or requested order.",
            );
          if (records.length && cursor.internalLast) {
            const first = records[0]!;
            const fingerprint = internalRecordFingerprint(first);
            if (
              first.blockNumber > cursor.internalLast.block ||
              (first.blockNumber === cursor.internalLast.block &&
                fingerprint === cursor.internalLast.fingerprint)
            )
              throw new ProviderError(
                "INVALID_PROVIDER_DATA",
                "Keyless Etherscan internal history repeated a row or moved forward across the saved descending window.",
              );
          }
          const candidates = records.filter(
            (record) =>
              !record.isError &&
              record.rawAmount !== "0" &&
              ["call", "create", "create2", "suicide", "selfdestruct"].includes(
                record.type,
              ),
          );
          const remainingPageMs = ensurePageBudget();
          const internalRpc =
            options.internalRpcFactory?.() ??
            options.internalRpc ??
            createBaseInternalRpcClient({
              maxDurationMs: remainingPageMs,
            });
          const staged: Transfer[] = [];
          for (const record of candidates) {
            ensurePageBudget();
            const transaction = resultObject(
              await request(ETHERSCAN_MCP_CHAIN, {
                module: "proxy",
                action: "eth_getTransactionByHash",
                txhash: record.hash,
              }),
              "Keyless Etherscan transaction metadata was unavailable.",
            );
            ensurePageBudget();
            const receipt = resultObject(
              await request(ETHERSCAN_MCP_CHAIN, {
                module: "proxy",
                action: "eth_getTransactionReceipt",
                txhash: record.hash,
              }),
              "Keyless Etherscan receipt metadata was unavailable.",
            );
            ensurePageBudget();
            const transfer = await traceBaseInternalRecord(
              record,
              {
                transaction: parseBaseTransactionMetadata(transaction),
                receipt: parseBaseReceiptMetadata(receipt),
              },
              { rpc: internalRpc },
            );
            if (
              controller.signal.aborted ||
              basePageDeadlineExpired(pageStartedAt)
            )
              throw new ProviderError(
                "RPC_BUDGET_EXCEEDED",
                "Base history page time budget expired during internal trace acquisition; no page was committed.",
                true,
              );
            if (transfer) staged.push(transfer);
            else
              warnings.push(
                "A Base internal row matched only the outer transaction frame and was excluded to avoid double counting; the native transaction stream owns that value.",
              );
          }
          transfers.push(...staged);
          streams = ["internal"];
          if (records.length) {
            const last = records[records.length - 1]!;
            cursor.internalLast = {
              block: last.blockNumber,
              fingerprint: internalRecordFingerprint(last),
            };
          }
          cursor.internalPage++;
          cursor.internalDone = rows.length < INTERNAL_PAGE_SIZE;
          cursor.phase = cursor.internalDone ? "root" : "internal";
          if (!cursor.internalDone && cursor.internalPage > MAX_INTERNAL_PAGES)
            warnings.push(
              "Base internal history reached the bounded 10,000-row provider window; later internal rows remain unknown and were not queried.",
            );
          warnings.push(
            "Base internal rows are indexed Etherscan MCP evidence and were accepted only after official metadata/block checks and a unique successful configured callTracer frame.",
          );
        }
        if (controller.signal.aborted || basePageDeadlineExpired(pageStartedAt))
          throw new ProviderError(
            "RPC_BUDGET_EXCEEDED",
            "Base history page time budget expired before the page could be committed.",
            true,
          );
        const exhausted = cursor.rootDone && cursor.internalDone;
        if (exhausted)
          warnings.push(
            "Configured Base native, ERC-20 and internal streams returned terminal pages; this does not establish complete wallet history.",
          );
        const next = exhausted ? null : encodeV2Cursor(cursor);
        const nodes = [
          ...new Set(
            transfers.flatMap((transfer) => [transfer.from, transfer.to]),
          ),
        ].map((address) => ({ address, chainId: ETHERSCAN_MCP_CHAIN }));
        return {
          transfers,
          nodes,
          cursor: next,
          warnings: [...new Set(warnings)],
          streams: [...new Set(streams)],
          exhausted,
        };
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await close();
      }
    });
    pageQueue = task.catch(() => undefined);
    return task;
  };
  return {
    id: ETHERSCAN_MCP_V2_PROVIDER_ID,
    mode: "live" as const,
    fetchPage,
  };
}
