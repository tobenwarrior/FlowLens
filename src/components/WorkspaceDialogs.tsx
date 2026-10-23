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
import { chainName, short } from "./Graph.tsx";
import { EXAMPLES } from "./StartPanel.tsx";

const CLI_EXAMPLE = EXAMPLES[0].address;

export type WorkspaceModal = "cases" | "coverage" | "agents" | "help" | null;

/** Summary of a case in the shared store, as the local API lists it. */
export interface AgentCaseSummary {
  id: string;
  title: string;
  root: string;
  mode: "demo" | "live";
  updatedAt: string;
  transferCount: number;
}

interface WorkspaceDialogsProps {
  modal: Exclude<WorkspaceModal, null>;
  /** Null on the start screen, before any case is open. */
  investigation: Investigation | null;
  saved: Investigation[];
  /** Cases the CLI, API and MCP share through the local case store. */
  agentCases: AgentCaseSummary[];
  agentCasesState: "idle" | "loading" | "error";
  onClose: () => void;
  onSelectCase: (value: Investigation) => void;
  onSelectAgentCase: (id: string) => void;
  onNotesChange: (notes: string) => void;
  onImport: () => void;
  onSave: () => void;
}

export function WorkspaceDialogs({
  modal,
  investigation,
  saved,
  agentCases,
  agentCasesState,
  onClose,
  onSelectCase,
  onSelectAgentCase,
  onNotesChange,
  onImport,
  onSave,
}: WorkspaceDialogsProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const evidenceOnly =
    !!investigation &&
    investigation.transfers.length === 0 &&
    investigation.coverage.some((item) => item.provider === "evidence-only");
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
              Browser saves stay in this browser. The agent workspace is the
              case store the local API and MCP tools share; the CLI opens the
              same files by path.
            </p>
            <span className="case-group-heading">On this browser</span>
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
            <span className="case-group-heading">
              Agent workspace
              <span className="case-group-note">
                shared with MCP and the API
              </span>
            </span>
            <div className="saved-cases">
              {agentCasesState === "loading" ? (
                <div className="empty-state">
                  Reading the shared case store…
                </div>
              ) : agentCasesState === "error" ? (
                <div className="empty-state">
                  The local API is not reachable, so the shared store cannot be
                  listed. Browser saves above are unaffected.
                </div>
              ) : agentCases.length === 0 ? (
                <div className="empty-state">
                  <span>
                    No cases here yet. Anything an MCP agent or the local API
                    creates appears in this list.
                  </span>
                </div>
              ) : (
                agentCases.map((c) => (
                  <button
                    className="saved-case"
                    key={c.id}
                    onClick={() => onSelectAgentCase(c.id)}
                  >
                    <Terminal size={23} />
                    <span>
                      <strong>{c.title}</strong>
                      <span>
                        {short(c.root)} · {c.transferCount} records · {c.mode} ·{" "}
                        {c.updatedAt.slice(0, 10)}
                      </span>
                    </span>
                    <ArrowRight size={16} />
                  </button>
                ))
              )}
            </div>
            {investigation && (
              <label className="notes-label">
                INVESTIGATION NOTES
                <textarea
                  aria-label="Investigation notes"
                  value={investigation.notes}
                  placeholder="Record observations, alternatives, and unresolved questions…"
                  onChange={(e) => onNotesChange(e.target.value)}
                />
              </label>
            )}
            <div className="modal-actions">
              <button className="button" onClick={onImport}>
                <Upload size={15} /> Import JSON
              </button>
              {investigation && (
                <button className="button primary" onClick={onSave}>
                  <Save size={15} /> Save current case
                </button>
              )}
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
            {!investigation ? (
              <div className="empty-state">
                <span>
                  No case is open. Trace a wallet and each loaded stream will
                  list its provider, pages and cursor here.
                </span>
              </div>
            ) : (
              <>
                <div className="coverage-source">
                  <div>
                    <strong>
                      {investigation.mode === "demo"
                        ? "Synthetic fixture provider"
                        : evidenceOnly
                          ? "Evidence-only investigation"
                          : "Indexed transfer ledger"}
                    </strong>
                    <span className="case-badge">
                      {investigation.mode === "demo" ? "DEMO" : "LIVE"}
                    </span>
                  </div>
                  <p>
                    {investigation.mode === "demo"
                      ? "All wallets, labels, hashes and amounts in this case are invented. No financial or attribution claims."
                      : evidenceOnly
                        ? "No wallet history is indexed in this case. Keep explicitly acquired or imported protocol observations separately; an empty graph does not mean no activity."
                        : "Loaded indexed transfers; each coverage row below names its provider and page state. Blockscout serves Ethereum and Derive Chain without a key. Etherscan history uses your permitted server-side key, and chain access depends on your provider plan."}
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
                          {c.provider} ·{" "}
                          {c.streams.length
                            ? c.streams.join(", ")
                            : "no streams"}{" "}
                          · {c.pagesLoaded} pages · {c.status}
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
                    The indexed graph does not include NFTs, fees or complete
                    cross-chain history, and holds internal transfers only for
                    the streams listed above. Gross flow is not unique capital,
                    profit, or assets under management.
                  </p>
                </div>
              </>
            )}
            <div className="coverage-source">
              <strong>
                Protocol observations · separate from graph totals
              </strong>
              <p>
                {investigation?.mode === "demo"
                  ? "Protocol evidence offers a clearly marked synthetic replay of Safe, bridge and internal-trace observations. No public provider is queried."
                  : "Protocol evidence can explicitly query Safe configuration/history or a known CCTP transaction and call trace. Public endpoint support and coverage are checked per request. No wallet-history discovery is implied."}
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
              by the visual workspace, local API, CLI and MCP tools. Agents can
              trace, inspect and preserve evidence without clicking the graph.
            </p>
            <div className="code-example">
              <span>START A LIVE CASE FROM ONE WALLET</span>
              <code>
                node server/cli.ts create --mode live --address {CLI_EXAMPLE}{" "}
                --file .local/case.json
              </code>
              <span>EXPAND ONE WALLET SCOPE · ONE PAGE</span>
              <code>
                node server/cli.ts expand --file .local/case.json --address{" "}
                {CLI_EXAMPLE} --chain 1 --pages 1
              </code>
              <span>INSPECT EVIDENCE & COVERAGE</span>
              <code>node server/cli.ts inspect --file .local/case.json</code>
              <span>LAUNCH THE STDIO MCP SERVER</span>
              <code>node server/mcp.ts</code>
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
              API: {window.location.origin}/api · Loopback only. MCP exposes
              typed operations including wallet, annotate, visibility, expand,
              acquire and export. Start with flowlens_status and
              flowlens_schema; inspect coverage and errors after every
              operation. README.md and docs/mcp.md contain complete setup and
              resume examples.
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
                    Paste any Ethereum address, or pick a public wallet on the
                    start screen. Live Ethereum history needs no key: Blockscout
                    serves it and receives the wallet you trace. Derive Chain
                    expansions go to Blockscout at explorer.derive.xyz, key or
                    not. Arbitrum needs a permitted Etherscan key; evidence-only
                    cases start without an index. Each chain has separate
                    coverage.
                  </p>
                </section>
              </div>
              <div>
                <span>02</span>
                <section>
                  <strong>Follow a connection</strong>
                  <p>
                    Select a wallet for its own inflows, outflows and
                    counterparties. Use checkboxes to show paths, or edit a
                    source-bearing label. Expand one page at a time; selections
                    retain every evidence record.
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
