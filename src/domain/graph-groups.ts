import type { Transfer } from "./types.ts";

/**
 * Investigation diagrams keep a busy wallet readable by drawing its few biggest
 * counterparties and boxing the rest: "funds split across 31 addresses", one arrow.
 * This decides which counterparties share a box. Nothing is hidden: every member is
 * still drawn, just without a line of its own.
 *
 * Pure and deterministic. Keys are opaque, as in graph-layout.
 */

/** Full nodes kept per wallet and direction before the rest are grouped. */
export const GROUP_KEEP = 5;

export interface KeyedLink {
  from: string;
  to: string;
  transfers: Transfer[];
}

export interface CounterpartyGroup {
  /** Layout key: `group:<anchor>:<direction>:<chainId>`, internal to the graph. */
  key: string;
  /** The one wallet every member trades with. */
  anchor: string;
  /** "in": the members pay the anchor. "out": the anchor pays them. */
  direction: "in" | "out";
  /** All transfers in this group are on this chain. */
  chainId: number;
  /** Member keys, biggest first. */
  members: string[];
  /** Every link between a member and the anchor. */
  links: KeyedLink[];
}

export function groupCounterparties(
  root: string,
  links: KeyedLink[],
  options: {
    /** How much a set of transfers moved, for ranking: USD, or a count without prices. */
    value: (transfers: Transfer[]) => number;
    /** Wallets that always keep their own line: pinned, selected or labelled. */
    keep?: Iterable<string>;
    limit?: number;
  },
): { groups: CounterpartyGroup[]; grouped: Set<string> } {
  const keep = new Set(options.keep ?? []);
  const limit = options.limit ?? GROUP_KEEP;
  const neighbours = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const { from, to } of links)
    if (from !== to) {
      touch(from, to);
      touch(to, from);
    }

  // A leaf trades with exactly one other wallet. Anything linking two wallets is a
  // lead in its own right and keeps its line.
  const buckets = new Map<
    string,
    {
      anchor: string;
      direction: "in" | "out";
      chainId: number;
      members: string[];
    }
  >();
  const between = (leaf: string, anchor: string) =>
    links.filter(
      (link) =>
        (link.from === leaf && link.to === anchor) ||
        (link.from === anchor && link.to === leaf),
    );
  for (const [key, around] of neighbours) {
    if (key === root || around.size !== 1) continue;
    const [anchor] = around;
    const shared = between(key, anchor);
    const chains = new Set(
      shared.flatMap((link) =>
        link.transfers.map((transfer) => transfer.chainId),
      ),
    );
    // A malformed or future mixed-chain leaf cannot be assigned safely to one box.
    if (chains.size !== 1) continue;
    const [chainId] = chains;
    const sent = shared
      .filter((link) => link.from === key)
      .reduce((sum, link) => sum + link.transfers.length, 0);
    const received = shared
      .filter((link) => link.to === key)
      .reduce((sum, link) => sum + link.transfers.length, 0);
    const direction = sent >= received ? "in" : "out";
    const id = `group:${anchor}:${direction}:${chainId}`;
    if (!buckets.has(id))
      buckets.set(id, { anchor, direction, chainId, members: [] });
    buckets.get(id)!.members.push(key);
  }

  const groups: CounterpartyGroup[] = [];
  for (const [key, { anchor, direction, chainId, members }] of buckets) {
    const moved = new Map(
      members.map((member) => {
        const transfers = between(member, anchor).flatMap(
          (link) => link.transfers,
        );
        return [
          member,
          { value: options.value(transfers), count: transfers.length },
        ];
      }),
    );
    const ranked = members
      .filter((member) => !keep.has(member))
      .sort(
        (a, b) =>
          moved.get(b)!.value - moved.get(a)!.value ||
          moved.get(b)!.count - moved.get(a)!.count ||
          (a < b ? -1 : a > b ? 1 : 0),
      );
    const rest = ranked.slice(limit);
    // One leftover wallet is clearer drawn than boxed on its own.
    if (rest.length < 2) continue;
    groups.push({
      key,
      anchor,
      direction,
      chainId,
      members: rest,
      links: rest.flatMap((member) => between(member, anchor)),
    });
  }
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    groups,
    grouped: new Set(groups.flatMap((group) => group.members)),
  };
}
