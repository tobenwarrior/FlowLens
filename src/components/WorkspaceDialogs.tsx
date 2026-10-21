import { useEffect, useRef } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Braces,
  FileJson,
  FolderOpen,
  RotateCcw,
  Save,
  ShieldAlert,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import type { Investigation } from "../domain/types.ts";
import { DEMO_ROOT } from "../domain/demo.ts";
import { chainName, short } from "./Graph.tsx";

export type WorkspaceModal = "cases" | "coverage" | "agents" | "help" | null;
interface WorkspaceDialogsProps {
  modal: Exclude<WorkspaceModal, null>;
  investigation: Investigation;
  saved: Investigation[];
  onClose: () => void;
  onSelectCase: (value: Investigation) => void;
  onNotesChange: (notes: string) => void;
  onImport: () => void;
  onSave: () => void;
}

export function WorkspaceDialogs({
  modal,
  investigation,
  saved,
  onClose,
  onSelectCase,
  onNotesChange,
  onImport,
  onSave,
}: WorkspaceDialogsProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(
      "button,a[href],input,select,textarea",
    );
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled),a[href],input,select,textarea",
        ),
      ].filter((el) => el.getClientRects().length);
      const head = items[0],
        tail = items.at(-1);
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className={`modal ${modal === "agents" ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={
          modal === "cases"
            ? "Saved investigations"
            : modal === "coverage"
              ? "Sources and coverage"
              : modal === "agents"
                ? "Agent interfaces"
                : "Field guide"
        }
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="icon-button modal-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        {modal === "cases" ? (
          <>
            <span className="modal-icon">
              <FolderOpen size={24} />
            </span>
            <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
            <h2>Investigations</h2>
            <p>
              Saved on this browser. Export JSON for durable backups and agent
              workflows.
            </p>
            <div className="saved-cases">
              {saved.length === 0 ? (
                <div className="empty-state">
                  <BookOpen size={26} />
                  <strong>A clear trail starts here.</strong>
                  <span>
                    Save your current case to return to its evidence, notes and
                    cursors.
                  </span>
                </div>
              ) : (
                saved.map((c) => (
                  <button
                    className="saved-case"
                    key={c.id}
                    onClick={() => onSelectCase(c)}
                  >
                    <FileJson size={23} />
                    <span>
                      <strong>{c.title}</strong>
                      <span>
                        {short(c.root)} · {c.transfers.length} records ·{" "}
                        {c.mode}
                      </span>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ))
              )}
            </div>
            <label className="notes-label">
              INVESTIGATION NOTES
              <textarea
                aria-label="Investigation notes"
                value={investigation.notes}
                placeholder="Record observations, alternatives, and unresolved questions…"
                onChange={(e) => onNotesChange(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="button" onClick={onImport}>
                <Upload size={15} /> Import JSON
              </button>
              <button className="button primary" onClick={onSave}>
                <Save size={15} /> Save current case
              </button>
            </div>
          </>
        ) : modal === "coverage" ? (
          <>
            <span className="modal-icon">
              <Activity size={24} />
            </span>
            <span className="eyebrow">KNOW WHAT YOU CAN SEE</span>
            <h2>Sources & coverage</h2>
            <p>
              A graph is only as complete as its sources. End-of-page is not
              proof of full wallet history.
            </p>
            <div className="coverage-source">
              <div>
                <strong>
                  {investigation.mode === "demo"
                    ? "Synthetic fixture provider"
                    : "Etherscan V2"}
                </strong>
                <span className="case-badge">
                  {investigation.mode === "demo" ? "DEMO" : "LIVE"}
                </span>
              </div>
              <p>
                {investigation.mode === "demo"
                  ? "All wallets, labels, hashes and amounts in this case are invented. No financial or attribution claims."
                  : "User-supplied server key. Native transfers and verified ERC-20 transfer logs only. Chain access depends on your provider plan."}
              </p>
            </div>
            <div className="coverage-list">
              {investigation.coverage.map((c) => (
                <div key={c.key}>
                  <span
                    className={`status-dot ${c.status === "error" ? "red" : "amber"}`}
                  />
                  <div>
                    <strong>
                      {chainName(c.chainId)} · {short(c.address)}
                    </strong>
                    <span>
                      {c.provider} · {c.pagesLoaded} pages · {c.status}
                    </span>
                    {c.warnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                    {c.error && <p className="error-text">{c.error}</p>}
                    <code>
                      {c.cursor
                        ? `Resume cursor: ${c.cursor.slice(0, 90)}${c.cursor.length > 90 ? "…" : ""}`
                        : "No next-page cursor in loaded stream"}
                    </code>
                  </div>
                </div>
              ))}
            </div>
            <div className="warning-box">
              <ShieldAlert size={18} />
              <p>
                Internal calls, NFTs, bridge joins, fees, historical ownership
                and unlabeled networks may be missing. Gross flow is not unique
                capital, profit, or assets under management.
              </p>
            </div>
            <div className="coverage-source">
              <strong>Arkham labels · disabled</strong>
              <p>
                Requires permitted user access covering automation and data use.
                Labels must preserve source, kind, confidence and retrieval
                date. No paywall scraping or proprietary dataset included.
              </p>
            </div>
          </>
        ) : modal === "agents" ? (
          <>
            <span className="modal-icon">
              <Terminal size={24} />
            </span>
            <span className="eyebrow">ONE ENGINE. EVERY INTERFACE.</span>
            <h2>A tracer your agents can use.</h2>
            <p>
              Typed evidence, bounded expansion and resumable cursors are shared
              by the visual workspace, local API and CLI. Agents never need to
              click the graph.
            </p>
            <div className="code-example">
              <span>CREATE A REPRODUCIBLE DEMO CASE</span>
              <code>
                node server/cli.ts create --address {DEMO_ROOT} --mode demo
                --file .local/case.json
              </code>
              <span>EXPAND ONE WALLET SCOPE · ONE PAGE</span>
              <code>
                node server/cli.ts expand --file .local/case.json --address{" "}
                {DEMO_ROOT} --chain 1 --pages 1
              </code>
              <span>INSPECT EVIDENCE & COVERAGE</span>
              <code>node server/cli.ts inspect --file .local/case.json</code>
            </div>
            <div className="agent-features">
              <span>
                <Braces size={17} /> Versioned JSON evidence
              </span>
              <span>
                <ShieldAlert size={17} /> Explicit source coverage
              </span>
              <span>
                <RotateCcw size={17} /> Persisted page cursors
              </span>
            </div>
            <div className="quiet-note">
              API: 127.0.0.1:4319/api · Loopback only · No MCP wrapper in this
              slice
            </div>
          </>
        ) : (
          <>
            <span className="modal-icon">
              <BookOpen size={24} />
            </span>
            <span className="eyebrow">A FEW GOOD INVESTIGATION HABITS</span>
            <h2>Follow evidence, carefully.</h2>
            <div className="guide-steps">
              <div>
                <span>01</span>
                <section>
                  <strong>Start with a wallet</strong>
                  <p>
                    Use the synthetic demo, or choose Live with your own
                    permitted Etherscan key. Each chain has separate coverage.
                  </p>
                </section>
              </div>
              <div>
                <span>02</span>
                <section>
                  <strong>Follow a connection</strong>
                  <p>
                    Select a wallet to inspect its label provenance. Expand one
                    page at a time, pin a useful node, or hide a distraction.
                  </p>
                </section>
              </div>
              <div>
                <span>03</span>
                <section>
                  <strong>Check the transaction</strong>
                  <p>
                    Select a path or evidence row for exact amounts, UTC time
                    and source. Live explorer links use the transaction’s chain.
                  </p>
                </section>
              </div>
              <div>
                <span>04</span>
                <section>
                  <strong>Keep the alternatives</strong>
                  <p>
                    Transfers are not trades. Shared funders do not prove
                    ownership. Save notes and export the case with its remaining
                    gaps.
                  </p>
                </section>
              </div>
            </div>
            <button className="button primary full" onClick={onClose}>
              Start exploring <ArrowRight size={15} />
            </button>
          </>
        )}
      </section>
    </div>
  );
}
