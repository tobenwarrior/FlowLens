import {
  Activity,
  ArrowRight,
  CircleHelp,
  FolderOpen,
  GitBranch,
  Terminal,
  ShieldCheck,
} from "lucide-react";
import type { Investigation } from "../domain/types.ts";

interface SidebarProps {
  /** Null on the start screen, before any case is open. */
  investigation: Investigation | null;
  savedCount: number;
  onWorkspace: () => void;
  onCases: () => void;
  onCoverage: () => void;
  onProtocol: () => void;
  onAgents: () => void;
  onHelp: () => void;
}

export function Sidebar({
  investigation,
  savedCount,
  onWorkspace,
  onCases,
  onCoverage,
  onProtocol,
  onAgents,
  onHelp,
}: SidebarProps) {
  return (
    <aside className="side-rail">
      <a className="brand" href="#" aria-label="FlowLens home">
        <img
          className="brand-wordmark"
          src="/flowlens-wordmark-dark.png"
          alt=""
          width={337}
          height={72}
        />
        <img
          className="brand-mark"
          src="/flowlens-mark.png"
          alt=""
          width={128}
          height={128}
        />
      </a>
      <div className="workspace-label">
        LOCAL WORKSPACE <span>01</span>
      </div>
      <nav>
        <button
          className="nav-item active"
          onClick={onWorkspace}
          aria-label="Trace workspace"
        >
          <GitBranch size={18} />
          <span>Trace workspace</span>
          <span className="nav-dot" />
        </button>
        <button
          className="nav-item"
          onClick={onCases}
          aria-label="Investigations"
        >
          <FolderOpen size={18} />
          <span>Investigations</span>
          <span className="nav-count">{savedCount}</span>
        </button>
        <button
          className="nav-item"
          onClick={onCoverage}
          aria-label="Sources & coverage"
        >
          <Activity size={18} />
          <span>Sources & coverage</span>
        </button>
        <button
          className="nav-item"
          onClick={onProtocol}
          aria-label="Protocol evidence"
          // Protocol evidence attaches to a case, so there is nothing to show before one.
          disabled={!investigation}
          title={investigation ? undefined : "Open or trace a case first"}
        >
          <ShieldCheck size={18} />
          <span>Protocol evidence</span>
        </button>
      </nav>
      {investigation && (
        <div className="rail-case">
          <span className="eyebrow">CURRENT INVESTIGATION</span>
          <strong>{investigation.title}</strong>
          <span>
            <i className="status-dot" />
            {investigation.mode === "demo" ? "Test fixture" : "Local case"}
          </span>
          <div className="case-line" />
          <p>
            {investigation.transfers.length} evidence records
            <br />
            {investigation.expanded.length} wallet scopes loaded
          </p>
        </div>
      )}
      <div className="rail-bottom">
        <button className="agent-card" onClick={onAgents}>
          <span className="terminal-icon">
            <Terminal size={18} />
          </span>
          <strong>Built for your agents</strong>
          <span>Same engine. Every interface.</span>
          <span className="agent-link">
            Explore CLI, API & MCP <ArrowRight size={13} />
          </span>
        </button>
        <button className="nav-item" onClick={onHelp} aria-label="Field guide">
          <CircleHelp size={17} />
          <span>Field guide</span>
          <span className="keycap">?</span>
        </button>
        <div className="local-footer">
          <span className="status-dot" /> Local workspace <span>v0.1</span>
        </div>
      </div>
    </aside>
  );
}
