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
import { projectGraph } from "../domain/graph-projection.ts";
import {
  EMPTY_PRICE_BOOK,
  formatCompact,
  formatUsdAmount,
  sumUsd,
  wholeUnits,
  type PriceBook,
} from "../domain/pricing.ts";
import {
  COLUMN_GAP,
  layoutFlow,
  linkKey,
  type FlowLink,
} from "../domain/graph-layout.ts";
import {
  captionAt,
  placeCaptions,
  pointAt,
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
/** Each node is its disc with a two-line caption underneath, in one foreignObject. */
const LABEL_WIDTH = 170;
const LABEL_HEIGHT = 40;
/** The hop captions sit this far above the topmost disc. */
const HOP_OFFSET = 44;
/** Room above each disc for its selection ring and the focus wallet's glow. */
const RING = 8;

const cleanLabel = (text: string) =>
  text.replace(" (demo)", "").replace(" · demo", "");

/** Width of monospace text at a font size: about 0.6em per character. */
const textWidth = (text: string, size: number, tracking = 0) =>
  text.length * size * (0.6 + tracking);
/** Line captions are 9px (`.edge-label`). */
const captionWidth = (text: string) => textWidth(text, 9);
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
  const layout = useMemo(() => {
    const links: FlowLink[] = edges.map((edge) => ({
      from:
        edge.from.toLowerCase() === root
          ? ROOT
          : nodeKey(edge.chainId, edge.from),
      to:
        edge.to.toLowerCase() === root ? ROOT : nodeKey(edge.chainId, edge.to),
      transfers: edge.transfers.length,
      firstAt: edge.transfers.reduce(
        (first, transfer) =>
          transfer.timestamp < first ? transfer.timestamp : first,
        edge.transfers[0].timestamp,
      ),
    }));
    return layoutFlow(
      ROOT,
      [...byKey.keys()],
      links,
      grouped ? (key) => byKey.get(key)?.category ?? "" : undefined,
    );
  }, [edges, byKey, grouped, root]);
  const radiusOf = (key: string) => (key === ROOT ? RADIUS.focus : RADIUS.node);
  const { minX, maxX, minY, maxY } = layout.bounds;
  const hopY = minY - RADIUS.focus - HOP_OFFSET + 12;

  // Route every line around the wallets and place its caption where it covers no
  // text. Wallet discs, their captions and the hop captions are the obstacles.
  const drawing = useMemo(() => {
    const keyFor = (chainId: number, address: string) =>
      address.toLowerCase() === root
        ? ROOT
        : nodeKey(chainId, address as `0x${string}`);
    const radius = (key: string) => (key === ROOT ? RADIUS.focus : RADIUS.node);
    // Half the width of each wallet's caption (address over label or chain).
    const half = new Map(
      [...layout.nodes.keys()].map((key) => {
        const node = byKey.get(key);
        const sub =
          key === ROOT
            ? "Focus wallet"
            : node?.label
              ? cleanLabel(node.label.text)
              : chainName(node!.chainId);
        const wide = Math.max(
          textWidth(short(key === ROOT ? root : node!.address), 11),
          textWidth(sub, 10),
        );
        return [key, Math.min(LABEL_WIDTH / 2, wide / 2 + 4)];
      }),
    );
    const clear = new Map<number, number>();
    for (const [key, p] of layout.nodes)
      clear.set(p.layer, Math.max(clear.get(p.layer) ?? 0, half.get(key)!));
    const walletRects = new Map(
      [...layout.nodes].map(([key, p]): [string, Rect[]] => {
        const r = radius(key);
        return [
          key,
          [
            { cx: p.x, cy: p.y, hw: r + 4, hh: r + 4, angle: 0 },
            {
              cx: p.x,
              cy: p.y + r + 18.5,
              hw: half.get(key)!,
              hh: 15,
              angle: 0,
            },
          ],
        ];
      }),
    );
    const hopRects: Rect[] = layout.layers.map((layer) => ({
      cx: layer * COLUMN_GAP,
      cy: hopY - 4,
      hw: textWidth(hopText(layer), 10, 0.12) / 2 + 4,
      hh: 8,
      angle: 0,
    }));
    const degree = new Map<string, number>();
    for (const edge of edges)
      for (const key of [
        keyFor(edge.chainId, edge.from),
        keyFor(edge.chainId, edge.to),
      ])
        degree.set(key, (degree.get(key) ?? 0) + 1);
    // Decide each line's shape first, so the lines in each fan can be given slots.
    const lines = edges.flatMap((edge) => {
      const fromKey = keyFor(edge.chainId, edge.from),
        toKey = keyFor(edge.chainId, edge.to);
      const a = layout.nodes.get(fromKey),
        b = layout.nodes.get(toKey);
      if (!a || !b || fromKey === toKey) return [];
      const backward = layout.backward.has(linkKey(fromKey, toKey));
      // A fan bends next to its busy wallet, so the level runs (and captions) sit a row apart.
      const busyFrom = degree.get(fromKey)!,
        busyTo = degree.get(toKey)!;
      const bend: "start" | "end" | "middle" =
        backward || busyFrom === busyTo
          ? "middle"
          : busyFrom > busyTo
            ? "start"
            : "end";
      return [{ edge, fromKey, toKey, a, b, backward, bend }];
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
    const requests: { id: string; texts: string[]; route: Route }[] = [];
    for (const { edge, fromKey, toKey, a, b, backward, bend } of lines) {
      const from = {
        x: a.x,
        y: a.y,
        r: radius(fromKey),
        clear: clear.get(a.layer)!,
      };
      const to = {
        x: b.x,
        y: b.y,
        r: radius(toKey),
        clear: clear.get(b.layer)!,
      };
      const blockers = [...walletRects]
        .filter(([key]) => key !== fromKey && key !== toKey)
        .flatMap(([, rects]) => rects);
      const route = backward
        ? routeBackward(from, to, blockers)
        : routeForward(from, to, blockers, bend, slots.get(edge.id));
      routes.set(edge.id, route);
      requests.push({
        id: edge.id,
        texts: edgeCaptions(edge.transfers, book),
        route,
      });
    }
    // Priced lines are weighted by USD value, on a log scale; unpriced lines stay thin.
    const values = new Map(
      edges.map((edge) => {
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
      edges.map((edge) => [edge.id, edge.transfers.length]),
    );
    const atFocus = (id: string) =>
      edges.some(
        (edge) =>
          edge.id === id &&
          (edge.from.toLowerCase() === root || edge.to.toLowerCase() === root),
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
        .map(({ id, texts, route }) => [id, captionAt(route, texts[0])]),
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
  }, [edges, layout, byKey, root, hopY, book]);

  // Hovering or focusing a wallet or line brings out its connections; the rest dims.
  const [spotlight, setSpotlight] = useState<
    { node: string } | { edge: string } | null
  >(null);
  const related = useMemo(() => {
    if (!spotlight) return null;
    const wallets = new Set<string>(),
      lines = new Set<string>();
    if ("node" in spotlight) wallets.add(spotlight.node);
    for (const edge of edges) {
      const from = keyOf(edge.chainId, edge.from),
        to = keyOf(edge.chainId, edge.to);
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
  }, [spotlight, edges, root]);

  // The drawn extent: discs, captions under them, hop captions and loops below.
  const extent = {
    left: minX - LABEL_WIDTH / 2 - 16,
    right: maxX + LABEL_WIDTH / 2 + 16,
    top: Math.min(
      minY - RADIUS.focus - HOP_OFFSET - RING - 16,
      drawing.high - 24,
    ),
    bottom: Math.max(maxY + RADIUS.focus + LABEL_HEIGHT + 16, drawing.low + 16),
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
              x={layer * COLUMN_GAP}
              y={hopY}
              className="hop-label"
              textAnchor="middle"
              pointerEvents="none"
            >
              {hopText(layer)}
            </text>
          ))}
          {edges.map((edge) => {
            const route = drawing.routes.get(edge.id);
            if (!route) return null;
            const fromKey = keyOf(edge.chainId, edge.from);
            const role =
              fromKey === ROOT ? "focus" : roleOf(byKey.get(fromKey)!);
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
                  aria-label={`Inspect ${edge.transfers.length} transfers from ${short(edge.from)} to ${short(edge.to)}`}
                  onClick={() => onTransfer(edge.transfers[0])}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onTransfer(edge.transfers[0]);
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
                  y={-5}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {caption.text}
                </text>
              </g>
            );
          })}
          {[...layout.nodes].map(([key, p]) => {
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
                    className={`graph-node role-${role}${isSelected ? " selected" : ""}`}
                    aria-label={
                      focus
                        ? `Focus wallet ${short(root)}`
                        : `${short(node!.address)} · ${label || "No label"} · ${chainName(node!.chainId)}`
                    }
                    title={
                      focus
                        ? `${root}\nFocus wallet · labels are per chain in the wallet panel`
                        : `${node!.address}\n${node!.label ? `${label} · ${node!.label.claimType || node!.label.kind} / ${node!.label.confidence}` : "Ownership unknown"} · ${chainName(node!.chainId)}`
                    }
                    onClick={() =>
                      onNode(
                        focus
                          ? { address: investigation.root, chainId: 1 }
                          : node!,
                      )
                    }
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
                        ? "Focus wallet"
                        : label || chainName(node!.chainId)}
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
