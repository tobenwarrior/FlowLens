import { ArrowRight, FolderOpen, Terminal } from "lucide-react";
import { short } from "./Graph.tsx";

/**
 * Public wallets of well-known organisations, so a first trace has somewhere to start.
 * Each one's ENS reverse record or verified contract name identifies it on Blockscout.
 */
export const EXAMPLES = [
  {
    name: "ENS DAO endowment",
    address: "0x4F2083f5fBede34C2714aFfb3105539775f7FE64",
  },
  {
    name: "ENS DAO wallet",
    address: "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7",
  },
  {
    name: "Uniswap governance timelock",
    address: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC",
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
            <strong>{example.name}</strong>
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
