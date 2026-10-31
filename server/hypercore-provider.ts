import {
  HYPERCORE_PROVIDER,
  HYPERCORE_SCOPE,
  HYPERCORE_SOURCE_URL,
  parseHypercoreEvidence,
  type HypercoreCoverage,
  type HypercoreEntry,
  type HypercoreEvidenceBundle,
  type HypercoreMode,
  type HypercoreRawLedgerEntry,
} from "../src/domain/hypercore.ts";
import { boundedJson, ProviderError, row } from "./history-provider.ts";

export { ProviderError };

export const HYPERCORE_API_URL = HYPERCORE_SOURCE_URL;
export const HYPERCORE_PAGE_LIMIT = 500;
export const HYPERCORE_MAX_RESPONSE_BYTES = 4_000_000;
export const HYPERCORE_REQUEST_DEADLINE_MS = 15_000;
export const HYPERCORE_DEFAULT_INTERVAL_MS = 1_000;

const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_CURSOR = 100_000;

export interface HypercoreQuery {
  account: string;
  startTime?: number;
  endTime?: number;
  cursor?: string | null;
}

export interface HypercoreRequest {
  type: "userNonFundingLedgerUpdates";
  user: string;
  startTime: number;
  endTime: number;
}

export interface HypercoreProviderResult {
  version: 1;
  mode: HypercoreMode;
  account: string;
  query: HypercoreQuery;
  request: HypercoreRequest;
  entries: HypercoreEntry[];
  cursor: string | null;
  nextCursor: string | null;
  exhausted: boolean;
  coverage: HypercoreCoverage;
  bundle: HypercoreEvidenceBundle;
  sourceUrl: string;
  retrievedAt: string;
  httpStatus: number;
}

export type HypercoreFetchQuery = HypercoreQuery;
export type HypercorePageResult = HypercoreProviderResult;

export interface HypercoreProvider {
  fetchPage(query: HypercoreQuery): Promise<HypercoreProviderResult>;
}

export interface HypercoreProviderOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
}

interface HypercoreCursor {
  v: 1;
  provider: typeof HYPERCORE_PROVIDER;
  account: string;
  startTime: number;
  endTime: number;
  boundaryTime: number;
  boundaryIds: string[];
}

function invalidArgument(message: string): ProviderError {
  return new ProviderError("INVALID_ARGUMENT", message);
}

function invalidData(message: string): ProviderError {
  return new ProviderError("INVALID_PROVIDER_DATA", message);
}

function account(value: unknown): string {
  if (typeof value !== "string" || !ACCOUNT.test(value))
    throw invalidArgument("account must be a valid EVM address.");
  return value.toLowerCase();
}

function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalidArgument(`${name} must be a non-negative safe integer.`);
  return value;
}

function cursorText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR
  )
    throw new ProviderError("INVALID_CURSOR", "Invalid HyperCore cursor.");
  return value;
}

function decodeCursor(value: unknown, queryAccount: string): HypercoreCursor {
  try {
    const source = cursorText(value);
    const parsed = row(
      JSON.parse(Buffer.from(source, "base64url").toString("utf8")),
    );
    if (
      parsed.v !== 1 ||
      parsed.provider !== HYPERCORE_PROVIDER ||
      parsed.account !== queryAccount ||
      !Number.isSafeInteger(parsed.startTime) ||
      typeof parsed.startTime !== "number" ||
      (parsed.startTime as number) < 0 ||
      !Number.isSafeInteger(parsed.endTime) ||
      typeof parsed.endTime !== "number" ||
      (parsed.endTime as number) < parsed.startTime ||
      !Number.isSafeInteger(parsed.boundaryTime) ||
      (parsed.boundaryTime as number) < parsed.startTime ||
      (parsed.boundaryTime as number) > parsed.endTime ||
      !Array.isArray(parsed.boundaryIds) ||
      parsed.boundaryIds.length > HYPERCORE_PAGE_LIMIT ||
      parsed.boundaryIds.some((id) => typeof id !== "string" || !HASH.test(id))
    )
      throw new Error();
    return {
      v: 1,
      provider: HYPERCORE_PROVIDER,
      account: queryAccount,
      startTime: parsed.startTime as number,
      endTime: parsed.endTime as number,
      boundaryTime: parsed.boundaryTime as number,
      boundaryIds: [...new Set(parsed.boundaryIds as string[])],
    };
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid HyperCore cursor or cursor belongs to another account/window.",
    );
  }
}

function encodeCursor(value: HypercoreCursor): string {
  const source = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  if (source.length > MAX_CURSOR)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "HyperCore cursor is too large.",
    );
  return source;
}

function rawEntry(value: unknown): HypercoreRawLedgerEntry {
  const source = row(value);
  if (
    typeof source.time !== "number" ||
    !Number.isSafeInteger(source.time) ||
    source.time < 0 ||
    typeof source.hash !== "string" ||
    !HASH.test(source.hash) ||
    !source.delta ||
    typeof source.delta !== "object" ||
    Array.isArray(source.delta)
  )
    throw invalidData("HyperCore returned a malformed ledger entry.");
  return {
    time: source.time,
    hash: source.hash,
    delta: source.delta as Record<string, unknown>,
  };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw invalidData("HyperCore returned a non-array ledger response.");
  if (value.length > HYPERCORE_PAGE_LIMIT)
    throw invalidData("HyperCore returned more than its 500-record page cap.");
  return value;
}

function makeCoverage(
  accountValue: string,
  startTime: number,
  endTime: number,
  cursor: string | null,
  exhausted: boolean,
  retrievedAt: string,
  pagesLoaded = 1,
): HypercoreCoverage {
  return {
    provider: HYPERCORE_PROVIDER,
    scope: HYPERCORE_SCOPE,
    account: accountValue,
    startTime,
    endTime,
    status: exhausted ? "exhausted" : "partial",
    pagesLoaded,
    cursor,
    exhausted,
    fullHistory: false,
    retention: "undocumented",
    warnings: [
      "Only the provider-scoped non-funding ledger window was requested.",
      "Funding payments and trade fills are intentionally omitted.",
      "Provider retention and historical availability are undocumented.",
    ],
    provenance: {
      source: "Hyperliquid public info",
      sourceUrl: HYPERCORE_API_URL,
      retrievedAt,
      synthetic: false,
    },
  };
}

function filterBoundary(
  entries: HypercoreEntry[],
  prior: HypercoreCursor | undefined,
): HypercoreEntry[] {
  if (!prior) return entries;
  const ids = new Set(prior.boundaryIds);
  for (const entry of entries) {
    if (entry.time < prior.boundaryTime)
      throw invalidData(
        "HyperCore pagination moved before its inclusive boundary.",
      );
  }
  return entries.filter(
    (entry) => !(entry.time === prior.boundaryTime && ids.has(entry.id)),
  );
}

function providerDataError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(
    "INVALID_PROVIDER_DATA",
    "Hyperliquid returned a malformed non-funding ledger page; no page was committed.",
  );
}

/** One bounded, sequential read of Hyperliquid's non-funding ledger endpoint. */
export function createHypercoreProvider(
  options: HypercoreProviderOptions = {},
): HypercoreProvider {
  const fetcher = options.fetch ?? fetch;
  const intervalMs = options.intervalMs ?? HYPERCORE_DEFAULT_INTERVAL_MS;
  if (
    typeof intervalMs !== "number" ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0
  )
    throw invalidArgument("intervalMs must be a non-negative safe integer.");
  let queue: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;

  async function request(body: HypercoreRequest) {
    const task = queue.then(async () => {
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      nextRequestAt = Date.now() + intervalMs;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HYPERCORE_REQUEST_DEADLINE_MS,
      );
      try {
        const response = await fetcher(HYPERCORE_API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (response.status === 403)
            throw new ProviderError(
              "PROVIDER_ACCESS_DENIED",
              "Hyperliquid public info denied this request; no retry or fallback was attempted.",
            );
          if (response.status === 429)
            throw new ProviderError(
              "PROVIDER_RATE_LIMITED",
              "Hyperliquid rate limit reached; resume later using the saved cursor.",
              true,
            );
          throw new ProviderError(
            "PROVIDER_HTTP_ERROR",
            `Hyperliquid returned HTTP ${response.status}; no page was committed.`,
            response.status >= 500,
          );
        }
        const value = await boundedJson(response, HYPERCORE_MAX_RESPONSE_BYTES);
        return {
          value,
          httpStatus: response.status,
          retrievedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (controller.signal.aborted)
          throw new ProviderError(
            "PROVIDER_TIMEOUT",
            "Hyperliquid request deadline exceeded; no page was committed.",
            true,
          );
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "Hyperliquid public info request failed; no page was committed.",
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }

  return {
    async fetchPage(input: HypercoreQuery): Promise<HypercoreProviderResult> {
      const accountValue = account(input?.account);
      let prior: HypercoreCursor | undefined;
      let startTime =
        input.startTime === undefined
          ? 0
          : nonNegative(input.startTime, "startTime");
      let endTime =
        input.endTime === undefined
          ? Date.now()
          : nonNegative(input.endTime, "endTime");
      if (input.cursor !== undefined && input.cursor !== null) {
        prior = decodeCursor(input.cursor, accountValue);
        if (
          input.startTime !== undefined &&
          input.startTime !== prior.startTime
        )
          throw new ProviderError(
            "INVALID_CURSOR",
            "startTime conflicts with the cursor fence.",
          );
        if (input.endTime !== undefined && input.endTime !== prior.endTime)
          throw new ProviderError(
            "INVALID_CURSOR",
            "endTime conflicts with the cursor fence.",
          );
        startTime = prior.boundaryTime;
        endTime = prior.endTime;
      }
      if (endTime < startTime)
        throw invalidArgument(
          "endTime must be greater than or equal to startTime.",
        );
      const requestBody: HypercoreRequest = {
        type: "userNonFundingLedgerUpdates",
        user: accountValue,
        startTime,
        endTime,
      };
      const response = await request(requestBody);
      const rows = array(response.value).map(rawEntry);
      if (rows.some((entry) => entry.time < startTime || entry.time > endTime))
        throw invalidData(
          "HyperCore returned a record outside the requested time window.",
        );
      for (let index = 1; index < rows.length; index++) {
        if (rows[index].time < rows[index - 1].time)
          throw invalidData(
            "HyperCore returned ledger records out of chronological order; no page was committed.",
          );
      }
      const rawBundle = {
        version: 1 as const,
        mode: "private" as const,
        account: accountValue,
        entries: rows.map((entry) => ({
          ...entry,
          account: accountValue,
          provenance: {
            source: "Hyperliquid public info",
            sourceUrl: HYPERCORE_API_URL,
            retrievedAt: response.retrievedAt,
            synthetic: false,
          },
        })),
        coverage: makeCoverage(
          accountValue,
          input.startTime ?? prior?.startTime ?? 0,
          endTime,
          null,
          rows.length < HYPERCORE_PAGE_LIMIT,
          response.retrievedAt,
        ),
      };
      let parsed: HypercoreEvidenceBundle;
      try {
        parsed = parseHypercoreEvidence(rawBundle, "private");
      } catch (error) {
        throw providerDataError(error);
      }
      let entries: HypercoreEntry[];
      try {
        entries = filterBoundary(parsed.entries, prior);
      } catch (error) {
        throw providerDataError(error);
      }
      if (prior && rows.length === HYPERCORE_PAGE_LIMIT && entries.length === 0)
        throw new ProviderError(
          "PAGINATION_NON_PROGRESS",
          "Hyperliquid returned a saturated page without a timestamp or boundary-record advance; no cursor was committed.",
        );
      const maxTime = parsed.entries.reduce(
        (max, entry) => Math.max(max, entry.time),
        startTime,
      );
      const exhausted = rows.length < HYPERCORE_PAGE_LIMIT;
      let nextCursor: string | null = null;
      if (!exhausted) {
        const boundaryIds = parsed.entries
          .filter((entry) => entry.time === maxTime)
          .map((entry) => entry.id);
        if (prior && maxTime === prior.boundaryTime)
          boundaryIds.push(...prior.boundaryIds);
        if (new Set(boundaryIds).size > HYPERCORE_PAGE_LIMIT)
          throw new ProviderError(
            "PAGINATION_NON_PROGRESS",
            "Hyperliquid pagination is saturated at one timestamp; no safe inclusive cursor can advance.",
          );
        nextCursor = encodeCursor({
          v: 1,
          provider: HYPERCORE_PROVIDER,
          account: accountValue,
          startTime: prior?.startTime ?? input.startTime ?? 0,
          endTime,
          boundaryTime: maxTime,
          boundaryIds: [...new Set(boundaryIds)],
        });
      }
      const coverage = makeCoverage(
        accountValue,
        input.startTime ?? prior?.startTime ?? 0,
        endTime,
        nextCursor,
        exhausted,
        response.retrievedAt,
      );
      let bundle: HypercoreEvidenceBundle;
      try {
        bundle = parseHypercoreEvidence(
          {
            ...rawBundle,
            entries,
            coverage,
          },
          "private",
        );
      } catch (error) {
        throw providerDataError(error);
      }
      const query: HypercoreQuery = {
        account: accountValue,
        startTime,
        endTime,
        ...(input.cursor === undefined || input.cursor === null
          ? {}
          : { cursor: input.cursor }),
      };
      return {
        version: 1,
        mode: "private",
        account: accountValue,
        query,
        request: requestBody,
        entries: bundle.entries,
        cursor: nextCursor,
        nextCursor,
        exhausted,
        coverage: bundle.coverage,
        bundle,
        sourceUrl: HYPERCORE_API_URL,
        retrievedAt: response.retrievedAt,
        httpStatus: response.httpStatus,
      };
    },
  };
}
