import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Expand,
  Minus,
  Plus,
  Wallet,
  Landmark,
  Layers,
  Pin,
} from "lucide-react";
import type { Investigation, Transfer, WalletNode } from "../domain/types.ts";
import {
  buildEdges,
  formatUnits,
  nodeKey,
  assetKey,
} from "../domain/engine.ts";
import { projectGraph } from "../domain/graph-projection.ts";

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
export function Graph({
  investigation,
  transfers,
  onNode,
  onTransfer,
  selected,
  grouped,
}: {
  investigation: Investigation;
  transfers: Transfer[];
  onNode: (n: WalletNode) => void;
  onTransfer: (t: Transfer) => void;
  selected?: string;
  grouped: boolean;
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
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [investigation.id]);
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
  const incoming = nodes.filter((n) =>
    projection.transfers.some(
      (t) => t.chainId === n.chainId && t.from === n.address && t.to === root,
    ),
  );
  const outgoing = nodes.filter((n) => !incoming.includes(n));
  const height = Math.max(
    510,
    Math.max(incoming.length, outgoing.length) * 92 + 90,
  );
  const positions = new Map<string, { x: number; y: number }>();
  const position = (arr: WalletNode[], x: number) =>
    arr.forEach((n, i) =>
      positions.set(nodeKey(n.chainId, n.address), {
        x,
        y: height / 2 + (i - (arr.length - 1) / 2) * 92,
      }),
    );
  position(incoming, 205);
  position(outgoing, 895);
  const point = (address: string, chainId: number) =>
    address.toLowerCase() === root
      ? { x: 550, y: height / 2 }
      : positions.get(nodeKey(chainId, address as `0x${string}`));
  const nodeTransfers = (n: WalletNode) =>
    projection.transfers.filter(
      (t) =>
        t.chainId === n.chainId && (t.from === n.address || t.to === n.address),
    );
  return (
    <div className="graph-wrap" data-testid="funding-graph" ref={viewportRef}>
      <div className="graph-lane lane-in">
        <ArrowDownLeft size={14} /> SOURCES OF FUNDS
      </div>
      <div className="graph-lane lane-out">
        DESTINATIONS <ArrowUpRight size={14} />
      </div>
      <svg
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        className="graph-svg"
        aria-label="Interactive directed funding graph"
        aria-description="Drag the blank canvas to pan. Use zoom controls or Fit graph to inspect more connections. Expansion retains the current text scale."
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
          if (drag)
            setPan({
              x: drag.px + (e.clientX - drag.x),
              y: drag.py + (e.clientY - drag.y),
            });
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
          <marker
            id="arrow-in"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 10 5 0 10Z" fill="#6b9c8b" />
          </marker>
          <marker
            id="arrow-out"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 10 5 0 10Z" fill="#9b8cb5" />
          </marker>
          <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="4" stdDeviation="7" floodOpacity=".04" />
          </filter>
        </defs>
        <g
          transform={`translate(${viewport.width / 2 + pan.x} ${viewport.height / 2 + pan.y}) scale(${zoom}) translate(-550 ${-height / 2})`}
          data-testid="graph-world"
        >
          <circle
            cx="550"
            cy={height / 2}
            r="152"
            className="root-orbit"
            pointerEvents="none"
          />
          <circle
            cx="550"
            cy={height / 2}
            r="108"
            className="root-orbit inner"
            pointerEvents="none"
          />
          {edges.map((edge) => {
            const a = point(edge.from, edge.chainId),
              b = point(edge.to, edge.chainId);
            if (!a || !b || edge.from === edge.to) return null;
            const isIn = edge.to.toLowerCase() === root;
            const right = b.x >= a.x;
            const x1 = a.x + (right ? 96 : -96),
              x2 = b.x + (right ? -103 : 103);
            const paired = edges.some(
              (e) =>
                e.chainId === edge.chainId &&
                e.from === edge.to &&
                e.to === edge.from,
            );
            const bend = paired ? (isIn ? 18 : -18) : 0;
            const path = `M ${x1} ${a.y} C ${(x1 + x2) / 2} ${a.y + bend}, ${(x1 + x2) / 2} ${b.y + bend}, ${x2} ${b.y}`;
            return (
              <g key={edge.id} className={`flow-edge ${isIn ? "in" : "out"}`}>
                <path
                  d={path}
                  className="edge-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`Inspect ${edge.transfers.length} transfers from ${short(edge.from)} to ${short(edge.to)}`}
                  onClick={() => onTransfer(edge.transfers[0])}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onTransfer(edge.transfers[0]);
                  }}
                />
                <path
                  d={path}
                  className="edge-line"
                  markerEnd={`url(#arrow-${isIn ? "in" : "out"})`}
                />
                <g
                  transform={`translate(${(x1 + x2) / 2 - 32} ${(a.y + b.y) / 2 - 11 + bend * 0.75})`}
                  className="edge-count"
                  pointerEvents="none"
                >
                  <rect width="64" height="23" rx="11" />
                  <text x="32" y="15" textAnchor="middle">
                    {edge.transfers.length} transfer
                    {edge.transfers.length === 1 ? "" : "s"}
                  </text>
                </g>
              </g>
            );
          })}
          <foreignObject x="446" y={height / 2 - 61} width="208" height="124">
            <button
              className={`wallet-card root-card ${selected === root ? "selected" : ""}`}
              title={`Investigation focus address: ${root}. Labels remain chain-specific in the wallet panel.`}
              onClick={() =>
                onNode({ address: investigation.root, chainId: 1 })
              }
            >
              <span className="root-card-top">
                <span className="wallet-icon">
                  <Wallet size={18} />
                </span>
                <span className="root-badge">FOCUS WALLET</span>
              </span>
              <strong>{short(root)}</strong>
              <span className="root-card-bottom">
                Investigation origin <span>●</span>
              </span>
            </button>
          </foreignObject>
          {nodes.map((n) => {
            const p = positions.get(nodeKey(n.chainId, n.address))!;
            const list = nodeTransfers(n);
            const symbols = [
              ...new Map(
                list.map((transfer) => [
                  assetKey(transfer.asset),
                  transfer.asset.symbol,
                ]),
              ).values(),
            ];
            return (
              <foreignObject
                key={nodeKey(n.chainId, n.address)}
                x={p.x - 97}
                y={p.y - 39}
                width="194"
                height="82"
              >
                <button
                  title={`${n.label?.text ? `${n.label.text} · ` : ""}${chainName(n.chainId)} · ${n.address}${n.label ? ` · ${n.label.claimType || n.label.kind} / ${n.label.confidence}` : " · Ownership unknown"}`}
                  className={`wallet-card counterparty ${selected === nodeKey(n.chainId, n.address) ? "selected" : ""} ${incoming.includes(n) ? "incoming" : "outgoing"}`}
                  onClick={() => onNode(n)}
                >
                  <span className="cp-icon">
                    {n.category === "exchange" ? (
                      <Landmark size={16} />
                    ) : n.category === "bridge" ? (
                      <Layers size={16} />
                    ) : (
                      <Wallet size={16} />
                    )}
                  </span>
                  <span className="cp-content">
                    <strong>
                      {(n.label?.text || short(n.address))
                        .replace(" (demo)", "")
                        .replace(" · demo", "")}
                    </strong>
                    <span>
                      <i className={`chain-dot chain-${n.chainId}`} />
                      {chainName(n.chainId)}{" "}
                      <span className="cp-category">· {short(n.address)}</span>
                    </span>
                  </span>
                  {investigation.pinned.includes(
                    nodeKey(n.chainId, n.address),
                  ) ? (
                    <Pin size={11} />
                  ) : (
                    <span className="node-more">↗</span>
                  )}
                </button>
                <span className="node-amount">
                  {list.length} transfer{list.length === 1 ? "" : "s"}
                  {symbols.length > 0 ? ` · ${symbols[0]}` : ""}
                  {symbols.length > 1
                    ? ` + ${symbols.length - 1} asset${symbols.length === 2 ? "" : "s"}`
                    : ""}
                </span>
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
        <span>
          <i className="legend-in" /> Inflow
        </span>
        <span>
          <i className="legend-out" /> Outflow
        </span>
        <span className="legend-help">Arrows show transfer direction</span>
      </div>
      <div className="graph-controls">
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.2, z - 0.15))}
        >
          <Minus size={16} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}
        >
          <Plus size={16} />
        </button>
        <span className="control-divider" />
        <button
          title="Fit graph"
          aria-label="Fit graph"
          onClick={() => {
            setZoom(
              Math.max(
                0.05,
                Math.min(
                  1,
                  (viewport.width - 48) / 1100,
                  (viewport.height - 88) / height,
                ),
              ),
            );
            setPan({ x: 0, y: 0 });
          }}
        >
          <Expand size={16} />
        </button>
      </div>
    </div>
  );
}
