import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Save,
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
  const [offset, setOffset] = useState(0);
  const [assetFilter, setAssetFilter] = useState(filter?.asset || "all");
  useEffect(() => setAssetFilter(filter?.asset || "all"), [filter?.asset]);
  const assets = walletFlows(investigation, {
    address: node.address,
    chainId: node.chainId,
    filter: { from: filter?.from, to: filter?.to },
  }).flows;
  const scope = walletFlows(investigation, {
    address: node.address,
    chainId: node.chainId,
    filter: {
      ...filter,
      asset: assetFilter === "all" ? undefined : assetFilter,
      direction,
    },
    offset,
    pageSize: 25,
  });
  useEffect(
    () => setOffset(0),
    [
      node.address,
      node.chainId,
      direction,
      assetFilter,
      filter?.asset,
      filter?.from,
      filter?.to,
    ],
  );
  const recordIds = scope.counterparties.flatMap((row) => row.transferIds);
  const nodeKeys = [
    ...new Set([
      ...(node.address === investigation.root
        ? []
        : [nodeKey(node.chainId, node.address)]),
      ...scope.counterparties
        .filter((row) => row.address !== investigation.root)
        .map((row) => row.key),
    ]),
  ];
  const apply = (change: VisibilityChange) =>
    void onVisibility(change).catch(() => {});
  const coverage = scope.coverage;
  return (
    <section className="wallet-flow-panel" aria-label="Selected wallet flows">
      <div className="wallet-section-title">
        <h3>Wallet flows</h3>
        <span>{chainName(node.chainId)}</span>
      </div>
      <p className="wallet-scope-note">
        Loaded evidence for this wallet · asset/time filters apply. Graph
        selections do not change these totals.
      </p>
      <div className="wallet-flow-totals">
        {scope.flows.length === 0 ? (
          <p>
            No loaded transfers in this scope. This does not establish zero
            activity.
          </p>
        ) : (
          scope.flows.map((flow) => (
            <div className="wallet-asset-total" key={assetKey(flow.asset)}>
              <strong title={flow.asset.contract || "Native asset"}>
                {flow.asset.symbol}
                <span>
                  {flow.asset.contract ? short(flow.asset.contract) : "Native"}
                </span>
              </strong>
              <dl>
                {(
                  [
                    ["Gross in", flow.inflow],
                    ["Gross out", flow.outflow],
                    ["Net", flow.net],
                  ] as const
                ).map(([title, raw]) => (
                  <div key={title}>
                    <dt>{title}</dt>
                    <dd
                      title={`${formatUnits(raw, flow.asset.decimals)} ${flow.asset.symbol}`}
                    >
                      {title === "Net" && BigInt(raw) > 0n ? "+" : ""}
                      {displayUnits(raw, flow.asset.decimals)}{" "}
                      <small>{flow.asset.symbol}</small>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))
        )}
      </div>
      <div className="wallet-list-controls">
        <label>
          Direction
          <select
            aria-label="Wallet flow direction"
            value={direction}
            onChange={(event) =>
              setDirection(event.target.value as typeof direction)
            }
          >
            <option value="all">In & out</option>
            <option value="in">Inflows</option>
            <option value="out">Outflows</option>
          </select>
        </label>
        <label>
          Asset
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
        </label>
        <span>
          {scope.counts.visibleTransfers} / {scope.counts.transfers} enabled for
          graph
        </span>
      </div>
      <div className="wallet-flow-tabs" aria-label="Wallet flow lists">
        <button
          className={tab === "counterparties" ? "active" : ""}
          onClick={() => setTab("counterparties")}
        >
          Counterparties <span>{scope.counterparties.length}</span>
        </button>
        <button
          className={tab === "transfers" ? "active" : ""}
          onClick={() => setTab("transfers")}
        >
          Transfers <span>{scope.counts.transfers}</span>
        </button>
      </div>
      <div className="wallet-selection-actions">
        <span>Show in graph</span>
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
        <div className="wallet-counterparties">
          {scope.counterparties.length === 0 ? (
            <p className="quiet-note">
              No counterparties loaded. Expand this wallet to request another
              supported page.
            </p>
          ) : (
            scope.counterparties.map((row) => (
              <div
                className={`wallet-counterparty ${row.visibility === "none" ? "is-hidden" : ""}`}
                key={row.key}
              >
                <div className="counterparty-heading">
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
                        nodeKeys: [
                          ...(row.address === investigation.root
                            ? []
                            : [row.key]),
                          ...(event.target.checked &&
                          node.address !== investigation.root
                            ? [nodeKey(node.chainId, node.address)]
                            : []),
                        ],
                        transferIds: row.transferIds,
                        visible: event.target.checked,
                      })
                    }
                  />
                  <button
                    className="counterparty-inspect"
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
                      {row.node?.label
                        ? `${short(row.address)} · ${row.node.label.claimType || row.node.label.confidence}`
                        : "Ownership unknown"}
                    </span>
                  </button>
                  <ArrowRight size={13} />
                </div>
                <div className="counterparty-counts">
                  {row.inflowCount} in · {row.outflowCount} out ·{" "}
                  {row.transferCount} transfers
                </div>
                {row.flows.map((flow) => (
                  <div
                    className="counterparty-amounts"
                    key={assetKey(flow.asset)}
                    title={flow.asset.contract || "Native asset"}
                  >
                    <span>
                      {flow.asset.symbol}{" "}
                      {flow.asset.contract
                        ? short(flow.asset.contract)
                        : "· native"}
                    </span>
                    <span>
                      In {displayUnits(flow.inflow, flow.asset.decimals)}
                    </span>
                    <span>
                      Out {displayUnits(flow.outflow, flow.asset.decimals)}
                    </span>
                    <span>
                      Net {displayUnits(flow.net, flow.asset.decimals)}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="wallet-transfer-selection">
          {scope.transfers.map(({ transfer, direction: relative, visible }) => (
            <div
              className={`wallet-transfer-row ${visible ? "" : "is-hidden"}`}
              key={transfer.id}
            >
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
              <button onClick={() => onTransfer(transfer)}>
                <strong>
                  <span className={relative === "in" ? "inflow" : ""}>
                    {relative === "self"
                      ? "Self"
                      : relative === "in"
                        ? "In"
                        : "Out"}
                  </span>{" "}
                  {displayUnits(transfer.rawAmount, transfer.asset.decimals)}{" "}
                  {transfer.asset.symbol}
                </strong>
                <span>
                  {short(transfer.from)} → {short(transfer.to)}
                </span>
                <small>
                  {transfer.timestamp.slice(0, 10)} UTC · {transfer.kind}
                </small>
              </button>
              <ArrowRight size={13} />
            </div>
          ))}
          {scope.counts.transfers === 0 && (
            <p className="quiet-note">
              No loaded transfers match this direction.
            </p>
          )}
          <div className="wallet-pagination">
            <button
              aria-label="Previous wallet transfer page"
              disabled={scope.page.previousOffset === null}
              onClick={() => setOffset(scope.page.previousOffset ?? 0)}
            >
              <ChevronLeft size={14} />
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
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="wallet-coverage-note">
        <strong>
          {coverage.length
            ? coverage
                .map(
                  (item) =>
                    `${item.pagesLoaded} page${item.pagesLoaded === 1 ? "" : "s"} · ${item.status === "exhausted" ? "loaded stream exhausted" : item.status}`,
                )
                .join("; ")
            : "History not requested for this wallet"}
        </strong>
        <span>
          {coverage.some((item) => item.cursor)
            ? "More history available. Use Load next page above to resume."
            : "Loaded evidence only. Missing streams and other chains remain outside this scope."}
        </span>
      </div>
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
