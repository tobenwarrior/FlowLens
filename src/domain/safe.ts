import type { Address } from "./types.ts";

export type SafeEvidenceMode = "synthetic" | "private";
export interface SafeProvenance {
  source: string;
  retrievedAt: string;
  synthetic: boolean;
  sourceUrl?: string;
}
interface SafeRecord {
  id: string;
  chainId: number;
  safeAddress: Address;
  provenance: SafeProvenance;
}
export interface SafeConfiguration extends SafeRecord {
  kind: "genesis" | "current" | "at-block";
  blockNumber: number;
  transactionIndex?: number;
  owners: Address[];
  threshold: number;
}
export interface SafeSignatureObservation {
  id: string;
  signer?: Address;
  type: "eoa" | "contract" | "approved-hash" | "unknown";
  observation: "supplied" | "source-recovered";
  participation?: "calldata-only";
  provenance: SafeProvenance;
}
export interface SafeExecution extends SafeRecord {
  transactionHash: string;
  executionIndex: string;
  blockNumber: number;
  transactionIndex?: number;
  safeTxHash?: string;
  nonce?: string;
  status: "success" | "failure" | "unknown";
  authorizationPath: "owner-signatures" | "module" | "unknown";
  configurationEvidenceId?: string;
  signatures: SafeSignatureObservation[];
  signatureCoverage: "partial" | "reported-complete" | "unavailable";
}
export interface SafeConfigurationEvent extends SafeRecord {
  transactionHash: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  type: "owner-added" | "owner-removed" | "threshold-changed" | "setup";
  owner?: Address;
  threshold?: number;
}
export interface SafeCoverage extends SafeRecord {
  stream:
    "configurations" | "executions" | "configuration-events" | "signatures";
  fromBlock: number;
  toBlock: number;
  status: "partial" | "exhausted" | "unsupported" | "error";
  cursor: string | null;
}
export interface SafeEvidenceLabel {
  id: string;
  chainId: number;
  address: Address;
  text: string;
  kind: "service" | "entity" | "prediction" | "user" | "demo";
  confidence: "verified" | "reported" | "unverified" | "synthetic";
  provenance: SafeProvenance;
}
export interface SafeEvidenceBundle {
  version: 1;
  mode: SafeEvidenceMode;
  configurations: SafeConfiguration[];
  executions: SafeExecution[];
  configurationEvents: SafeConfigurationEvent[];
  coverage: SafeCoverage[];
  labels: SafeEvidenceLabel[];
}
export type SafeThresholdObservation =
  | "configuration-unavailable"
  | "configuration-order-ambiguous"
  | "configuration-link-crosses-observed-change"
  | "configuration-link-conflicts-with-snapshot"
  | "signature-evidence-unavailable"
  | "module-authorization-not-owner-quorum"
  | "authorization-path-unresolved"
  | "below-threshold-in-supplied-observations"
  | "observed-count-meets-threshold";
export interface SafeExecutionAnalysis {
  evidenceId: string;
  chainId: number;
  safeAddress: Address;
  transactionHash: string;
  executionIndex: string;
  executionStatus: SafeExecution["status"];
  authorizationPath: SafeExecution["authorizationPath"];
  configurationEvidenceId: string | null;
  configuredThreshold: number | null;
  configuredOwners: Address[];
  signatureCoverage: SafeExecution["signatureCoverage"];
  signatureObservationCount: number;
  uniqueObservedSigners: Address[];
  observedConfiguredSigners: Address[];
  observedOtherSigners: Address[];
  unknownSignatureCount: number;
  thresholdObservation: SafeThresholdObservation;
  signatureEvidenceIds: string[];
  warnings: string[];
}
export interface SafeConfigurationChangeAnalysis {
  chainId: number;
  safeAddress: Address;
  coverageId: string | null;
  coverageStatus: SafeCoverage["status"] | "unavailable";
  fromBlock: number | null;
  toBlock: number | null;
  eventIds: string[];
  setupEventIds: string[];
  observation:
    | "no changes observed in supplied scope"
    | "configuration changes observed in supplied scope"
    | "configuration-change coverage incomplete"
    | "configuration-change coverage unavailable"
    | "configuration snapshots differ without matching change evidence";
}
export interface SafeAnalysis {
  version: 1;
  mode: SafeEvidenceMode;
  executionCount: number;
  independentlyVerifiedSignatures: false;
  executions: SafeExecutionAnalysis[];
  configurationChanges: SafeConfigurationChangeAnalysis[];
  warnings: string[];
}

export class SafeEvidenceError extends Error {
  name = "SafeEvidenceError";
  code = "INVALID_SAFE_EVIDENCE";
  retryable = false;
}
const fail = (message: string): never => {
  throw new SafeEvidenceError(message);
};
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    return fail(
      `${name} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return fail(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    return fail(`Invalid ${name}`);
  return value as T;
}
function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    return fail(`${name} must be an array of at most ${max} items`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, "evidence ID");
  if (!/^[a-zA-Z0-9:._-]+$/.test(result)) return fail("Invalid evidence ID");
  return result;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.trim()))
    return fail("Invalid Safe evidence address");
  return value.trim().toLowerCase() as Address;
}
function hash(value: unknown): string {
  const result = text(value, "transaction hash", 66).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) return fail("Invalid transaction hash");
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, "retrieval timestamp", 40);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      result,
    );
  if (!parts || !Number.isFinite(Date.parse(result)))
    return fail("Invalid retrieval timestamp with timezone");
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59
  )
    return fail("Invalid calendar retrieval timestamp");
  return new Date(result).toISOString();
}
function provenance(value: unknown, mode: SafeEvidenceMode): SafeProvenance {
  const p = object(value, "provenance");
  if (
    typeof p.synthetic !== "boolean" ||
    p.synthetic !== (mode === "synthetic")
  )
    return fail(
      "Every evidence record must match the explicit synthetic/private mode",
    );
  const result: SafeProvenance = {
    source: text(p.source, "source"),
    retrievedAt: timestamp(p.retrievedAt),
    synthetic: p.synthetic,
  };
  if (p.sourceUrl !== undefined) {
    const url = text(p.sourceUrl, "source URL", 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("Invalid source URL");
    }
    if (parsed.protocol !== "https:") return fail("Source URL must use HTTPS");
    if (parsed.username || parsed.password)
      return fail("Source URL credentials are not allowed");
    result.sourceUrl = url;
  }
  return result;
}
function record(
  value: Record<string, unknown>,
  mode: SafeEvidenceMode,
): SafeRecord {
  return {
    id: id(value.id),
    chainId: integer(value.chainId, "chain ID", 1),
    safeAddress: address(value.safeAddress),
    provenance: provenance(value.provenance, mode),
  };
}
function configuration(
  value: unknown,
  mode: SafeEvidenceMode,
): SafeConfiguration {
  const c = object(value, "Safe configuration"),
    owners = list(c.owners, "owners", 100).map(address);
  if (new Set(owners).size !== owners.length)
    return fail("Duplicate owner in Safe configuration");
  const result: SafeConfiguration = {
    ...record(c, mode),
    kind: choice(
      c.kind,
      ["genesis", "current", "at-block"],
      "configuration kind",
    ),
    blockNumber: integer(c.blockNumber, "configuration block"),
    owners,
    threshold: integer(c.threshold, "threshold", 1, owners.length),
  };
  if (c.transactionIndex !== undefined)
    result.transactionIndex = integer(
      c.transactionIndex,
      "configuration transaction index",
    );
  return result;
}
function signature(
  value: unknown,
  mode: SafeEvidenceMode,
): SafeSignatureObservation {
  const s = object(value, "signature observation"),
    type = choice(
      s.type,
      ["eoa", "contract", "approved-hash", "unknown"],
      "signature type",
    );
  const result: SafeSignatureObservation = {
    id: id(s.id),
    type,
    observation: choice(
      s.observation,
      ["supplied", "source-recovered"],
      "signature observation source",
    ),
    provenance: provenance(s.provenance, mode),
  };
  if (s.signer !== undefined) result.signer = address(s.signer);
  if (s.participation !== undefined)
    result.participation = choice(
      s.participation,
      ["calldata-only"] as const,
      "signature participation",
    );
  if (type !== "unknown" && !result.signer)
    return fail("A known signature type requires an observed signer address");
  return result;
}
function execution(value: unknown, mode: SafeEvidenceMode): SafeExecution {
  const e = object(value, "Safe execution");
  const result: SafeExecution = {
    ...record(e, mode),
    transactionHash: hash(e.transactionHash),
    executionIndex: text(e.executionIndex, "execution index", 100),
    blockNumber: integer(e.blockNumber, "execution block"),
    status: choice(
      e.status,
      ["success", "failure", "unknown"],
      "execution status",
    ),
    authorizationPath: choice(
      e.authorizationPath ?? "unknown",
      ["owner-signatures", "module", "unknown"],
      "execution authorization path",
    ),
    signatureCoverage: choice(
      e.signatureCoverage,
      ["partial", "reported-complete", "unavailable"],
      "signature coverage",
    ),
    signatures: list(e.signatures, "signature observations", 100).map((s) =>
      signature(s, mode),
    ),
  };
  if (!/^[\w.:-]+$/.test(result.executionIndex))
    return fail("Invalid execution index");
  if (result.signatureCoverage === "unavailable" && result.signatures.length)
    return fail(
      "Unavailable signature coverage cannot contain signer observations",
    );
  if (e.transactionIndex !== undefined)
    result.transactionIndex = integer(
      e.transactionIndex,
      "execution transaction index",
    );
  if (e.safeTxHash !== undefined) result.safeTxHash = hash(e.safeTxHash);
  if (e.configurationEvidenceId !== undefined)
    result.configurationEvidenceId = id(e.configurationEvidenceId);
  if (e.nonce !== undefined) {
    result.nonce = text(e.nonce, "Safe nonce", 80);
    if (!/^\d+$/.test(result.nonce))
      return fail("Safe nonce must be an unsigned integer string");
    result.nonce = BigInt(result.nonce).toString();
  }
  return result;
}
function configurationEvent(
  value: unknown,
  mode: SafeEvidenceMode,
): SafeConfigurationEvent {
  const e = object(value, "configuration event");
  const result: SafeConfigurationEvent = {
    ...record(e, mode),
    transactionHash: hash(e.transactionHash),
    blockNumber: integer(e.blockNumber, "event block"),
    transactionIndex: integer(e.transactionIndex, "event transaction index"),
    logIndex: integer(e.logIndex, "event log index"),
    type: choice(
      e.type,
      ["owner-added", "owner-removed", "threshold-changed", "setup"],
      "configuration event type",
    ),
  };
  if (e.owner !== undefined) result.owner = address(e.owner);
  if (e.threshold !== undefined)
    result.threshold = integer(e.threshold, "event threshold", 1, 100);
  if (
    (result.type === "owner-added" || result.type === "owner-removed") &&
    !result.owner
  )
    return fail("Owner change event requires an owner");
  if (result.type === "threshold-changed" && result.threshold === undefined)
    return fail("Threshold change event requires its observed threshold");
  return result;
}
function coverage(value: unknown, mode: SafeEvidenceMode): SafeCoverage {
  const c = object(value, "Safe coverage");
  const result: SafeCoverage = {
    ...record(c, mode),
    stream: choice(
      c.stream,
      ["configurations", "executions", "configuration-events", "signatures"],
      "Safe coverage stream",
    ),
    fromBlock: integer(c.fromBlock, "coverage first block"),
    toBlock: integer(c.toBlock, "coverage last block"),
    status: choice(
      c.status,
      ["partial", "exhausted", "unsupported", "error"],
      "coverage status",
    ),
    cursor: c.cursor === null ? null : text(c.cursor, "coverage cursor", 4096),
  };
  if (result.fromBlock > result.toBlock)
    return fail("Coverage first block must not exceed last block");
  if (result.status === "exhausted" && result.cursor !== null)
    return fail("Exhausted coverage cannot retain a next cursor");
  return result;
}
function label(value: unknown, mode: SafeEvidenceMode): SafeEvidenceLabel {
  const l = object(value, "Safe evidence label");
  if (mode === "private" && (l.kind === "demo" || l.confidence === "synthetic"))
    return fail("A synthetic label cannot enter private Safe evidence");
  return {
    id: id(l.id),
    chainId: integer(l.chainId, "label chain ID", 1),
    address: address(l.address),
    text: text(l.text, "label text"),
    kind: choice(
      l.kind,
      ["service", "entity", "prediction", "user", "demo"],
      "label kind",
    ),
    confidence: choice(
      l.confidence,
      ["verified", "reported", "unverified", "synthetic"],
      "label confidence",
    ),
    provenance: provenance(l.provenance, mode),
  };
}
const sameSafe = (
  a: { chainId: number; safeAddress: Address },
  b: { chainId: number; safeAddress: Address },
) => a.chainId === b.chainId && a.safeAddress === b.safeAddress;
function position(
  a: { blockNumber: number; transactionIndex?: number },
  b: { blockNumber: number; transactionIndex?: number },
): -1 | 0 | 1 | null {
  if (a.blockNumber !== b.blockNumber)
    return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex === undefined || b.transactionIndex === undefined)
    return null;
  return a.transactionIndex === b.transactionIndex
    ? 0
    : a.transactionIndex < b.transactionIndex
      ? -1
      : 1;
}
const configurationFingerprint = (c: SafeConfiguration) =>
  JSON.stringify([[...c.owners].sort(), c.threshold]);

/** Validates supplied observations. It does not fetch or cryptographically authenticate them. */
export function parseSafeEvidence(
  input: unknown,
  mode: SafeEvidenceMode,
): SafeEvidenceBundle {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return fail("Safe evidence must be serializable JSON");
  }
  if (!encoded || new TextEncoder().encode(encoded).length > 2_000_000)
    return fail("Safe evidence exceeds the 2 MB input budget");
  const b = object(input, "Safe evidence bundle");
  if (b.version !== 1) return fail("Unsupported Safe evidence version");
  if (mode !== "synthetic" && mode !== "private")
    return fail("Invalid Safe evidence mode");
  if (b.mode !== mode)
    return fail(
      "Safe evidence mode must match the explicitly requested replay mode",
    );
  const result: SafeEvidenceBundle = {
    version: 1,
    mode,
    configurations: list(b.configurations, "configurations", 200).map((c) =>
      configuration(c, mode),
    ),
    executions: list(b.executions, "executions", 1000).map((e) =>
      execution(e, mode),
    ),
    configurationEvents: list(
      b.configurationEvents,
      "configuration events",
      2000,
    ).map((e) => configurationEvent(e, mode)),
    coverage: list(b.coverage, "coverage", 200).map((c) => coverage(c, mode)),
    labels: list(b.labels ?? [], "labels", 200).map((l) => label(l, mode)),
  };
  const seen = new Set<string>();
  for (const r of [
    ...result.configurations,
    ...result.executions,
    ...result.configurationEvents,
    ...result.coverage,
    ...result.labels,
    ...result.executions.flatMap((e) => e.signatures),
  ]) {
    if (seen.has(r.id)) return fail(`Duplicate evidence ID: ${r.id}`);
    seen.add(r.id);
  }
  const snapshotKeys = new Set<string>();
  for (const c of result.configurations) {
    const key = `${c.chainId}:${c.safeAddress}:${c.kind}:${c.blockNumber}:${c.transactionIndex ?? "block"}`;
    if (snapshotKeys.has(key))
      return fail(
        "Duplicate configuration snapshot identity, even under different evidence IDs",
      );
    snapshotKeys.add(key);
  }
  const executionKeys = new Set<string>(),
    eventKeys = new Set<string>();
  for (const e of result.executions) {
    const key = `${e.chainId}:${e.safeAddress}:${e.transactionHash}:${e.executionIndex}`;
    if (executionKeys.has(key))
      return fail(
        "Duplicate execution identity, even under different evidence IDs",
      );
    executionKeys.add(key);
    if (e.configurationEvidenceId) {
      const config = result.configurations.find(
        (c) => c.id === e.configurationEvidenceId,
      );
      if (!config)
        return fail("Execution references missing configuration evidence");
      if (!sameSafe(e, config))
        return fail(
          "Configuration evidence must identify the same Safe and chain as its execution",
        );
      if (config.kind === "current")
        return fail(
          "A current snapshot cannot establish historical execution configuration",
        );
      if (config.blockNumber > e.blockNumber)
        return fail("Configuration evidence is after the execution");
      if (
        config.blockNumber === e.blockNumber &&
        config.transactionIndex !== undefined &&
        e.transactionIndex !== undefined &&
        config.transactionIndex >= e.transactionIndex
      )
        return fail(
          "Configuration must be observed before the execution transaction",
        );
    }
  }
  for (const e of result.configurationEvents) {
    const key = `${e.chainId}:${e.transactionHash}:${e.logIndex}`;
    if (eventKeys.has(key))
      return fail("Duplicate configuration event identity");
    eventKeys.add(key);
  }
  return result;
}

/** Reports what the supplied scoped evidence supports; configuration is never a signature observation. */
export function analyzeSafeEvidence(input: SafeEvidenceBundle): SafeAnalysis {
  const bundle = parseSafeEvidence(input, input.mode);
  const executions = bundle.executions.map((e): SafeExecutionAnalysis => {
    let config = bundle.configurations.find(
      (c) => c.id === e.configurationEvidenceId,
    );
    const warnings = [
      "Signature observations are supplied/source-recovered claims and are not independently verified cryptographic signatures.",
    ];
    let thresholdObservation: SafeThresholdObservation =
      "configuration-unavailable";
    if (!config)
      warnings.push(
        "Historical configuration is unavailable; the current snapshot is not substituted.",
      );
    if (
      config &&
      config.blockNumber === e.blockNumber &&
      (config.transactionIndex === undefined ||
        e.transactionIndex === undefined)
    ) {
      config = undefined;
      thresholdObservation = "configuration-order-ambiguous";
      warnings.push(
        "Configuration and execution share a block without enough transaction ordering evidence.",
      );
    }
    if (config) {
      let intervening = false,
        ambiguous = false,
        sameTransaction = false;
      for (const event of bundle.configurationEvents) {
        if (
          !sameSafe(e, event) ||
          event.type === "setup" ||
          event.blockNumber < config.blockNumber ||
          event.blockNumber > e.blockNumber
        )
          continue;
        if (event.transactionHash === e.transactionHash) {
          ambiguous = true;
          sameTransaction = true;
          continue;
        }
        const afterSnapshot = position(event, config),
          beforeExecution = position(event, e);
        if (afterSnapshot === -1 || beforeExecution === 1) continue;
        if (afterSnapshot === 1 && beforeExecution === -1) intervening = true;
        else ambiguous = true;
      }
      if (intervening || ambiguous) {
        config = undefined;
        thresholdObservation = ambiguous
          ? "configuration-order-ambiguous"
          : "configuration-link-crosses-observed-change";
        if (sameTransaction)
          warnings.push(
            "A configuration change shares the same outer transaction as the execution; per-call ordering is unavailable, so the execution configuration is unresolved.",
          );
        else if (ambiguous)
          warnings.push(
            "A configuration change shares a boundary block/transaction without enough ordering evidence; the execution configuration is unresolved.",
          );
        else
          warnings.push(
            "An observed configuration change lies between the linked snapshot and execution; the execution configuration is unresolved.",
          );
      }
    }
    if (config) {
      let contradictory = false,
        ambiguous = false;
      const linked = config;
      for (const snapshot of bundle.configurations) {
        if (
          snapshot.id === linked.id ||
          !sameSafe(e, snapshot) ||
          configurationFingerprint(snapshot) ===
            configurationFingerprint(linked) ||
          snapshot.blockNumber < linked.blockNumber ||
          snapshot.blockNumber > e.blockNumber
        )
          continue;
        const afterLinked = position(snapshot, linked),
          beforeExecution = position(snapshot, e);
        if (afterLinked === -1 || beforeExecution === 1) continue;
        if (afterLinked === 1 && beforeExecution === -1) contradictory = true;
        else ambiguous = true;
      }
      if (contradictory || ambiguous) {
        config = undefined;
        thresholdObservation = ambiguous
          ? "configuration-order-ambiguous"
          : "configuration-link-conflicts-with-snapshot";
        warnings.push(
          ambiguous
            ? "A contradictory configuration snapshot has unresolved boundary ordering; execution configuration is unavailable."
            : "A later contradictory configuration snapshot precedes execution; the linked older owner set/threshold cannot be treated as applicable.",
        );
      }
    }
    const uniqueObservedSigners = [
      ...new Set(e.signatures.flatMap((s) => (s.signer ? [s.signer] : []))),
    ].sort();
    const configuredOwners = config ? [...config.owners].sort() : [];
    const typedObservedSigners = [
      ...new Set(
        e.signatures.flatMap((s) =>
          s.signer &&
          s.type !== "unknown" &&
          s.participation !== "calldata-only"
            ? [s.signer]
            : [],
        ),
      ),
    ].sort();
    const observedConfiguredSigners = typedObservedSigners.filter((s) =>
      configuredOwners.includes(s),
    );
    const observedOtherSigners = config
      ? typedObservedSigners.filter((s) => !configuredOwners.includes(s))
      : [];
    const unknownSignatureCount = e.signatures.filter(
      (s) => s.type === "unknown" || !s.signer,
    ).length;
    const calldataOnlyCount = e.signatures.filter(
      (s) => s.participation === "calldata-only",
    ).length;
    if (config)
      thresholdObservation =
        e.signatureCoverage === "unavailable" ||
        (e.signatures.length > 0 && calldataOnlyCount === e.signatures.length)
          ? "signature-evidence-unavailable"
          : observedConfiguredSigners.length >= config.threshold
            ? "observed-count-meets-threshold"
            : "below-threshold-in-supplied-observations";
    if (e.authorizationPath === "module") {
      thresholdObservation = "module-authorization-not-owner-quorum";
      warnings.push(
        "Module-authorized execution is distinct from an owner-signature quorum; owner count is not used as its authorization test.",
      );
    } else if (e.authorizationPath === "unknown") {
      thresholdObservation = "authorization-path-unresolved";
      warnings.push(
        "Execution authorization path was not supplied; owner-signature quorum applicability is unresolved.",
      );
    }
    if (e.signatureCoverage === "partial")
      warnings.push(
        "Signature evidence is partial; an observed count below threshold does not contradict a successful execution.",
      );
    if (e.signatureCoverage === "reported-complete")
      warnings.push(
        "Completeness is reported by the supplied source, not independently verified.",
      );
    if (unknownSignatureCount)
      warnings.push(
        "Unknown signature types/identities remain unresolved and are not assigned to configured owners.",
      );
    if (calldataOnlyCount)
      warnings.push(
        "Calldata-only signature recoveries do not establish participation in the Safe's consumed signature prefix and are excluded from quorum comparisons.",
      );
    return {
      evidenceId: e.id,
      chainId: e.chainId,
      safeAddress: e.safeAddress,
      transactionHash: e.transactionHash,
      executionIndex: e.executionIndex,
      executionStatus: e.status,
      authorizationPath: e.authorizationPath,
      configurationEvidenceId: e.configurationEvidenceId ?? null,
      configuredThreshold: config?.threshold ?? null,
      configuredOwners,
      signatureCoverage: e.signatureCoverage,
      signatureObservationCount: e.signatures.length,
      uniqueObservedSigners,
      observedConfiguredSigners,
      observedOtherSigners,
      unknownSignatureCount,
      thresholdObservation,
      signatureEvidenceIds: e.signatures.map((s) => s.id),
      warnings,
    };
  });
  const safes = new Map<string, { chainId: number; safeAddress: Address }>();
  for (const r of [
    ...bundle.configurations,
    ...bundle.executions,
    ...bundle.configurationEvents,
    ...bundle.coverage,
  ])
    safes.set(`${r.chainId}:${r.safeAddress}`, {
      chainId: r.chainId,
      safeAddress: r.safeAddress,
    });
  const configurationChanges: SafeConfigurationChangeAnalysis[] = [];
  for (const safe of safes.values()) {
    const scopes = bundle.coverage.filter(
      (c) => sameSafe(c, safe) && c.stream === "configuration-events",
    );
    const events = bundle.configurationEvents.filter((e) => sameSafe(e, safe));
    const add = (
      scope: SafeCoverage | null,
      observed: SafeConfigurationEvent[],
    ) => {
      const changes = observed.filter((e) => e.type !== "setup"),
        setups = observed.filter((e) => e.type === "setup");
      let observation: SafeConfigurationChangeAnalysis["observation"] =
        changes.length
          ? "configuration changes observed in supplied scope"
          : !scope
            ? "configuration-change coverage unavailable"
            : scope.status === "exhausted"
              ? "no changes observed in supplied scope"
              : "configuration-change coverage incomplete";
      if (scope && scope.status === "exhausted" && !changes.length) {
        const snapshots = bundle.configurations.filter(
          (c) =>
            sameSafe(c, safe) &&
            c.blockNumber >= scope.fromBlock &&
            c.blockNumber <= scope.toBlock,
        );
        const fingerprints = new Set(snapshots.map(configurationFingerprint));
        if (fingerprints.size > 1)
          observation =
            "configuration snapshots differ without matching change evidence";
      }
      configurationChanges.push({
        ...safe,
        coverageId: scope?.id ?? null,
        coverageStatus: scope?.status ?? "unavailable",
        fromBlock: scope?.fromBlock ?? null,
        toBlock: scope?.toBlock ?? null,
        eventIds: changes.map((e) => e.id),
        setupEventIds: setups.map((e) => e.id),
        observation,
      });
    };
    for (const scope of scopes)
      add(
        scope,
        events.filter(
          (e) =>
            e.blockNumber >= scope.fromBlock && e.blockNumber <= scope.toBlock,
        ),
      );
    const uncovered = events.filter(
      (e) =>
        !scopes.some(
          (s) => e.blockNumber >= s.fromBlock && e.blockNumber <= s.toBlock,
        ),
    );
    if (!scopes.length || uncovered.length) add(null, uncovered);
  }
  return {
    version: 1,
    mode: bundle.mode,
    executionCount: executions.length,
    independentlyVerifiedSignatures: false,
    executions,
    configurationChanges,
    warnings: [
      "Configured owners and threshold describe account configuration, not who signed a particular execution.",
      "Configured quorum does not establish ownership; observed signer overlap and issuer entitlements do not establish corporate ownership either.",
      "No signature recovery, EIP-1271 validation, approved-hash verification or live Safe fetch is performed by replay analysis.",
      "Coverage describes only the supplied chain/block/stream scope and never complete Safe history.",
    ],
  };
}

/** Fictional replay fixture. It contains no source chain evidence or real-world attribution. */
export function createSyntheticSafeEvidence(): SafeEvidenceBundle {
  const safeAddress = `0x${"1".repeat(40)}` as Address;
  const owners = ["2", "3", "4", "5", "6"].map(
    (d) => `0x${d.repeat(40)}` as Address,
  );
  const provenance: SafeProvenance = {
    source: "Flowlens synthetic Safe replay v1",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    synthetic: true,
  };
  return {
    version: 1,
    mode: "synthetic",
    configurations: [
      {
        id: "config-genesis",
        chainId: 1,
        safeAddress,
        kind: "genesis",
        blockNumber: 100,
        transactionIndex: 0,
        owners: [...owners],
        threshold: 3,
        provenance: { ...provenance },
      },
      {
        id: "config-current",
        chainId: 1,
        safeAddress,
        kind: "current",
        blockNumber: 300,
        owners: [...owners],
        threshold: 3,
        provenance: { ...provenance },
      },
    ],
    executions: Array.from({ length: 11 }, (_, i) => ({
      id: `execution-${i}`,
      chainId: 1,
      safeAddress,
      transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      executionIndex: `log:${i}`,
      blockNumber: 200 + i,
      transactionIndex: 1,
      nonce: String(i),
      status: "success" as const,
      authorizationPath: "owner-signatures" as const,
      configurationEvidenceId: "config-genesis",
      signatureCoverage: "partial" as const,
      signatures: owners.slice(0, (i % 2) + 1).map((signer, n) => ({
        id: `signature-${i}-${n}`,
        signer,
        type: "eoa" as const,
        observation: "source-recovered" as const,
        provenance: { ...provenance },
      })),
      provenance: { ...provenance },
    })),
    configurationEvents: [],
    coverage: [
      {
        id: "config-events-scope",
        chainId: 1,
        safeAddress,
        stream: "configuration-events",
        fromBlock: 100,
        toBlock: 300,
        status: "exhausted",
        cursor: null,
        provenance: { ...provenance },
      },
      {
        id: "execution-scope",
        chainId: 1,
        safeAddress,
        stream: "executions",
        fromBlock: 200,
        toBlock: 210,
        status: "exhausted",
        cursor: null,
        provenance: { ...provenance },
      },
    ],
    labels: [
      {
        id: "safe-demo-label",
        chainId: 1,
        address: safeAddress,
        text: "Synthetic Safe account",
        kind: "demo",
        confidence: "synthetic",
        provenance: { ...provenance },
      },
    ],
  };
}
