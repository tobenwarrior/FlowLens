import {
  aggregateFlows,
  assetKey,
  filterTransfers,
  nodeKey,
  normalizeAddress,
} from "./engine.ts";
import type {
  Address,
  AssetFlow,
  Coverage,
  Investigation,
  TraceFilter,
  Transfer,
  WalletNode,
} from "./types.ts";

export interface WalletFlowQuery {
  address: string;
  chainId?: number;
  filter?: TraceFilter;
  offset?: number;
  pageSize?: number;
}
export interface WalletTransferRow {
  transfer: Transfer;
  direction: "in" | "out" | "self";
  counterpartyKey: string;
  visible: boolean;
}
export interface WalletCounterparty {
  key: string;
  address: Address;
  chainId: number;
  node?: WalletNode;
  flows: AssetFlow[];
  transferIds: string[];
  transferCount: number;
  inflowCount: number;
  outflowCount: number;
  visible: boolean;
  visibility: "all" | "some" | "none";
}
export interface WalletFlowView {
  address: Address;
  chainId?: number;
  scope: "loaded-evidence";
  flows: AssetFlow[];
  counterparties: WalletCounterparty[];
  transfers: WalletTransferRow[];
  coverage: Coverage[];
  counts: {
    transfers: number;
    visibleTransfers: number;
    inflows: number;
    outflows: number;
  };
  page: {
    offset: number;
    pageSize: number;
    total: number;
    nextOffset: number | null;
    previousOffset: number | null;
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function bound(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function flows(transfers: Transfer[], address: Address): AssetFlow[] {
  return aggregateFlows(transfers, address).sort((a, b) =>
    compare(assetKey(a.asset), assetKey(b.asset)),
  );
}

/** Graph projection only: hidden evidence stays in the case and its loaded totals. */
export function visibleTransfers(
  investigation: Investigation,
  transfers: Transfer[] = investigation.transfers,
): Transfer[] {
  const hiddenNodes = new Set(investigation.hidden);
  const hiddenEvidence = new Set(investigation.hiddenTransfers ?? []);
  const root = normalizeAddress(investigation.root);
  return filterTransfers(transfers, root).filter(
    (transfer) =>
      !hiddenEvidence.has(transfer.id) &&
      [transfer.from, transfer.to].every(
        (address) =>
          normalizeAddress(address) === root ||
          !hiddenNodes.has(nodeKey(transfer.chainId, address)),
      ),
  );
}

/** A deterministic view over loaded evidence. This never requests or completes wallet history. */
export function walletFlows(
  investigation: Investigation,
  query: WalletFlowQuery,
): WalletFlowView {
  const address = normalizeAddress(query.address);
  const offset = bound(query.offset ?? 0, "Wallet-flow offset", 0, 20_000);
  const pageSize = bound(query.pageSize ?? 25, "Wallet-flow page size", 1, 100);
  if (investigation.transfers.length > 20_000)
    throw new Error("Wallet-flow evidence exceeds the 20000-transfer budget");
  if (query.chainId !== undefined)
    bound(query.chainId, "Wallet-flow chain ID", 1, Number.MAX_SAFE_INTEGER);
  if (
    query.chainId !== undefined &&
    query.filter?.chainId !== undefined &&
    query.chainId !== query.filter.chainId
  )
    throw new Error("Wallet-flow chain ID and filter chain ID must agree");
  const chainId = query.chainId ?? query.filter?.chainId;
  const filter = {
    ...query.filter,
    ...(chainId === undefined ? {} : { chainId }),
  };
  const matching = filterTransfers(investigation.transfers, address, filter)
    .filter(
      (transfer) =>
        normalizeAddress(transfer.from) === address ||
        normalizeAddress(transfer.to) === address,
    )
    .sort(
      (a, b) =>
        Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
        compare(a.id, b.id),
    );
  const visible = new Set(
    visibleTransfers(investigation, matching).map((transfer) => transfer.id),
  );
  const nodes = new Map(
    investigation.nodes.map((node) => [
      nodeKey(node.chainId, node.address),
      node,
    ]),
  );
  const grouped = new Map<
    string,
    { address: Address; chainId: number; rows: WalletTransferRow[] }
  >();
  const rows: WalletTransferRow[] = matching.map((transfer) => {
    const incoming = normalizeAddress(transfer.to) === address;
    const outgoing = normalizeAddress(transfer.from) === address;
    const counterparty = normalizeAddress(
      incoming ? transfer.from : transfer.to,
    );
    const key = nodeKey(transfer.chainId, counterparty);
    const row: WalletTransferRow = {
      transfer,
      direction: incoming && outgoing ? "self" : incoming ? "in" : "out",
      counterpartyKey: key,
      visible: visible.has(transfer.id),
    };
    if (!grouped.has(key))
      grouped.set(key, {
        address: counterparty,
        chainId: transfer.chainId,
        rows: [],
      });
    grouped.get(key)!.rows.push(row);
    return row;
  });
  const counterparties = [...grouped.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([key, group]): WalletCounterparty => {
      const visibleCount = group.rows.filter((row) => row.visible).length;
      const node = nodes.get(key);
      return {
        key,
        address: group.address,
        chainId: group.chainId,
        ...(node ? { node } : {}),
        flows: flows(
          group.rows.map((row) => row.transfer),
          address,
        ),
        transferIds: group.rows.map((row) => row.transfer.id),
        transferCount: group.rows.length,
        inflowCount: group.rows.filter((row) => row.direction !== "out").length,
        outflowCount: group.rows.filter((row) => row.direction !== "in").length,
        visible: visibleCount > 0,
        visibility:
          visibleCount === 0
            ? "none"
            : visibleCount === group.rows.length
              ? "all"
              : "some",
      };
    });
  return {
    address,
    ...(chainId === undefined ? {} : { chainId }),
    scope: "loaded-evidence",
    flows: flows(matching, address),
    counterparties,
    transfers: rows.slice(offset, offset + pageSize),
    coverage: investigation.coverage
      .filter(
        (coverage) =>
          normalizeAddress(coverage.address) === address &&
          (chainId === undefined || coverage.chainId === chainId),
      )
      .sort((a, b) => compare(a.key, b.key)),
    counts: {
      transfers: rows.length,
      visibleTransfers: visible.size,
      inflows: rows.filter((row) => row.direction !== "out").length,
      outflows: rows.filter((row) => row.direction !== "in").length,
    },
    page: {
      offset,
      pageSize,
      total: rows.length,
      nextOffset: offset + pageSize < rows.length ? offset + pageSize : null,
      previousOffset: offset > 0 ? Math.max(0, offset - pageSize) : null,
    },
  };
}
