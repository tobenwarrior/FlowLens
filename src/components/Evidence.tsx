import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  EyeOff,
  Pin,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Investigation, Transfer, WalletNode } from "../domain/types.ts";
import { formatUnits, nodeKey } from "../domain/engine.ts";
import { chainName, displayUnits, explorer, short } from "./Graph.tsx";

export function TransferList({
  transfers,
  root,
  onSelect,
  compact = false,
}: {
  transfers: Transfer[];
  root: string;
  onSelect: (t: Transfer) => void;
  compact?: boolean;
}) {
  return (
    <div className={`transfer-list ${compact ? "compact" : ""}`}>
      {transfers.length === 0 ? (
        <div className="empty-state">No transfers match this scope.</div>
      ) : (
        transfers
          .slice()
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .map((t) => {
            const incoming = t.to.toLowerCase() === root.toLowerCase();
            const outgoing = t.from.toLowerCase() === root.toLowerCase();
            return (
              <button
                className="transfer-row"
                key={t.id}
                onClick={() => onSelect(t)}
              >
                <span
                  title={
                    incoming
                      ? "Inflow to focus wallet"
                      : outgoing
                        ? "Outflow from focus wallet"
                        : "Expanded counterparty path"
                  }
                  className={`transfer-arrow ${incoming ? "in" : outgoing ? "out" : "path"}`}
                >
                  {incoming ? (
                    <ArrowDownLeft size={16} />
                  ) : outgoing ? (
                    <ArrowUpRight size={16} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                </span>
                <span className="transfer-main">
                  <strong>
                    {displayUnits(t.rawAmount, t.asset.decimals)}{" "}
                    <span>{t.asset.symbol}</span>
                  </strong>
                  <span>
                    {short(t.from)} <span className="row-to">→</span>{" "}
                    {short(t.to)}
                  </span>
                </span>
                <span className="transfer-meta">
                  <span>{chainName(t.chainId)}</span>
                  <span>
                    {new Date(t.timestamp).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      timeZone: "UTC",
                    })}
                  </span>
                </span>
                {!compact && (
                  <span className="row-kind">
                    {t.kind === "erc20"
                      ? "Token transfer"
                      : t.kind === "internal"
                        ? "Internal transfer"
                        : "Native transfer"}
                  </span>
                )}
                <span className="row-chevron">↗</span>
              </button>
            );
          })
      )}
    </div>
  );
}
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button copy-button"
      aria-label="Copy value"
      title="Copy value"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
export function EvidenceDrawer({
  investigation,
  node,
  transfer,
  onClose,
  onSelect,
  onExpand,
  onPin,
  onHide,
  busy,
}: {
  investigation: Investigation;
  node: WalletNode | null;
  transfer: Transfer | null;
  onClose: () => void;
  onSelect: (t: Transfer) => void;
  onExpand: (n: WalletNode) => void;
  onPin: (n: WalletNode) => void;
  onHide: (n: WalletNode) => void;
  busy: boolean;
}) {
  const root = investigation.root.toLowerCase();
  const [expansionChain, setExpansionChain] = useState(node?.chainId || 1);
  useEffect(() => setExpansionChain(node?.chainId || 1), [node]);
  const focus = node?.address.toLowerCase() === root;
  const matching = node
    ? investigation.transfers.filter(
        (t) =>
          (focus || t.chainId === node.chainId) &&
          (t.from === node.address || t.to === node.address),
      )
    : investigation.transfers;
  const coverage = node
    ? investigation.coverage.find(
        (c) => c.address === node.address && c.chainId === expansionChain,
      )
    : undefined;
  return (
    <aside className="evidence-drawer" aria-label="Evidence drawer">
      <div className="drawer-title">
        <span className="eyebrow">
          {transfer ? "TRANSFER EVIDENCE" : "WALLET INSPECTOR"}
        </span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close evidence"
        >
          <X size={18} />
        </button>
      </div>
      {transfer ? (
        <>
          <div className="evidence-hero">
            <span
              className={`transfer-arrow large ${transfer.to === root ? "in" : "out"}`}
            >
              {transfer.to === root ? (
                <ArrowDownLeft size={23} />
              ) : (
                <ArrowUpRight size={23} />
              )}
            </span>
            <h2>
              {formatUnits(transfer.rawAmount, transfer.asset.decimals)}{" "}
              <span>{transfer.asset.symbol}</span>
            </h2>
            <p>
              {transfer.synthetic
                ? "Synthetic transfer for demonstration"
                : "Observed on-chain transfer"}
            </p>
            <span className="status-pill">
              <Check size={12} />{" "}
              {transfer.synthetic ? "Fixture · success" : "Success"}
            </span>
          </div>
          <div className="evidence-fields">
            <div>
              <label>FROM</label>
              <code>{transfer.from}</code>
              <CopyButton value={transfer.from} />
            </div>
            <div>
              <label>TO</label>
              <code>{transfer.to}</code>
              <CopyButton value={transfer.to} />
            </div>
            <div className="field-pair">
              <section>
                <label>NETWORK</label>
                <span>
                  <i className={`chain-dot chain-${transfer.chainId}`} />
                  {chainName(transfer.chainId)}
                </span>
              </section>
              <section>
                <label>TRANSFER TYPE</label>
                <span>{transfer.kind.toUpperCase()}</span>
              </section>
            </div>
            <div>
              <label>UTC TIMESTAMP</label>
              <span>
                {transfer.timestamp
                  .replace("T", " ")
                  .replace(".000Z", " UTC")
                  .replace("Z", " UTC")}
              </span>
            </div>
            <div className="field-pair">
              <section>
                <label>BLOCK</label>
                <span>{transfer.blockNumber.toLocaleString()}</span>
              </section>
              <section>
                <label>EVENT INDEX</label>
                <span>{transfer.eventIndex}</span>
              </section>
            </div>
            <div>
              <label>
                EXACT RAW AMOUNT · {transfer.asset.decimals} DECIMALS
              </label>
              <code>{transfer.rawAmount}</code>
            </div>
            <div>
              <label>TOKEN CONTRACT</label>
              <code>{transfer.asset.contract || "Native asset"}</code>
            </div>
            <div>
              <label>TRANSACTION HASH</label>
              <code>{transfer.hash}</code>
              <CopyButton value={transfer.hash} />
            </div>
          </div>
          <div className="provenance-box">
            <ShieldCheck size={16} />
            <div>
              <strong>Evidence provenance</strong>
              <p>{transfer.source}</p>
              <span>Retrieved {transfer.retrievedAt.slice(0, 10)}</span>
              <label>EVIDENCE ID</label>
              <code>{transfer.id}</code>
            </div>
          </div>
          {!transfer.synthetic &&
          explorer(transfer.chainId, "tx", transfer.hash) ? (
            <a
              className="button primary full"
              target="_blank"
              rel="noreferrer"
              href={explorer(transfer.chainId, "tx", transfer.hash)}
            >
              Verify in {chainName(transfer.chainId)} explorer{" "}
              <ExternalLink size={14} />
            </a>
          ) : (
            <div className="quiet-note">
              Synthetic evidence has no explorer record.
            </div>
          )}
          <p className="drawer-caveat">
            A transfer records movement of an asset. It does not establish a
            trade, shared control, or ownership.
          </p>
        </>
      ) : (
        <>
          <div className="wallet-heading">
            <span className="avatar">
              {node?.category === "exchange"
                ? "EX"
                : node?.category === "bridge"
                  ? "BR"
                  : "0x"}
            </span>
            <h2>
              {node?.label?.text
                .replace(" (demo)", "")
                .replace(" · demo", "") || short(node?.address || root)}
            </h2>
            <p>
              {node ? chainName(node.chainId) : "All loaded networks"} ·{" "}
              {node?.category || "wallet"}
            </p>
          </div>
          <div className="address-block">
            <code>{node?.address || root}</code>
            <CopyButton value={node?.address || root} />
          </div>
          {node?.label ? (
            <div className="label-provenance">
              <span className="eyebrow">LABEL PROVENANCE</span>
              <strong>{node.label.source}</strong>
              <span>
                {node.label.kind} · {node.label.confidence}
              </span>
              <p>
                Retrieved {node.label.retrievedAt.slice(0, 10)}. Labels and
                shared funders do not establish ownership.
              </p>
            </div>
          ) : (
            <div className="quiet-note">
              No attribution label. Ownership is unknown.
            </div>
          )}
          {node && focus && (
            <label className="expand-network">
              NETWORK TO EXPAND
              <select
                aria-label="Expansion network"
                value={expansionChain}
                onChange={(e) => setExpansionChain(Number(e.target.value))}
              >
                {(investigation.mode === "demo" ? [1, 8453] : [1, 42161]).map(
                  (id) => (
                    <option key={id} value={id}>
                      {chainName(id)}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          {node && (
            <div className="node-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  onExpand({
                    ...node,
                    chainId: focus ? expansionChain : node.chainId,
                  })
                }
              >
                <Plus size={15} />
                {busy
                  ? "Loading…"
                  : coverage?.cursor
                    ? "Load next page"
                    : "Expand wallet"}
              </button>
              {!focus && (
                <>
                  <button
                    className={`icon-button outlined ${investigation.pinned.includes(nodeKey(node.chainId, node.address)) ? "active" : ""}`}
                    aria-label="Pin wallet"
                    title="Pin wallet"
                    onClick={() => onPin(node)}
                  >
                    <Pin size={16} />
                  </button>
                  <button
                    className="icon-button outlined"
                    aria-label="Hide wallet"
                    title="Hide wallet"
                    onClick={() => onHide(node)}
                  >
                    <EyeOff size={16} />
                  </button>
                </>
              )}
            </div>
          )}
          {coverage && (
            <div className="drawer-coverage">
              <span
                className={`status-dot ${coverage.status === "error" ? "red" : ""}`}
              />
              <strong>
                {coverage.status === "error"
                  ? "Source error"
                  : `${coverage.pagesLoaded} page${coverage.pagesLoaded === 1 ? "" : "s"} loaded`}
              </strong>
              <span>
                {coverage.cursor
                  ? "More history available"
                  : coverage.status === "exhausted"
                    ? "Loaded stream exhausted"
                    : "Coverage partial"}
              </span>
            </div>
          )}
          <div className="drawer-section-heading">
            <h3>Transfer evidence</h3>
            <span>{matching.length}</span>
          </div>
          <TransferList
            transfers={matching}
            root={root}
            onSelect={onSelect}
            compact
          />
        </>
      )}
    </aside>
  );
}
