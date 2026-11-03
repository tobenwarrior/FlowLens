import { ArrowRight, FolderOpen, Terminal } from "lucide-react";
import { short } from "./Graph.tsx";

/**
 * Public wallets of well-known organisations whose recent history is real activity,
 * so a first trace shows money moving rather than airdrop spam. Each owner publishes
 * its address; `source` names where.
 */
export const EXAMPLES = [
  {
    name: "Lido DAO treasury",
    address: "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c",
    source: "Lido's deployed-contracts list",
  },
  {
    name: "Sky governance pause proxy",
    address: "0xBE8E3e3618f7474F8cB1d074A26afFef007E98FB",
    source: "Sky's on-chain chainlog",
  },
  {
    name: "SafeDAO treasury",
    address: "0x0B00b3227A5F3df3484f03990A87e02EbaD2F888",
    source: "the Safe Foundation's treasury page",
  },
];

interface StartPanelProps {
  /** Name of the provider serving Ethereum history, when the local API reports one. */
  provider: string | null;
  busy: boolean;
  savedCount: number;
  onTrace: (address: string) => void;
  onCases: () => void;
  onAgents: () => void;
}

/** What the workspace shows before any case is open. */
export function StartPanel({
  provider,
  busy,
  savedCount,
  onTrace,
  onCases,
  onAgents,
}: StartPanelProps) {
  return (
    <section className="start-panel" aria-labelledby="start-title">
      <div className="start-intro">
        <span className="eyebrow">START A LIVE TRACE</span>
        <h2 id="start-title">Trace any Ethereum wallet</h2>
        <p>
          Paste an address above, or start from one of these public wallets.
          FlowLens loads its history page by page
          {provider ? ` from ${provider}` : ""}, shows who it pays and who pays
          it, and keeps every transfer as evidence you can check.
        </p>
        <p className="start-privacy">
          The address you trace is sent to that history provider. Your cases,
          notes and labels stay on this device.
        </p>
      </div>
      <div className="start-examples">
        <span className="eyebrow">PUBLIC WALLETS TO TRY</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.address}
            className="start-example"
            disabled={busy}
            onClick={() => onTrace(example.address)}
          >
            <span className="start-example-name">
              <strong>{example.name}</strong>
              <small>Address from {example.source}</small>
            </span>
            <code>{short(example.address)}</code>
            <ArrowRight size={14} />
          </button>
        ))}
      </div>
      <div className="start-links">
        <button className="text-button" onClick={onCases}>
          <FolderOpen size={14} /> Open a saved investigation
          {savedCount ? ` (${savedCount})` : ""}
        </button>
        <button className="text-button" onClick={onAgents}>
          <Terminal size={14} /> Trace from an agent: CLI, API and MCP
        </button>
      </div>
    </section>
  );
}
