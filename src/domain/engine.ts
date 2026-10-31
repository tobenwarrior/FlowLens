import { parseProtocolEvidence } from "./protocols.ts";
import type {
  Address,
  Asset,
  AssetFlow,
  Coverage,
  ExpansionBudget,
  FlowEdge,
  Investigation,
  Label,
  TraceFilter,
  TraceProvider,
  TraceQuery,
  Transfer,
  TransferKind,
  WalletNode,
} from "./types.ts";
import { isCredentialParameterName } from "./source-url.ts";

const MAX_SNAPSHOT_BYTES = 5_000_000;
const KINDS: TransferKind[] = ["native", "erc20", "internal"];
const MAX_TRANSFERS = 20_000;
/** Maximum number of retained nodes in one investigation snapshot. */
export const MAX_RETAINED_NODES = 2_000;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 1024): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`${name} must be a string of at most ${max} characters`);
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
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      result,
    );
  if (!parts || !Number.isFinite(Date.parse(result)))
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    parts;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1] ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  )
    throw new Error(`${name} must be a valid ISO timestamp`);
  return new Date(result).toISOString();
}
function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${name} must be an array of at most ${max} items`);
  return value;
}
function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`Invalid ${name}`);
  return value as T;
}
function rawInteger(value: unknown, signed = false): string {
  const result = text(value, "raw amount", 1000);
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(result))
    throw new Error("Raw amount must be an integer string");
  return result;
}

export function normalizeAddress(value: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.trim()))
    throw new Error("Address must contain 40 hexadecimal characters after 0x");
  return value.trim().toLowerCase() as Address;
}
export function nodeKey(chainId: number, address: string): string {
  return `${integer(chainId, "chain ID", 1)}:${normalizeAddress(address)}`;
}
export function assetKey(asset: Asset): string {
  return `${integer(asset.chainId, "asset chain ID", 1)}:${asset.contract === null ? "native" : normalizeAddress(asset.contract)}`;
}
export function transferId(transfer: Transfer): string {
  return `${transfer.chainId}:${transfer.hash.toLowerCase()}:${transfer.kind}:${transfer.eventIndex}:${transfer.asset.contract?.toLowerCase() ?? "native"}`;
}
function parseAsset(input: unknown): Asset {
  const a = object(input, "asset");
  return {
    chainId: integer(a.chainId, "asset chain ID", 1),
    symbol: text(a.symbol, "asset symbol", 40),
    decimals: integer(a.decimals, "asset decimals", 0, 255),
    contract:
      a.contract === null ? null : normalizeAddress(a.contract as string),
  };
}
export function parseLabel(input: unknown): Label {
  const l = object(input, "label");
  const result: Label = {
    text: text(l.text, "label text", 200),
    source: text(l.source, "label source", 200),
    kind: oneOf(
      l.kind,
      ["service", "entity", "prediction", "user", "demo", "ai"],
      "label kind",
    ),
    confidence: oneOf(
      l.confidence,
      ["verified", "reported", "unverified", "synthetic"],
      "label confidence",
    ),
    retrievedAt: timestamp(l.retrievedAt, "label retrieval date"),
  };
  if (l.sourceUrl !== undefined) {
    const url = text(l.sourceUrl, "label URL", 2048);
    if (!/^https:\/\//.test(url)) throw new Error("Label URL must use HTTPS");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid label URL");
    }
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    if (
      parsed.username ||
      parsed.password ||
      [...parsed.searchParams.keys(), ...fragment.keys()].some((key) =>
        isCredentialParameterName(key),
      )
    )
      throw new Error("Label URL must not contain credentials");
    result.sourceUrl = url;
  }
  if (l.claimType !== undefined)
    result.claimType = oneOf<NonNullable<Label["claimType"]>>(
      l.claimType,
      ["provider-assertion", "hypothesis", "verified-evidence"],
      "label claim type",
    );
  if (l.observedAt !== undefined)
    result.observedAt = timestamp(l.observedAt, "label observation date");
  if (l.evidenceNote !== undefined)
    result.evidenceNote = text(l.evidenceNote, "label evidence note", 4000);
  if (result.claimType === "verified-evidence" && !result.evidenceNote?.trim())
    throw new Error(
      "Verified-evidence labels require an evidence note; the claim is not independently authenticated",
    );
  // A model's attribution is a hypothesis. It may never present itself as established
  // ownership, however confident the generating agent sounded.
  if (
    result.kind === "ai" &&
    (result.confidence === "verified" ||
      result.claimType === "verified-evidence")
  )
    throw new Error(
      "AI-generated labels are hypotheses; they cannot claim verified confidence or verified evidence",
    );
  return result;
}
function parseNode(input: unknown): WalletNode {
  const n = object(input, "node");
  const result: WalletNode = {
    address: normalizeAddress(n.address as string),
    chainId: integer(n.chainId, "node chain ID", 1),
  };
  if (n.label !== undefined) result.label = parseLabel(n.label);
  if (n.category !== undefined)
    result.category = oneOf<NonNullable<WalletNode["category"]>>(
      n.category,
      ["wallet", "exchange", "bridge", "protocol"],
      "node category",
    );
  return result;
}
function parseTransfer(input: unknown): Transfer {
  const t = object(input, "transfer");
  const hash = text(t.hash, "transaction hash", 66).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash))
    throw new Error("Invalid transaction hash");
  const result: Transfer = {
    id: text(t.id, "evidence ID", 300),
    chainId: integer(t.chainId, "transfer chain ID", 1),
    hash,
    kind: oneOf(t.kind, KINDS, "transfer kind"),
    eventIndex: text(t.eventIndex, "event index", 100),
    from: normalizeAddress(t.from as string),
    to: normalizeAddress(t.to as string),
    asset: parseAsset(t.asset),
    rawAmount: rawInteger(t.rawAmount),
    timestamp: timestamp(t.timestamp, "transfer timestamp"),
    blockNumber: integer(t.blockNumber, "block number"),
    status: oneOf(t.status, ["success"], "transaction status"),
    source: text(t.source, "evidence source", 200),
    retrievedAt: timestamp(t.retrievedAt, "evidence retrieval date"),
  };
  if (!/^[\w.:-]+$/.test(result.eventIndex))
    throw new Error("Invalid event index");
  if (result.asset.chainId !== result.chainId)
    throw new Error("Transfer and asset chain IDs must agree");
  if ((result.kind === "erc20") !== (result.asset.contract !== null))
    throw new Error("Asset contract must match transfer kind");
  if (result.id !== transferId(result))
    throw new Error("Evidence ID does not match canonical transfer identity");
  if (t.synthetic !== undefined) {
    if (typeof t.synthetic !== "boolean")
      throw new Error("Invalid synthetic flag");
    result.synthetic = t.synthetic;
  }
  return result;
}
function strings(input: unknown, name: string, max = 1000): string[] {
  return list(input, name, max).map((v) => text(v, name, 4096));
}
function parseCoverage(input: unknown): Coverage {
  const c = object(input, "coverage");
  const result: Coverage = {
    key: text(c.key, "coverage key", 300),
    address: normalizeAddress(c.address as string),
    chainId: integer(c.chainId, "coverage chain ID", 1),
    provider: text(c.provider, "provider ID", 100),
    status: oneOf(
      c.status,
      ["partial", "exhausted", "error", "unsupported"],
      "coverage status",
    ),
    pagesLoaded: integer(c.pagesLoaded, "pages loaded", 0, 1_000_000),
    cursor: c.cursor === null ? null : text(c.cursor, "cursor", 4096),
    warnings: strings(c.warnings, "warnings", 100),
    streams: list(c.streams, "streams", 3).map((v) =>
      oneOf(v, KINDS, "coverage stream"),
    ),
    updatedAt: timestamp(c.updatedAt, "coverage update date"),
  };
  if (c.error !== undefined)
    result.error = text(c.error, "coverage error", 500);
  if (c.errorCode !== undefined) {
    const code = text(c.errorCode, "coverage error code", 64);
    if (!ERROR_CODE.test(code)) throw new Error("Invalid coverage error code");
    result.errorCode = code;
  }
  if (c.retryable !== undefined) {
    if (typeof c.retryable !== "boolean")
      throw new Error("Coverage retryable must be a boolean");
    result.retryable = c.retryable;
  }
  if (
    result.key !==
    `${result.provider}:${nodeKey(result.chainId, result.address)}`
  )
    throw new Error("Invalid coverage key");
  if (result.status === "exhausted" && result.cursor !== null)
    throw new Error("Exhausted coverage cannot have a cursor");
  return result;
}

/** Strict snapshot boundary; rebuilds known fields so imported secrets/unknown properties are not retained. */
export function parseInvestigation(input: unknown): Investigation {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("Investigation must be serializable JSON");
  }
  if (
    !serialized ||
    new TextEncoder().encode(serialized).length > MAX_SNAPSHOT_BYTES
  )
    throw new Error("Investigation exceeds the 5 MB import limit");
  const c = object(input, "investigation");
  if (c.version !== 1) throw new Error("Unsupported investigation version");
  const result: Investigation = {
    version: 1,
    id: text(c.id, "case ID", 100),
    title: text(c.title, "title", 200),
    root: normalizeAddress(c.root as string),
    mode: oneOf(c.mode, ["demo", "live"], "investigation mode"),
    createdAt: timestamp(c.createdAt, "creation date"),
    updatedAt: timestamp(c.updatedAt, "update date"),
    transfers: list(c.transfers, "transfers", MAX_TRANSFERS).map(parseTransfer),
    nodes: list(c.nodes, "nodes", MAX_RETAINED_NODES).map(parseNode),
    coverage: list(c.coverage, "coverage", 2000).map(parseCoverage),
    expanded: strings(c.expanded, "expanded nodes"),
    pinned: strings(c.pinned, "pinned nodes"),
    hidden: strings(c.hidden, "hidden nodes"),
    notes: text(c.notes, "notes", 100_000),
  };
  if (c.hiddenTransfers !== undefined) {
    result.hiddenTransfers = strings(
      c.hiddenTransfers,
      "hidden transfers",
      MAX_TRANSFERS,
    );
    if (new Set(result.hiddenTransfers).size !== result.hiddenTransfers.length)
      throw new Error("Duplicate hidden transfer IDs");
    const known = new Set(result.transfers.map((t) => t.id));
    if (result.hiddenTransfers.some((id) => !known.has(id)))
      throw new Error("Hidden transfer must refer to loaded evidence");
  }
  if (c.protocolEvidence !== undefined)
    result.protocolEvidence = parseProtocolEvidence(
      c.protocolEvidence,
      result.mode === "demo" ? "synthetic" : "private",
    );
  if (result.mode === "live" && result.transfers.some((t) => t.synthetic))
    throw new Error("Synthetic evidence cannot enter a live investigation");
  if (
    result.mode === "live" &&
    result.nodes.some(
      (node) =>
        node.label?.confidence === "synthetic" || node.label?.kind === "demo",
    )
  )
    throw new Error(
      "Synthetic or demo labels cannot enter a live investigation",
    );
  if (
    new Set(result.transfers.map((t) => t.id)).size !== result.transfers.length
  )
    throw new Error("Duplicate evidence IDs in snapshot");
  if (
    result.mode === "demo" &&
    result.transfers.some((t) => t.synthetic !== true)
  )
    throw new Error(
      "Demo investigations require explicitly synthetic transfers",
    );
  uniqueTransfers(result.transfers);
  if (
    new Set(result.nodes.map((n) => nodeKey(n.chainId, n.address))).size !==
    result.nodes.length
  )
    throw new Error("Duplicate nodes in snapshot");
  if (
    new Set(result.coverage.map((c) => c.key)).size !== result.coverage.length
  )
    throw new Error("Duplicate coverage records in snapshot");
  for (const key of [...result.expanded, ...result.pinned, ...result.hidden])
    if (!/^\d+:0x[0-9a-f]{40}$/.test(key))
      throw new Error("Invalid saved node key");
  return result;
}

export function formatUnits(
  raw: string,
  decimals: number,
  maxFraction = decimals,
): string {
  rawInteger(raw, true);
  integer(decimals, "decimals", 0, 255);
  integer(maxFraction, "maximum fraction", 0, 255);
  const value = BigInt(raw),
    negative = value < 0n,
    absolute = (negative ? -value : value)
      .toString()
      .padStart(decimals + 1, "0");
  const whole = decimals ? absolute.slice(0, -decimals) : absolute;
  const fraction = decimals
    ? absolute.slice(-decimals).slice(0, maxFraction).replace(/0+$/, "")
    : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
function evidenceFingerprint(t: Transfer): string {
  return JSON.stringify([
    t.chainId,
    t.hash.toLowerCase(),
    t.kind,
    t.eventIndex,
    normalizeAddress(t.from),
    normalizeAddress(t.to),
    assetKey(t.asset),
    t.asset.decimals,
    BigInt(rawInteger(t.rawAmount)).toString(),
    Date.parse(t.timestamp),
    t.blockNumber,
    t.status,
  ]);
}
function uniqueTransfers(transfers: Transfer[]): Transfer[] {
  const unique = new Map<string, Transfer>(),
    decimals = new Map<string, number>();
  for (const transfer of transfers) {
    const asset = assetKey(transfer.asset),
      id = transferId(transfer),
      old = unique.get(id);
    if (decimals.has(asset) && decimals.get(asset) !== transfer.asset.decimals)
      throw new Error(`Conflicting decimals for asset ${asset}`);
    decimals.set(asset, transfer.asset.decimals);
    if (old && evidenceFingerprint(old) !== evidenceFingerprint(transfer))
      throw new Error(
        `Conflicting evidence for ID ${id}; existing evidence retained`,
      );
    if (!old) unique.set(id, transfer);
  }
  return [...unique.values()];
}
function dateBoundary(
  value: string | undefined,
  end: boolean,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) throw new Error("Invalid filter date");
  return parsed;
}
/** Direction is relative to the investigation root; expanded paths remain visible with direction=all. */
export function filterTransfers(
  transfers: Transfer[],
  root: Address,
  filter: TraceFilter = {},
): Transfer[] {
  const address = normalizeAddress(root),
    from = dateBoundary(filter.from, false),
    to = dateBoundary(filter.to, true);
  if (filter.chainId !== undefined)
    integer(filter.chainId, "filter chain ID", 1);
  if (filter.direction !== undefined)
    oneOf(filter.direction, ["all", "in", "out"], "filter direction");
  if (from !== undefined && to !== undefined && from > to)
    throw new Error("Filter start date must not exceed end date");
  return uniqueTransfers(transfers).filter((t) => {
    if (filter.chainId !== undefined && t.chainId !== filter.chainId)
      return false;
    if (
      filter.asset &&
      filter.asset !== "all" &&
      filter.asset !== assetKey(t.asset) &&
      filter.asset.toLowerCase() !== t.asset.symbol.toLowerCase()
    )
      return false;
    if (filter.direction === "in" && normalizeAddress(t.to) !== address)
      return false;
    if (filter.direction === "out" && normalizeAddress(t.from) !== address)
      return false;
    const time = Date.parse(t.timestamp);
    return (
      (from === undefined || time >= from) && (to === undefined || time <= to)
    );
  });
}
export function buildEdges(transfers: Transfer[]): FlowEdge[] {
  const edges = new Map<string, FlowEdge>();
  for (const t of uniqueTransfers(transfers)) {
    const from = normalizeAddress(t.from),
      to = normalizeAddress(t.to),
      id = `${t.chainId}:${from}:${to}`;
    if (!edges.has(id))
      edges.set(id, { id, from, to, chainId: t.chainId, transfers: [] });
    edges.get(id)!.transfers.push(t);
  }
  return [...edges.values()];
}
export function aggregateFlows(
  transfers: Transfer[],
  root: Address,
): AssetFlow[] {
  const address = normalizeAddress(root),
    flows = new Map<
      string,
      { asset: Asset; inflow: bigint; outflow: bigint }
    >();
  for (const t of uniqueTransfers(transfers)) {
    const incoming = normalizeAddress(t.to) === address,
      outgoing = normalizeAddress(t.from) === address;
    if (!incoming && !outgoing) continue;
    const key = assetKey(t.asset);
    if (!flows.has(key))
      flows.set(key, { asset: t.asset, inflow: 0n, outflow: 0n });
    const flow = flows.get(key)!,
      amount = BigInt(rawInteger(t.rawAmount));
    if (incoming) flow.inflow += amount;
    if (outgoing) flow.outflow += amount;
  }
  return [...flows.values()].map((f) => ({
    asset: f.asset,
    inflow: f.inflow.toString(),
    outflow: f.outflow.toString(),
    net: (f.inflow - f.outflow).toString(),
  }));
}
export function createInvestigation(
  root: Address,
  mode: "demo" | "live",
  title = "Untitled investigation",
): Investigation {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: crypto.randomUUID(),
    title: text(title, "title", 200),
    root: normalizeAddress(root),
    mode: oneOf(mode, ["demo", "live"], "mode"),
    createdAt: now,
    updatedAt: now,
    transfers: [],
    nodes: [],
    coverage: [],
    expanded: [],
    pinned: [],
    hidden: [],
    notes: "",
  };
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Provider request failed")
    .replace(/((?:api[_-]?key|token|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

/** No recursive crawling: requests only the named address, at most 10 pages, with atomic page commits. */
export async function expandInvestigation(
  investigation: Investigation,
  provider: TraceProvider,
  query: TraceQuery,
  budget: ExpansionBudget = { maxPages: 1, maxNodes: MAX_RETAINED_NODES },
): Promise<Investigation> {
  const maxPages = integer(budget.maxPages, "page budget", 1, 10),
    maxNodes = integer(budget.maxNodes, "node budget", 1, MAX_RETAINED_NODES);
  if (investigation.mode !== provider.mode)
    throw new Error("Provider mode must match investigation mode");
  const address = normalizeAddress(query.address),
    chainId = integer(query.chainId, "chain ID", 1),
    pageSize = integer(query.pageSize ?? 12, "page size", 1, 100);
  if (query.cursor !== undefined && query.cursor !== null)
    text(query.cursor, "cursor", 4096);
  const result = parseInvestigation(investigation),
    key = `${text(provider.id, "provider ID", 100)}:${nodeKey(chainId, address)}`;
  const previous = result.coverage.find((c) => c.key === key);
  if (previous?.status === "exhausted" && query.cursor === undefined)
    return result;
  const coverage: Coverage = previous
    ? {
        ...previous,
        warnings: [...previous.warnings],
        streams: [...previous.streams],
      }
    : {
        key,
        address,
        chainId,
        provider: provider.id,
        status: "partial",
        pagesLoaded: 0,
        cursor: null,
        warnings: [],
        streams: [],
        updatedAt: new Date().toISOString(),
      };
  let cursor = query.cursor === undefined ? coverage.cursor : query.cursor;
  const cursors = new Set<string | null>();
  for (let page = 0; page < maxPages; page++) {
    try {
      if (cursors.has(cursor))
        throw new Error(
          "Provider repeated a pagination cursor; expansion stopped",
        );
      cursors.add(cursor);
      const response = await provider.fetchPage({
        address,
        chainId,
        cursor,
        pageSize,
      });
      if (response.cursor !== null)
        text(response.cursor, "provider cursor", 4096);
      if (
        typeof response.exhausted !== "boolean" ||
        (response.exhausted && response.cursor !== null) ||
        (!response.exhausted && response.cursor === null)
      )
        throw new Error("Provider returned inconsistent pagination state");
      if (response.cursor !== null && response.cursor === cursor)
        throw new Error(
          "Provider repeated a pagination cursor; page was not committed",
        );
      const incoming = list(response.transfers, "provider transfers", 1000)
        .map(parseTransfer)
        .map((t) => (result.mode === "demo" ? { ...t, synthetic: true } : t));
      if (
        incoming.some(
          (t) => t.chainId !== chainId || ![t.from, t.to].includes(address),
        )
      )
        throw new Error("Provider returned unrelated transfer evidence");
      if (result.mode === "live" && incoming.some((t) => t.synthetic))
        throw new Error("Synthetic evidence cannot enter a live investigation");
      const incomingNodes = list(
        response.nodes,
        "provider nodes",
        MAX_RETAINED_NODES,
      ).map(parseNode);
      if (incomingNodes.some((n) => n.chainId !== chainId))
        throw new Error("Provider returned nodes on the wrong chain");
      const nodes = new Map(
        result.nodes.map((n) => [nodeKey(n.chainId, n.address), n]),
      );
      for (const node of [
        ...incomingNodes,
        { address, chainId },
        ...incoming.flatMap((t) => [
          { address: t.from, chainId: t.chainId },
          { address: t.to, chainId: t.chainId },
        ]),
      ]) {
        const id = nodeKey(node.chainId, node.address),
          old = nodes.get(id);
        nodes.set(
          id,
          old
            ? {
                ...node,
                ...old,
                ...(!old.label && "label" in node ? { label: node.label } : {}),
              }
            : node,
        );
      }
      if (nodes.size > maxNodes)
        throw new Error(
          `Node budget of ${maxNodes} would be exceeded; page was not committed`,
        );
      const transfers = uniqueTransfers([...result.transfers, ...incoming]);
      if (transfers.length > MAX_TRANSFERS)
        throw new Error(
          `Evidence budget of ${MAX_TRANSFERS} transfers would be exceeded`,
        );
      const streams = list(response.streams, "provider streams", 3).map((v) =>
        oneOf(v, KINDS, "provider stream"),
      );
      const warnings = strings(response.warnings, "provider warnings", 100);
      for (const missing of KINDS.filter((k) => !streams.includes(k)))
        warnings.push(
          `${missing} transfers are not covered by this provider page.`,
        );
      // Only now commit: a rejected page leaves evidence and its previous cursor intact.
      result.nodes = [...nodes.values()];
      result.transfers = transfers;
      coverage.cursor = response.cursor;
      coverage.pagesLoaded++;
      coverage.status = response.exhausted ? "exhausted" : "partial";
      coverage.streams = [...new Set([...coverage.streams, ...streams])];
      coverage.warnings = [...new Set([...coverage.warnings, ...warnings])];
      delete coverage.error;
      delete coverage.errorCode;
      delete coverage.retryable;
      cursor = response.cursor;
      if (response.exhausted) break;
    } catch (error) {
      coverage.status = "error";
      coverage.error = safeError(error);
      const failure =
        error && typeof error === "object"
          ? (error as { code?: unknown; retryable?: unknown })
          : undefined;
      coverage.errorCode =
        typeof failure?.code === "string" && ERROR_CODE.test(failure.code)
          ? failure.code
          : "EXPANSION_FAILED";
      coverage.retryable = failure?.retryable === true;
      break;
    }
  }
  coverage.updatedAt = new Date().toISOString();
  result.updatedAt = coverage.updatedAt;
  result.coverage = [...result.coverage.filter((c) => c.key !== key), coverage];
  if (
    coverage.pagesLoaded > 0 &&
    !result.expanded.includes(nodeKey(chainId, address))
  )
    result.expanded.push(nodeKey(chainId, address));
  return result;
}
