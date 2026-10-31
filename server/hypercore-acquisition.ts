import { normalizeAddress } from "../src/domain/engine.ts";
import {
  analyzeHypercoreEvidence,
  HYPERCORE_PROVIDER,
  HYPERCORE_SCOPE,
  HYPERCORE_SOURCE_URL,
  mergeHypercoreEvidence,
  parseHypercoreEvidence,
  type HypercoreEvidenceBundle,
} from "../src/domain/hypercore.ts";
import {
  createHypercoreProvider,
  type HypercoreProvider,
  type HypercoreQuery,
} from "./hypercore-provider.ts";
import { ProviderError } from "./history-provider.ts";

export function parseHypercoreQuery(input: unknown): HypercoreQuery {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("HyperCore query must be an object");
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!["account", "startTime", "endTime", "cursor"].includes(key))
      throw new Error(`Unsupported HyperCore query field: ${key}`);
  const query: HypercoreQuery = {
    account: normalizeAddress(value.account as string),
  };
  for (const key of ["startTime", "endTime"] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
      throw new Error(`${key} must be a non-negative safe integer`);
    query[key] = value[key] as number;
  }
  if (value.cursor !== undefined) {
    if (
      value.cursor !== null &&
      (typeof value.cursor !== "string" ||
        !value.cursor.length ||
        value.cursor.length > 100_000)
    )
      throw new Error("HyperCore cursor must be null or a bounded string");
    query.cursor = value.cursor as string | null;
  }
  if (
    query.startTime !== undefined &&
    query.endTime !== undefined &&
    query.startTime > query.endTime
  )
    throw new Error("HyperCore startTime must not exceed endTime");
  return query;
}

function message(error: Error): string {
  return error.message
    .replace(/((?:api[_-]?key|token|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

/** One shared acquisition boundary for case files, the local API and agent tools. */
export async function acquireHypercoreHistory(
  input: unknown,
  previous?: HypercoreEvidenceBundle,
  provider: HypercoreProvider = createHypercoreProvider(),
) {
  const query = parseHypercoreQuery(input);
  const prior = previous
    ? parseHypercoreEvidence(previous, "private")
    : undefined;
  if (prior) {
    if (prior.account !== query.account)
      throw new Error("HyperCore account must match the saved account");
    if (
      (query.startTime !== undefined &&
        query.startTime !== prior.coverage.startTime) ||
      (query.endTime !== undefined && query.endTime !== prior.coverage.endTime)
    )
      throw new Error(
        "The saved HyperCore window is frozen; use a new case for a different window",
      );
    if (query.cursor !== undefined && query.cursor !== prior.coverage.cursor)
      throw new Error("HyperCore continuation must use the saved cursor");
    query.startTime = prior.coverage.startTime;
    query.endTime = prior.coverage.endTime;
    query.cursor = prior.coverage.cursor;
  } else {
    query.startTime ??= 0;
    query.endTime ??= Date.now();
  }
  const wrap = (
    bundle: HypercoreEvidenceBundle,
    errors: { code: string; message: string; retryable: boolean }[],
    cached: boolean,
    latestPageCount: number,
  ) => ({
    version: 1 as const,
    mode: "private" as const,
    domain: "hypercore" as const,
    account: query.account,
    bundle,
    analysis: analyzeHypercoreEvidence(bundle),
    errors,
    cached,
    latestPageCount,
    indexedHistoryChanged: false as const,
  });
  if (prior?.coverage.exhausted) return wrap(prior, [], true, 0);
  try {
    const page = await provider.fetchPage(query);
    const next = parseHypercoreEvidence(page.bundle, "private");
    if (
      next.account !== query.account ||
      next.coverage.startTime !== query.startTime ||
      next.coverage.endTime !== query.endTime
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "HyperCore page does not match the requested account/window",
      );
    next.coverage.pagesLoaded = (prior?.coverage.pagesLoaded ?? 0) + 1;
    delete next.coverage.error;
    delete next.coverage.errorCode;
    delete next.coverage.retryable;
    return wrap(
      mergeHypercoreEvidence(prior, next),
      [],
      false,
      next.entries.length,
    );
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const failure = {
      code: error.code,
      message: message(error),
      retryable: error.retryable,
    };
    const failed = parseHypercoreEvidence(
      {
        version: 1,
        mode: "private",
        account: query.account,
        entries: prior?.entries ?? [],
        coverage: {
          provider: HYPERCORE_PROVIDER,
          scope: HYPERCORE_SCOPE,
          account: query.account,
          startTime: query.startTime,
          endTime: query.endTime,
          status: "error",
          pagesLoaded: prior?.coverage.pagesLoaded ?? 0,
          cursor: prior?.coverage.cursor ?? query.cursor ?? null,
          exhausted: false,
          fullHistory: false,
          retention: "undocumented",
          warnings: [
            ...new Set([
              ...(prior?.coverage.warnings ?? []),
              "A page request failed. Previously committed records and the cursor were retained.",
            ]),
          ],
          provenance: {
            source: "FlowLens Hyperliquid request attempt",
            sourceUrl: HYPERCORE_SOURCE_URL,
            retrievedAt: new Date().toISOString(),
            synthetic: false,
          },
          error: failure.message,
          errorCode: failure.code,
          retryable: failure.retryable,
        },
      },
      "private",
    );
    return wrap(failed, [failure], false, 0);
  }
}
