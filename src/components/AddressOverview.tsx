import { useId, useMemo } from "react";
import { aggregateFlows, normalizeAddress } from "../domain/engine.ts";
import { netFlowSeries } from "../domain/net-flow.ts";
import type { NetFlowSeries } from "../domain/net-flow.ts";
import { formatCompact, quoteFor, wholeUnits } from "../domain/pricing.ts";
import type { PriceBook } from "../domain/pricing.ts";
import type { Address, Investigation } from "../domain/types.ts";
import { chainName } from "./Graph.tsx";

const CHART_WIDTH = 560;
const CHART_HEIGHT = 150;
const PAD_LEFT = 46;
const PAD_BOTTOM = 18;

function axisLabel(series: NetFlowSeries, value: number): string {
  if (series.unit?.kind === "usd") return `$${formatCompact(value, 1)}`;
  return formatCompact(value, 1);
}

/**
 * Cumulative net flow over loaded evidence.
 *
 * Deliberately not called a balance: FlowLens never reads account balances, so this
 * starts at zero and only accumulates what was loaded. The caption says so, because a
 * line that looks like a balance chart will be read as one otherwise.
 */
function NetFlowChart({ series }: { series: NetFlowSeries }) {
  const gradientId = useId();
  const { points } = series;

  if (points.length < 2) {
    return (
      <div className="chart-empty">
        {points.length === 0
          ? "No loaded evidence for this wallet yet."
          : "A single transfer is not yet a series — load more evidence."}
      </div>
    );
  }

  const first = Date.parse(points[0].timestamp);
  const last = Date.parse(points[points.length - 1].timestamp);
  const span = Math.max(1, last - first);
  // Always include zero so the baseline is meaningful and negatives read as negative.
  const top = Math.max(series.max, 0);
  const bottom = Math.min(series.min, 0);
  const range = Math.max(1e-9, top - bottom);
  const plotHeight = CHART_HEIGHT - PAD_BOTTOM;

  const x = (t: string) =>
    PAD_LEFT + ((Date.parse(t) - first) / span) * (CHART_WIDTH - PAD_LEFT - 8);
  const y = (value: number) =>
    plotHeight - ((value - bottom) / range) * (plotHeight - 8) - 4;

  const line = points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${x(points[points.length - 1].timestamp).toFixed(1)} ${y(bottom).toFixed(1)} L${x(points[0].timestamp).toFixed(1)} ${y(bottom).toFixed(1)} Z`;
  const zeroY = y(0);

  const ticks = [top, bottom + range / 2, bottom].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  return (
    <svg
      className="netflow-chart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Cumulative net flow across ${points.length} loaded transfers, from ${points[0].timestamp.slice(0, 10)} to ${points[points.length - 1].timestamp.slice(0, 10)}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--blue)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--blue)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {ticks.map((value) => (
        <g key={value}>
          <line
            className="chart-grid"
            x1={PAD_LEFT}
            x2={CHART_WIDTH - 8}
            y1={y(value)}
            y2={y(value)}
          />
          <text
            className="chart-tick"
            x={PAD_LEFT - 6}
            y={y(value) + 3}
            textAnchor="end"
          >
            {axisLabel(series, value)}
          </text>
        </g>
      ))}
      {bottom < 0 && top > 0 ? (
        <line
          className="chart-zero"
          x1={PAD_LEFT}
          x2={CHART_WIDTH - 8}
          y1={zeroY}
          y2={zeroY}
        />
      ) : null}
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} className="chart-line" />
      <text className="chart-tick" x={PAD_LEFT} y={CHART_HEIGHT - 5}>
        {points[0].timestamp.slice(0, 10)}
      </text>
      <text
        className="chart-tick"
        x={CHART_WIDTH - 8}
        y={CHART_HEIGHT - 5}
        textAnchor="end"
      >
        {points[points.length - 1].timestamp.slice(0, 10)}
      </text>
    </svg>
  );
}

/**
 * Per-asset gross in, gross out and net across loaded evidence.
 *
 * Gross and net stay separate columns on purpose: netting them into one number hides
 * churn, and a wallet that moved ten million through in both directions is a different
 * thing from one that received nothing.
 */
function AssetsPanel({
  investigation,
  address,
  book,
}: {
  investigation: Investigation;
  address: Address;
  book: PriceBook;
}) {
  const rows = useMemo(() => {
    // A flow is already scoped to one chain and one contract, so USDC on Ethereum and
    // USDC on Base are separate rows. Grouping by symbol here would merge two distinct
    // assets and misreport which chain the amounts came from.
    const flows = aggregateFlows(investigation.transfers, address);
    return flows
      .map((flow) => {
        const quote = quoteFor(flow.asset, book);
        const net = wholeUnits(flow.net, flow.asset.decimals);
        return {
          flow,
          net,
          inflow: wholeUnits(flow.inflow, flow.asset.decimals),
          outflow: wholeUnits(flow.outflow, flow.asset.decimals),
          usd: quote ? net * Number(quote.usd) : null,
        };
      })
      .sort(
        (a, b) =>
          Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0) ||
          Math.abs(b.net) - Math.abs(a.net),
      );
  }, [investigation, address, book]);

  if (!rows.length)
    return <div className="chart-empty">No assets in loaded evidence.</div>;

  return (
    <div className="txscroll">
      <table className="txtable assets-table">
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Chain</th>
            <th scope="col" style={{ textAlign: "right" }}>
              Gross in
            </th>
            <th scope="col" style={{ textAlign: "right" }}>
              Gross out
            </th>
            <th scope="col" style={{ textAlign: "right" }}>
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.flow.asset.chainId}:${row.flow.asset.symbol}`}>
              <td>
                <span className="txtoken">
                  <span
                    className={`chain-dot chain-${row.flow.asset.chainId}`}
                    aria-hidden="true"
                  />
                  {row.flow.asset.symbol}
                </span>
              </td>
              <td className="txparty-addr">
                {chainName(row.flow.asset.chainId)}
              </td>
              <td className="txvalue in">{formatCompact(row.inflow)}</td>
              <td className="txvalue out">{formatCompact(row.outflow)}</td>
              <td
                className={`txvalue ${row.net > 0 ? "in" : row.net < 0 ? "out" : "self"}`}
              >
                {row.net > 0 ? "+" : ""}
                {formatCompact(row.net)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddressOverview({
  investigation,
  address,
  book,
}: {
  investigation: Investigation;
  address: string;
  book: PriceBook;
}) {
  const focus = normalizeAddress(address);
  const series = useMemo(
    () => netFlowSeries(investigation.transfers, focus, book),
    [investigation, focus, book],
  );

  const unitNote =
    series.unit?.kind === "asset"
      ? `${series.unit.symbol} — no price source configured`
      : series.unit?.kind === "usd"
        ? "USD"
        : null;

  return (
    <div className="overview-grid">
      <section className="txpanel" aria-label="Assets in loaded evidence">
        <div className="panel-head">
          <h2>Assets</h2>
          <span className="panel-note">gross and net kept separate</span>
        </div>
        <AssetsPanel
          investigation={investigation}
          address={focus}
          book={book}
        />
      </section>

      <section className="txpanel" aria-label="Cumulative net flow">
        <div className="panel-head">
          <h2>Cumulative net flow</h2>
          {unitNote ? <span className="panel-note">{unitNote}</span> : null}
        </div>
        <div className="chart-wrap">
          <NetFlowChart series={series} />
        </div>
        <div className="txfoot">
          <span>
            Running total of loaded transfers — not a balance, and not wallet
            history.
          </span>
          {series.excluded > 0 ? (
            <span className="txfoot-right">{series.excluded} excluded</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
