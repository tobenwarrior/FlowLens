import { ProtocolEvidenceDialog } from "./components/ProtocolEvidence.tsx";
import type { ProtocolEvidenceBundle } from "./domain/protocols.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Command,
  Download,
  GitBranch,
  Layers,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import type { Investigation, Transfer, WalletNode } from "./domain/types.ts";
import {
  aggregateFlows,
  assetKey,
  expandInvestigation,
  filterTransfers,
  nodeKey,
  normalizeAddress,
  parseInvestigation,
} from "./domain/engine.ts";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "./domain/demo.ts";
import { Graph, chainName, displayUnits, short } from "./components/Graph.tsx";
import { EvidenceDrawer, TransferList } from "./components/Evidence.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkspaceDialogs } from "./components/WorkspaceDialogs.tsx";
import type { WorkspaceModal } from "./components/WorkspaceDialogs.tsx";

const CURRENT = "flowlens.current.v1";
const SAVED = "flowlens.saved.v1";
const hasEvidenceOnlyCoverage = (value: Investigation) =>
  value.mode === "live" &&
  value.coverage.some((item) => item.provider === "evidence-only");
async function api<T>(
  url: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    `/api${url}`,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.error ||
        "The local provider could not complete this request.",
    );
  return data;
}
function readCases(): Investigation[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED) || "[]").map(
      parseInvestigation,
    );
  } catch {
    return [];
  }
}
function download(c: Investigation) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(c, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `flowlens-${c.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [investigation, setInvestigation] = useState<Investigation | null>(
    null,
  );
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [historyMode, setHistoryMode] = useState<"indexed" | "evidence-only">(
    "indexed",
  );
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<WorkspaceModal>(null);
  const [selectedNode, setSelectedNode] = useState<WalletNode | null>(null);
  const [selectedTransfer, setSelectedTransfer] = useState<Transfer | null>(
    null,
  );
  const [drawer, setDrawer] = useState(false);
  const [chain, setChain] = useState("all");
  const [asset, setAsset] = useState("all");
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showDates, setShowDates] = useState(false);
  const [view, setView] = useState<"graph" | "list">("graph");
  const [grouped, setGrouped] = useState(false);
  const [saved, setSaved] = useState<Investigation[]>([]);
  const [provider, setProvider] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const savedSnapshot = useRef<Investigation | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      let initial: Investigation;
      try {
        const raw = localStorage.getItem(CURRENT);
        initial = raw
          ? parseInvestigation(JSON.parse(raw))
          : await createDemoInvestigation();
      } catch {
        initial = await createDemoInvestigation();
      }
      if (alive) {
        setInvestigation(initial);
        setMode(initial.mode);
        setHistoryMode(
          hasEvidenceOnlyCoverage(initial) ? "evidence-only" : "indexed",
        );
        setInput(initial.root);
        setSaved(readCases());
      }
    })();
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (alive)
          setProvider(
            Boolean(
              s?.providers?.etherscan?.available ||
              s?.liveAvailable ||
              s?.etherscan?.available ||
              s?.providers?.some?.(
                (p: { id: string; available: boolean }) =>
                  p.id.includes("etherscan") && p.available,
              ),
            ),
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (investigation) {
      try {
        localStorage.setItem(CURRENT, JSON.stringify(investigation));
      } catch {
        setError(
          "Browser storage is full. Export this investigation to preserve your progress.",
        );
      }
      setSavedAt(savedSnapshot.current === investigation);
    }
  }, [investigation]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 4000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (e.key === "Escape") {
        setModal(null);
        setDrawer(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el && view === "graph" && window.innerWidth <= 1020)
      el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [investigation?.id, view, drawer]);
  const dateRangeInvalid = Boolean(from && to && from > to);
  const filtered = useMemo(
    () =>
      investigation && !dateRangeInvalid
        ? filterTransfers(investigation.transfers, investigation.root, {
            chainId: chain === "all" ? undefined : Number(chain),
            asset: asset === "all" ? undefined : asset,
            direction,
            from: from ? `${from}T00:00:00.000Z` : undefined,
            to: to ? `${to}T23:59:59.999Z` : undefined,
          })
        : [],
    [investigation, chain, asset, direction, from, to, dateRangeInvalid],
  );
  const allFlows = useMemo(
    () =>
      investigation
        ? aggregateFlows(investigation.transfers, investigation.root)
        : [],
    [investigation],
  );
  const flows = useMemo(
    () => (investigation ? aggregateFlows(filtered, investigation.root) : []),
    [filtered, investigation],
  );
  const primaryFlow = flows.find((f) => f.asset.symbol === "USDC") || flows[0];
  const resetFilters = () => {
    setChain("all");
    setAsset("all");
    setDirection("all");
    setFrom("");
    setTo("");
  };
  const selectNode = (n: WalletNode) => {
    setSelectedNode(n);
    setSelectedTransfer(null);
    setDrawer(true);
  };
  const selectTransfer = (t: Transfer) => {
    setSelectedTransfer(t);
    setDrawer(true);
  };
  async function start() {
    setError("");
    let root;
    try {
      root = normalizeAddress(input.trim());
    } catch {
      setError(
        "Enter a valid EVM address: 0x followed by 40 hexadecimal characters.",
      );
      return;
    }
    if (mode === "demo" && root !== DEMO_ROOT) {
      setError(
        "Demo mode uses the synthetic focus wallet. Choose Live for a real address, or reset to the demo wallet.",
      );
      return;
    }
    setBusy(true);
    try {
      const c =
        mode === "demo"
          ? await createDemoInvestigation()
          : await api<Investigation>("/investigations", {
              root,
              mode,
              historyMode,
              title: `Trace ${short(root)}`,
            });
      setInvestigation(c);
      setDrawer(false);
      resetFilters();
      setToast(
        mode === "demo"
          ? "Synthetic investigation ready"
          : "Investigation created. Review source coverage.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to start investigation.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function expand(n: WalletNode) {
    if (!investigation || busy) return;
    setBusy(true);
    setError("");
    try {
      const next =
        investigation.mode === "demo"
          ? await expandInvestigation(
              investigation,
              demoProvider,
              { address: n.address, chainId: n.chainId, pageSize: 8 },
              { maxPages: 1, maxNodes: 80 },
            )
          : await api<Investigation>(
              `/investigations/${investigation.id}/expand`,
              {
                address: n.address,
                chainId: n.chainId,
                pageSize: 10,
                maxPages: 1,
              },
            );
      setInvestigation({
        ...next,
        notes: investigation.notes,
        pinned: investigation.pinned,
        hidden: investigation.hidden,
      });
      const failure = next.coverage.find(
        (c) =>
          c.address === n.address &&
          c.chainId === n.chainId &&
          c.status === "error",
      );
      if (failure) setError(failure.error || failure.warnings.join(" "));
      else setToast("One bounded page loaded. Evidence and cursor preserved.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Expansion failed. Last successful evidence is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!investigation) return;
    try {
      let updated = investigation;
      if (updated.mode === "live") {
        updated = await api<Investigation>(
          `/investigations/${updated.id}`,
          updated,
          "PUT",
        );
      } else updated = { ...updated, updatedAt: new Date().toISOString() };
      const list = [
        updated,
        ...readCases().filter((c) => c.id !== updated.id),
      ].slice(0, 20);
      localStorage.setItem(SAVED, JSON.stringify(list));
      setSaved(list);
      savedSnapshot.current = updated;
      setInvestigation(updated);
      setSavedAt(true);
      setToast("Investigation saved on this device.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not save. Export JSON to preserve evidence.",
      );
    }
  }
  async function refreshCase() {
    if (!investigation || investigation.mode !== "live" || busy) return;
    const caseId = investigation.id;
    setBusy(true);
    try {
      const latest = await api<Investigation>(`/investigations/${caseId}`);
      setInvestigation((current) =>
        current?.id === caseId
          ? {
              ...latest,
              notes: current.notes,
              pinned: current.pinned,
              hidden: current.hidden,
            }
          : current,
      );
      setDrawer(false);
      setSelectedNode(null);
      setSelectedTransfer(null);
      setError("");
      setToast(
        "Source refreshed. Local notes, pins and hidden nodes preserved.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not refresh this investigation. Local evidence is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    setError("");
    try {
      if (file.size > 5_000_000)
        throw new Error("Investigation exceeds the 5 MB import limit.");
      const c = parseInvestigation(JSON.parse(await file.text()));
      const restored =
        c.mode === "live"
          ? await api<Investigation>(`/investigations/${c.id}`, c, "PUT")
          : c;
      setInvestigation(restored);
      setInput(c.root);
      setMode(c.mode);
      setHistoryMode(hasEvidenceOnlyCoverage(c) ? "evidence-only" : "indexed");
      setDrawer(false);
      resetFilters();
      setModal(null);
      setToast("Investigation restored with evidence and cursors.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid investigation JSON.");
    }
  }
  const togglePin = (n: WalletNode) => {
    if (!investigation) return;
    const key = nodeKey(n.chainId, n.address);
    setInvestigation({
      ...investigation,
      pinned: investigation.pinned.includes(key)
        ? investigation.pinned.filter((k) => k !== key)
        : [...investigation.pinned, key],
    });
  };
  const hide = (n: WalletNode) => {
    if (!investigation) return;
    setInvestigation({
      ...investigation,
      hidden: [...investigation.hidden, nodeKey(n.chainId, n.address)],
    });
    setDrawer(false);
  };
  if (!investigation)
    return (
      <div className="boot">
        <div className="brand-mark">
          f<span>·</span>
        </div>
        <p>Opening your investigation workspace…</p>
        <LoaderCircle className="spin" size={20} />
      </div>
    );
  const networks = [
    ...new Set([
      ...investigation.transfers.map((t) => t.chainId),
      ...investigation.coverage.map((item) => item.chainId),
    ]),
  ];
  const evidenceOnly =
    hasEvidenceOnlyCoverage(investigation) &&
    investigation.transfers.length === 0;
  const hasFilter =
    chain !== "all" || asset !== "all" || direction !== "all" || from || to;
  return (
    <div className="app-shell">
      <Sidebar
        investigation={investigation}
        savedCount={saved.length}
        onWorkspace={() => {
          setModal(null);
          setDrawer(false);
        }}
        onCases={() => {
          setSaved(readCases());
          setModal("cases");
        }}
        onProtocol={() => {
          setModal(null);
          setProtocolOpen(true);
        }}
        onCoverage={() => setModal("coverage")}
        onAgents={() => setModal("agents")}
        onHelp={() => setModal("help")}
      />
      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>Trace</strong>
          </div>
          <div className="topbar-right">
            <span className="local-only">
              <span className="status-dot" /> Runs on your device
            </span>
            <button
              className="icon-button"
              title="Agent interfaces"
              aria-label="Agent interfaces"
              onClick={() => setModal("agents")}
            >
              <Terminal size={17} />
            </button>
            <span className="user-avatar">FL</span>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <span className="eyebrow">FOLLOW THE FLOW. KEEP THE EVIDENCE.</span>
            <h1>
              Every connection has a story<span>.</span>
            </h1>
            <p>Trace the funds. Inspect the source. Build a clearer picture.</p>
          </div>
          <button
            className="button new-trace"
            onClick={() => {
              searchInput.current?.focus();
              searchInput.current?.select();
            }}
          >
            <Plus size={16} /> New trace
          </button>
        </div>
        <section
          className="trace-command"
          aria-label="Start wallet investigation"
        >
          <div className="command-input">
            <Search size={19} />
            <input
              ref={searchInput}
              aria-label="Wallet address"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
              placeholder="Enter an EVM wallet address"
              spellCheck={false}
            />
            <kbd>
              <Command size={11} /> K
            </kbd>
          </div>
          <div className="command-options">
            <label className="mode-select">
              <select
                aria-label="Data mode"
                value={
                  mode === "live" && historyMode === "evidence-only"
                    ? "live-evidence"
                    : mode
                }
                onChange={(e) => {
                  const next = e.target.value;
                  setMode(next === "demo" ? "demo" : "live");
                  setHistoryMode(
                    next === "live-evidence" ? "evidence-only" : "indexed",
                  );
                  if (next === "demo") setInput(DEMO_ROOT);
                }}
              >
                <option value="demo">Demo data</option>
                <option value="live">
                  {provider ? "Live · Etherscan" : "Live · key required"}
                </option>
                <option value="live-evidence">Live · evidence only</option>
              </select>
              <ChevronDown size={13} />
            </label>
            <button
              className="button primary trace-submit"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <GitBranch size={16} />
              )}{" "}
              Trace wallet <ArrowRight size={15} />
            </button>
          </div>
        </section>
        {error && (
          <div className="error-banner" role="alert">
            <ShieldAlert size={17} />
            <span>{error}</span>
            {investigation.mode === "live" && (
              <button
                className="button subtle"
                disabled={busy}
                onClick={() => void refreshCase()}
              >
                <RotateCcw size={14} /> Refresh case
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="demo-banner">
          <span
            className={`demo-dot ${investigation.mode === "live" ? "live" : ""}`}
          />
          <strong>
            {investigation.mode === "demo"
              ? "You’re exploring a synthetic investigation."
              : evidenceOnly
                ? "Private investigation · evidence only."
                : "Private investigation · partial source coverage."}
          </strong>
          <span>
            {investigation.mode === "demo"
              ? "Fictional wallets, labels and transfers. No live claims."
              : evidenceOnly
                ? "No wallet history loaded. Add bounded protocol observations from the evidence panel."
                : "Only loaded transfers are shown. Review provider limitations."}
          </span>
          <button onClick={() => setModal("coverage")}>
            View coverage <ArrowRight size={13} />
          </button>
        </div>
        <section
          className={`investigation-panel ${evidenceOnly ? "evidence-only-case" : ""}`}
        >
          <div className="case-header">
            <div className="case-title">
              <span className="case-symbol">
                <GitBranch size={19} />
              </span>
              <div>
                <h2>
                  {investigation.mode === "demo"
                    ? "The Northstar trail"
                    : investigation.title}
                  <span className="case-badge">
                    {investigation.mode === "demo" ? "DEMO" : "LOCAL"}
                  </span>
                </h2>
                <span className="case-subtitle">
                  {short(investigation.root)} <span>·</span> {networks.length}{" "}
                  networks <span>·</span> {investigation.transfers.length}{" "}
                  evidence records
                </span>
              </div>
            </div>
            <div className="case-actions">
              <button
                className="button subtle"
                onClick={() => download(investigation)}
              >
                <Download size={15} />
                <span>Export JSON</span>
              </button>
              <button
                className={`button ${savedAt ? "saved" : ""}`}
                onClick={() => void save()}
              >
                {savedAt ? <Check size={15} /> : <Save size={15} />}
                <span>{savedAt ? "Saved" : "Save case"}</span>
              </button>
            </div>
          </div>
          <div className="filterbar">
            <label className="filter-select">
              <Layers size={14} />
              <select
                aria-label="Filter network"
                value={chain}
                onChange={(e) => setChain(e.target.value)}
              >
                <option value="all">All networks</option>
                {networks.map((n) => (
                  <option key={n} value={n}>
                    {chainName(n)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="filter-select">
              <span className="asset-icon">◈</span>
              <select
                aria-label="Filter asset"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
              >
                <option value="all">All assets</option>
                {allFlows.map((f) => (
                  <option key={assetKey(f.asset)} value={assetKey(f.asset)}>
                    {f.asset.symbol} · {chainName(f.asset.chainId)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="filter-select">
              <ArrowDownLeft size={14} />
              <select
                aria-label="Filter direction"
                value={direction}
                onChange={(e) =>
                  setDirection(e.target.value as typeof direction)
                }
              >
                <option value="all">Both directions</option>
                <option value="in">Inflows to focus</option>
                <option value="out">Outflows from focus</option>
              </select>
              <ChevronDown size={12} />
            </label>
            <button
              className={`filter-select date-toggle ${from || to ? "active" : ""}`}
              onClick={() => setShowDates((v) => !v)}
            >
              <SlidersHorizontal size={14} />
              <span>{from || to ? "Custom dates" : "All time"}</span>
              <ChevronDown size={12} />
            </button>
            {hasFilter && (
              <button className="reset-button" onClick={resetFilters}>
                <RotateCcw size={12} /> Reset
              </button>
            )}
            <div className="filter-spacer" />
            <div className="view-switch" aria-label="Workspace view">
              <button
                aria-label="Graph view"
                className={view === "graph" ? "active" : ""}
                onClick={() => setView("graph")}
              >
                <GitBranch size={15} /> <span>Graph</span>
              </button>
              <button
                aria-label="List view"
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
              >
                <List size={15} /> <span>Evidence</span>
              </button>
            </div>
          </div>
          {showDates && (
            <div className="date-row">
              <label>
                From UTC{" "}
                <input
                  type="date"
                  aria-label="From date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <span>→</span>
              <label>
                To UTC{" "}
                <input
                  type="date"
                  aria-label="To date"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <span
                className={`date-hint ${dateRangeInvalid ? "error-text" : ""}`}
                role={dateRangeInvalid ? "alert" : undefined}
              >
                {dateRangeInvalid
                  ? "From date must be on or before the To date."
                  : "Filters apply to loaded evidence only."}
              </span>
            </div>
          )}
          <div className="summary-scope-mobile">
            {primaryFlow
              ? `${primaryFlow.asset.symbol} · ${chainName(primaryFlow.asset.chainId)} · focus wallet · loaded scope`
              : "No matching evidence"}
            {flows.length > 1 ? ` · ${flows.length - 1} other assets` : ""}
          </div>
          <div className="flow-summary">
            <div>
              <span className="metric-label">
                <ArrowDownLeft size={13} /> Gross inflow
              </span>
              <strong className="inflow">
                {primaryFlow
                  ? displayUnits(primaryFlow.inflow, primaryFlow.asset.decimals)
                  : "0"}
                <small>{primaryFlow?.asset.symbol || "—"}</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">
                <ArrowUpRight size={13} /> Gross outflow
              </span>
              <strong>
                {primaryFlow
                  ? displayUnits(
                      primaryFlow.outflow,
                      primaryFlow.asset.decimals,
                    )
                  : "0"}
                <small>{primaryFlow?.asset.symbol || "—"}</small>
              </strong>
            </div>
            <div>
              <span className="metric-label">Net flow</span>
              <strong className="net">
                {primaryFlow && BigInt(primaryFlow.net) > 0n ? "+" : ""}
                {primaryFlow
                  ? displayUnits(primaryFlow.net, primaryFlow.asset.decimals)
                  : "0"}
                <small>{primaryFlow?.asset.symbol || "—"}</small>
              </strong>
            </div>
            <div className="scope-note">
              <span className="scope-icon">
                <LayoutGrid size={16} />
              </span>
              <p>
                <strong>
                  {primaryFlow
                    ? `${primaryFlow.asset.symbol} · ${chainName(primaryFlow.asset.chainId)}`
                    : "No matching evidence"}
                </strong>
                <span>
                  Focus wallet · loaded scope only
                  {flows.length > 1
                    ? ` · ${flows.length - 1} other assets`
                    : ""}
                </span>
              </p>
            </div>
          </div>
          <div className="canvas-heading">
            <div>
              <span className="eyebrow">
                {view === "graph" ? "FUNDING GRAPH" : "TRANSFER EVIDENCE"}
              </span>
              <span className="record-count">{filtered.length} transfers</span>
            </div>
            <div>
              {investigation.hidden.length > 0 && (
                <button
                  className="text-button"
                  onClick={() =>
                    setInvestigation({ ...investigation, hidden: [] })
                  }
                >
                  Restore {investigation.hidden.length} hidden
                </button>
              )}
              <button
                className={`text-button ${grouped ? "active" : ""}`}
                onClick={() => setGrouped((g) => !g)}
                title="Arrange counterparties by service category"
              >
                <Layers size={13} />
                {grouped ? "Grouped by type" : "Group by type"}
              </button>
            </div>
          </div>
          <div className="mobile-graph-hint">
            {view === "graph"
              ? "Drag to follow paths · select a wallet to inspect"
              : "Select a transfer to inspect its evidence"}
          </div>
          <div className={`canvas-and-drawer ${drawer ? "drawer-open" : ""}`}>
            <div className="canvas-main" ref={canvasRef}>
              {view === "graph" ? (
                <Graph
                  investigation={investigation}
                  transfers={filtered}
                  onNode={selectNode}
                  onTransfer={selectTransfer}
                  selected={
                    selectedNode
                      ? selectedNode.address === investigation.root
                        ? investigation.root
                        : nodeKey(selectedNode.chainId, selectedNode.address)
                      : undefined
                  }
                  grouped={grouped}
                />
              ) : (
                <div className="evidence-table">
                  <div className="table-heading">
                    <span>ASSET & DIRECTION</span>
                    <span>NETWORK / UTC DATE</span>
                    <span>TYPE</span>
                  </div>
                  <TransferList
                    transfers={filtered}
                    root={investigation.root}
                    onSelect={selectTransfer}
                  />
                </div>
              )}
            </div>
            {drawer && (
              <EvidenceDrawer
                investigation={investigation}
                node={selectedNode}
                transfer={selectedTransfer}
                onClose={() => setDrawer(false)}
                onSelect={selectTransfer}
                onExpand={(n) => void expand(n)}
                onPin={togglePin}
                onHide={hide}
                busy={busy}
              />
            )}
          </div>
          <div className="canvas-footer">
            <span>
              <span className="status-dot amber" />
              <strong>Partial coverage</strong>
              <span className="footer-detail">
                {investigation.mode === "demo"
                  ? "Synthetic native & token transfers"
                  : evidenceOnly
                    ? "Wallet history not indexed"
                    : "Loaded native & ERC-20 streams"}{" "}
                · internal transfers excluded
              </span>
            </span>
            <button onClick={() => setModal("coverage")}>
              Review sources <ArrowRight size={13} />
            </button>
          </div>
        </section>
        <footer className="page-footer">
          <span>Evidence first. Assumptions second.</span>
          <span>Transfers show movement, not ownership.</span>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Import investigation JSON"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.currentTarget.value = "";
        }}
      />
      {protocolOpen && (
        <ProtocolEvidenceDialog
          investigation={investigation}
          onClose={() => setProtocolOpen(false)}
          onAcquire={async (request) => {
            const result = await api<{
              bundle: ProtocolEvidenceBundle;
              warnings?: string[];
              errors?: unknown[];
              acquisition?: unknown;
            }>("/acquire", { ...request, caseId: investigation.id });
            const latest = await api<Investigation>(
              `/investigations/${investigation.id}`,
            );
            setInvestigation((current) =>
              current?.id === latest.id
                ? {
                    ...latest,
                    notes: current.notes,
                    pinned: current.pinned,
                    hidden: current.hidden,
                  }
                : current,
            );
            setToast(
              "Protocol observations preserved. Indexed history is unchanged.",
            );
            return {
              ...result,
              bundle: latest.protocolEvidence ?? result.bundle,
            };
          }}
          onAttach={async (bundle: ProtocolEvidenceBundle) => {
            let updatedAt = investigation.updatedAt;
            if (investigation.mode === "live") {
              const result = await api<{ updatedAt: string }>(
                `/investigations/${investigation.id}/replay`,
                { bundle },
              );
              updatedAt = result.updatedAt;
            }
            setInvestigation({
              ...investigation,
              protocolEvidence: bundle,
              updatedAt,
            });
            setToast("Replay evidence kept separately from indexed history.");
          }}
        />
      )}
      {modal && (
        <WorkspaceDialogs
          modal={modal}
          investigation={investigation}
          saved={saved}
          onClose={() => setModal(null)}
          onSelectCase={(value) => {
            setInvestigation(value);
            setInput(value.root);
            setMode(value.mode);
            setHistoryMode(
              hasEvidenceOnlyCoverage(value) ? "evidence-only" : "indexed",
            );
            setModal(null);
            resetFilters();
            setDrawer(false);
          }}
          onNotesChange={(notes) =>
            setInvestigation({ ...investigation, notes })
          }
          onImport={() => fileInput.current?.click()}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}
