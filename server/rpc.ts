export interface RpcClient {
  chainId: number;
  source?: string;
  sourceUrl?: string;
  request(method: string, params: unknown[]): Promise<unknown>;
}
export class RpcProviderError extends Error {
  code: string;
  retryable: boolean;
  rpcCode?: number;
  constructor(
    code: string,
    message: string,
    retryable = false,
    rpcCode?: number,
  ) {
    super(message);
    this.name = "RpcProviderError";
    this.code = code;
    this.retryable = retryable;
    this.rpcCode = rpcCode;
  }
}
export const PUBLIC_RPC = {
  1: {
    url: "https://ethereum-rpc.publicnode.com",
    name: "PublicNode Ethereum RPC",
    documentation: "https://ethereum.publicnode.com/",
  },
  8453: {
    url: "https://base-rpc.publicnode.com",
    name: "PublicNode Base RPC",
    documentation: "https://base.publicnode.com/",
  },
  42161: {
    url: "https://arbitrum-one-rpc.publicnode.com",
    name: "PublicNode Arbitrum RPC",
    documentation: "https://arbitrum.publicnode.com/",
  },
} as const;
const METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_call",
  "eth_getLogs",
  "debug_traceTransaction",
]);
const queues = new Map<number, { tail: Promise<unknown>; lastCall: number }>();
export interface PublicRpcOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  maxCalls?: number;
  maxResponseBytes?: number;
  maxDurationMs?: number;
}

async function boundedJson(response: Response, max: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > max)
    throw new RpcProviderError(
      "RPC_RESPONSE_TOO_LARGE",
      "RPC response exceeds the configured byte budget.",
    );
  if (!response.body)
    throw new RpcProviderError(
      "RPC_INVALID_RESPONSE",
      "RPC response has no body.",
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) {
        await reader.cancel().catch(() => undefined);
        throw new RpcProviderError(
          "RPC_RESPONSE_TOO_LARGE",
          "RPC response exceeds the configured byte budget.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new RpcProviderError(
      "RPC_INVALID_RESPONSE",
      "RPC returned invalid JSON.",
    );
  }
}
/** Fixed public endpoints and read-only methods. No environment credentials, signing or automatic retries. */
export function createPublicRpcClient(
  chainId: number,
  options: PublicRpcOptions = {},
): RpcClient {
  const endpoint = PUBLIC_RPC[chainId as keyof typeof PUBLIC_RPC];
  if (!endpoint)
    throw new RpcProviderError(
      "RPC_UNSUPPORTED_CHAIN",
      "Public RPC chain is not supported. Use Ethereum, Base or Arbitrum One.",
    );
  const interval = options.intervalMs ?? 1000,
    maxCalls = options.maxCalls ?? 32,
    maxBytes = options.maxResponseBytes ?? 2_000_000,
    duration = options.maxDurationMs ?? 45_000;
  if (
    !Number.isInteger(interval) ||
    interval < 0 ||
    interval > 10000 ||
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 64 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 5_000_000 ||
    !Number.isInteger(duration) ||
    duration < 100 ||
    duration > 120_000
  )
    throw new RpcProviderError(
      "RPC_INVALID_BUDGET",
      "Invalid RPC request, byte or time budget.",
    );
  const fetcher = options.fetch ?? fetch;
  let calls = 0,
    nextId = 1;
  const deadline = Date.now() + duration;
  // Public instances share pacing within this process. Independent processes still share external provider limits.
  const queue =
    options.intervalMs === 0
      ? { tail: Promise.resolve(), lastCall: 0 }
      : (queues.get(chainId) ?? { tail: Promise.resolve(), lastCall: 0 });
  if (options.intervalMs !== 0) queues.set(chainId, queue);
  return {
    chainId,
    source: endpoint.name,
    sourceUrl: endpoint.documentation,
    async request(method, params) {
      if (!METHODS.has(method))
        throw new RpcProviderError(
          "RPC_METHOD_DENIED",
          "Only supported read-only RPC methods are permitted.",
        );
      if (!Array.isArray(params))
        throw new RpcProviderError(
          "RPC_INVALID_ARGUMENT",
          "RPC params must be an array.",
        );
      let encoded: string;
      try {
        encoded = JSON.stringify(params);
      } catch {
        throw new RpcProviderError(
          "RPC_INVALID_ARGUMENT",
          "RPC params must be serializable JSON.",
        );
      }
      if (encoded.length > 1_000_000)
        throw new RpcProviderError(
          "RPC_INPUT_TOO_LARGE",
          "RPC parameters exceed the byte budget.",
        );
      if (calls >= maxCalls)
        throw new RpcProviderError(
          "RPC_BUDGET_EXCEEDED",
          "RPC request budget exhausted; no additional request was sent.",
        );
      calls++;
      const id = nextId++;
      const task = queue.tail.then(async () => {
        const wait = Math.max(0, queue.lastCall + interval - Date.now());
        if (Date.now() + wait >= deadline)
          throw new RpcProviderError(
            "RPC_BUDGET_EXCEEDED",
            "RPC operation time budget exhausted; no additional request was sent.",
          );
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        queue.lastCall = Date.now();
        try {
          const response = await fetcher(endpoint.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            redirect: "error",
            signal: AbortSignal.timeout(
              Math.max(1, Math.min(12_000, deadline - Date.now())),
            ),
          });
          if (response.status === 401 || response.status === 403)
            throw new RpcProviderError(
              "RPC_ACCESS_DENIED",
              "Public RPC denied access. No retry or credential fallback was attempted.",
            );
          if (response.status === 429)
            throw new RpcProviderError(
              "RPC_RATE_LIMITED",
              "Public RPC rate limit reached. Retry later; no automatic retry was made.",
              true,
            );
          if (!response.ok)
            throw new RpcProviderError(
              "RPC_HTTP_ERROR",
              `Public RPC returned HTTP ${response.status}.`,
              response.status >= 500,
            );
          const value = await boundedJson(response, maxBytes);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new RpcProviderError(
              "RPC_INVALID_RESPONSE",
              "RPC returned an invalid response object.",
            );
          const body = value as Record<string, unknown>;
          if (body.jsonrpc !== "2.0" || body.id !== id)
            throw new RpcProviderError(
              "RPC_INVALID_RESPONSE",
              "RPC response identity does not match the request.",
            );
          if (body.error !== undefined) {
            const error =
              body.error && typeof body.error === "object"
                ? (body.error as Record<string, unknown>)
                : {};
            const code =
              typeof error.code === "number" ? error.code : undefined;
            const detail = String(error.message ?? "").toLowerCase();
            if (
              code === -32601 ||
              /method.*(?:not supported|not available|does not exist|disabled)|unsupported.*method/.test(
                detail,
              )
            )
              throw new RpcProviderError(
                "RPC_METHOD_UNSUPPORTED",
                "RPC method is unavailable on this public provider.",
                false,
                code,
              );
            if (/rate limit|too many requests/.test(detail))
              throw new RpcProviderError(
                "RPC_RATE_LIMITED",
                "Public RPC rate limit reached. Retry later.",
                true,
                code,
              );
            if (code === 3 || /revert/.test(detail))
              throw new RpcProviderError(
                "RPC_CALL_REVERTED",
                "Read-only contract call reverted; the requested interface or historical state may be unavailable.",
                false,
                code,
              );
            throw new RpcProviderError(
              "RPC_REJECTED",
              "Public RPC rejected this read-only request; no raw provider error was retained.",
              false,
              code,
            );
          }
          if (!("result" in body))
            throw new RpcProviderError(
              "RPC_INVALID_RESPONSE",
              "RPC response contains neither result nor error.",
            );
          if (
            method === "eth_chainId" &&
            (typeof body.result !== "string" ||
              !/^0x[0-9a-f]+$/i.test(body.result) ||
              BigInt(body.result) !== BigInt(chainId))
          )
            throw new RpcProviderError(
              "RPC_CHAIN_MISMATCH",
              "RPC chain identity does not match the requested chain.",
            );
          return body.result;
        } catch (error) {
          if (error instanceof RpcProviderError) throw error;
          throw new RpcProviderError(
            "RPC_NETWORK_ERROR",
            "Public RPC request failed or timed out. No automatic retry was made.",
            true,
          );
        }
      });
      queue.tail = task.catch(() => undefined);
      return task;
    },
  };
}
