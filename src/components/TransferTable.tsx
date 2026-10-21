import {
  Bell,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ExternalLink,
  Filter,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Investigation, Transfer, WalletNode } from "../domain/types.ts";
import {
  buildTransferTable,
  type SortField,
  type TableFilter,
  type TableSort,
  type TransferTab,
  type TransferTableRow,
} from "../domain/transfer-table.ts";
import { formatCompact, formatUsd, wholeUnits } from "../domain/pricing.ts";
import type { PriceBook } from "../domain/pricing.ts";
import { chainName, explorer, short } from "./Graph.tsx";

const TABS: { id: TransferTab; label: string }[] = [
  { id: "transfers", label: "Transfers" },
  { id: "inflow", label: "Inflow" },
  { id: "outflow", label: "Outflow" },
  { id: "swaps", label: "Swaps" },
];

const USD_STEPS = [0, 1, 10, 100, 1000, 10_000];

/** UTC, second precision, column-aligned — the format addresses and hashes are read in. */
function timestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function Party({
  node,
  address,
  chainId,
}: {
  node?: WalletNode;
  address: string;
  chainId: number;
}) {
  const label = node?.label;
  return (
    <span className="txparty">
      {label ? (
        <>
          <span
            className="txparty-name"
            title={`${label.text} — ${label.source}`}
          >
            {label.text}
          </span>
          <span
            className={`labelchip ${label.kind}`}
            title={`${label.kind} attribution · ${label.confidence}${
              label.claimType ? ` · ${label.claimType}` : ""
            }`}
          >
            {label.kind}
          </span>
        </>
      ) : null}
      <span
        className="txparty-addr"
        title={`${address} on ${chainName(chainId)}`}
      >
        ({short(address)})
      </span>
    </span>
  );
}

function SortHeader({
  field,
  label,
  sort,
  onSort,
  numeric = false,
}: {
  field: SortField;
  label: string;
  sort: TableSort;
  onSort: (field: SortField) => void;
  numeric?: boolean;
}) {
  const active = sort.field === field;
  const ariaSort = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th
      scope="col"
      style={numeric ? { textAlign: "right" } : undefined}
      aria-sort={ariaSort}
    >
      <button
        className="txsort"
        aria-sort={ariaSort}
        onClick={() => onSort(field)}
      >
        {label}
        <ChevronsUpDown aria-hidden="true" />
      </button>
    </th>
  );
}

export function TransferTable({
  investigation,
  address,
  book,
  onSelect,
  onRefresh,
  refreshing = false,
}: {
  investigation: Investigation;
  address: string;
  book: PriceBook;
  onSelect: (transfer: Transfer) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [tab, setTab] = useState<TransferTab>("transfers");
  const [sort, setSort] = useState<TableSort>({
    field: "time",
    direction: "desc",
  });
  const [offset, setOffset] = useState(0);
  const [minUsd, setMinUsd] = useState<number | null>(null);
  const pageSize = 25;

  const filter: TableFilter = useMemo(
    () => (minUsd === null ? {} : { minUsd }),
    [minUsd],
  );

  const view = useMemo(
    () =>
      buildTransferTable(investigation, {
        address,
        tab,
        sort,
        offset,
        pageSize,
        filter,
        book,
      }),
    [investigation, address, tab, sort, offset, filter, book],
  );

  const choose = (next: TransferTab) => {
    setTab(next);
    setOffset(0);
  };

  const applySort = (field: SortField) => {
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === "desc" ? "asc" : "desc" }
        : { field, direction: "desc" },
    );
    setOffset(0);
  };

  const cycleUsdFloor = () => {
    const index = minUsd === null ? 0 : USD_STEPS.indexOf(minUsd);
    const next = USD_STEPS[(index + 1) % USD_STEPS.length];
    setMinUsd(next === 0 ? null : next);
    setOffset(0);
  };

  const { page } = view;
  const canPrevious = page.offset > 0;
  const canNext = page.offset + page.pageSize < page.total;

  const count = (id: TransferTab) =>
    id === "transfers"
      ? view.counts.transfers
      : id === "inflow"
        ? view.counts.inflow
        : id === "outflow"
          ? view.counts.outflow
          : view.counts.swaps;

  return (
    <section className="txpanel" aria-label="Transaction history">
      <div
        className="txtabs"
        role="tablist"
        aria-label="Transaction history view"
      >
        {TABS.map((entry) => {
          const selected = tab === entry.id;
          return (
            <button
              key={entry.id}
              role="tab"
              id={`txtab-${entry.id}`}
              aria-selected={selected}
              aria-controls="txtable-panel"
              className="txtab"
              onClick={() => choose(entry.id)}
            >
              {entry.label}
              <span className="txtab-count">{count(entry.id)}</span>
              {selected && page.total > page.pageSize ? (
                <span className="txpager">
                  <button
                    aria-label="Previous page"
                    disabled={!canPrevious}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOffset(Math.max(0, offset - pageSize));
                    }}
                  >
                    <ChevronLeft aria-hidden="true" size={13} />
                  </button>
                  {page.pageIndex + 1} / {page.pageCount}
                  <button
                    aria-label="Next page"
                    disabled={!canNext}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOffset(offset + pageSize);
                    }}
                  >
                    <ChevronRight aria-hidden="true" size={13} />
                  </button>
                </span>
              ) : null}
            </button>
          );
        })}
        {onRefresh ? (
          <button
            className="icon-button"
            style={{ border: 0, width: 40, flex: "none" }}
            aria-label="Re-read loaded evidence"
            onClick={onRefresh}
          >
            <RefreshCw
              className={refreshing ? "spin" : undefined}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </div>

      <div className="txtools">
        {minUsd === null ? (
          <button className="txchip txchip-add" onClick={cycleUsdFloor}>
            <Plus aria-hidden="true" size={11} />
            USD floor
          </button>
        ) : (
          <span className="txchip">
            <button
              aria-label="Clear the USD floor"
              onClick={() => setMinUsd(null)}
            >
              <X aria-hidden="true" size={11} />
            </button>
            <button
              className="txchip-cycle"
              style={{ color: "inherit" }}
              onClick={cycleUsdFloor}
              aria-label="Raise the USD floor"
            >
              USD &gt;= ${formatCompact(minUsd, 0)}
            </button>
          </span>
        )}
        <span style={{ color: "var(--text-faint)", fontSize: 10 }}>
          <Filter
            aria-hidden="true"
            size={10}
            style={{ verticalAlign: "-1px" }}
          />{" "}
          loaded evidence only
        </span>
        <span className="txtools-right">
          <button
            className="icon-button"
            aria-label="Alerts are not configured"
            disabled
          >
            <Bell aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            aria-label="Bookmarks are not configured"
            disabled
          >
            <Bookmark aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            aria-label="Saving is handled by the case actions"
            disabled
          >
            <Save aria-hidden="true" />
          </button>
        </span>
      </div>

      <div
        className="txscroll"
        id="txtable-panel"
        role="tabpanel"
        aria-labelledby={`txtab-${tab}`}
      >
        {tab === "swaps" ? (
          <SwapRows
            view={view}
            onSelect={onSelect}
            sort={sort}
            onSort={applySort}
          />
        ) : (
          <TransferRows
            view={view}
            onSelect={onSelect}
            sort={sort}
            onSort={applySort}
          />
        )}
      </div>

      <div className="txfoot">
        <span>
          {page.total}{" "}
          {tab === "swaps" ? "two-sided transactions" : "transfers"} in loaded
          evidence
        </span>
        {view.pricing.unpriced > 0 ? (
          <span>· {view.pricing.unpriced} unpriced</span>
        ) : null}
        <span className="txfoot-right">
          Loaded evidence only — an empty view is not an absence of history
        </span>
      </div>
    </section>
  );
}

function TransferRows({
  view,
  onSelect,
  sort,
  onSort,
}: {
  view: ReturnType<typeof buildTransferTable>;
  onSelect: (transfer: Transfer) => void;
  sort: TableSort;
  onSort: (field: SortField) => void;
}) {
  if (!view.rows.length) return <Empty tab={view.tab} />;
  return (
    <table className="txtable">
      <thead>
        <tr>
          <th scope="col" aria-label="Chain" style={{ width: 26 }} />
          <SortHeader
            field="time"
            label="Time (UTC)"
            sort={sort}
            onSort={onSort}
          />
          <th scope="col">From</th>
          <th scope="col">To</th>
          <SortHeader
            field="value"
            label="Value"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <th scope="col">Token</th>
          <SortHeader
            field="usd"
            label="USD"
            sort={sort}
            onSort={onSort}
            numeric
          />
          <th scope="col" style={{ width: 26 }} aria-label="Explorer" />
        </tr>
      </thead>
      <tbody>
        {view.rows.map((row) => (
          <Row key={row.id} row={row} onSelect={onSelect} />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  row,
  onSelect,
}: {
  row: TransferTableRow;
  onSelect: (transfer: Transfer) => void;
}) {
  const { transfer } = row;
  const units = wholeUnits(transfer.rawAmount, transfer.asset.decimals);
  // Synthetic hashes are invented. Linking them to a block explorer would send the
  // reader to a page that does not exist and dress a fixture up as a chain record.
  const link = transfer.synthetic
    ? undefined
    : explorer(transfer.chainId, "tx", transfer.hash);
  return (
    <tr
      className={row.visible ? undefined : "hidden-evidence"}
      onClick={() => onSelect(transfer)}
      title={
        row.visible
          ? undefined
          : "Hidden from the graph; still counted in loaded totals"
      }
    >
      <td>
        <span
          className={`chain-dot chain-${transfer.chainId}`}
          title={chainName(transfer.chainId)}
        />
      </td>
      <td className="txtime">{timestamp(transfer.timestamp)}</td>
      <td>
        <Party
          node={row.direction === "in" ? row.counterparty.node : undefined}
          address={transfer.from}
          chainId={transfer.chainId}
        />
      </td>
      <td>
        <Party
          node={row.direction === "out" ? row.counterparty.node : undefined}
          address={transfer.to}
          chainId={transfer.chainId}
        />
      </td>
      <td className={`txvalue ${row.direction}`}>
        {row.direction === "out" ? "−" : row.direction === "in" ? "+" : ""}
        {formatCompact(units)}
      </td>
      <td>
        <span className="txtoken">
          <span
            className={`chain-dot chain-${transfer.chainId}`}
            aria-hidden="true"
          />
          {transfer.asset.symbol}
        </span>
      </td>
      <td className={`txusd ${row.usd ? "" : "unpriced"}`}>
        {formatUsd(row.usd)}
      </td>
      <td>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open in a block explorer"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink aria-hidden="true" size={12} />
          </a>
        ) : null}
      </td>
    </tr>
  );
}

function SwapRows({
  view,
  onSelect,
  sort,
  onSort,
}: {
  view: ReturnType<typeof buildTransferTable>;
  onSelect: (transfer: Transfer) => void;
  sort: TableSort;
  onSort: (field: SortField) => void;
}) {
  if (!view.swaps.length) return <Empty tab="swaps" />;
  return (
    <table className="txtable">
      <thead>
        <tr>
          <th scope="col" aria-label="Chain" style={{ width: 26 }} />
          <SortHeader
            field="time"
            label="Time (UTC)"
            sort={sort}
            onSort={onSort}
          />
          <th scope="col">Venue</th>
          <th scope="col">Sold</th>
          <th scope="col">Bought</th>
          <SortHeader
            field="usd"
            label="USD"
            sort={sort}
            onSort={onSort}
            numeric
          />
        </tr>
      </thead>
      <tbody>
        {view.swaps.map(({ id, swap, venue }) => (
          <tr key={id} onClick={() => onSelect(swap.sold)}>
            <td>
              <span
                className={`chain-dot chain-${swap.chainId}`}
                title={chainName(swap.chainId)}
              />
            </td>
            <td className="txtime">{timestamp(swap.timestamp)}</td>
            <td>
              {venue ? (
                <Party
                  node={venue.node}
                  address={venue.address}
                  chainId={venue.chainId}
                />
              ) : (
                <span
                  className="txparty-addr"
                  title="Both legs faced different addresses"
                >
                  not a single venue
                </span>
              )}
            </td>
            <td className="txvalue out">
              −
              {formatCompact(
                wholeUnits(swap.sold.rawAmount, swap.sold.asset.decimals),
              )}{" "}
              {swap.sold.asset.symbol}
            </td>
            <td className="txvalue in">
              +
              {formatCompact(
                wholeUnits(swap.bought.rawAmount, swap.bought.asset.decimals),
              )}{" "}
              {swap.bought.asset.symbol}
            </td>
            <td className={`txusd ${swap.usd ? "" : "unpriced"}`}>
              {formatUsd(swap.usd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ tab }: { tab: TransferTab }) {
  return (
    <div className="txempty">
      <strong>
        {tab === "swaps"
          ? "No two-sided transactions in loaded evidence."
          : "No transfers match this view."}
      </strong>
      {tab === "swaps"
        ? "A swap appears here when both legs of one transaction have been loaded."
        : "Expand a wallet or widen the filters; this reads loaded evidence and never fetches."}
    </div>
  );
}
