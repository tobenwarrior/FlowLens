import { aggregateFlows, assetKey, normalizeAddress } from "./engine.ts";
import { usdValue, type PriceBook } from "./pricing.ts";
import type { Address, AssetFlow, Transfer } from "./types.ts";

/**
 * The focus wallet's headline totals for the transfers in scope. With prices, one USD
 * figure covers every priced asset and the rest are counted, not guessed. Without
 * them, the most active asset stands in, in its own units. Gross inflow, gross outflow
 * and net stay separate either way.
 */
export interface FlowSummary {
  /** Assets the focus wallet sent or received. */
  assets: number;
  usd: {
    inflow: number;
    outflow: number;
    net: number;
    /** Assets with at least one transfer that has no price, left out of the totals. */
    unpricedAssets: number;
    /** Whether the totals use spot prices, prices at each transfer's block, or both. */
    pricing: "spot" | "block" | "mixed";
  } | null;
  /** The only asset, or else the one with the most transfers. */
  primary: AssetFlow | null;
}

export function summarizeFlows(
  transfers: Transfer[],
  root: Address,
  book: PriceBook,
): FlowSummary {
  const address = normalizeAddress(root);
  const flows = aggregateFlows(transfers, root);
  const counts = new Map<string, number>();
  const unpriced = new Set<string>();
  let inflow = 0,
    outflow = 0,
    priced = 0,
    atBlock = 0;
  for (const transfer of transfers) {
    const incoming = normalizeAddress(transfer.to) === address,
      outgoing = normalizeAddress(transfer.from) === address;
    if (!incoming && !outgoing) continue;
    const key = assetKey(transfer.asset);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const usd = usdValue(transfer, book);
    if (!usd) {
      unpriced.add(key);
      continue;
    }
    const amount = Number(usd.amount);
    if (incoming) inflow += amount;
    if (outgoing) outflow += amount;
    priced += 1;
    if (usd.atBlock) atBlock += 1;
  }
  const primary = flows.reduce<AssetFlow | null>(
    (best, flow) =>
      !best ||
      (counts.get(assetKey(flow.asset)) ?? 0) >
        (counts.get(assetKey(best.asset)) ?? 0)
        ? flow
        : best,
    null,
  );
  return {
    assets: flows.length,
    usd: priced
      ? {
          inflow,
          outflow,
          net: inflow - outflow,
          unpricedAssets: unpriced.size,
          pricing: atBlock === priced ? "block" : atBlock ? "mixed" : "spot",
        }
      : null,
    primary,
  };
}
