import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Download,
  FileJson,
  Layers,
  LoaderCircle,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import {
  analyzeProtocolEvidence,
  createSyntheticProtocolEvidence,
  parseProtocolEvidence,
} from "../domain/protocols.ts";
import type { ProtocolEvidenceBundle } from "../domain/protocols.ts";
import type { Investigation } from "../domain/types.ts";
import { chainName, short } from "./Graph.tsx";

const human = (s: string) => s.replaceAll("-", " ");
interface AcquisitionRequest {
  kind: "safe" | "bridge" | "internal";
  chainId: number;
  address?: string;
  hash?: string;
  maxCalls: number;
  maxPages?: number;
  verifySignatures?: boolean;
}
interface AcquisitionResult {
  bundle: ProtocolEvidenceBundle;
  warnings?: string[];
  errors?: unknown[];
  acquisition?: unknown;
}
function issueMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value)
    return String(value.message);
  return "The provider returned an unresolved observation. Inspect its details.";
}
export function ProtocolEvidenceDialog({
  investigation,
  onClose,
  onAttach,
  onAcquire,
}: {
  investigation: Investigation;
  onClose: () => void;
  onAttach: (bundle: ProtocolEvidenceBundle) => Promise<void>;
  onAcquire: (request: AcquisitionRequest) => Promise<AcquisitionResult>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState(investigation.protocolEvidence ?? null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [kept, setKept] = useState(Boolean(investigation.protocolEvidence));
  const [readKind, setReadKind] = useState<AcquisitionRequest["kind"]>("safe");
  const [readChain, setReadChain] = useState("1");
  const [readSubject, setReadSubject] = useState(investigation.root as string);
  const [reading, setReading] = useState(false);
  const [attemptedRead, setAttemptedRead] = useState(false);
  const [readResult, setReadResult] = useState<AcquisitionResult | null>(null);
  const analysis = useMemo(
    () => (bundle ? analyzeProtocolEvidence(bundle) : null),
    [bundle],
  );
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  async function importFile(value: File) {
    setError("");
    try {
      if (value.size > 5_000_000)
        throw new Error("Protocol evidence exceeds the 5 MB limit.");
      setBundle(
        parseProtocolEvidence(
          JSON.parse(await value.text()),
          investigation.mode === "demo" ? "synthetic" : "private",
        ),
      );
      setKept(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid replay bundle.");
    }
  }
  function exportBundle() {
    if (!bundle) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `flowlens-${bundle.mode}-protocol-evidence.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function attach() {
    if (!bundle) return;
    setBusy(true);
    setError("");
    try {
      await onAttach(bundle);
      setKept(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to keep replay evidence.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function acquire() {
    setError("");
    const subject = readSubject.trim();
    if (
      !(
        readKind === "safe" ? /^0x[0-9a-fA-F]{40}$/ : /^0x[0-9a-fA-F]{64}$/
      ).test(subject)
    ) {
      setError(
        readKind === "safe"
          ? "Enter a valid Safe address: 0x and 40 hexadecimal characters."
          : "Enter a transaction hash: 0x and 64 hexadecimal characters.",
      );
      return;
    }
    setReading(true);
    setAttemptedRead(true);
    try {
      const result = await onAcquire({
        kind: readKind,
        chainId: Number(readChain),
        ...(readKind === "safe"
          ? { address: subject, maxPages: 1, verifySignatures: false }
          : { hash: subject }),
        maxCalls: 32,
      });
      setBundle(parseProtocolEvidence(result.bundle, "private"));
      setReadResult(result);
      setKept(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The bounded provider read could not finish. Existing evidence is preserved.",
      );
    } finally {
      setReading(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="protocol-dialog"
      aria-label="Protocol evidence replay"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="protocol-content">
        <button
          className="icon-button modal-close"
          aria-label="Close protocol evidence"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        <span className="modal-icon">
          <ShieldCheck size={24} />
        </span>
        <span className="eyebrow">OBSERVATIONS, WITH THEIR LIMITS</span>
        <h2>Look beyond the transfer.</h2>
        <p>
          Inspect Safe, bridge and internal-trace evidence. Every conclusion
          stays tied to its source and scope.
        </p>
        <div className="protocol-actions">
          {investigation.mode === "demo" && (
            <button
              className="button primary"
              onClick={() => {
                setBundle(createSyntheticProtocolEvidence());
                setKept(false);
                setError("");
              }}
            >
              <Layers size={14} /> Load synthetic replay
            </button>
          )}
          <button
            className="button"
            disabled={reading || busy}
            onClick={() => file.current?.click()}
          >
            <Upload size={14} /> Import{" "}
            {investigation.mode === "demo" ? "synthetic" : "private"} JSON
          </button>
          {bundle && (
            <button className="button subtle" onClick={exportBundle}>
              <Download size={14} /> Export replay
            </button>
          )}
        </div>
        {investigation.mode === "live" && (
          <section
            className="protocol-read"
            aria-label="Acquire public protocol evidence"
          >
            <div className="protocol-read-heading">
              <span className="eyebrow">ONE BOUNDED PUBLIC READ</span>
              <span>32 RPC calls maximum · no recursive expansion</span>
            </div>
            <div className="protocol-read-controls">
              <label>
                Observation
                <select
                  aria-label="Protocol observation type"
                  value={readKind}
                  disabled={reading || busy}
                  onChange={(e) => {
                    const next = e.target.value as AcquisitionRequest["kind"];
                    setReadKind(next);
                    if (next === "safe" && readChain === "8453")
                      setReadChain("1");
                    setReadSubject(next === "safe" ? investigation.root : "");
                  }}
                >
                  <option value="safe">Safe configuration & history</option>
                  <option value="bridge">CCTP transaction receipt</option>
                  <option value="internal">Transaction call trace</option>
                </select>
              </label>
              <label>
                Network
                <select
                  aria-label="Protocol network"
                  value={readChain}
                  disabled={reading || busy}
                  onChange={(e) => setReadChain(e.target.value)}
                >
                  <option value="1">Ethereum</option>
                  <option value="8453" disabled={readKind === "safe"}>
                    Base{readKind === "safe" ? " · Safe unavailable" : ""}
                  </option>
                  <option value="42161">Arbitrum One</option>
                </select>
              </label>
            </div>
            <label className="protocol-subject-label">
              {readKind === "safe" ? "Safe address" : "Transaction hash"}
              <input
                aria-label={
                  readKind === "safe"
                    ? "Safe address"
                    : "Protocol transaction hash"
                }
                spellCheck={false}
                autoComplete="off"
                value={readSubject}
                disabled={reading || busy}
                placeholder={
                  readKind === "safe"
                    ? "0x… (40 hexadecimal characters)"
                    : "0x… (64 hexadecimal characters)"
                }
                onChange={(e) => setReadSubject(e.target.value)}
              />
            </label>
            <p>
              This sends the{" "}
              {readKind === "safe"
                ? "address to public RPC and Safe services"
                : "transaction hash to a public RPC provider"}
              . Results are kept privately with this case.{" "}
              {readKind === "safe"
                ? "One history page; EOA recovery is off. Current configuration does not prove who signed an execution."
                : readKind === "bridge"
                  ? "Only supported CCTP events are decoded. Missing matches and beneficiary credit stay unresolved."
                  : "The endpoint may refuse traces. One transaction never establishes complete wallet history."}
            </p>
            <button
              className="button primary"
              disabled={reading || busy}
              onClick={() => void acquire()}
            >
              {reading ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <ShieldCheck size={14} />
              )}
              {reading
                ? "Reading public evidence…"
                : "Query public providers & keep evidence"}
            </button>
            {reading && (
              <p className="protocol-read-status" role="status">
                Checking chain and transaction identity before decoding.
                Provider reads follow bounded call, page and time budgets.
              </p>
            )}
          </section>
        )}
        <input
          ref={file}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          aria-label="Import protocol evidence JSON"
          onChange={(e) => {
            const next = e.target.files?.[0];
            if (next) void importFile(next);
            e.currentTarget.value = "";
          }}
        />
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {readResult && (
          <div className="protocol-read-result" role="status">
            <strong>Provider observations preserved.</strong>
            <p>
              Coverage and unresolved states remain part of the evidence.
              Indexed graph totals are unchanged.
            </p>
            {(readResult.warnings ?? []).map((warning, index) => (
              <p key={`warning-${index}`}>{warning}</p>
            ))}
            {(readResult.errors ?? []).map((issue, index) => (
              <p className="error-text" key={`error-${index}`}>
                {issueMessage(issue)}
              </p>
            ))}
            {readResult.acquisition !== undefined && (
              <details>
                <summary>
                  Inspect acquisition status, budgets and errors
                </summary>
                <pre>{JSON.stringify(readResult.acquisition, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
        {!analysis ? (
          <div className="protocol-empty">
            <FileJson size={29} />
            <strong>More context. Fewer assumptions.</strong>
            <p>
              Configured owners are separate from observed signatures. A bridge
              message can match while beneficiary credit remains unknown.
              Internal-call values need trace context.
            </p>
            <span>
              {attemptedRead
                ? "A public provider read was attempted. Review its status above; no successful evidence was added."
                : "No live Safe, bridge or internal-trace provider has been queried."}
            </span>
          </div>
        ) : (
          <>
            <div className="protocol-mode">
              <span className="case-badge">
                {bundle?.mode === "synthetic"
                  ? "SYNTHETIC REPLAY"
                  : "PRIVATE EVIDENCE"}
              </span>
              <span>Indexed graph totals remain unchanged.</span>
            </div>
            {analysis.safe && (
              <section className="protocol-section">
                <div className="protocol-section-title">
                  <ShieldCheck size={18} />
                  <h3>Safe execution evidence</h3>
                  <span>{analysis.safe.executionCount} executions</span>
                </div>
                <p>
                  Configured quorum and observed signers are different facts.
                  Signatures have not been independently verified by this
                  replay.
                </p>
                {(bundle?.safe?.configurations ?? [])
                  .slice(-6)
                  .map((configuration) => (
                    <div className="safe-configuration" key={configuration.id}>
                      <strong>
                        {configuration.threshold} of{" "}
                        {configuration.owners.length} configured
                      </strong>
                      <span>
                        {chainName(configuration.chainId)} ·{" "}
                        {short(configuration.safeAddress)} ·{" "}
                        {human(configuration.kind)} at block{" "}
                        {configuration.blockNumber}
                      </span>
                      <small>
                        {configuration.provenance.source}. Configuration is
                        separate from execution signature evidence.
                      </small>
                    </div>
                  ))}
                {(bundle?.safe?.configurations.length ?? 0) > 6 && (
                  <p>
                    Showing the last 6 configuration observations. All earlier
                    snapshots remain in JSON.
                  </p>
                )}
                <div className="protocol-row table-label">
                  <span>EXECUTION</span>
                  <span>CONFIGURED</span>
                  <span>OBSERVED SIGNERS</span>
                  <span>OBSERVATION</span>
                </div>
                {analysis.safe.executions.slice(0, 12).map((row) => (
                  <div className="protocol-row" key={row.evidenceId}>
                    <span>
                      <strong>{short(row.transactionHash)}</strong>
                      <small>
                        {chainName(row.chainId)} · {row.executionStatus}
                      </small>
                    </span>
                    <span>
                      {row.configuredThreshold === null
                        ? "Unresolved"
                        : `${row.configuredThreshold} of ${row.configuredOwners.length}`}
                    </span>
                    <span>
                      {row.uniqueObservedSigners.length} supplied{" "}
                      <small>
                        {row.observedConfiguredSigners.length} configured ·{" "}
                        {row.unknownSignatureCount} unknown
                      </small>
                    </span>
                    <span className="protocol-observation">
                      {human(row.thresholdObservation)}
                    </span>
                  </div>
                ))}
                {analysis.safe.executions.length > 12 && (
                  <p>
                    {analysis.safe.executions.length - 12} more executions are
                    preserved in JSON.
                  </p>
                )}
                <div className="protocol-notes">
                  {analysis.safe.configurationChanges.map((c, i) => (
                    <p key={i}>
                      <strong>
                        {chainName(c.chainId)} · {short(c.safeAddress)}
                      </strong>{" "}
                      {c.observation}
                      {c.fromBlock !== null
                        ? ` · blocks ${c.fromBlock}–${c.toBlock}`
                        : ""}
                    </p>
                  ))}
                </div>
              </section>
            )}
            {analysis.bridges && (
              <section className="protocol-section">
                <div className="protocol-section-title">
                  <Layers size={18} />
                  <h3>Bridge message matching</h3>
                  <span>{analysis.bridges.matches.length} groups</span>
                </div>
                <p>
                  Only protocol identifiers join transport observations. Matched
                  transport does not establish beneficiary credit or ownership.
                </p>
                {analysis.bridges.matches.slice(0, 12).map((match) => (
                  <div
                    className={`bridge-observation ${match.status === "matched" ? "matched" : "unresolved"}`}
                    key={match.id}
                  >
                    <div>
                      <strong>{human(match.status)}</strong>
                      <span>
                        {match.sourceIds.length} source <ArrowRight size={11} />{" "}
                        {match.destinationIds.length} destination
                      </span>
                    </div>
                    <code>{match.identityKeys.join(" · ") || match.id}</code>
                    <p>
                      Amounts: {human(match.amountReconciliation.status)} ·
                      Independent credit:{" "}
                      {human(match.independentCredit.status)}
                    </p>
                    {match.conflicts.map((c, i) => (
                      <p className="error-text" key={i}>
                        {c}
                      </p>
                    ))}
                  </div>
                ))}
              </section>
            )}
            {analysis.internal && (
              <section className="protocol-section">
                <div className="protocol-section-title">
                  <Braces size={18} />
                  <h3>Internal trace projection</h3>
                  <span>{analysis.internal.transfers.length} movements</span>
                </div>
                <p>
                  {analysis.internal.excluded.length} traces excluded from the
                  projection. Root transactions, inherited values, failed
                  ancestors and nonmoving calls cannot inflate funding.
                </p>
                <div className="internal-reasons">
                  {Object.entries(
                    analysis.internal.excluded.reduce<Record<string, number>>(
                      (counts, item) => ({
                        ...counts,
                        [item.reason]: (counts[item.reason] || 0) + 1,
                      }),
                      {},
                    ),
                  ).map(([reason, count]) => (
                    <span key={reason}>
                      {human(reason)} <strong>{count}</strong>
                    </span>
                  ))}
                </div>
                {analysis.internal.coverage.map((c) => (
                  <div className="protocol-coverage" key={c.id}>
                    <span
                      className={`status-dot ${c.status === "unavailable" ? "amber" : ""}`}
                    />
                    <strong>
                      {chainName(c.chainId)} · {human(c.status)}
                    </strong>
                    <p>
                      {c.provider} ·{" "}
                      {c.blockFrom === null
                        ? "Unbounded scope not established"
                        : `supplied blocks ${c.blockFrom}–${c.blockTo}`}
                      . Full wallet history: not established.
                    </p>
                  </div>
                ))}
              </section>
            )}
            <details className="protocol-json">
              <summary>Inspect complete evidence and provenance</summary>
              <pre>{JSON.stringify(bundle, null, 2)}</pre>
            </details>
            <div className="protocol-bottom">
              <p>
                Replay validates structure and consistency. Source assertions
                remain supplied evidence.
              </p>
              <button
                className="button primary"
                disabled={busy || kept || reading}
                onClick={() => void attach()}
              >
                {busy ? "Saving…" : kept ? "Kept with case" : "Keep with case"}{" "}
                <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
