import { assetKey, normalizeAddress } from "./engine.ts";
import { usdValue, wholeUnits } from "./pricing.ts";
import type { PriceBook } from "./pricing.ts";
import type { Asset, Transfer } from "./types.ts";

/**
 * Cumulative net flow across loaded evidence — NOT a balance history.
 *
 * FlowLens never reads account balances; it only knows the transfers it has loaded.
 * The series therefore starts at zero and accumulates what was observed, which is a
 * different quantity from what the wallet held. It can be negative, and a wallet that
 * was funded before the loaded window will look poorer than it was.
 */
export interface NetFlowPoint {
  timestamp: string;
  /** Running total in the series unit. */
  value: number;
  transferCount: number;
}

export type NetFlowUnit =
  { kind: "usd" } | { kind: "asset"; asset: Asset; symbol: string };

export interface NetFlowSeries {
  scope: "loaded-evidence";
  measure: "cumulative-net-flow";
  unit: NetFlowUnit | null;
  points: NetFlowPoint[];
  min: number;
  max: number;
  /** Transfers excluded because nothing priced them or they used another asset. */
  excluded: number;
}

const EMPTY: NetFlowSeries = {
  scope: "loaded-evidence",
  measure: "cumulative-net-flow",
  unit: null,
  points: [],
  min: 0,
  max: 0,
  excluded: 0,
};

/** The asset carrying the most loaded transfers, used when nothing is priced. */
function dominantAsset(transfers: Transfer[]): Asset | null {
  const counts = new Map<string, { asset: Asset; count: number }>();
  for (const transfer of transfers) {
    const key = assetKey(transfer.asset);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { asset: transfer.asset, count: 1 });
  }
  let best: { asset: Asset; count: number } | null = null;
  for (const entry of counts.values())
    if (!best || entry.count > best.count) best = entry;
  return best?.asset ?? null;
}

/**
 * Build the running series for `address` over already-loaded evidence.
 *
 * Prefers USD so assets are comparable. With no prices available it falls back to the
 * single most-loaded asset and reports that in `unit`, rather than silently adding
 * quantities of different tokens together.
 */
export function netFlowSeries(
  transfers: Transfer[],
  address: string,
  book: PriceBook = { quotes: {} },
): NetFlowSeries {
  const focus = normalizeAddress(address);
  const scoped = transfers
    .filter(
      (transfer) =>
        normalizeAddress(transfer.from) === focus ||
        normalizeAddress(transfer.to) === focus,
    )
    .slice()
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  if (!scoped.length) return EMPTY;

  const priced = scoped.filter((transfer) => usdValue(transfer, book));
  const useUsd = priced.length > 0;
  const fallback = useUsd ? null : dominantAsset(scoped);
  if (!useUsd && !fallback) return EMPTY;

  const unit: NetFlowUnit = useUsd
    ? { kind: "usd" }
    : { kind: "asset", asset: fallback!, symbol: fallback!.symbol };
  const wantedKey = fallback ? assetKey(fallback) : null;

  const points: NetFlowPoint[] = [];
  let running = 0;
  let count = 0;
  let excluded = 0;
  let min = 0;
  let max = 0;

  for (const transfer of scoped) {
    let amount: number | null = null;
    if (useUsd) {
      const value = usdValue(transfer, book);
      amount = value ? Number(value.amount) : null;
    } else if (assetKey(transfer.asset) === wantedKey) {
      amount = wholeUnits(transfer.rawAmount, transfer.asset.decimals);
    }
    if (amount === null || !Number.isFinite(amount)) {
      excluded += 1;
      continue;
    }
    // A self-transfer moves nothing in or out; it still counts as observed evidence.
    const incoming = normalizeAddress(transfer.to) === focus;
    const outgoing = normalizeAddress(transfer.from) === focus;
    const delta = incoming && outgoing ? 0 : incoming ? amount : -amount;
    running += delta;
    count += 1;
    if (running < min) min = running;
    if (running > max) max = running;
    points.push({
      timestamp: transfer.timestamp,
      value: running,
      transferCount: count,
    });
  }

  if (!points.length) return { ...EMPTY, excluded };
  return {
    scope: "loaded-evidence",
    measure: "cumulative-net-flow",
    unit,
    points,
    min,
    max,
    excluded,
  };
}
