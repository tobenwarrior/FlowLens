import { filterTransfers, nodeKey, normalizeAddress } from "./engine.ts";
import { deriveSwaps } from "./swaps.ts";
import type { SwapRow } from "./swaps.ts";
import { usdValue, wholeUnits } from "./pricing.ts";
import type { PriceBook, UsdValue } from "./pricing.ts";
import { visibleTransfers } from "./wallet-flows.ts";
import type {
  Address,
  Investigation,
  TraceFilter,
  Transfer,
  WalletNode,
} from "./types.ts";

export type TransferTab = "transfers" | "inflow" | "outflow" | "swaps";
export type SortField = "time" | "value" | "usd";
export type SortDirection = "asc" | "desc";

export interface TableSort {
  field: SortField;
  direction: SortDirection;
}

export interface TableFilter extends TraceFilter {
  /** Arkham's "USD >= $N" chip. Drops only unpriced-or-below rows from the view. */
  minUsd?: number;
  /** Case-insensitive asset symbol match. */
  token?: string;
}

export interface TableCounterparty {
  address: Address;
  chainId: number;
  node?: WalletNode;
}

export interface TransferTableRow {
  id: string;
  transfer: Transfer;
  direction: "in" | "out" | "self";
  counterparty: TableCounterparty;
  usd: UsdValue | null;
  visible: boolean;
}

export interface SwapTableRow {
  id: string;
  swap: SwapRow;
  venue: TableCounterparty | null;
}

export interface TransferTableView {
  tab: TransferTab;
  address: Address;
  scope: "loaded-evidence";
  rows: TransferTableRow[];
  swaps: SwapTableRow[];
  counts: {
    transfers: number;
    inflow: number;
    outflow: number;
    swaps: number;
  };
  page: {
    offset: number;
    pageSize: number;
    total: number;
    pageIndex: number;
    pageCount: number;
  };
  pricing: {
    priced: number;
    unpriced: number;
    /** Priced rows whose quote came from the transfer's own block. */
    atBlock: number;
  };
}

export interface TransferTableQuery {
  address: string;
  tab?: TransferTab;
  filter?: TableFilter;
  sort?: TableSort;
  offset?: number;
  pageSize?: number;
  book?: PriceBook;
}

const DEFAULT_SORT: TableSort = { field: "time", direction: "desc" };

function bound(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function direction(
  transfer: Transfer,
  address: Address,
): "in" | "out" | "self" {
  const incoming = normalizeAddress(transfer.to) === address;
  const outgoing = normalizeAddress(transfer.from) === address;
  return incoming && outgoing ? "self" : incoming ? "in" : "out";
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ordering is total: the tiebreak on transfer id keeps paging deterministic. */
function sortRows(
  rows: TransferTableRow[],
  sort: TableSort,
): TransferTableRow[] {
  const factor = sort.direction === "asc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    let primary: number;
    if (sort.field === "time") {
      primary =
        Date.parse(b.transfer.timestamp) - Date.parse(a.transfer.timestamp);
    } else if (sort.field === "usd") {
      primary = Number(b.usd?.amount ?? 0) - Number(a.usd?.amount ?? 0);
    } else {
      // Compare whole units so two assets of different decimals rank by magnitude.
      primary =
        wholeUnits(b.transfer.rawAmount, b.transfer.asset.decimals) -
        wholeUnits(a.transfer.rawAmount, a.transfer.asset.decimals);
    }
    if (primary !== 0) return primary * factor;
    return compareStrings(a.id, b.id);
  });
}

function sortSwaps(rows: SwapTableRow[], sort: TableSort): SwapTableRow[] {
  const factor = sort.direction === "asc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    let primary: number;
    if (sort.field === "usd") {
      primary =
        Number(b.swap.usd?.amount ?? 0) - Number(a.swap.usd?.amount ?? 0);
    } else {
      primary = Date.parse(b.swap.timestamp) - Date.parse(a.swap.timestamp);
    }
    if (primary !== 0) return primary * factor;
    return compareStrings(a.id, b.id);
  });
}

/**
 * A deterministic, paged table over already-loaded evidence.
 *
 * Like every other view in FlowLens this reads what the case already holds; it never
 * fetches, and an empty tab means "not in loaded evidence", never "did not happen".
 */
export function buildTransferTable(
  investigation: Investigation,
  query: TransferTableQuery,
): TransferTableView {
  const address = normalizeAddress(query.address);
  const tab = query.tab ?? "transfers";
  const sort = query.sort ?? DEFAULT_SORT;
  const offset = bound(query.offset ?? 0, "Table offset", 0, 20_000);
  const pageSize = bound(query.pageSize ?? 25, "Table page size", 1, 100);
  const book: PriceBook = query.book ?? { quotes: {} };
  const filter = query.filter ?? {};

  const scoped = filterTransfers(
    investigation.transfers,
    address,
    filter,
  ).filter(
    (transfer) =>
      normalizeAddress(transfer.from) === address ||
      normalizeAddress(transfer.to) === address,
  );

  const visible = new Set(
    visibleTransfers(investigation, scoped).map((transfer) => transfer.id),
  );
  const nodes = new Map(
    investigation.nodes.map((node) => [
      nodeKey(node.chainId, node.address),
      node,
    ]),
  );
  const lookup = (value: Address, chainId: number): TableCounterparty => ({
    address: value,
    chainId,
    node: nodes.get(nodeKey(chainId, value)),
  });

  let rows: TransferTableRow[] = scoped.map((transfer) => {
    const flow = direction(transfer, address);
    const counterparty = normalizeAddress(
      flow === "in" ? transfer.from : transfer.to,
    );
    return {
      id: transfer.id,
      transfer,
      direction: flow,
      counterparty: lookup(counterparty, transfer.chainId),
      usd: usdValue(transfer, book),
      visible: visible.has(transfer.id),
    };
  });

  if (filter.token) {
    const wanted = filter.token.toLowerCase();
    rows = rows.filter(
      (row) => row.transfer.asset.symbol.toLowerCase() === wanted,
    );
  }
  if (filter.minUsd !== undefined) {
    const floor = filter.minUsd;
    rows = rows.filter((row) => Number(row.usd?.amount ?? 0) >= floor);
  }

  const inflow = rows.filter((row) => row.direction !== "out");
  const outflow = rows.filter((row) => row.direction !== "in");
  const swapRows: SwapTableRow[] = deriveSwaps(
    rows.map((row) => row.transfer),
    address,
    book,
  )
    .filter((swap) =>
      filter.minUsd === undefined
        ? true
        : Number(swap.usd?.amount ?? 0) >= filter.minUsd,
    )
    .map((swap) => ({
      id: swap.id,
      swap,
      venue: swap.venue ? lookup(swap.venue, swap.chainId) : null,
    }));

  const selected =
    tab === "inflow" ? inflow : tab === "outflow" ? outflow : rows;
  const ordered = sortRows(selected, sort);
  const orderedSwaps = sortSwaps(swapRows, sort);

  const total = tab === "swaps" ? orderedSwaps.length : ordered.length;
  const start = Math.min(offset, Math.max(0, total - 1));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  let priced = 0;
  let unpriced = 0;
  let atBlock = 0;
  for (const row of rows) {
    if (!row.usd) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    if (row.usd.atBlock) atBlock += 1;
  }

  return {
    tab,
    address,
    scope: "loaded-evidence",
    rows: tab === "swaps" ? [] : ordered.slice(start, start + pageSize),
    swaps: tab === "swaps" ? orderedSwaps.slice(start, start + pageSize) : [],
    counts: {
      transfers: rows.length,
      inflow: inflow.length,
      outflow: outflow.length,
      swaps: orderedSwaps.length,
    },
    page: {
      offset: total === 0 ? 0 : start,
      pageSize,
      total,
      pageIndex: total === 0 ? 0 : Math.floor(start / pageSize),
      pageCount,
    },
    pricing: { priced, unpriced, atBlock },
  };
}
