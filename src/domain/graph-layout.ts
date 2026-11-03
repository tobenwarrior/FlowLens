/**
 * Layered left-to-right layout for the funding graph, in the style of investigation
 * diagrams: every hop from the focus wallet gets its own column, senders to the left
 * and recipients to the right, and each column is ordered to keep lines from crossing.
 *
 * Pure and deterministic. Keys are opaque; the caller decides what a node is. The graph
 * is capped (GRAPH_NODE_LIMIT), so the quadratic passes here stay cheap.
 */

export const COLUMN_GAP = 260;
export const ROW_GAP = 120;

/** Transfers from one node to another, already summed by the caller. */
export interface FlowLink {
  from: string;
  to: string;
  transfers: number;
  /** Earliest transfer time; breaks ties between two directions of one pair. */
  firstAt: string;
}

export interface PlacedNode {
  /** Column relative to the focus wallet: negative before it, positive after it. */
  layer: number;
  x: number;
  y: number;
}

export interface FlowLayout {
  nodes: Map<string, PlacedNode>;
  /** Columns in use, ascending, relative to the focus wallet's column (0). */
  layers: number[];
  /** Links whose target sits in the same or an earlier column, drawn as arcs. */
  backward: Set<string>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export const linkKey = (from: string, to: string) => `${from}->${to}`;

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export function layoutFlow(
  root: string,
  keys: string[],
  links: FlowLink[],
  group?: (key: string) => string,
  /** The height a node needs in its column; ROW_GAP unless it is a taller box. */
  size: (key: string) => number = () => ROW_GAP,
): FlowLayout {
  const all = [root, ...keys.filter((key) => key !== root)];
  const rank = new Map(all.map((key, index) => [key, index]));
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;

  // One direction per pair: the side with more transfers, then the earlier one.
  const pairs = new Map<
    string,
    {
      a: string;
      b: string;
      ab: number;
      ba: number;
      abAt?: string;
      baAt?: string;
    }
  >();
  for (const link of links) {
    if (link.from === link.to || !rank.has(link.from) || !rank.has(link.to))
      continue;
    const [a, b] = [link.from, link.to].sort(byRank);
    const id = linkKey(a, b);
    const pair = pairs.get(id) ?? { a, b, ab: 0, ba: 0 };
    const forward = link.from === a;
    if (forward) {
      pair.ab += link.transfers;
      if (!pair.abAt || link.firstAt < pair.abAt) pair.abAt = link.firstAt;
    } else {
      pair.ba += link.transfers;
      if (!pair.baAt || link.firstAt < pair.baAt) pair.baAt = link.firstAt;
    }
    pairs.set(id, pair);
  }
  const succ = new Map(all.map((key) => [key, [] as string[]]));
  const neighbours = new Map(all.map((key) => [key, [] as string[]]));
  for (const { a, b, ab, ba, abAt, baAt } of pairs.values()) {
    const aFirst =
      ab !== ba ? ab > ba : !baAt || (abAt !== undefined && abAt <= baAt);
    if (aFirst) succ.get(a)!.push(b);
    else succ.get(b)!.push(a);
    neighbours.get(a)!.push(b);
    neighbours.get(b)!.push(a);
  }
  for (const list of succ.values()) list.sort(byRank);

  // Break cycles: a depth-first walk from the focus wallet drops links that close one.
  const dagSucc = new Map(all.map((key) => [key, [] as string[]]));
  const dagPred = new Map(all.map((key) => [key, [] as string[]]));
  const state = new Map<string, "open" | "done">();
  const visit = (node: string) => {
    state.set(node, "open");
    for (const next of succ.get(node)!) {
      const seen = state.get(next);
      if (seen === "open") continue;
      dagSucc.get(node)!.push(next);
      dagPred.get(next)!.push(node);
      if (!seen) visit(next);
    }
    state.set(node, "done");
  };
  for (const key of all) if (!state.has(key)) visit(key);

  // Longest-path columns, then pull each source next to its nearest recipient.
  const order: string[] = [];
  const indegree = new Map(all.map((key) => [key, dagPred.get(key)!.length]));
  const ready = all.filter((key) => indegree.get(key) === 0);
  while (ready.length) {
    ready.sort(byRank);
    const node = ready.shift()!;
    order.push(node);
    for (const next of dagSucc.get(node)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  const column = new Map<string, number>();
  for (const node of order)
    column.set(
      node,
      Math.max(0, ...dagPred.get(node)!.map((prev) => column.get(prev)! + 1)),
    );
  for (const node of [...order].reverse()) {
    const next = dagSucc.get(node)!;
    if (node !== root && dagPred.get(node)!.length === 0 && next.length)
      column.set(node, Math.min(...next.map((key) => column.get(key)!)) - 1);
  }
  const rootColumn = column.get(root)!;
  for (const key of all)
    if (
      key !== root &&
      dagPred.get(key)!.length === 0 &&
      dagSucc.get(key)!.length === 0
    )
      column.set(key, rootColumn + 1);
  const layerOf = (key: string) => column.get(key)! - rootColumn;

  const groupOf = (key: string) => group?.(key) ?? "";
  const layers = [...new Set(all.map(layerOf))].sort((a, b) => a - b);
  const columns = new Map(
    layers.map((layer) => [
      layer,
      all
        .filter((key) => layerOf(key) === layer)
        .sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || byRank(a, b)),
    ]),
  );

  // Order each column by the mean position of its neighbours (barycentre sweeps).
  const index = new Map<string, number>();
  const reindex = (list: string[]) =>
    list.forEach((key, i) => index.set(key, i - (list.length - 1) / 2));
  for (const list of columns.values()) reindex(list);
  const sweep = (forward: boolean) => {
    const sequence = forward ? layers : [...layers].reverse();
    for (const layer of sequence.slice(1)) {
      const list = columns.get(layer)!;
      const centre = new Map(
        list.map((key) => {
          const side = neighbours
            .get(key)!
            .filter((other) =>
              forward ? layerOf(other) < layer : layerOf(other) > layer,
            )
            .map((other) => index.get(other)!);
          return [key, side.length ? mean(side) : index.get(key)!];
        }),
      );
      list.sort(
        (a, b) =>
          groupOf(a).localeCompare(groupOf(b)) ||
          centre.get(a)! - centre.get(b)! ||
          index.get(a)! - index.get(b)!,
      );
      reindex(list);
    }
  };
  const crossings = () => {
    let count = 0;
    for (let i = 0; i + 1 < layers.length; i++) {
      const left = layers[i],
        right = layers[i + 1];
      const spans: [number, number][] = [];
      for (const key of columns.get(left)!)
        for (const other of neighbours.get(key)!)
          if (layerOf(other) === right)
            spans.push([index.get(key)!, index.get(other)!]);
      for (let a = 0; a < spans.length; a++)
        for (let b = a + 1; b < spans.length; b++)
          if ((spans[a][0] - spans[b][0]) * (spans[a][1] - spans[b][1]) < 0)
            count++;
    }
    return count;
  };
  const snapshot = () =>
    new Map([...columns].map(([layer, list]) => [layer, [...list]]));
  let best = snapshot(),
    fewest = crossings();
  for (let round = 0; round < 6 && fewest > 0; round++) {
    for (const forward of [true, false]) {
      sweep(forward);
      const count = crossings();
      if (count < fewest) {
        fewest = count;
        best = snapshot();
      }
    }
  }
  for (const [layer, list] of best) {
    columns.set(layer, list);
    reindex(list);
  }

  // Rows: line each node up with its neighbours, keeping ROW_GAP between rows. Each
  // column takes the closest fit that keeps its order and spacing: rows that would
  // collide pool into one block centred on their mean wish, and the rest stay put.
  // Neighbouring rows sit half of each one's height apart: ROW_GAP for two wallets.
  const pack = (wanted: number[], heights: number[]) => {
    const offset = heights.map((_, i) =>
      heights
        .slice(0, i)
        .reduce((sum, h, j) => sum + (h + heights[j + 1]) / 2, 0),
    );
    const blocks: { start: number; size: number; sum: number }[] = [];
    wanted.forEach((value, i) => {
      blocks.push({ start: i, size: 1, sum: value - offset[i] });
      while (blocks.length > 1) {
        const last = blocks.at(-1)!,
          prev = blocks.at(-2)!;
        if (prev.sum / prev.size <= last.sum / last.size) break;
        blocks.pop();
        prev.size += last.size;
        prev.sum += last.sum;
      }
    });
    return blocks.flatMap(({ start, size, sum }) =>
      Array.from({ length: size }, (_, k) => sum / size + offset[start + k]),
    );
  };
  const y = new Map(all.map((key) => [key, index.get(key)! * ROW_GAP]));
  for (let pass = 0; pass < 4; pass++) {
    for (const layer of layers) {
      const list = columns.get(layer)!;
      const rows = pack(
        list.map((key) => {
          const around = neighbours.get(key)!.map((other) => y.get(other)!);
          return around.length ? mean(around) : y.get(key)!;
        }),
        list.map(size),
      );
      list.forEach((key, i) => y.set(key, rows[i]));
    }
  }

  const rootY = y.get(root)!;
  const nodes = new Map<string, PlacedNode>(
    all.map((key) => [
      key,
      {
        layer: layerOf(key),
        x: layerOf(key) * COLUMN_GAP,
        y: y.get(key)! - rootY,
      },
    ]),
  );
  const backward = new Set(
    links
      .filter(
        (link) =>
          nodes.has(link.from) &&
          nodes.has(link.to) &&
          link.from !== link.to &&
          nodes.get(link.to)!.layer <= nodes.get(link.from)!.layer,
      )
      .map((link) => linkKey(link.from, link.to)),
  );
  const placed = [...nodes.values()];
  return {
    nodes,
    layers,
    backward,
    bounds: {
      minX: Math.min(...placed.map((node) => node.x)),
      maxX: Math.max(...placed.map((node) => node.x)),
      minY: Math.min(...placed.map((node) => node.y)),
      maxY: Math.max(...placed.map((node) => node.y)),
    },
  };
}
