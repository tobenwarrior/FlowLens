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
import { row } from "./history-provider.ts";
import type { TraceQuery } from "../src/domain/types.ts";

export const ETHERSCAN_MCP_ENDPOINT =
  "https://mcp-keyless.etherscan.io/mcp" as const;
export const ETHERSCAN_MCP_CHAIN = 8453 as const;
export const ETHERSCAN_MCP_PROVIDER_ID = "etherscan-mcp-keyless-v1" as const;
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
