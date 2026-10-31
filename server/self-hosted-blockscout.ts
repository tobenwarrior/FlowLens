import { createHash } from "node:crypto";
import type {
  TraceProvider,
  TraceQuery,
  TransferPage,
} from "../src/domain/types.ts";
import { boundedJson, ProviderError, row } from "./history-provider.ts";
import {
  createBlockscoutProvider,
  type BlockscoutExplorer,
} from "./blockscout.ts";

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_HEX = "0x2105";
const MAX_RESPONSE_BYTES = 4_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const INDEXING_WARNING =
  "Self-hosted Base completeness requires FIRST_BLOCK=0 and TRACE_FIRST_BLOCK=0; the readiness API cannot verify the configured index range, so this route never claims complete wallet history.";
const completeRatio = (value: unknown): boolean =>
  value === "1.0" || value === 1;

/** One queue covers readiness and history so concurrent pages cannot bypass the provider interval. */
function createPacedFetch(
  fetcher: typeof fetch,
  intervalMs: number,
): typeof fetch {
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;
  const paced = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const task = queue.then(async () => {
      const wait = Math.max(0, lastCall + intervalMs - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = Date.now();
      // Internal readiness/history callers create a timeout before entering this queue. Replace it
      // at dispatch so queue wait does not consume the full 15-second response budget.
      return fetcher(input, {
        ...(init ?? {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    });
    queue = task.catch(() => undefined);
    return task;
  };
  return paced as typeof fetch;
}

/** Normalize and constrain the operator-supplied Blockscout origin before any request. */
export function selfHostedBlockscoutOrigin(value: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ProviderError(
      "INVALID_SELF_HOSTED_URL",
      "FLOWLENS_BASE_BLOCKSCOUT_URL must be a non-empty loopback HTTP(S) origin.",
    );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderError(
      "INVALID_SELF_HOSTED_URL",
      "FLOWLENS_BASE_BLOCKSCOUT_URL must be a valid loopback HTTP(S) origin.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    value !== value.trim() ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (host !== "127.0.0.1" && host !== "[::1]") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.pathname !== "/" ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  )
    throw new ProviderError(
      "INVALID_SELF_HOSTED_URL",
      "FLOWLENS_BASE_BLOCKSCOUT_URL must be an HTTP(S) origin on 127.0.0.1 or [::1] with no credentials, query, fragment or path.",
    );
  return parsed.origin;
}

function endpointIdentity(
  origin: string,
): `blockscout-self-hosted-v1-${string}` {
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return `blockscout-self-hosted-v1-${digest}`;
}

function readinessError(message: string, retryable = false): ProviderError {
  return new ProviderError("SELF_HOSTED_NOT_READY", message, retryable);
}

async function readinessRequest(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "SELF_HOSTED_UNAVAILABLE",
      "Self-hosted Base Blockscout readiness request failed or timed out; no page was committed.",
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429)
      throw new ProviderError(
        "RATE_LIMITED",
        "Self-hosted Base Blockscout readiness was rate limited; no page was committed.",
        true,
      );
    throw new ProviderError(
      "SELF_HOSTED_UNAVAILABLE",
      `Self-hosted Base Blockscout readiness returned HTTP ${response.status}; no page was committed.`,
      response.status >= 500,
    );
  }
  return boundedJson(response, MAX_RESPONSE_BYTES);
}

/** Check the two local readiness contracts without disclosing a wallet address. */
export async function checkSelfHostedBaseReadiness(options: {
  origin: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const origin = selfHostedBlockscoutOrigin(options.origin);
  const fetcher = options.fetch ?? fetch;
  const rpcBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_chainId",
    params: [],
  });
  const rpc = row(
    await readinessRequest(fetcher, new URL("/api/eth-rpc", origin), {
      method: "POST",
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
      }),
      body: rpcBody,
    }),
  );
  if (
    rpc.jsonrpc !== "2.0" ||
    rpc.id !== 1 ||
    (rpc.error !== undefined && rpc.error !== null) ||
    typeof rpc.result !== "string" ||
    rpc.result.toLowerCase() !== BASE_CHAIN_HEX
  )
    throw new ProviderError(
      "SELF_HOSTED_CHAIN_MISMATCH",
      "Self-hosted Blockscout RPC is not serving Base (chain ID 0x2105); no page was committed.",
    );

  const status = row(
    await readinessRequest(
      fetcher,
      new URL("/api/v2/main-page/indexing-status", origin),
      { headers: new Headers({ accept: "application/json" }) },
    ),
  );
  if (
    status.finished_indexing !== true ||
    status.finished_indexing_blocks !== true ||
    !completeRatio(status.indexed_blocks_ratio) ||
    !completeRatio(status.indexed_internal_transactions_ratio)
  )
    throw readinessError(
      "Self-hosted Base Blockscout is not fully indexed: finished_indexing, finished_indexing_blocks and both indexing ratios must report complete; no page was committed.",
      true,
    );
}

/**
 * Base history through an operator-run Blockscout instance reached by a local port or SSH tunnel.
 * The wrapped provider owns the existing v2 parser, pagination and raw-trace validation.
 */
export function createSelfHostedBlockscoutProvider(options: {
  origin: string;
  fetch?: typeof fetch;
  intervalMs?: number;
}): TraceProvider {
  const origin = selfHostedBlockscoutOrigin(options.origin);
  const fetcher = options.fetch ?? fetch;
  const transport = createPacedFetch(
    fetcher,
    Math.max(0, options.intervalMs ?? 500),
  );
  const explorer: BlockscoutExplorer = {
    api: `${origin}/api/v2`,
    native: "ETH",
    pageSize: true,
  };
  const inner = createBlockscoutProvider({
    fetch: transport,
    intervalMs: 0,
    explorers: { [BASE_CHAIN_ID]: explorer },
    providerId: endpointIdentity(origin),
  });
  return {
    id: inner.id,
    mode: "live",
    async fetchPage(query: TraceQuery): Promise<TransferPage> {
      if (query.chainId !== BASE_CHAIN_ID)
        throw new ProviderError(
          "UNSUPPORTED_CHAIN",
          "Self-hosted Blockscout is configured only for Base (8453).",
        );
      await checkSelfHostedBaseReadiness({ origin, fetch: transport });
      const page = await inner.fetchPage(query);
      return {
        ...page,
        warnings: [...new Set([...page.warnings, INDEXING_WARNING])],
      };
    },
  };
}
