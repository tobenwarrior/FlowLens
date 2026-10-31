import { nodeKey, normalizeAddress } from "./engine.ts";
import type { Investigation, Transfer, WalletNode } from "./types.ts";

/** The human graph is a readable projection; retained evidence has a larger bound. */
export const GRAPH_NODE_LIMIT = 80;

export interface GraphProjectionOptions {
  /** A selected counterparty is shown before pinned and activity-ranked nodes. */
  selected?: string;
  /** Preserve the graph's category grouping as a final, deterministic tie-break. */
  grouped?: boolean;
}

export interface GraphProjection {
  /** Counterparties shown around the focus wallet, in render order. */
  nodes: WalletNode[];
  /** Transfers whose endpoints are the focus wallet or a displayed counterparty. */
  transfers: Transfer[];
  totalCounterparties: number;
  omittedCounterparties: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the bounded human graph without changing the retained investigation.
 *
 * Selection and pins are presentation state. They affect only this projection; the
 * full node/evidence arrays remain available to history tables, totals and exports.
 */
export function projectGraph(
  investigation: Investigation,
  transfers: Transfer[] = investigation.transfers,
  options: GraphProjectionOptions = {},
): GraphProjection {
  const root = normalizeAddress(investigation.root);
  const hiddenNodes = new Set(investigation.hidden);
  const hiddenTransfers = new Set(investigation.hiddenTransfers ?? []);
  const eligibleTransfers = transfers.filter((transfer) => {
    if (hiddenTransfers.has(transfer.id)) return false;
    return [transfer.from, transfer.to].every((address) => {
      const normalized = normalizeAddress(address);
      return (
        normalized === root ||
        !hiddenNodes.has(nodeKey(transfer.chainId, normalized))
      );
    });
  });
  const activity = new Map<string, Set<string>>();
  for (const transfer of eligibleTransfers) {
    for (const address of [transfer.from, transfer.to]) {
      const normalized = normalizeAddress(address);
      if (normalized === root) continue;
      const key = nodeKey(transfer.chainId, normalized);
      if (!activity.has(key)) activity.set(key, new Set());
      activity.get(key)!.add(transfer.id);
    }
  }
  const pinned = new Set(investigation.pinned);
  const selected = options.selected?.toLowerCase();
  const candidates = investigation.nodes
    .filter((node) => {
      const key = nodeKey(node.chainId, node.address);
      return (
        normalizeAddress(node.address) !== root &&
        !hiddenNodes.has(key) &&
        activity.has(key)
      );
    })
    .map((node) => {
      const key = nodeKey(node.chainId, node.address);
      return {
        node,
        key,
        activity: activity.get(key)!.size,
        selected: selected === key,
        pinned: pinned.has(key),
      };
    })
    .sort((a, b) => {
      return (
        Number(b.selected) - Number(a.selected) ||
        Number(b.pinned) - Number(a.pinned) ||
        b.activity - a.activity ||
        (options.grouped
          ? compare(a.node.category ?? "", b.node.category ?? "")
          : 0) ||
        compare(a.key, b.key)
      );
    });
  const nodes = candidates.slice(0, GRAPH_NODE_LIMIT).map(({ node }) => node);
  const displayed = new Set(
    nodes.map((node) => nodeKey(node.chainId, node.address)),
  );
  const endpointIsDisplayed = (transfer: Transfer, address: AddressLike) => {
    const normalized = normalizeAddress(address);
    return (
      normalized === root ||
      displayed.has(nodeKey(transfer.chainId, normalized))
    );
  };
  const projectedTransfers = eligibleTransfers
    .filter(
      (transfer) =>
        endpointIsDisplayed(transfer, transfer.from) &&
        endpointIsDisplayed(transfer, transfer.to),
    )
    .slice()
    .sort(
      (a, b) =>
        compare(a.id, b.id) ||
        compare(a.timestamp, b.timestamp) ||
        compare(a.eventIndex, b.eventIndex),
    );
  return {
    nodes,
    transfers: projectedTransfers,
    totalCounterparties: candidates.length,
    omittedCounterparties: Math.max(0, candidates.length - nodes.length),
  };
}

type AddressLike = `0x${string}`;
