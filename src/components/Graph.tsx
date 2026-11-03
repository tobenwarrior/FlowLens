import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Expand,
  Landmark,
  Layers,
  Minus,
  Pin,
  Plus,
  Wallet,
} from "lucide-react";
import type { Investigation, Transfer, WalletNode } from "../domain/types.ts";
import {
  assetKey,
  buildEdges,
  formatUnits,
  nodeKey,
} from "../domain/engine.ts";
import {
  chainIdForTransfers,
  graphFocusChainId,
  projectGraph,
} from "../domain/graph-projection.ts";
import {
  groupCounterparties,
  type CounterpartyGroup,
} from "../domain/graph-groups.ts";
import { rootLabel } from "../domain/workspace.ts";
import {
  EMPTY_PRICE_BOOK,
  formatCompact,
  formatUsdAmount,
  readablePlaces,
  roundUnits,
  sumUsd,
  wholeUnits,
  type PriceBook,
} from "../domain/pricing.ts";
import {
  COLUMN_GAP,
  ROW_GAP,
  layoutFlow,
  linkKey,
  type FlowLink,
} from "../domain/graph-layout.ts";
import {
  ARROW_GAP,
  LANE,
  captionAt,
  placeCaptions,
  pointAt,
  reverseRoute,
  routeBackward,
  routeForward,
  type Caption,
  type Rect,
  type Route,
} from "../domain/graph-drawing.ts";

export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export const chainName = (id: number) =>
  ({
    1: "Ethereum",
    957: "Derive",
    8453: "Base",
    42161: "Arbitrum",
    999: "HyperEVM",
    4663: "Robinhood",
  })[id] || `Chain ${id}`;
export const displayUnits = (
  raw: string,
  decimals: number,
  maxFraction = 6,
) => {
  const value = formatUnits(raw, decimals, maxFraction);
  if ((value === "0" || value === "-0") && BigInt(raw) !== 0n)
    return `${BigInt(raw) < 0n ? ">−" : "<"}0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  const [whole, fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
};
/** An amount rounded for reading (see readablePlaces); tiny amounts stay visible. */
export const displayAmount = (
  raw: string,
  asset: { symbol: string; decimals: number },
) => {
  const places = readablePlaces(raw, asset);
  const rounded = roundUnits(raw, asset.decimals, places);
  if (BigInt(rounded) === 0n && BigInt(raw) !== 0n)
    return `${BigInt(raw) < 0n ? ">−" : "<"}0.${"0".repeat(Math.max(0, places - 1))}1`;
  return displayUnits(rounded, asset.decimals, places);
};
export const explorer = (id: number, type: "tx" | "address", value: string) => {
  const origin = (
    {
      1: "https://etherscan.io",
      957: "https://explorer.derive.xyz",
      8453: "https://basescan.org",
      42161: "https://arbiscan.io",
      999: "https://hyperevmscan.io",
      4663: "https://robinhoodchain.blockscout.com",
    } as Record<number, string>
  )[id];
  return origin ? `${origin}/${type}/${value}` : undefined;
};

/** The focus wallet's layout key; every other node is keyed by chain and address. */
const ROOT = "root";
type Role = "focus" | "wallet" | "labelled" | "exchange" | "bridge";
const ROLES: { role: Role; name: string }[] = [
  { role: "focus", name: "Focus" },
  { role: "wallet", name: "Wallet" },
  { role: "labelled", name: "Labelled" },
  { role: "exchange", name: "Exchange" },
  { role: "bridge", name: "Bridge or protocol" },
];
const roleOf = (node: WalletNode): Role =>
  node.category === "exchange"
    ? "exchange"
    : node.category === "bridge" || node.category === "protocol"
      ? "bridge"
      : node.label
        ? "labelled"
        : "wallet";
const RADIUS = { focus: 28, node: 22 };
/** A group box: a header over a grid of address chips (`.counterparty-group`). */
const CHIP = { width: 86, height: 20, gap: 4 };
const BOX = { pad: 8, head: 24 };
/** Chips drawn per box; past this, one "+N more" chip opens the full list. */
const MAX_CHIPS = 59;
/**
 * A box's grid. It stays three chips wide in a busy column; with nothing beyond it,
 * a big group may grow to five, outwards from its wallet.
 */
const boxShape = (members: number, roomy: boolean) => {
  const chips = Math.min(members, MAX_CHIPS + 1);
  const columns =
    chips <= 8 ? 2 : chips <= 24 || !roomy ? 3 : chips <= 48 ? 4 : 5;
  const rows = Math.ceil(chips / columns);
  return {
    columns,
    shown: members > MAX_CHIPS + 1 ? MAX_CHIPS : members,
    width: columns * CHIP.width + (columns - 1) * CHIP.gap + 2 * BOX.pad,
    height: BOX.head + rows * CHIP.height + (rows - 1) * CHIP.gap + 2 * BOX.pad,
  };
};
/** A line the graph draws: between two wallets, or between a wallet and a group. */
interface DrawnEdge {
  id: string;
  fromKey: string;
  toKey: string;
  transfers: Transfer[];
  /** "0xab…cd to 0xef…01", for the line's accessible name. */
  name: string;
}
/**
 * Each node is its disc with a caption underneath, in one foreignObject: the address,
 * then a label of up to two lines (`.node-sub`).
 */
const LABEL_WIDTH = 170;
const LABEL_HEIGHT = 53;
/** A label line's height and the characters that fit on it (`.node-sub`, 10px). */
const SUB_LINE = 13;
const subLines = (text: string) =>
  textWidth(text, 10) > LABEL_WIDTH - 8 ? 2 : 1;
/** The hop captions sit this far above the topmost disc. */
const HOP_OFFSET = 44;
/** Room above each disc for its selection ring and the focus wallet's glow. */
const RING = 8;

const cleanLabel = (text: string) =>
  text.replace(" (demo)", "").replace(" · demo", "");

/** Width of monospace text at a font size: about 0.6em per character. */
const textWidth = (text: string, size: number, tracking = 0) =>
  text.length * size * (0.6 + tracking);
/** Line captions are 10px (`.edge-label`). */
const captionWidth = (text: string) => textWidth(text, 10);
const hopText = (layer: number) =>
  layer === 0
    ? "Focus"
    : `${Math.abs(layer)} hop${Math.abs(layer) === 1 ? "" : "s"} ${layer < 0 ? "before" : "after"}`;

/**
 * A line's caption, fullest first: its value and transfer count, or a single
 * transfer's UTC time; then the value alone for tight spots. The value is the USD
 * total when every transfer on the line is priced, otherwise the main token's total,
 * both in compact form ("30.5K"). Assets are told apart by contract, not symbol.
 * Exact amounts stay in the evidence drawer.
 */
export function edgeCaptions(
  transfers: Transfer[],
  book: PriceBook = EMPTY_PRICE_BOOK,
): [string, string] {
  const assets = new Map<
    string,
    { symbol: string; decimals: number; raw: bigint; count: number }
  >();
  for (const transfer of transfers) {
    const key = assetKey(transfer.asset);
    const entry = assets.get(key) ?? {
      symbol: transfer.asset.symbol,
      decimals: transfer.asset.decimals,
      raw: 0n,
      count: 0,
    };
    entry.raw += BigInt(transfer.rawAmount);
    entry.count++;
    assets.set(key, entry);
  }
  const [main] = [...assets.values()].sort(
    (a, b) => b.count - a.count || (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0),
  );
  const usd = sumUsd(transfers, book);
  const priced = usd.priced > 0 && usd.unpriced === 0;
  const amount = priced
    ? formatUsdAmount(usd.amount)
    : `${formatCompact(wholeUnits(main.raw.toString(), main.decimals), 2)} ${main.symbol}`;
  if (transfers.length === 1) {
    const at = transfers[0].timestamp;
    return [`${amount} · ${at.slice(0, 10)} ${at.slice(11, 16)} UTC`, amount];
  }
  const extra =
    !priced && assets.size > 1
      ? ` +${assets.size - 1} asset${assets.size === 2 ? "" : "s"}`
      : "";
  return [`${amount}${extra} (${transfers.length} transfers)`, amount];
}

export function Graph({
  investigation,
  transfers,
  onNode,
  onTransfer,
  selected,
  grouped,
  book = EMPTY_PRICE_BOOK,
  onExpand,
  busy = false,
  focusChain,
}: {
  investigation: Investigation;
  transfers: Transfer[];
  onNode: (n: WalletNode) => void;
  onTransfer: (t: Transfer) => void;
  selected?: string;
  grouped: boolean;
  /** Prices for USD captions and line weights; lines show token amounts without them. */
  book?: PriceBook;
  /** Loads a wallet's next page of history, from the "+" on its disc. */
  onExpand?: (n: WalletNode) => void;
  busy?: boolean;
  /** Explicit network filter to use when opening the focus wallet. */
  focusChain?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1100, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      setViewport((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [drag, setDrag] = useState<{
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);
  const root = investigation.root.toLowerCase();
  const rootChain = graphFocusChainId(
    investigation.root,
    transfers,
    investigation.transfers,
    focusChain,
  );
  const projection = useMemo(
    () =>
      projectGraph(investigation, transfers, {
        selected,
        grouped,
      }),
    [investigation, transfers, selected, grouped],
  );
  const edges = useMemo(
    () => buildEdges(projection.transfers),
    [projection.transfers],
  );
  const nodes = projection.nodes;
  const byKey = useMemo(
    () => new Map(nodes.map((n) => [nodeKey(n.chainId, n.address), n])),
    [nodes],
  );
  const keyOf = (chainId: number, address: string) =>
    address.toLowerCase() === root
      ? ROOT
      : nodeKey(chainId, address as `0x${string}`);
  // A busy wallet keeps its biggest counterparties as nodes and boxes the rest, as
  // investigators draw it. Pinned, selected and labelled wallets keep their nodes.
  const grouping = useMemo(() => {
    const keyed = edges.map((edge) => ({
      from: keyOf(edge.chainId, edge.from),
      to: keyOf(edge.chainId, edge.to),
      transfers: edge.transfers,
    }));
    const keep = [
      ...investigation.pinned,
      ...(selected ? [selected] : []),
      ...nodes
        .filter((node) => node.label)
        .map((node) => nodeKey(node.chainId, node.address)),
    ];
    const { groups, grouped } = groupCounterparties(ROOT, keyed, {
      keep,
      value: (transfers) => {
        const usd = sumUsd(transfers, book);
        return usd.priced ? usd.amount : 0;
      },
    });
    const byGroup = new Map(groups.map((group) => [group.key, group]));
    return { groups, grouped, byGroup };
    // keyOf reads only `root`.
  }, [edges, investigation.pinned, selected, nodes, book, root]);
  const groupName = (group: CounterpartyGroup) =>
    `${group.members.length} more ${group.direction === "in" ? "senders" : "recipients"} on ${chainName(group.chainId)}`;
  const drawn = useMemo<DrawnEdge[]>(() => {
    const plain = edges
      .map((edge) => ({
        id: edge.id,
        fromKey: keyOf(edge.chainId, edge.from),
        toKey: keyOf(edge.chainId, edge.to),
        transfers: edge.transfers,
        name: `${short(edge.from)} to ${short(edge.to)}`,
      }))
      .filter(
        (edge) =>
          !grouping.grouped.has(edge.fromKey) &&
          !grouping.grouped.has(edge.toKey),
      );
    // One line per group and direction: the members' flow, and any flow back.
    const boxed = grouping.groups.flatMap((group): DrawnEdge[] => {
      const members = new Set(group.members);
      const inbound = group.links
        .filter((link) => members.has(link.from))
        .flatMap((link) => link.transfers);
      const outbound = group.links
        .filter((link) => members.has(link.to))
        .flatMap((link) => link.transfers);
      const anchor =
        group.anchor === ROOT
          ? short(root)
          : short(byKey.get(group.anchor)!.address);
      return [
        inbound.length && {
          id: `${group.key}:in`,
          fromKey: group.key,
          toKey: group.anchor,
          transfers: inbound,
          name: `${groupName(group)} to ${anchor}`,
        },
        outbound.length && {
          id: `${group.key}:out`,
          fromKey: group.anchor,
          toKey: group.key,
          transfers: outbound,
          name: `${anchor} to ${groupName(group)}`,
        },
      ].filter((edge): edge is DrawnEdge => Boolean(edge));
    });
    return [...plain, ...boxed];
  }, [edges, grouping, byKey, root]);
  // Lay out with narrow boxes first. A box with nothing beyond it may then widen,
  // outwards from its wallet, and the layout runs again for its new height.
  const { layout, shapes } = useMemo(() => {
    const links: FlowLink[] = drawn.map((edge) => ({
      from: edge.fromKey,
      to: edge.toKey,
      transfers: edge.transfers.length,
      firstAt: edge.transfers.reduce(
        (first, transfer) =>
          transfer.timestamp < first ? transfer.timestamp : first,
        edge.transfers[0].timestamp,
      ),
    }));
    const keys = [
      ...[...byKey.keys()].filter((key) => !grouping.grouped.has(key)),
      ...grouping.groups.map((group) => group.key),
    ];
    type Shape = ReturnType<typeof boxShape> & { dx: number };
    const run = (shapes: Map<string, Shape>) =>
      layoutFlow(
        ROOT,
        keys,
        links,
        grouped ? (key) => byKey.get(key)?.category ?? "" : undefined,
        // A box needs its own height plus the room a wallet's caption would take.
        (key) => (shapes.has(key) ? shapes.get(key)!.height + 36 : ROW_GAP),
      );
    const narrow = new Map(
      grouping.groups.map((group): [string, Shape] => [
        group.key,
        { ...boxShape(group.members.length, false), dx: 0 },
      ]),
    );
    const first = run(narrow);
    const used = new Set([...first.nodes.values()].map((p) => p.layer));
    const shapes = new Map(
      grouping.groups.map((group): [string, Shape] => {
        const p = first.nodes.get(group.key),
          anchor = first.nodes.get(group.anchor);
        const outward = p && anchor ? Math.sign(p.layer - anchor.layer) : 0;
        if (!outward || used.has(p!.layer + outward))
          return [group.key, narrow.get(group.key)!];
        const shape = boxShape(group.members.length, true);
        return [
          group.key,
          {
            ...shape,
            dx: outward * Math.max(0, shape.width / 2 - LABEL_WIDTH / 2),
          },
        ];
      }),
    );
    const widened = [...shapes].some(
      ([key, shape]) => shape.width !== narrow.get(key)!.width,
    );
    return { layout: widened ? run(shapes) : first, shapes };
  }, [drawn, byKey, grouping, grouped]);
  // Columns move apart where a busy wallet fans out, so each of its lines has a lane
  // to bend in (see LANE in graph-drawing).
  const columnX = useMemo(() => {
    const fan = new Map<string, number>(),
      widest = new Map<number, number>();
    for (const edge of drawn) {
      const a = layout.nodes.get(edge.fromKey),
        b = layout.nodes.get(edge.toKey);
      if (!a || !b || Math.abs(a.layer - b.layer) !== 1) continue;
      const left = Math.min(a.layer, b.layer);
      for (const key of [edge.fromKey, edge.toKey]) {
        const id = `${key}|${left}`;
        fan.set(id, (fan.get(id) ?? 0) + 1);
        widest.set(left, Math.max(widest.get(left) ?? 0, fan.get(id)!));
      }
    }
    const extra = (left: number) =>
      Math.min(240, Math.max(0, (widest.get(left) ?? 0) - 4) * LANE);
    const x = new Map<number, number>([[0, 0]]);
    const after = layout.layers.filter((layer) => layer > 0);
    const before = layout.layers.filter((layer) => layer < 0).reverse();
    let previous = 0;
    for (const layer of after) {
      x.set(
        layer,
        x.get(previous)! + (layer - previous) * COLUMN_GAP + extra(layer - 1),
      );
      previous = layer;
    }
    previous = 0;
    for (const layer of before) {
      x.set(
        layer,
        x.get(previous)! - (previous - layer) * COLUMN_GAP - extra(layer),
      );
      previous = layer;
    }
    return x;
  }, [drawn, layout]);
  /** Where a node is drawn: its column, and a widened box shifted outwards. */
  const at = (key: string) => {
    const p = layout.nodes.get(key)!;
    return { ...p, x: columnX.get(p.layer)! + (shapes.get(key)?.dx ?? 0) };
  };
  const radiusOf = (key: string) => (key === ROOT ? RADIUS.focus : RADIUS.node);
  // Address poisoning: different wallets whose shortened forms match. Each is flagged,
  // so nobody takes one for another; the full address is in its tooltip.
  const lookalikes = useMemo(() => {
    const byShort = new Map<string, Set<string>>();
    for (const address of [root, ...nodes.map((node) => node.address)]) {
      const key = short(address).toLowerCase();
      if (!byShort.has(key)) byShort.set(key, new Set());
      byShort.get(key)!.add(address.toLowerCase());
    }
    return new Set(
      [...byShort.values()]
        .filter((set) => set.size > 1)
        .flatMap((set) => [...set]),
    );
  }, [nodes, root]);
  const chainLine = (node: WalletNode) =>
    lookalikes.has(node.address.toLowerCase())
      ? `Lookalike · ${chainName(node.chainId)}`
      : chainName(node.chainId);
  const focusLabel = useMemo(() => {
    const label = rootLabel(investigation);
    return label ? cleanLabel(label.text) : "";
  }, [investigation]);
  // What each node covers around its centre: a group's box, or a disc with its caption.
  const reach = (key: string) => {
    const shape = shapes.get(key);
    return shape
      ? {
          half: shape.width / 2,
          above: shape.height / 2,
          below: shape.height / 2,
        }
      : {
          half: LABEL_WIDTH / 2,
          above: RADIUS.focus,
          below: RADIUS.focus + LABEL_HEIGHT,
        };
  };
  const placed = [...layout.nodes.keys()].map((key) => [key, at(key)] as const);
  const minX = Math.min(...placed.map(([key, p]) => p.x - reach(key).half));
  const maxX = Math.max(...placed.map(([key, p]) => p.x + reach(key).half));
  const top = Math.min(...placed.map(([key, p]) => p.y - reach(key).above));
  const bottom = Math.max(...placed.map(([key, p]) => p.y + reach(key).below));
  const hopY = top - HOP_OFFSET + 12;

  // Route every line around the wallets and place its caption where it covers no
  // text. Wallet discs, their captions and the hop captions are the obstacles.
  const drawing = useMemo(() => {
    // A line meets a box at its side, as it meets a wallet at its disc.
    const radius = (key: string) =>
      shapes.has(key)
        ? shapes.get(key)!.width / 2
        : key === ROOT
          ? RADIUS.focus
          : RADIUS.node;
    // Each wallet's caption (address over label or chain): half its width, and how
    // many lines its label takes.
    const caption = new Map(
      [...layout.nodes.keys()].map((key) => {
        if (shapes.has(key))
          return [key, { half: shapes.get(key)!.width / 2, lines: 1 }];
        const node = byKey.get(key);
        const sub =
          key === ROOT
            ? focusLabel || "Focus wallet"
            : node?.label
              ? cleanLabel(node.label.text)
              : chainLine(node!);
        const wide = Math.max(
          textWidth(short(key === ROOT ? root : node!.address), 11),
          textWidth(sub, 10),
        );
        return [
          key,
          {
            half: Math.min(LABEL_WIDTH / 2, wide / 2 + 4),
            lines: subLines(sub),
          },
        ];
      }),
    );
    const half = new Map(
      [...caption].map(([key, { half }]) => [key, half] as const),
    );
    const clear = new Map<number, number>();
    for (const [key, p] of layout.nodes)
      clear.set(p.layer, Math.max(clear.get(p.layer) ?? 0, half.get(key)!));
    const walletRects = new Map(
      [...layout.nodes.keys()].map((key): [string, Rect[]] => {
        const p = at(key);
        const shape = shapes.get(key);
        if (shape)
          return [
            key,
            [
              {
                cx: p.x,
                cy: p.y,
                hw: shape.width / 2 + 4,
                hh: shape.height / 2 + 4,
                angle: 0,
              },
            ],
          ];
        const r = radius(key);
        return [
          key,
          [
            { cx: p.x, cy: p.y, hw: r + 4, hh: r + 4, angle: 0 },
            {
              cx: p.x,
              cy:
                p.y + r + 18.5 + ((caption.get(key)!.lines - 1) * SUB_LINE) / 2,
              hw: half.get(key)!,
              hh: 15 + ((caption.get(key)!.lines - 1) * SUB_LINE) / 2,
              angle: 0,
            },
          ],
        ];
      }),
    );
    const hopRects: Rect[] = layout.layers.map((layer) => ({
      cx: columnX.get(layer)!,
      cy: hopY - 4,
      hw: textWidth(hopText(layer), 10, 0.12) / 2 + 4,
      hh: 8,
      angle: 0,
    }));
    const degree = new Map<string, number>();
    for (const edge of drawn)
      for (const key of [edge.fromKey, edge.toKey])
        degree.set(key, (degree.get(key) ?? 0) + 1);
    // Decide each line's shape first, so the lines in each fan can be given slots.
    // Money flowing back to the previous column runs as a second straight line beside
    // the first, not a loop: it is laid out left to right, then reversed.
    const pairs = new Set(
      drawn.map((edge) => linkKey(edge.fromKey, edge.toKey)),
    );
    const lines = drawn.flatMap((edge) => {
      if (edge.fromKey === edge.toKey) return [];
      const start = layout.nodes.get(edge.fromKey),
        finish = layout.nodes.get(edge.toKey);
      if (!start || !finish) return [];
      const back = layout.backward.has(linkKey(edge.fromKey, edge.toKey));
      const flipped = back && start.layer - finish.layer === 1;
      const backward = back && !flipped;
      const [fromKey, toKey] = flipped
        ? [edge.toKey, edge.fromKey]
        : [edge.fromKey, edge.toKey];
      const a = at(fromKey),
        b = at(toKey);
      // The two directions of one pair sit a little apart, so both arrows show.
      const shift = pairs.has(linkKey(edge.toKey, edge.fromKey))
        ? flipped
          ? 4
          : -4
        : 0;
      // A fan bends next to its busy wallet, so the level runs (and captions) sit a row apart.
      const busyFrom = degree.get(fromKey)!,
        busyTo = degree.get(toKey)!;
      const bend: "start" | "end" | "middle" =
        backward || busyFrom === busyTo
          ? "middle"
          : busyFrom > busyTo
            ? "start"
            : "end";
      return [{ edge, fromKey, toKey, a, b, backward, flipped, shift, bend }];
    });
    const fans = new Map<string, typeof lines>();
    for (const line of lines)
      if (line.bend !== "middle") {
        const hub = `${line.bend}:${line.bend === "start" ? line.fromKey : line.toKey}`;
        fans.set(hub, [...(fans.get(hub) ?? []), line]);
      }
    const slots = new Map<string, { slot: number; of: number }>();
    for (const members of fans.values()) {
      members.sort(
        (p, q) =>
          (p.bend === "start" ? p.b.y - q.b.y : p.a.y - q.a.y) ||
          (p.edge.id < q.edge.id ? -1 : 1),
      );
      members.forEach((line, slot) =>
        slots.set(line.edge.id, { slot, of: members.length }),
      );
    }
    const routes = new Map<string, Route>();
    const requests: {
      id: string;
      texts: string[];
      route: Route;
      below?: boolean;
    }[] = [];
    for (const line of lines) {
      const { edge, fromKey, toKey, a, b, backward, flipped, shift, bend } =
        line;
      // A reversed line's arrowhead lands on its left end, so the gap moves there.
      const from = {
        x: a.x,
        y: a.y + shift,
        r: radius(fromKey) + (flipped ? ARROW_GAP : 0),
        clear: clear.get(a.layer)!,
      };
      const to = {
        x: b.x,
        y: b.y + shift,
        r: radius(toKey) - (flipped ? ARROW_GAP : 0),
        clear: clear.get(b.layer)!,
      };
      const blockers = [...walletRects]
        .filter(([key]) => key !== fromKey && key !== toKey)
        .flatMap(([, rects]) => rects);
      const ahead = backward
        ? routeBackward(from, to, blockers)
        : routeForward(from, to, blockers, bend, slots.get(edge.id));
      const route = flipped ? reverseRoute(ahead) : ahead;
      routes.set(edge.id, route);
      // The two lines of a pair are labelled one over, one under, like ⇄ in a diagram.
      requests.push({
        id: edge.id,
        texts: edgeCaptions(edge.transfers, book),
        route,
        below: shift > 0,
      });
    }
    // Priced lines are weighted by USD value, on a log scale; unpriced lines stay thin.
    const values = new Map(
      drawn.map((edge) => {
        const usd = sumUsd(edge.transfers, book);
        return [edge.id, usd.priced && !usd.unpriced ? usd.amount : null];
      }),
    );
    const most = Math.max(
      0,
      ...[...values.values()].filter((v): v is number => v !== null),
    );
    const weights = new Map(
      [...values].map(([id, value]) => [
        id,
        value !== null && most > 0
          ? 1.2 + 2.8 * (Math.log10(1 + value) / Math.log10(1 + most))
          : null,
      ]),
    );
    // Lines at the focus wallet claim their caption spots first, then the busiest lines.
    const weight = new Map(
      drawn.map((edge) => [edge.id, edge.transfers.length]),
    );
    const atFocus = (id: string) =>
      drawn.some(
        (edge) =>
          edge.id === id && (edge.fromKey === ROOT || edge.toKey === ROOT),
      );
    requests.sort(
      (a, b) =>
        Number(atFocus(b.id)) - Number(atFocus(a.id)) ||
        weight.get(b.id)! - weight.get(a.id)! ||
        (a.id < b.id ? -1 : 1),
    );
    const captions = placeCaptions(
      requests,
      [...[...walletRects.values()].flat(), ...hopRects],
      captionWidth,
    );
    // Hidden captions still exist, shown on hover or keyboard focus of their line.
    const tucked = new Map<string, Caption>(
      requests
        .filter(({ id }) => !captions.has(id))
        .map(({ id, texts, route, below }) => [
          id,
          captionAt(route, texts[0], route.prefer, below),
        ]),
    );
    let low = -Infinity,
      high = Infinity;
    for (const route of routes.values())
      for (let i = 0; i <= 40; i++) {
        const point = pointAt(route, i / 40);
        low = Math.max(low, point.y);
        high = Math.min(high, point.y);
      }
    return { routes, captions, tucked, low, high, weights };
  }, [
    drawn,
    layout,
    byKey,
    shapes,
    columnX,
    root,
    hopY,
    book,
    focusLabel,
    lookalikes,
  ]);

  // Hovering or focusing a wallet or line brings out its connections; the rest dims.
  const [spotlight, setSpotlight] = useState<
    { node: string } | { edge: string } | null
  >(null);
  const related = useMemo(() => {
    if (!spotlight) return null;
    const wallets = new Set<string>(),
      lines = new Set<string>();
    if ("node" in spotlight) wallets.add(spotlight.node);
    for (const edge of drawn) {
      const from = edge.fromKey,
        to = edge.toKey;
      if (
        "edge" in spotlight
          ? edge.id === spotlight.edge
          : from === spotlight.node || to === spotlight.node
      ) {
        lines.add(edge.id);
        wallets.add(from);
        wallets.add(to);
      }
    }
    return { wallets, lines };
  }, [spotlight, drawn]);

  // The drawn extent: discs, captions under them, hop captions and loops below.
  const extent = {
    left: minX - 16,
    right: maxX + 16,
    top: Math.min(top - HOP_OFFSET - RING - 16, drawing.high - 24),
    bottom: Math.max(bottom + 16, drawing.low + 16),
  };
  const centre = {
    x: (extent.left + extent.right) / 2,
    y: (extent.top + extent.bottom) / 2,
  };
  const fitZoom = Math.max(
    0.3,
    Math.min(
      1,
      (viewport.width - 48) / (extent.right - extent.left),
      (viewport.height - 88) / (extent.bottom - extent.top),
    ),
  );
  // Fit when the case or its wallets change, and on resize until the user zooms or pans.
  const signature = `${investigation.id}|${[...layout.nodes.keys()].join(",")}`;
  const fitted = useRef({ signature: "", adjusted: false });
  useEffect(() => {
    if (fitted.current.signature === signature && fitted.current.adjusted)
      return;
    fitted.current = { signature, adjusted: false };
    setZoom(fitZoom);
    setPan({ x: 0, y: 0 });
  }, [signature, fitZoom]);
  const adjusted = () => {
    fitted.current.adjusted = true;
  };
  const walletAt = (key: string, chainId = rootChain): WalletNode =>
    key === ROOT ? { address: investigation.root, chainId } : byKey.get(key)!;
  // A wallet's line opens its first transfer; a group's opens the wallet it trades
  // with, whose panel lists every counterparty.
  const inspect = (edge: DrawnEdge) => {
    const group =
      grouping.byGroup.get(edge.fromKey) ?? grouping.byGroup.get(edge.toKey);
    if (group)
      onNode(
        walletAt(group.anchor, chainIdForTransfers(edge.transfers, rootChain)),
      );
    else onTransfer(edge.transfers[0]);
  };

  return (
    <div className="graph-wrap" data-testid="funding-graph" ref={viewportRef}>
      <svg
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        className="graph-svg"
        aria-label="Interactive directed funding graph"
        aria-description="Money flows left to right, one column per hop from the focus wallet. Drag the blank canvas to pan; use the zoom controls or Fit graph to see more."
        width={viewport.width}
        height={viewport.height}
        onPointerDown={(e) => {
          if (
            e.target === e.currentTarget ||
            (e.target instanceof Element &&
              e.target.getAttribute("data-pan-surface") === "true")
          ) {
            setDrag({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          if (drag) {
            adjusted();
            setPan({
              x: drag.px + (e.clientX - drag.x),
              y: drag.py + (e.clientY - drag.y),
            });
          }
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
      >
        <rect
          width={viewport.width}
          height={viewport.height}
          fill="transparent"
          data-pan-surface="true"
          className="graph-pan-surface"
        />
        <defs>
          {ROLES.map(({ role }) => (
            <marker
              key={role}
              id={`arrow-${role}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="9"
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M0 0 10 5 0 10Z" className={`arrow-head role-${role}`} />
            </marker>
          ))}
        </defs>
        <g
          transform={`translate(${viewport.width / 2 + pan.x} ${viewport.height / 2 + pan.y}) scale(${zoom}) translate(${-centre.x} ${-centre.y})`}
          data-testid="graph-world"
          className={related ? "has-spotlight" : undefined}
        >
          {layout.layers.map((layer) => (
            <text
              key={layer}
              x={columnX.get(layer)}
              y={hopY}
              className="hop-label"
              textAnchor="middle"
              pointerEvents="none"
            >
              {hopText(layer)}
            </text>
          ))}
          {drawn.map((edge) => {
            const route = drawing.routes.get(edge.id);
            if (!route) return null;
            const fromKey = edge.fromKey;
            const role =
              fromKey === ROOT
                ? "focus"
                : shapes.has(fromKey)
                  ? "wallet"
                  : roleOf(byKey.get(fromKey)!);
            const placed = drawing.captions.get(edge.id);
            const caption = placed ?? drawing.tucked.get(edge.id)!;
            const weight = drawing.weights.get(edge.id);
            return (
              <g
                key={edge.id}
                className={`flow-edge role-${role}${related?.lines.has(edge.id) ? " is-related" : ""}`}
                onMouseEnter={() => setSpotlight({ edge: edge.id })}
                onMouseLeave={() => setSpotlight(null)}
              >
                <path
                  d={route.path}
                  className="edge-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`Inspect ${edge.transfers.length} transfers from ${edge.name}`}
                  onClick={() => inspect(edge)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") inspect(edge);
                  }}
                  onFocus={() => setSpotlight({ edge: edge.id })}
                  onBlur={() => setSpotlight(null)}
                />
                <path
                  d={route.path}
                  className="edge-line"
                  markerEnd={`url(#arrow-${role})`}
                  style={
                    weight ? ({ "--w": weight } as CSSProperties) : undefined
                  }
                />
                <text
                  className={`edge-label${placed ? "" : " tucked"}`}
                  transform={`translate(${caption.x} ${caption.y}) rotate(${caption.angle})`}
                  y={caption.below ? 13 : -5}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {caption.text}
                </text>
              </g>
            );
          })}
          {[...layout.nodes.keys()].map((key) => {
            const p = at(key);
            const node = byKey.get(key);
            const focus = key === ROOT;
            if (!focus && !node) return null;
            const r = radiusOf(key);
            const role = focus ? "focus" : roleOf(node!);
            const isSelected = focus
              ? selected?.toLowerCase() === root
              : selected === key;
            const label = node?.label ? cleanLabel(node.label.text) : "";
            return (
              <foreignObject
                key={key}
                className={`node-box${related?.wallets.has(key) ? " is-related" : ""}`}
                x={p.x - LABEL_WIDTH / 2}
                y={p.y - r - RING}
                width={LABEL_WIDTH}
                height={2 * r + LABEL_HEIGHT + RING}
              >
                <div
                  className="graph-node-wrap"
                  onMouseEnter={() => setSpotlight({ node: key })}
                  onMouseLeave={() => setSpotlight(null)}
                  onFocus={() => setSpotlight({ node: key })}
                  onBlur={() => setSpotlight(null)}
                >
                  <button
                    className={`graph-node role-${role}${isSelected ? " selected" : ""}${!focus && lookalikes.has(node!.address.toLowerCase()) ? " lookalike" : ""}`}
                    aria-label={
                      focus
                        ? `Focus wallet ${short(root)}${focusLabel ? ` · ${focusLabel}` : ""}`
                        : `${short(node!.address)} · ${label || "No label"} · ${chainLine(node!)}`
                    }
                    title={
                      focus
                        ? `${root}\n${focusLabel ? `${focusLabel} · focus wallet` : "Focus wallet"} · labels are per chain in the wallet panel`
                        : `${lookalikes.has(node!.address.toLowerCase()) ? "Lookalike address: another wallet here shortens the same way. Compare the full address.\n" : ""}${node!.address}\n${node!.label ? `${label} · ${node!.label.claimType || node!.label.kind} / ${node!.label.confidence}` : "Ownership unknown"} · ${chainName(node!.chainId)}`
                    }
                    onClick={() => onNode(focus ? walletAt(ROOT) : node!)}
                  >
                    <span className="node-disc">
                      <span className="node-shape">
                        {role === "exchange" ? (
                          <Landmark size={16} />
                        ) : role === "bridge" ? (
                          <Layers size={16} />
                        ) : (
                          <Wallet size={focus ? 20 : 16} />
                        )}
                      </span>
                      {investigation.pinned.includes(key) && (
                        <Pin size={10} className="node-pin" />
                      )}
                      {!focus && (
                        <i
                          className={`node-chain chain-dot chain-${node!.chainId}`}
                          title={chainName(node!.chainId)}
                        />
                      )}
                    </span>
                    <strong className="node-name">
                      {short(focus ? root : node!.address)}
                    </strong>
                    <span className="node-sub">
                      {focus
                        ? focusLabel || "Focus wallet"
                        : label || chainLine(node!)}
                    </span>
                  </button>
                  {!focus && onExpand && (
                    <button
                      className="node-expand"
                      aria-label={`Load more history for ${short(node!.address)}`}
                      title="Load this wallet's next page of history"
                      disabled={busy}
                      onClick={() => onExpand(node!)}
                    >
                      <Plus size={12} />
                    </button>
                  )}
                </div>
              </foreignObject>
            );
          })}
          {grouping.groups.map((group) => {
            const shape = shapes.get(group.key);
            if (!layout.nodes.has(group.key) || !shape) return null;
            const p = at(group.key);
            return (
              <foreignObject
                key={group.key}
                className={`node-box${related?.wallets.has(group.key) ? " is-related" : ""}`}
                x={p.x - shape.width / 2}
                y={p.y - shape.height / 2}
                width={shape.width}
                height={shape.height}
              >
                <div
                  className="counterparty-group"
                  role="group"
                  aria-label={groupName(group)}
                  onMouseEnter={() => setSpotlight({ node: group.key })}
                  onMouseLeave={() => setSpotlight(null)}
                >
                  <span className="group-head">{groupName(group)}</span>
                  <div
                    className="group-chips"
                    style={{
                      gridTemplateColumns: `repeat(${shape.columns}, minmax(0, 1fr))`,
                    }}
                  >
                    {group.members.slice(0, shape.shown).map((member) => {
                      const node = byKey.get(member)!;
                      const lookalike = lookalikes.has(
                        node.address.toLowerCase(),
                      );
                      const moved = group.links
                        .filter(
                          (link) => link.from === member || link.to === member,
                        )
                        .flatMap((link) => link.transfers);
                      const [amount] = edgeCaptions(moved, book);
                      return (
                        <button
                          key={member}
                          className={`group-chip${lookalike ? " lookalike" : ""}`}
                          aria-label={`${short(node.address)} · ${chainLine(node)} · ${amount}`}
                          title={`${lookalike ? "Lookalike address: another wallet here shortens the same way.\n" : ""}${node.address}\n${amount} · ${chainName(node.chainId)}\nSelect to draw this wallet with its own line`}
                          onClick={() => onNode(node)}
                          onFocus={() => setSpotlight({ node: group.key })}
                          onBlur={() => setSpotlight(null)}
                        >
                          <i
                            className={`chain-dot chain-${node.chainId}`}
                            aria-hidden="true"
                          />
                          {short(node.address)}
                        </button>
                      );
                    })}
                    {group.members.length > shape.shown && (
                      <button
                        className="group-chip group-more"
                        title="List every counterparty in the wallet panel"
                        onClick={() =>
                          onNode(
                            walletAt(
                              group.anchor,
                              chainIdForTransfers(
                                group.links.flatMap((link) => link.transfers),
                                rootChain,
                              ),
                            ),
                          )
                        }
                      >
                        +{group.members.length - shape.shown} more
                      </button>
                    )}
                  </div>
                </div>
              </foreignObject>
            );
          })}
        </g>
      </svg>
      {projection.omittedCounterparties > 0 && (
        <div className="graph-omission" role="status">
          Showing {nodes.length} of {projection.totalCounterparties}{" "}
          counterparties; {projection.omittedCounterparties} omitted from the
          graph. Retained evidence and totals are unchanged.
        </div>
      )}
      {nodes.length === 0 && (
        <div className="graph-empty">
          <Wallet size={28} />
          <strong>No visible connections</strong>
          <span>
            {investigation.coverage.some(
              (item) => item.provider === "evidence-only",
            ) && investigation.transfers.length === 0
              ? "Wallet history is not indexed. Add observations in Protocol evidence."
              : "Adjust your filters or load another page of history."}
          </span>
        </div>
      )}
      <div className="graph-legend">
        {ROLES.map(({ role, name }) => (
          <span key={role}>
            <i className={`legend-dot role-${role}`} /> {name}
          </span>
        ))}
        <span className="legend-help">Lines take the sender's colour</span>
      </div>
      <div className="graph-controls">
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            adjusted();
            setZoom((z) => Math.max(0.2, z - 0.15));
          }}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            adjusted();
            setZoom((z) => Math.min(1.8, z + 0.15));
          }}
        >
          <Plus size={16} />
        </button>
        <span className="control-divider" />
        <button
          title="Fit graph"
          aria-label="Fit graph"
          onClick={() => {
            fitted.current.adjusted = false;
            setZoom(fitZoom);
            setPan({ x: 0, y: 0 });
          }}
        >
          <Expand size={16} />
        </button>
      </div>
    </div>
  );
}
