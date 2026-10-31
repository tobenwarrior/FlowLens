import { expandCase, type Providers } from "./operations.ts";
import {
  nodeKey,
  normalizeAddress,
  parseInvestigation,
} from "../src/domain/engine.ts";
import type { Address, Coverage, Investigation } from "../src/domain/types.ts";

export interface WalletHistoryCollectionQuery {
  address: string;
  chainId: number;
  maxPages: number;
  pageSize?: number;
}

export type WalletHistoryCollectionStatus =
  "exhausted" | "error" | "budget-reached";

export interface WalletHistoryCollectionSummary {
  pagesCommitted: number;
  transfersAdded: number;
  status: WalletHistoryCollectionStatus;
  chainId: number;
  address: Address;
  errorCode?: string;
  error?: string;
  cursor: string | null;
}

export interface WalletHistoryCollectionResult {
  investigation: Investigation;
  summary: WalletHistoryCollectionSummary;
}

type PageCallback = (value: Investigation) => Promise<void>;

function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function validateQuery(query: WalletHistoryCollectionQuery): {
  address: Address;
  chainId: number;
  maxPages: number;
  pageSize?: number;
} {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new Error("History collection query must be an object");
  const address = normalizeAddress(query.address);
  const chainId = boundedInteger(
    query.chainId,
    "Collection chain ID",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxPages = boundedInteger(
    query.maxPages,
    "Collection page budget",
    1,
    200,
  );
  const pageSize =
    query.pageSize === undefined
      ? undefined
      : boundedInteger(query.pageSize, "Collection page size", 1, 100);
  return {
    address,
    chainId,
    maxPages,
    ...(pageSize === undefined ? {} : { pageSize }),
  };
}

function providerId(
  value: Investigation,
  chainId: number,
  providers: Providers,
): string | undefined {
  return (value.mode === "live" ? providers.live.get(chainId) : providers.demo)
    ?.id;
}

function coverageFor(
  value: Investigation,
  address: Address,
  chainId: number,
  providers: Providers,
): Coverage | undefined {
  const id = providerId(value, chainId, providers);
  const key = id ? `${id}:${nodeKey(chainId, address)}` : undefined;
  if (key) return value.coverage.find((coverage) => coverage.key === key);
  return value.coverage.find(
    (coverage) =>
      coverage.chainId === chainId &&
      normalizeAddress(coverage.address) === address,
  );
}

function summary(
  value: Investigation,
  address: Address,
  chainId: number,
  pagesCommitted: number,
  transfersAdded: number,
  status: WalletHistoryCollectionStatus,
  providers: Providers,
): WalletHistoryCollectionSummary {
  const coverage = coverageFor(value, address, chainId, providers);
  return {
    pagesCommitted,
    transfersAdded,
    status,
    chainId,
    address,
    ...(coverage?.errorCode ? { errorCode: coverage.errorCode } : {}),
    ...(coverage?.error ? { error: coverage.error } : {}),
    cursor: coverage?.cursor ?? null,
  };
}

function currentCoverage(
  value: Investigation,
  address: Address,
  chainId: number,
  providers: Providers,
): Coverage | undefined {
  return coverageFor(value, address, chainId, providers);
}

function markCursorCycle(
  value: Investigation,
  address: Address,
  chainId: number,
  providers: Providers,
): Investigation {
  const result = parseInvestigation(value);
  const coverage = currentCoverage(result, address, chainId, providers);
  if (!coverage)
    throw new Error("Cannot record a pagination cycle without saved coverage");
  const updatedAt = new Date().toISOString();
  coverage.status = "error";
  coverage.errorCode = "PAGINATION_CYCLE";
  coverage.error =
    "Provider repeated a stored pagination cursor; collection stopped before the next request.";
  coverage.retryable = false;
  coverage.updatedAt = updatedAt;
  result.updatedAt = updatedAt;
  return result;
}

function transferCountDifference(
  before: Investigation,
  after: Investigation,
): number {
  const previous = new Set(before.transfers.map((transfer) => transfer.id));
  return after.transfers.filter((transfer) => !previous.has(transfer.id))
    .length;
}

function committedPageDifference(
  before: Investigation,
  after: Investigation,
  address: Address,
  chainId: number,
  providers: Providers,
): number {
  const previous = currentCoverage(before, address, chainId, providers);
  const next = currentCoverage(after, address, chainId, providers);
  return Math.max(0, (next?.pagesLoaded ?? 0) - (previous?.pagesLoaded ?? 0));
}

function cursorKey(cursor: string | null): string {
  return cursor === null ? "<null>" : cursor;
}

function errorSummary(
  value: Investigation,
  address: Address,
  chainId: number,
  pagesCommitted: number,
  transfersAdded: number,
  providers: Providers,
): WalletHistoryCollectionSummary {
  return summary(
    value,
    address,
    chainId,
    pagesCommitted,
    transfersAdded,
    "error",
    providers,
  );
}

/** Collect one wallet/network sequentially, committing each returned page through the caller. */
export async function collectWalletHistory(
  value: Investigation,
  query: WalletHistoryCollectionQuery,
  providers: Providers,
  onPage?: PageCallback,
): Promise<WalletHistoryCollectionResult> {
  const checked = validateQuery(query);
  let investigation = parseInvestigation(value);
  let pagesCommitted = 0;
  let transfersAdded = 0;
  const seen = new Set<string>();

  for (let iteration = 0; iteration < checked.maxPages; iteration++) {
    const coverage = currentCoverage(
      investigation,
      checked.address,
      checked.chainId,
      providers,
    );
    if (coverage?.status === "exhausted")
      return {
        investigation,
        summary: summary(
          investigation,
          checked.address,
          checked.chainId,
          pagesCommitted,
          transfersAdded,
          "exhausted",
          providers,
        ),
      };
    if (coverage?.status === "error")
      return {
        investigation,
        summary: errorSummary(
          investigation,
          checked.address,
          checked.chainId,
          pagesCommitted,
          transfersAdded,
          providers,
        ),
      };

    const cursor = coverage?.cursor ?? null;
    const key = cursorKey(cursor);
    if (seen.has(key)) {
      investigation = markCursorCycle(
        investigation,
        checked.address,
        checked.chainId,
        providers,
      );
      if (onPage) await onPage(investigation);
      return {
        investigation,
        summary: errorSummary(
          investigation,
          checked.address,
          checked.chainId,
          pagesCommitted,
          transfersAdded,
          providers,
        ),
      };
    }
    seen.add(key);

    const next = await expandCase(
      investigation,
      {
        address: checked.address,
        chainId: checked.chainId,
        maxPages: 1,
        ...(checked.pageSize === undefined
          ? {}
          : { pageSize: checked.pageSize }),
      },
      providers,
    );
    pagesCommitted += committedPageDifference(
      investigation,
      next,
      checked.address,
      checked.chainId,
      providers,
    );
    transfersAdded += transferCountDifference(investigation, next);
    investigation = next;
    if (onPage) await onPage(investigation);

    const nextCoverage = currentCoverage(
      investigation,
      checked.address,
      checked.chainId,
      providers,
    );
    if (nextCoverage?.status === "error")
      return {
        investigation,
        summary: errorSummary(
          investigation,
          checked.address,
          checked.chainId,
          pagesCommitted,
          transfersAdded,
          providers,
        ),
      };
    if (nextCoverage?.status === "exhausted")
      return {
        investigation,
        summary: summary(
          investigation,
          checked.address,
          checked.chainId,
          pagesCommitted,
          transfersAdded,
          "exhausted",
          providers,
        ),
      };
  }

  return {
    investigation,
    summary: summary(
      investigation,
      checked.address,
      checked.chainId,
      pagesCommitted,
      transfersAdded,
      "budget-reached",
      providers,
    ),
  };
}
