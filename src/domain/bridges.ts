import { assetKey, normalizeAddress } from "./engine.ts";
import type { Address, Asset } from "./types.ts";

export type ReplayMode = "synthetic" | "private";
export interface BridgeProvenance {
  source: string;
  retrievedAt: string;
  synthetic: boolean;
  sourceUrl?: string;
}
export type BridgeMessage =
  | {
      protocol: "cctp";
      version: 1 | 2;
      sourceDomain?: number;
      destinationDomain?: number;
      nonce?: string;
      messageHash?: string;
    }
  | { protocol: "layerzero"; guid: string }
  | { protocol: "indexed"; namespace: string; messageId: string };
export interface BridgeRoute {
  sourceChainId: number;
  destinationChainId: number;
}
export interface BridgeObservation {
  id: string;
  role: "source" | "destination" | "fee";
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: string;
  rawAmount: string;
  asset: Asset;
  route: BridgeRoute;
  message: BridgeMessage;
  provenance: BridgeProvenance;
  feeSide?: "source" | "destination";
  sender?: Address;
  recipient?: Address;
  recipientScope?: "end-recipient" | "pooled-service" | "unknown";
  independentCredit?: {
    status: "observed" | "unverified" | "not-applicable";
    beneficiary?: Address;
    evidence: BridgeProvenance[];
  };
}
/** A supplied conversion ratio between exact raw-unit asset identities; symbol equality is irrelevant. */
export interface BridgeAssetMapping {
  id: string;
  sourceAsset: Asset;
  destinationAsset: Asset;
  sourceUnits: string;
  destinationUnits: string;
  provenance: BridgeProvenance;
}
export interface BridgeCoverage {
  id: string;
  chainId: number;
  protocol: string;
  stream: "source" | "destination" | "fee" | "independent-credit";
  status: "partial" | "supplied-scope-exhausted" | "unavailable" | "error";
  blockFrom: number | null;
  blockTo: number | null;
  warnings: string[];
  provenance: BridgeProvenance;
}
export interface BridgeEvidenceBundle {
  version: 1;
  mode: ReplayMode;
  observations: BridgeObservation[];
  assetMappings: BridgeAssetMapping[];
  coverage: BridgeCoverage[];
}
export interface BridgeAmountReconciliation {
  status: "balanced" | "difference" | "unavailable";
  mappingId?: string;
  sourceRaw?: string;
  destinationRaw?: string;
  sourceFeeRaw?: string;
  destinationFeeRaw?: string;
  /** Difference in a common exact numerator: sourceRaw*destinationUnits - destinationRaw*sourceUnits - mapped fees. */
  differenceNumerator?: string;
  denominator?: string;
  reason?: string;
}
export interface CctpRouteValidation {
  status: "known-mapping-consistent" | "unresolved" | "conflicting";
  sourceUrl: string;
  checkedAt: string;
  mappings: {
    sourceChainId: number;
    destinationChainId: number;
    expectedSourceDomain: number | null;
    expectedDestinationDomain: number | null;
    observedSourceDomains: number[];
    observedDestinationDomains: number[];
  }[];
  unresolvedReasons: string[];
}
export interface BridgeMatch {
  id: string;
  status:
    | "matched"
    | "unmatched-source"
    | "unmatched-destination"
    | "ambiguous"
    | "conflicting";
  identityKeys: string[];
  routes: BridgeRoute[];
  observationIds: string[];
  sourceIds: string[];
  destinationIds: string[];
  feeIds: string[];
  conflicts: string[];
  cctpRouteValidation?: CctpRouteValidation;
  amountReconciliation: BridgeAmountReconciliation;
  independentCredit: {
    status:
      | "unverified"
      | "observed-in-supplied-evidence"
      | "not-applicable-as-supplied";
    beneficiary?: Address;
    evidence: BridgeProvenance[];
  };
  warnings: string[];
}
export interface BridgeAnalysis {
  version: 1;
  mode: ReplayMode;
  matches: BridgeMatch[];
  coverage: BridgeCoverage[];
  completeHistory: false;
  warnings: string[];
}
export class BridgeEvidenceError extends Error {
  code = "INVALID_BRIDGE_EVIDENCE";
  retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "BridgeEvidenceError";
  }
}

const fail = (message: string): never => {
  throw new BridgeEvidenceError(message);
};
// Circle's named-chain domain table, checked 2026-10-21. Only this app's common mainnets are registered.
// Protocol domains are distinct identifiers, not EVM chain IDs. Unknown routes remain unresolved.
const CCTP_DOMAINS: Readonly<Record<number, number>> = Object.freeze({
  1: 0,
  8453: 6,
  42161: 3,
});
const CCTP_DOMAINS_SOURCE =
  "https://developers.circle.com/cctp/concepts/supported-chains-and-domains";
function object(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(`${name} must be an object`);
  return input as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${name} must be a nonempty string of at most ${max} characters`);
  return value as string;
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
    fail(`${name} must be an integer from ${min} through ${max}`);
  return value as number;
}
function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail(`${name} must be an array of at most ${max} items`);
  return value as unknown[];
}
function oneOf<const T extends string>(
  value: unknown,
  choices: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    fail(`Invalid ${name}`);
  return value as T;
}
function raw(value: unknown, name: string, positive = false): string {
  const s = text(value, name, 1000);
  if (!/^\d+$/.test(s) || (positive && BigInt(s) === 0n))
    fail(
      `${name} must be ${positive ? "a positive" : "an unsigned"} integer string`,
    );
  return BigInt(s).toString();
}
function hash(value: unknown, name: string): string {
  const s = text(value, name, 66);
  if (!/^0x[0-9a-f]{64}$/i.test(s)) fail(`Invalid ${name} hash`);
  return s.toLowerCase();
}
function timestamp(value: unknown, name: string): string {
  const s = text(value, name, 40),
    m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        s,
      );
  if (!m || !Number.isFinite(Date.parse(s)))
    fail(`${name} must be a valid ISO timestamp with timezone`);
  const [, year, month, day, hour, minute, second] = m!;
  const y = Number(year),
    mo = Number(month),
    d = Number(day),
    leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > days[mo - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    fail(`${name} must be a valid calendar timestamp`);
  return new Date(s).toISOString();
}
function provenance(input: unknown, mode: ReplayMode): BridgeProvenance {
  const p = object(input, "provenance");
  if (
    typeof p.synthetic !== "boolean" ||
    p.synthetic !== (mode === "synthetic")
  )
    fail("Provenance synthetic flag must agree with replay mode");
  const result: BridgeProvenance = {
    source: text(p.source, "source", 300),
    retrievedAt: timestamp(p.retrievedAt, "retrievedAt"),
    synthetic: p.synthetic as boolean,
  };
  if (p.sourceUrl !== undefined) {
    const value = text(p.sourceUrl, "source URL", 2048);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail("Invalid source URL");
    }
    if (url!.protocol !== "https:" || url!.username || url!.password)
      fail("Source URLs must be HTTPS without credentials");
    result.sourceUrl = url!.toString();
  }
  return result;
}
function asset(input: unknown): Asset {
  const a = object(input, "asset");
  return {
    chainId: integer(a.chainId, "asset chain", 1),
    symbol: text(a.symbol, "asset symbol", 40),
    decimals: integer(a.decimals, "asset decimals", 0, 255),
    contract:
      a.contract === null ? null : normalizeAddress(a.contract as string),
  };
}
function message(input: unknown): BridgeMessage {
  const m = object(input, "message"),
    protocol = oneOf(
      m.protocol,
      ["cctp", "layerzero", "indexed"],
      "bridge protocol",
    );
  if (protocol === "layerzero")
    return { protocol, guid: hash(m.guid, "LayerZero GUID") };
  if (protocol === "indexed") {
    const namespace = text(m.namespace, "protocol namespace", 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace))
      fail("Invalid protocol namespace");
    let id = text(m.messageId, "message ID", 256);
    if (!/^[A-Za-z0-9:._/-]+$/.test(id)) fail("Invalid indexed message ID");
    if (/^0x[0-9a-f]+$/i.test(id)) id = id.toLowerCase();
    return { protocol, namespace, messageId: id };
  }
  const version = integer(m.version ?? 1, "CCTP message version", 1, 2) as
    1 | 2;
  const result: Extract<BridgeMessage, { protocol: "cctp" }> = {
    protocol,
    version,
  };
  if (m.messageHash !== undefined)
    result.messageHash = hash(m.messageHash, "CCTP message");
  const hasDomain =
    m.sourceDomain !== undefined || m.destinationDomain !== undefined;
  if (hasDomain) {
    result.sourceDomain = integer(
      m.sourceDomain,
      "source domain",
      0,
      0xffffffff,
    );
    result.destinationDomain = integer(
      m.destinationDomain,
      "destination domain",
      0,
      0xffffffff,
    );
    if (result.sourceDomain === result.destinationDomain)
      fail("CCTP route domains must differ");
  }
  if (m.nonce !== undefined) {
    if (!hasDomain) fail("A CCTP nonce requires both domains");
    if (version === 1) {
      result.nonce = raw(m.nonce, "CCTP nonce");
      if (BigInt(result.nonce) > 18446744073709551615n)
        fail("CCTP v1 nonce exceeds uint64");
    } else result.nonce = hash(m.nonce, "CCTP v2 nonce");
  }
  if (!result.messageHash && result.nonce === undefined)
    fail("CCTP evidence needs domains plus nonce or a message hash");
  return result;
}
function route(input: unknown): BridgeRoute {
  const r = object(input, "route"),
    result = {
      sourceChainId: integer(r.sourceChainId, "source chain", 1),
      destinationChainId: integer(r.destinationChainId, "destination chain", 1),
    };
  if (result.sourceChainId === result.destinationChainId)
    fail("Bridge route chains must differ");
  return result;
}
function observation(input: unknown, mode: ReplayMode): BridgeObservation {
  const o = object(input, "bridge observation"),
    role = oneOf(o.role, ["source", "destination", "fee"], "observation role");
  const result: BridgeObservation = {
    id: text(o.id, "observation ID"),
    role,
    chainId: integer(o.chainId, "observation chain", 1),
    txHash: hash(o.txHash, "transaction"),
    logIndex: integer(o.logIndex, "log index"),
    blockNumber: integer(o.blockNumber, "block number"),
    timestamp: timestamp(o.timestamp, "observation timestamp"),
    rawAmount: raw(o.rawAmount, "raw amount"),
    asset: asset(o.asset),
    route: route(o.route),
    message: message(o.message),
    provenance: provenance(o.provenance, mode),
  };
  if (result.asset.chainId !== result.chainId)
    fail("Observation and asset chain must agree");
  if (role === "fee")
    result.feeSide = oneOf(o.feeSide, ["source", "destination"], "fee side");
  const side = role === "fee" ? result.feeSide : role;
  if (
    result.chainId !==
    (side === "source"
      ? result.route.sourceChainId
      : result.route.destinationChainId)
  )
    fail("Observation chain disagrees with its role and declared route");
  if (o.sender !== undefined)
    result.sender = normalizeAddress(o.sender as string);
  if (o.recipient !== undefined)
    result.recipient = normalizeAddress(o.recipient as string);
  if (o.recipientScope !== undefined)
    result.recipientScope = oneOf(
      o.recipientScope,
      ["end-recipient", "pooled-service", "unknown"],
      "recipient scope",
    );
  if (o.independentCredit !== undefined) {
    if (role !== "destination")
      fail("Independent credit evidence belongs to a destination observation");
    const c = object(o.independentCredit, "independent credit"),
      status = oneOf(
        c.status,
        ["observed", "unverified", "not-applicable"],
        "independent credit status",
      ),
      evidence = array(c.evidence, "credit evidence", 50).map((x) =>
        provenance(x, mode),
      );
    if (
      status === "observed" &&
      (evidence.length === 0 || c.beneficiary === undefined)
    )
      fail(
        "Observed independent credit requires a beneficiary and separate source evidence",
      );
    result.independentCredit = {
      status,
      evidence,
      ...(c.beneficiary !== undefined
        ? { beneficiary: normalizeAddress(c.beneficiary as string) }
        : {}),
    };
  }
  return result;
}
function coverage(input: unknown, mode: ReplayMode): BridgeCoverage {
  const c = object(input, "bridge coverage"),
    status = oneOf(
      c.status,
      ["partial", "supplied-scope-exhausted", "unavailable", "error"],
      "bridge coverage status",
    );
  const result: BridgeCoverage = {
    id: text(c.id, "coverage ID"),
    chainId: integer(c.chainId, "coverage chain", 1),
    protocol: text(c.protocol, "coverage protocol", 100),
    stream: oneOf(
      c.stream,
      ["source", "destination", "fee", "independent-credit"],
      "coverage stream",
    ),
    status,
    blockFrom:
      c.blockFrom === null
        ? null
        : integer(c.blockFrom, "coverage start block"),
    blockTo:
      c.blockTo === null ? null : integer(c.blockTo, "coverage end block"),
    warnings: array(c.warnings, "coverage warnings", 100).map((x) =>
      text(x, "coverage warning", 500),
    ),
    provenance: provenance(c.provenance, mode),
  };
  if (
    (result.blockFrom === null) !== (result.blockTo === null) ||
    (result.blockFrom !== null &&
      result.blockTo !== null &&
      result.blockFrom > result.blockTo)
  )
    fail("Coverage must have an ordered pair of block bounds or null bounds");
  if (
    status === "supplied-scope-exhausted" &&
    (result.blockFrom === null || result.blockTo === null)
  )
    fail("Exhausted supplied scope requires bounded block coverage");
  return result;
}
/** Strict local replay boundary. No RPC/explorer calls or claim authentication occur here. */
export function parseBridgeEvidence(
  input: unknown,
  mode: ReplayMode,
): BridgeEvidenceBundle {
  oneOf(mode, ["synthetic", "private"], "replay mode");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    fail("Bridge evidence must be serializable JSON");
  }
  if (!serialized || new TextEncoder().encode(serialized).length > 5_000_000)
    fail("Bridge evidence exceeds the 5 MB replay limit");
  const value = object(input, "bridge evidence");
  if (value.version !== 1) fail("Unsupported bridge evidence version");
  if (value.mode !== mode)
    fail("Bridge evidence mode does not match requested replay mode");
  const result: BridgeEvidenceBundle = {
    version: 1,
    mode,
    observations: array(value.observations, "bridge observations", 10000).map(
      (x) => observation(x, mode),
    ),
    assetMappings: array(value.assetMappings, "asset mappings", 500).map(
      (x) => {
        const m = object(x, "asset mapping");
        return {
          id: text(m.id, "mapping ID"),
          sourceAsset: asset(m.sourceAsset),
          destinationAsset: asset(m.destinationAsset),
          sourceUnits: raw(m.sourceUnits, "source units", true),
          destinationUnits: raw(m.destinationUnits, "destination units", true),
          provenance: provenance(m.provenance, mode),
        };
      },
    ),
    coverage: array(value.coverage, "bridge coverage", 2000).map((x) =>
      coverage(x, mode),
    ),
  };
  const ids = new Set<string>(),
    events = new Set<string>(),
    transactions = new Map<string, string>(),
    assetDecimals = new Map<string, number>();
  for (const o of result.observations) {
    if (ids.has(o.id)) fail("Duplicate bridge observation ID");
    ids.add(o.id);
    const event = `${o.chainId}:${o.txHash}:${o.logIndex}`;
    if (events.has(event)) fail("Duplicate bridge event identity");
    events.add(event);
    const transaction = `${o.chainId}:${o.txHash}`,
      facts = JSON.stringify([o.blockNumber, o.timestamp]);
    if (
      transactions.has(transaction) &&
      transactions.get(transaction) !== facts
    )
      fail("Conflicting bridge transaction facts in supplied evidence");
    transactions.set(transaction, facts);
  }
  for (const list of [result.assetMappings, result.coverage]) {
    const seen = new Set<string>();
    for (const row of list) {
      if (seen.has(row.id)) fail("Duplicate mapping or coverage ID");
      seen.add(row.id);
    }
  }
  for (const a of [
    ...result.observations.map((o) => o.asset),
    ...result.assetMappings.flatMap((m) => [m.sourceAsset, m.destinationAsset]),
  ]) {
    const key = assetKey(a);
    if (assetDecimals.has(key) && assetDecimals.get(key) !== a.decimals)
      fail("Conflicting decimals for bridge asset identity");
    assetDecimals.set(key, a.decimals);
  }
  return result;
}
function identityKeys(message: BridgeMessage): string[] {
  if (message.protocol === "layerzero")
    return [`layerzero:guid:${message.guid}`];
  if (message.protocol === "indexed")
    return [`indexed:${message.namespace}:${message.messageId}`];
  return [
    ...(message.nonce !== undefined
      ? [
          `cctp:v${message.version}:${message.sourceDomain}:${message.destinationDomain}:${message.nonce}`,
        ]
      : []),
    ...(message.messageHash ? [`cctp:hash:${message.messageHash}`] : []),
  ];
}
const assetIdentity = (a: Asset) => `${assetKey(a)}:${a.decimals}`;
function validateCctpRoutes(
  messages: Extract<BridgeMessage, { protocol: "cctp" }>[],
  routes: BridgeRoute[],
): { validation: CctpRouteValidation; conflicts: string[] } {
  const sourceDomains = [
    ...new Set(
      messages.flatMap((m) =>
        m.sourceDomain === undefined ? [] : [m.sourceDomain],
      ),
    ),
  ].sort((a, b) => a - b);
  const destinationDomains = [
    ...new Set(
      messages.flatMap((m) =>
        m.destinationDomain === undefined ? [] : [m.destinationDomain],
      ),
    ),
  ].sort((a, b) => a - b);
  const conflicts: string[] = [],
    unresolvedReasons: string[] = [];
  if (sourceDomains.length > 1 || destinationDomains.length > 1)
    conflicts.push("message-domain-mismatch");
  if (sourceDomains.length === 0)
    unresolvedReasons.push("CCTP source domain was not supplied.");
  if (destinationDomains.length === 0)
    unresolvedReasons.push("CCTP destination domain was not supplied.");
  const mappings = routes.map((route) => {
    const expectedSourceDomain = CCTP_DOMAINS[route.sourceChainId] ?? null,
      expectedDestinationDomain =
        CCTP_DOMAINS[route.destinationChainId] ?? null;
    if (expectedSourceDomain === null)
      unresolvedReasons.push(
        `Unknown CCTP domain mapping for source chain ${route.sourceChainId}.`,
      );
    else if (sourceDomains.some((domain) => domain !== expectedSourceDomain))
      conflicts.push("cctp-source-domain-chain-mismatch");
    if (expectedDestinationDomain === null)
      unresolvedReasons.push(
        `Unknown CCTP domain mapping for destination chain ${route.destinationChainId}.`,
      );
    else if (
      destinationDomains.some((domain) => domain !== expectedDestinationDomain)
    )
      conflicts.push("cctp-destination-domain-chain-mismatch");
    return {
      ...route,
      expectedSourceDomain,
      expectedDestinationDomain,
      observedSourceDomains: sourceDomains,
      observedDestinationDomains: destinationDomains,
    };
  });
  return {
    validation: {
      status: conflicts.length
        ? "conflicting"
        : unresolvedReasons.length
          ? "unresolved"
          : "known-mapping-consistent",
      sourceUrl: CCTP_DOMAINS_SOURCE,
      checkedAt: "2026-10-21",
      mappings,
      unresolvedReasons: [...new Set(unresolvedReasons)],
    },
    conflicts: [...new Set(conflicts)],
  };
}
function reconcile(
  sources: BridgeObservation[],
  destinations: BridgeObservation[],
  fees: BridgeObservation[],
  mappings: BridgeAssetMapping[],
  conflicts: string[],
): BridgeAmountReconciliation {
  if (sources.length !== 1 || destinations.length !== 1 || conflicts.length)
    return {
      status: "unavailable",
      reason:
        "Unique non-conflicting source and destination observations are required.",
    };
  const source = sources[0],
    destination = destinations[0],
    matches = mappings.filter(
      (m) =>
        assetIdentity(m.sourceAsset) === assetIdentity(source.asset) &&
        assetIdentity(m.destinationAsset) === assetIdentity(destination.asset),
    );
  if (matches.length !== 1)
    return {
      status: "unavailable",
      reason: matches.length
        ? "Multiple supplied asset mappings are ambiguous."
        : "No explicit mapping exists between these exact asset identities.",
    };
  const mapping = matches[0];
  let sourceFee = 0n,
    destinationFee = 0n;
  for (const fee of fees) {
    if (
      fee.feeSide === "source" &&
      assetIdentity(fee.asset) === assetIdentity(source.asset)
    )
      sourceFee += BigInt(fee.rawAmount);
    else if (
      fee.feeSide === "destination" &&
      assetIdentity(fee.asset) === assetIdentity(destination.asset)
    )
      destinationFee += BigInt(fee.rawAmount);
    else
      return {
        status: "unavailable",
        reason:
          "A supplied fee has no mapping to the exact source or destination asset.",
      };
  }
  const numerator =
    (BigInt(source.rawAmount) - sourceFee) * BigInt(mapping.destinationUnits) -
    (BigInt(destination.rawAmount) + destinationFee) *
      BigInt(mapping.sourceUnits);
  return {
    status: numerator === 0n ? "balanced" : "difference",
    mappingId: mapping.id,
    sourceRaw: source.rawAmount,
    destinationRaw: destination.rawAmount,
    sourceFeeRaw: sourceFee.toString(),
    destinationFeeRaw: destinationFee.toString(),
    differenceNumerator: numerator.toString(),
    denominator: mapping.sourceUnits,
  };
}
/** Deterministic exact-key joins. Matching never establishes independent credit or common ownership. */
export function matchBridgeEvidence(
  input: BridgeEvidenceBundle,
): BridgeAnalysis {
  const bundle = parseBridgeEvidence(input, input.mode),
    parent = bundle.observations.map((_, i) => i),
    byKey = new Map<string, number>();
  const find = (index: number): number => {
    let i = index;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  bundle.observations.forEach((o, index) => {
    for (const key of identityKeys(o.message)) {
      const previous = byKey.get(key);
      if (previous !== undefined) parent[find(index)] = find(previous);
      else byKey.set(key, index);
    }
  });
  const groups = new Map<number, BridgeObservation[]>();
  bundle.observations.forEach((o, i) => {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  });
  const matches: BridgeMatch[] = [...groups.values()].map((observations) => {
    const sources = observations.filter((o) => o.role === "source"),
      destinations = observations.filter((o) => o.role === "destination"),
      fees = observations.filter((o) => o.role === "fee");
    const routes = [
        ...new Map(
          observations.map((o) => [
            `${o.route.sourceChainId}:${o.route.destinationChainId}`,
            o.route,
          ]),
        ).values(),
      ],
      conflicts: string[] = [];
    if (routes.length !== 1) conflicts.push("route-mismatch");
    const cctp = observations
      .map((o) => o.message)
      .filter(
        (m): m is Extract<BridgeMessage, { protocol: "cctp" }> =>
          m.protocol === "cctp",
      );
    if (new Set(cctp.map((m) => m.version)).size > 1)
      conflicts.push("message-version-mismatch");
    if (new Set(cctp.map((m) => m.messageHash).filter(Boolean)).size > 1)
      conflicts.push("message-hash-mismatch");
    if (
      new Set(
        cctp
          .filter((m) => m.nonce !== undefined)
          .map((m) => `${m.sourceDomain}:${m.destinationDomain}:${m.nonce}`),
      ).size > 1
    )
      conflicts.push("message-domain-nonce-mismatch");
    const cctpRouting = cctp.length
      ? validateCctpRoutes(cctp, routes)
      : undefined;
    if (cctpRouting) conflicts.push(...cctpRouting.conflicts);
    if (sources.length === 0 && destinations.length === 0)
      conflicts.push("orphan-fee-observation");
    const status: BridgeMatch["status"] = conflicts.length
      ? "conflicting"
      : sources.length > 1 ||
          destinations.length > 1 ||
          (sources.length === 1 &&
            destinations.length === 1 &&
            cctpRouting?.validation.status === "unresolved")
        ? "ambiguous"
        : sources.length === 1 && destinations.length === 1
          ? "matched"
          : sources.length
            ? "unmatched-source"
            : "unmatched-destination";
    const destination = destinations.length === 1 ? destinations[0] : undefined,
      credit = destination?.independentCredit;
    const independentCredit: BridgeMatch["independentCredit"] = {
      status:
        credit?.status === "observed"
          ? "observed-in-supplied-evidence"
          : credit?.status === "not-applicable"
            ? "not-applicable-as-supplied"
            : "unverified",
      evidence: credit?.evidence ?? [],
      ...(credit?.beneficiary ? { beneficiary: credit.beneficiary } : {}),
    };
    const warnings = [
      "Protocol-indexed transport matching does not establish common ownership or legal attribution.",
      "No source claim in this replay has been independently fetched or authenticated.",
    ];
    if (independentCredit.status === "unverified")
      warnings.push(
        "Independent recipient/customer credit is unverified; a matched transport is not proof of credit.",
      );
    if (destination?.recipientScope === "pooled-service")
      warnings.push(
        "The destination is a supplied pooled-service classification; a transport receipt does not identify its customer.",
      );
    if (sources.length > 1 || destinations.length > 1)
      warnings.push(
        "Multiple endpoint observations share the supplied identity; no preferred endpoint was selected.",
      );
    if (cctpRouting?.validation.status === "unresolved")
      warnings.push(
        "CCTP route mapping is unresolved; an exact message key alone does not validate domain-to-chain attribution.",
        ...cctpRouting.validation.unresolvedReasons,
      );
    const keys = [
      ...new Set(observations.flatMap((o) => identityKeys(o.message))),
    ].sort();
    return {
      id: keys[0],
      status,
      identityKeys: keys,
      routes,
      observationIds: observations.map((o) => o.id),
      sourceIds: sources.map((o) => o.id),
      destinationIds: destinations.map((o) => o.id),
      feeIds: fees.map((o) => o.id),
      conflicts,
      ...(cctpRouting ? { cctpRouteValidation: cctpRouting.validation } : {}),
      amountReconciliation: reconcile(
        sources,
        destinations,
        fees,
        bundle.assetMappings,
        cctpRouting?.validation.status === "unresolved"
          ? [...conflicts, "unresolved-cctp-route"]
          : conflicts,
      ),
      independentCredit,
      warnings,
    };
  });
  return {
    version: 1,
    mode: bundle.mode,
    matches,
    coverage: bundle.coverage,
    completeHistory: false,
    warnings: [
      "Only supplied protocol observations and declared block scopes were replayed; complete bridge history is not established.",
      "Unmatched states remain unresolved. Equal amounts, symbols, or close timestamps are never a matching rule.",
      ...(bundle.coverage.some((c) => c.stream === "independent-credit")
        ? []
        : ["No independent-credit coverage stream was supplied."]),
    ],
  };
}
export function createSyntheticBridgeEvidence(): BridgeEvidenceBundle {
  const p: BridgeProvenance = {
    source: "Flowlens synthetic bridge fixture v1",
    retrievedAt: "2026-10-21T12:00:00.000Z",
    synthetic: true,
  };
  const sourceAsset: Asset = {
      chainId: 1,
      symbol: "DEMO",
      decimals: 6,
      contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    destinationAsset: Asset = {
      chainId: 8453,
      symbol: "DEMO",
      decimals: 6,
      contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
  const route = { sourceChainId: 1, destinationChainId: 8453 },
    message: BridgeMessage = {
      protocol: "cctp",
      version: 1,
      sourceDomain: 0,
      destinationDomain: 6,
      nonce: "9001",
    };
  const make = (
    id: string,
    role: BridgeObservation["role"],
    txDigit: string,
    rawAmount: string,
  ): BridgeObservation => ({
    id,
    role,
    chainId: role === "source" ? 1 : 8453,
    txHash: `0x${txDigit.repeat(64)}`,
    logIndex: 0,
    blockNumber: 100,
    timestamp: "2026-10-20T10:00:00.000Z",
    rawAmount,
    asset: role === "source" ? sourceAsset : destinationAsset,
    route,
    message,
    provenance: p,
    ...(role === "fee" ? { feeSide: "destination" as const } : {}),
  });
  const unresolved = make("unresolved-source", "source", "4", "200000000");
  unresolved.message = {
    protocol: "indexed",
    namespace: "demo-bridge",
    messageId: "unresolved-002",
  };
  return parseBridgeEvidence(
    {
      version: 1,
      mode: "synthetic",
      observations: [
        make("source", "source", "1", "1000000000000"),
        {
          ...make("destination", "destination", "2", "999999987020"),
          recipientScope: "pooled-service",
        },
        make("fee", "fee", "3", "12980"),
        unresolved,
      ],
      assetMappings: [
        {
          id: "synthetic-unit-map",
          sourceAsset,
          destinationAsset,
          sourceUnits: "1",
          destinationUnits: "1",
          provenance: p,
        },
      ],
      coverage: [
        {
          id: "synthetic-source-page",
          chainId: 1,
          protocol: "cctp",
          stream: "source",
          status: "partial",
          blockFrom: 0,
          blockTo: 100,
          warnings: [
            "Fictional local replay only; no bridge provider was queried.",
          ],
          provenance: p,
        },
      ],
    },
    "synthetic",
  );
}
