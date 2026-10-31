import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  HypercoreEntry,
  HypercoreEvidenceBundle,
} from "../domain/hypercore.ts";
import { findHypercoreBridgeTransfer } from "../domain/hypercore.ts";
import type { Transfer } from "../domain/types.ts";
import { chainName, explorer } from "./Graph.tsx";
import "../hypercore.css";

const PAGE_SIZE = 25;
const TOKEN_KEYS = ["coin", "token", "asset", "symbol", "currency"] as const;

export interface HypercoreHistoryProps {
  bundle?: HypercoreEvidenceBundle;
  transfers?: readonly Transfer[];
  onLoad?: () => Promise<void>;
  busy?: boolean;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function actionLabel(entry: HypercoreEntry): string {
  if (entry.delta.type === "borrowLend") {
    const operation = textValue(entry.delta.operation);
    if (operation === "supply") return "Supply (lending)";
    if (operation === "withdraw") return "Withdraw (lending)";
  }
  const known: Record<string, string> = {
    borrowLend: "Borrow / lend",
    cStakingTransfer: "Staking transfer",
    deposit: "Deposit",
    send: "Send",
    spotTransfer: "Spot transfer",
    withdraw: "Withdraw",
  };
  if (known[entry.delta.type]) return known[entry.delta.type];
  const spaced = entry.delta.type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : "Unknown action";
}

function utcTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not returned";
  return `${date.toISOString().replace("T", " ").replace("Z", " UTC")}`;
}

function coverageWindow(bundle: HypercoreEvidenceBundle): string {
  const { startTime, endTime } = bundle.coverage;
  return `${utcTime(startTime)} → ${utcTime(endTime)}`;
}

function coverageNote(bundle: HypercoreEvidenceBundle): string {
  const { coverage } = bundle;
  if (coverage.exhausted || coverage.status === "exhausted")
    return "Window loaded; complete history not established.";
  if (coverage.status === "error")
    return "Window incomplete; committed entries retained. Resume loading to continue.";
  if (coverage.status === "unsupported")
    return "Window unavailable; committed entries retained.";
  return "Window incomplete; committed entries retained. Load next page to continue.";
}

function tokenFor(entry: HypercoreEntry): string {
  if (
    (entry.delta.type === "deposit" || entry.delta.type === "withdraw") &&
    textValue(entry.delta.usdc)
  )
    return "USDC";
  for (const key of TOKEN_KEYS) {
    const value = textValue(entry.delta[key]);
    if (value) return value;
  }
  return "Not returned";
}

function amountFor(entry: HypercoreEntry): string {
  return (
    textValue(entry.delta.amount) ??
    textValue(entry.delta.usdc) ??
    "Not returned"
  );
}

function directionClass(entry: HypercoreEntry): string {
  if (entry.flow.accountingDirection === "in") return "in";
  if (entry.flow.accountingDirection === "out") return "out";
  return "self";
}

function endpointLabel(entry: HypercoreEntry): string | null {
  if (entry.flow.endpointKind === "protocol-accounting")
    return "Protocol accounting";
  if (entry.flow.endpointKind === "bridge-accounting")
    return "Bridge accounting";
  return null;
}

function RelatedBridgeTransfer({ transfer }: { transfer: Transfer }) {
  const transactionUrl = transfer.synthetic
    ? undefined
    : explorer(transfer.chainId, "tx", transfer.hash);
  const addressUrl = (value: string) =>
    transfer.synthetic
      ? undefined
      : explorer(transfer.chainId, "address", value);
  const fromUrl = addressUrl(transfer.from);
  const toUrl = addressUrl(transfer.to);
  return (
    <div className="hypercore-bridge-relation">
      <strong>
        Related {chainName(transfer.chainId)} bridge leg · not a HyperCore
        endpoint or finalization proof
      </strong>
      <span>
        {fromUrl ? (
          <a href={fromUrl} target="_blank" rel="noreferrer">
            <code>{transfer.from}</code>
          </a>
        ) : (
          <code>{transfer.from}</code>
        )}{" "}
        →{" "}
        {toUrl ? (
          <a href={toUrl} target="_blank" rel="noreferrer">
            <code>{transfer.to}</code>
          </a>
        ) : (
          <code>{transfer.to}</code>
        )}
      </span>
      <span>
        Transfer ID: <code>{transfer.id}</code>
      </span>
      {transactionUrl ? (
        <a href={transactionUrl} target="_blank" rel="noreferrer">
          Verify {chainName(transfer.chainId)} transaction
        </a>
      ) : null}
    </div>
  );
}

function RawRecord({
  entry,
  bridgeTransfer,
}: {
  entry: HypercoreEntry;
  bridgeTransfer: Transfer | null;
}) {
  const raw =
    JSON.stringify(
      {
        hash: entry.hash,
        delta: entry.delta,
        provenance: entry.provenance,
      },
      null,
      2,
    ) ?? "{}";
  return (
    <details className="hypercore-raw">
      <summary>Raw record</summary>
      {bridgeTransfer ? (
        <RelatedBridgeTransfer transfer={bridgeTransfer} />
      ) : null}
      <pre>{raw}</pre>
    </details>
  );
}

function AddressCell({
  label,
  value,
  emptyLabel,
  copied,
  onCopy,
}: {
  label: "from" | "to";
  value: string | null;
  emptyLabel: string;
  copied: boolean;
  onCopy: (value: string) => void;
}) {
  if (!value)
    return <span className="hypercore-not-returned">{emptyLabel}</span>;
  return (
    <button
      className="hypercore-address"
      type="button"
      aria-label={`Copy ${label} address`}
      onClick={() => onCopy(value)}
    >
      <code>{value}</code>
      {copied ? <span className="hypercore-copied">Copied</span> : null}
    </button>
  );
}

function loadLabel(bundle: HypercoreEvidenceBundle | undefined): string {
  if (!bundle) return "Load HyperCore";
  if (bundle.coverage.exhausted || bundle.coverage.status === "exhausted")
    return "Window loaded";
  if (bundle.coverage.status === "error") return "Resume load";
  if (bundle.coverage.status === "unsupported") return "HyperCore unavailable";
  return "Load next page";
}

function loadDisabled(
  bundle: HypercoreEvidenceBundle | undefined,
  busy: boolean,
  onLoad: (() => Promise<void>) | undefined,
): boolean {
  return (
    busy ||
    !onLoad ||
    Boolean(
      bundle &&
      (bundle.coverage.exhausted ||
        bundle.coverage.status === "exhausted" ||
        bundle.coverage.status === "unsupported"),
    )
  );
}

export function HypercoreHistory({
  bundle,
  transfers = [],
  onLoad,
  busy = false,
}: HypercoreHistoryProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const entries = useMemo(
    () =>
      [...(bundle?.entries ?? [])].sort((a, b) => {
        if (a.time !== b.time) return b.time > a.time ? 1 : -1;
        return b.id.localeCompare(a.id);
      }),
    [bundle],
  );
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageEntries = entries.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const hasPrevious = currentPage > 0;
  const hasNext = currentPage + 1 < pageCount;
  const coverage = bundle?.coverage;
  const bridgeTransfers = useMemo(() => {
    const matches = new Map<string, Transfer | null>();
    for (const entry of entries)
      matches.set(entry.id, findHypercoreBridgeTransfer(entry, transfers));
    return matches;
  }, [entries, transfers]);

  useEffect(() => {
    setPageIndex(0);
    setCopiedAddress(null);
    setLoadError(null);
  }, [bundle]);

  useEffect(() => {
    setPageIndex((value) => Math.min(value, pageCount - 1));
  }, [pageCount]);

  async function requestNextPage() {
    const load = onLoad;
    if (loadDisabled(bundle, busy, load) || !load) return;
    setLoadError(null);
    try {
      await load();
    } catch (error) {
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : "HyperCore ledger load failed.",
      );
    }
  }

  async function copyAddress(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAddress(value);
    } catch {
      // Clipboard access is optional; the full address remains selectable text.
    }
  }

  const notices = [
    loadError,
    coverage?.error,
    ...(coverage?.warnings ?? []),
  ].filter((value): value is string => Boolean(value));

  return (
    <section
      className="txpanel hypercore-panel"
      aria-labelledby="hypercore-ledger-heading"
      aria-busy={busy}
    >
      <header className="hypercore-header">
        <div>
          <span className="eyebrow">Ledger history</span>
          <h2 id="hypercore-ledger-heading">HyperCore ledger</h2>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={loadDisabled(bundle, busy, onLoad)}
          onClick={() => void requestNextPage()}
        >
          {busy ? (
            <LoaderCircle className="hypercore-spinner" aria-hidden="true" />
          ) : null}
          {loadLabel(bundle)}
        </button>
      </header>

      {notices.length ? (
        <details className="hypercore-notices">
          <summary>Load details ({notices.length})</summary>
          <ul>
            {notices.map((notice, index) => (
              <li key={`${notice}-${index}`}>{notice}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {bundle ? (
        <>
          <div className="hypercore-meta">
            <div className="hypercore-count">
              <strong>{entries.length}</strong> ledger entries loaded
              {bundle.mode === "synthetic" ? (
                <span className="hypercore-badge">Synthetic evidence</span>
              ) : null}
            </div>
            <div className="hypercore-coverage">
              <span>Provider window: {coverageWindow(bundle)}</span>
              <span>Provider: {bundle.coverage.provider}</span>
            </div>
            <p className="hypercore-coverage-note">{coverageNote(bundle)}</p>
          </div>

          <div className="txscroll">
            {pageEntries.length ? (
              <table className="txtable hypercore-table">
                <thead>
                  <tr>
                    <th scope="col">UTC time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Token</th>
                    <th scope="col">Amount</th>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                  </tr>
                </thead>
                <tbody>
                  {pageEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="txtime">{utcTime(entry.time)}</td>
                      <td>
                        <div className="hypercore-action">
                          <span>{actionLabel(entry)}</span>
                          {endpointLabel(entry) ? (
                            <span className="hypercore-badge">
                              {endpointLabel(entry)}
                            </span>
                          ) : null}
                          {entry.flow.counterparty === "system-transport" ? (
                            <span className="hypercore-badge">
                              System transport
                            </span>
                          ) : null}
                          {entry.hashKind === "virtual" ? (
                            <span className="hypercore-badge hypercore-badge-muted">
                              Virtual event
                            </span>
                          ) : null}
                        </div>
                        <RawRecord
                          entry={entry}
                          bridgeTransfer={bridgeTransfers.get(entry.id) ?? null}
                        />
                      </td>
                      <td className="txtoken">{tokenFor(entry)}</td>
                      <td className={`txvalue ${directionClass(entry)}`}>
                        {amountFor(entry)}
                      </td>
                      <td>
                        <AddressCell
                          label="from"
                          value={entry.flow.from}
                          emptyLabel={endpointLabel(entry) ?? "Not returned"}
                          copied={copiedAddress === entry.flow.from}
                          onCopy={(value) => void copyAddress(value)}
                        />
                      </td>
                      <td>
                        <AddressCell
                          label="to"
                          value={entry.flow.to}
                          emptyLabel={endpointLabel(entry) ?? "Not returned"}
                          copied={copiedAddress === entry.flow.to}
                          onCopy={(value) => void copyAddress(value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="txempty">
                <strong>No ledger entries in this window</strong>
                Load HyperCore to request a provider window.
              </div>
            )}
          </div>

          <footer className="txfoot hypercore-footer">
            <span>
              Showing {pageEntries.length} of {entries.length} loaded entries
            </span>
            <span className="txfoot-right hypercore-pager">
              Page {currentPage + 1} / {pageCount}
              <button
                className="icon-button"
                type="button"
                aria-label="Previous HyperCore ledger page"
                disabled={!hasPrevious}
                onClick={() => setPageIndex((value) => Math.max(0, value - 1))}
              >
                <ChevronLeft aria-hidden="true" size={13} />
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Next HyperCore ledger page"
                disabled={!hasNext}
                onClick={() =>
                  setPageIndex((value) => Math.min(pageCount - 1, value + 1))
                }
              >
                <ChevronRight aria-hidden="true" size={13} />
              </button>
            </span>
          </footer>
        </>
      ) : (
        <div className="txempty hypercore-empty">
          <strong>No HyperCore ledger window loaded</strong>
          Use the button to request the provider-scoped non-funding ledger
          window.
        </div>
      )}
    </section>
  );
}
