import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Save,
  Search,
  X,
} from "lucide-react";
import type {
  Investigation,
  Label,
  TraceFilter,
  Transfer,
  WalletNode,
} from "../domain/types.ts";
import { assetKey, formatUnits, nodeKey } from "../domain/engine.ts";
import { walletFlows } from "../domain/wallet-flows.ts";
import { chainName, displayUnits, short } from "./Graph.tsx";

export interface VisibilityChange {
  nodeKeys?: string[];
  transferIds?: string[];
  visible: boolean;
}
export function WalletFlows({
  investigation,
  node,
  filter,
  busy,
  onVisibility,
  onWallet,
  onTransfer,
}: {
  investigation: Investigation;
  node: WalletNode;
  filter?: TraceFilter;
  busy: boolean;
  onVisibility: (change: VisibilityChange) => Promise<void>;
  onWallet: (node: WalletNode) => void;
  onTransfer: (transfer: Transfer) => void;
}) {
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [tab, setTab] = useState<"counterparties" | "transfers">(
    "counterparties",
  );
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [assetFilter, setAssetFilter] = useState(filter?.asset || "all");
  useEffect(() => setAssetFilter(filter?.asset || "all"), [filter?.asset]);
  useEffect(() => {
    setSearch("");
    setOffset(0);
  }, [node.address, node.chainId]);
  useEffect(
    () => setOffset(0),
    [direction, assetFilter, filter?.from, filter?.to, investigation.updatedAt],
  );
  const invalidDates = Boolean(
    filter?.from && filter.to && filter.from > filter.to,
  );
  const dates = invalidDates ? {} : { from: filter?.from, to: filter?.to };
  const assets = walletFlows(investigation, {
    address: node.address,
    chainId: node.chainId,
    filter: dates,
  }).flows;
  const effectiveAsset = assetFilter === "all" ? undefined : assetFilter;
  const base = walletFlows(investigation, {
    address: node.address,
    chainId: node.chainId,
    filter: { ...dates, asset: effectiveAsset },
  });
  const scope = walletFlows(investigation, {
    address: node.address,
    chainId: node.chainId,
    filter: { ...dates, asset: effectiveAsset, direction },
    offset,
    pageSize: 25,
  });
  const query = search.trim().toLowerCase();
  const counterparties = scope.counterparties.filter(
    (row) =>
      !query ||
      row.address.toLowerCase().includes(query) ||
      row.node?.label?.text.toLowerCase().includes(query),
  );
  const selectionRows =
    tab === "counterparties" ? counterparties : scope.counterparties;
  const recordIds = selectionRows.flatMap((row) => row.transferIds);
  const nodeKeys = [
    ...new Set([
      ...(node.address === investigation.root
        ? []
        : [nodeKey(node.chainId, node.address)]),
      ...selectionRows
        .filter((row) => row.address !== investigation.root)
        .map((row) => row.key),
    ]),
  ];
  const apply = (change: VisibilityChange) =>
    void onVisibility(change).catch(() => {});
  const labelStatus = (label: Label | undefined) =>
    !label
      ? "Ownership unknown"
      : label.confidence === "synthetic"
        ? "Synthetic label"
        : label.claimType === "hypothesis"
          ? "Hypothesis"
          : label.claimType === "verified-evidence"
            ? "Supplied evidence"
            : label.claimType === "provider-assertion"
              ? "Provider assertion"
              : "Legacy label";
  const totalRows = (flows: typeof base.flows) =>
    flows.map((flow) => (
      <div className="wallet-total-row" key={assetKey(flow.asset)} role="row">
        <span
          className="wallet-total-asset"
          role="rowheader"
          title={`${chainName(flow.asset.chainId)} · ${flow.asset.contract || "Native asset"}`}
        >
          <strong>{flow.asset.symbol}</strong>
          <small>
            {flow.asset.contract ? short(flow.asset.contract) : "Native"}
          </small>
        </span>
        {([flow.inflow, flow.outflow, flow.net] as const).map((raw, index) => (
          <span
            role="cell"
            className={
              index === 0 ? "inflow" : index === 2 ? "wallet-net" : undefined
            }
            key={index}
            title={`${formatUnits(raw, flow.asset.decimals)} ${flow.asset.symbol}`}
          >
            {index === 2 && BigInt(raw) > 0n ? "+" : ""}
            {displayUnits(raw, flow.asset.decimals)}
          </span>
        ))}
      </div>
    ));
  return (
    <section className="wallet-flow-panel" aria-label="Selected wallet flows">
      <div className="wallet-flow-toolbar">
        <span>Loaded flows · {chainName(node.chainId)}</span>
        <select
          aria-label="Wallet flow asset"
          value={assetFilter}
          onChange={(event) => setAssetFilter(event.target.value)}
        >
          <option value="all">All assets</option>
          {assets.map((flow) => (
            <option key={assetKey(flow.asset)} value={assetKey(flow.asset)}>
              {flow.asset.symbol} ·{" "}
              {flow.asset.contract ? short(flow.asset.contract) : "native"}
            </option>
          ))}
        </select>
      </div>
      {invalidDates ? (
        <p className="wallet-inline-error" role="status">
          Correct the date range to inspect wallet flows.
        </p>
      ) : (
        <>
          {base.flows.length > 0 && (
            <div
              className="wallet-summary-grid"
              role="table"
              aria-label="Loaded asset totals"
            >
              <div className="wallet-total-head" role="row">
                <span role="columnheader">Asset</span>
                <span role="columnheader">Gross in</span>
                <span role="columnheader">Gross out</span>
                <span role="columnheader">Net</span>
              </div>
              {totalRows(base.flows.slice(0, 2))}
              {base.flows.length > 2 && (
                <details className="wallet-more-totals">
                  <summary>{base.flows.length - 2} more assets</summary>
                  {totalRows(base.flows.slice(2))}
                </details>
              )}
            </div>
          )}
          <p className="wallet-totals-note">
            Both-direction loaded totals. Hiding paths preserves evidence.
          </p>
          <div
            className="wallet-direction-tabs"
            role="group"
            aria-label="Wallet flow direction"
          >
            {(
              [
                ["all", "Both", base.counts.transfers],
                ["in", "In", base.counts.inflows],
                ["out", "Out", base.counts.outflows],
              ] as const
            ).map(([value, title, count]) => (
              <button
                key={value}
                aria-label={`${title} wallet flows`}
                aria-pressed={direction === value}
                className={direction === value ? "active" : ""}
                onClick={() => setDirection(value)}
              >
                {title}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <div className="wallet-flow-tabs" aria-label="Wallet flow lists">
            <button
              className={tab === "counterparties" ? "active" : ""}
              aria-pressed={tab === "counterparties"}
              onClick={() => setTab("counterparties")}
            >
              Counterparties <span>{scope.counterparties.length}</span>
            </button>
            <button
              className={tab === "transfers" ? "active" : ""}
              aria-pressed={tab === "transfers"}
              onClick={() => setTab("transfers")}
            >
              Transfers <span>{scope.counts.transfers}</span>
            </button>
          </div>
          {tab === "counterparties" && (
            <label className="wallet-search">
              <Search size={15} />
              <input
                aria-label="Search counterparties"
                placeholder="Search name or address"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button
                  aria-label="Clear counterparty search"
                  onClick={() => setSearch("")}
                >
                  <X size={13} />
                </button>
              )}
            </label>
          )}
          <div className="wallet-selection-actions">
            <span>
              {tab === "counterparties" && query
                ? `${counterparties.length} matching`
                : `${scope.counts.visibleTransfers}/${scope.counts.transfers} enabled`}
            </span>
            <button
              disabled={busy || !recordIds.length}
              onClick={() =>
                apply({ nodeKeys, transferIds: recordIds, visible: true })
              }
            >
              Select all
            </button>
            <button
              disabled={busy || !recordIds.length}
              onClick={() => apply({ transferIds: recordIds, visible: false })}
            >
              Select none
            </button>
          </div>
          {tab === "counterparties" ? (
            <div
              className="wallet-counterparties"
              aria-label="Wallet counterparties"
            >
              {counterparties.length === 0 ? (
                <div className="wallet-list-empty">
                  <strong>
                    {query
                      ? "No matching counterparties"
                      : "No loaded counterparties"}
                  </strong>
                  <span>
                    {query
                      ? "Try another name or address."
                      : "Load a supported history page to discover connections. An empty list does not establish no activity."}
                  </span>
                </div>
              ) : (
                counterparties.map((row) => (
                  <div
                    className={`wallet-counterparty ${row.visibility === "none" ? "is-hidden" : ""}`}
                    key={row.key}
                  >
                    <div className="counterparty-heading">
                      <label className="visibility-toggle">
                        <input
                          type="checkbox"
                          aria-label={`Show counterparty ${row.key}`}
                          checked={row.visibility === "all"}
                          ref={(element) => {
                            if (element)
                              element.indeterminate = row.visibility === "some";
                          }}
                          disabled={busy}
                          onChange={(event) =>
                            apply({
                              nodeKeys: event.target.checked
                                ? [
                                    ...(row.address === investigation.root
                                      ? []
                                      : [row.key]),
                                    ...(node.address === investigation.root
                                      ? []
                                      : [nodeKey(node.chainId, node.address)]),
                                  ]
                                : [],
                              transferIds: row.transferIds,
                              visible: event.target.checked,
                            })
                          }
                        />
                      </label>
                      <button
                        className="counterparty-inspect"
                        title={row.address}
                        onClick={() =>
                          onWallet(
                            row.node || {
                              address: row.address,
                              chainId: row.chainId,
                            },
                          )
                        }
                      >
                        <strong>
                          {row.node?.label?.text ||
                            (row.address === node.address
                              ? "Self transfer"
                              : short(row.address))}
                        </strong>
                        <span>
                          {short(row.address)}
                          <span className="counterparty-label-status">
                            {labelStatus(row.node?.label)}
                          </span>
                        </span>
                      </button>
                      <ArrowRight size={14} />
                    </div>
                    <div className="counterparty-amounts">
                      {row.flows.map((flow) => (
                        <div
                          className="counterparty-asset-flow"
                          key={assetKey(flow.asset)}
                          title={`${chainName(flow.asset.chainId)} · ${flow.asset.contract || "Native asset"}`}
                        >
                          <span className="counterparty-asset-name">
                            {flow.asset.symbol}
                            {flow.asset.contract ? (
                              <small>{short(flow.asset.contract)}</small>
                            ) : null}
                          </span>
                          {direction !== "out" && (
                            <span className="inflow">
                              In{" "}
                              {displayUnits(flow.inflow, flow.asset.decimals)}{" "}
                              {flow.asset.symbol}
                            </span>
                          )}
                          {direction !== "in" && (
                            <span>
                              Out{" "}
                              {displayUnits(flow.outflow, flow.asset.decimals)}{" "}
                              {flow.asset.symbol}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="counterparty-row-meta">
                      <span>
                        {row.transferCount} transfer
                        {row.transferCount === 1 ? "" : "s"}
                      </span>
                      {row.node?.label && (
                        <details className="counterparty-provenance">
                          <summary>Label source</summary>
                          <div>
                            <strong>{row.node.label.source}</strong>
                            <span>
                              {row.node.label.claimType ||
                                "Legacy provider label"}{" "}
                              · {row.node.label.confidence}
                            </span>
                            <span>
                              Observed{" "}
                              {row.node.label.observedAt ||
                                row.node.label.retrievedAt}
                            </span>
                            {row.node.label.sourceUrl && (
                              <a
                                href={row.node.label.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                View source
                              </a>
                            )}
                            <p>Local label claim, not proof of ownership.</p>
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="wallet-transfer-selection">
              {scope.transfers.map(
                ({ transfer, direction: relative, visible }) => (
                  <div
                    className={`wallet-transfer-row ${visible ? "" : "is-hidden"}`}
                    key={transfer.id}
                  >
                    <label className="visibility-toggle">
                      <input
                        type="checkbox"
                        aria-label={`Show transfer ${transfer.id}`}
                        checked={visible}
                        disabled={busy}
                        onChange={(event) =>
                          apply({
                            transferIds: [transfer.id],
                            nodeKeys: event.target.checked
                              ? [
                                  nodeKey(transfer.chainId, transfer.from),
                                  nodeKey(transfer.chainId, transfer.to),
                                ]
                              : [],
                            visible: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <button onClick={() => onTransfer(transfer)}>
                      <strong>
                        <span className={relative === "in" ? "inflow" : ""}>
                          {relative === "self"
                            ? "Self"
                            : relative === "in"
                              ? "In"
                              : "Out"}
                        </span>
                        {displayUnits(
                          transfer.rawAmount,
                          transfer.asset.decimals,
                        )}{" "}
                        {transfer.asset.symbol}
                      </strong>
                      <span>
                        {short(transfer.from)} → {short(transfer.to)}
                      </span>
                      <small>
                        {transfer.timestamp.slice(0, 10)} UTC · {transfer.kind}
                      </small>
                    </button>
                    <ArrowRight size={14} />
                  </div>
                ),
              )}
              {scope.counts.transfers === 0 && (
                <div className="wallet-list-empty">
                  <strong>No loaded transfers</strong>
                  <span>
                    This direction and asset have no retained evidence.
                  </span>
                </div>
              )}
              <div className="wallet-pagination">
                <button
                  aria-label="Previous wallet transfer page"
                  disabled={scope.page.previousOffset === null}
                  onClick={() => setOffset(scope.page.previousOffset ?? 0)}
                >
                  <ChevronLeft size={15} />
                </button>
                <span>
                  {scope.counts.transfers ? scope.page.offset + 1 : 0}–
                  {Math.min(
                    scope.page.offset + scope.page.pageSize,
                    scope.page.total,
                  )}{" "}
                  of {scope.page.total} loaded
                </span>
                <button
                  aria-label="Next wallet transfer page"
                  disabled={scope.page.nextOffset === null}
                  onClick={() => setOffset(scope.page.nextOffset ?? 0)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <details className="wallet-coverage-note">
        <summary>
          {scope.coverage.some((item) => item.cursor)
            ? "More history available"
            : scope.coverage.length
              ? "Limited history coverage"
              : "History not requested"}
          <span>Loaded evidence only</span>
        </summary>
        <div>
          {scope.coverage.map((item) => (
            <p key={item.key}>
              {item.pagesLoaded} page{item.pagesLoaded === 1 ? "" : "s"} ·{" "}
              {item.status === "exhausted"
                ? "loaded stream exhausted"
                : item.status}
              {item.cursor ? " · Resume using Load next page" : ""}
            </p>
          ))}
          <p>
            Missing streams and other chains remain outside this scope. A
            provider's final page does not establish complete wallet history.
          </p>
        </div>
      </details>
    </section>
  );
}

export function WalletLabelEditor({
  node,
  busy,
  onAnnotate,
}: {
  node: WalletNode;
  busy: boolean;
  onAnnotate: (node: WalletNode, label: Label | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(node.label?.text || "");
  const [source, setSource] = useState(node.label?.source || "Local analyst");
  const [sourceUrl, setSourceUrl] = useState(node.label?.sourceUrl || "");
  const [claim, setClaim] = useState<NonNullable<Label["claimType"]>>(
    node.label?.claimType || "hypothesis",
  );
  const [confidence, setConfidence] = useState<Label["confidence"]>(
    node.label?.confidence || "unverified",
  );
  const initialObserved = useMemo(
    () =>
      (
        node.label?.observedAt ||
        node.label?.retrievedAt ||
        new Date().toISOString()
      ).slice(0, 16),
    [node.label],
  );
  const [observed, setObserved] = useState(initialObserved);
  const [note, setNote] = useState(node.label?.evidenceNote || "");
  const [error, setError] = useState("");
  async function submit(remove = false) {
    setError("");
    try {
      if (!remove && !name.trim())
        throw new Error("Enter an entity name or label.");
      await onAnnotate(
        node,
        remove
          ? null
          : {
              text: name.trim(),
              source: source.trim(),
              ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
              kind: "entity",
              confidence,
              claimType: claim,
              observedAt: new Date(`${observed}Z`).toISOString(),
              retrievedAt: new Date().toISOString(),
              ...(note.trim() ? { evidenceNote: note.trim() } : {}),
            },
      );
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not preserve this label.",
      );
    }
  }
  return (
    <section
      className="wallet-label-editor"
      aria-label="Wallet attribution editor"
    >
      <button
        className="button subtle"
        onClick={() => setOpen((value) => !value)}
      >
        <Pencil size={13} />
        {node.label ? "Edit entity label" : "Add entity label"}
      </button>
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            Applies to {chainName(node.chainId)} · {short(node.address)}.
            Funding links do not establish ownership.
          </p>
          <label>
            Entity or ownership label
            <input
              aria-label="Entity label"
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Claim type
            <select
              aria-label="Label claim type"
              value={claim}
              onChange={(event) => setClaim(event.target.value as typeof claim)}
            >
              <option value="hypothesis">Hypothesis</option>
              <option value="provider-assertion">Provider assertion</option>
              <option value="verified-evidence">
                Verified evidence supplied by analyst
              </option>
            </select>
          </label>
          <label>
            Confidence
            <select
              aria-label="Label confidence"
              value={confidence}
              onChange={(event) =>
                setConfidence(event.target.value as typeof confidence)
              }
            >
              <option value="unverified">Unverified</option>
              <option value="reported">Reported</option>
              <option value="verified">Verified by supplied evidence</option>
              {confidence === "synthetic" && (
                <option value="synthetic">Synthetic</option>
              )}
            </select>
          </label>
          <label>
            Source / provider
            <input
              aria-label="Label source"
              maxLength={200}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <label>
            Source URL (HTTPS, optional)
            <input
              aria-label="Label source URL"
              type="url"
              placeholder="https://…"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </label>
          <label>
            Observed at (UTC)
            <input
              aria-label="Label observed at"
              type="datetime-local"
              required
              value={observed}
              onChange={(event) => setObserved(event.target.value)}
            />
          </label>
          <label>
            Evidence note
            {claim === "verified-evidence" ? " (required)" : " (optional)"}
            <textarea
              aria-label="Label evidence note"
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p>
            FlowLens retains your claim; it does not independently verify
            ownership. Only retain data you may use. No Arkham lookup is
            performed.
          </p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="label-form-actions">
            <button className="button primary" type="submit" disabled={busy}>
              <Save size={13} />
              Save label
            </button>
            {node.label && (
              <button
                className="button subtle"
                type="button"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                Remove label
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
