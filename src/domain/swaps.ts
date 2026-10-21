import { assetKey, normalizeAddress } from "./engine.ts";
import type { Address, Transfer } from "./types.ts";
import type { PriceBook, UsdValue } from "./pricing.ts";
import { usdValue } from "./pricing.ts";

/**
 * A pair of opposing transfers settled in one transaction.
 *
 * This is NOT a trade claim. FlowLens observes that the focus address both sent and
 * received different assets inside a single transaction hash; it does not establish a
 * buy, a sell, intent, price or ownership. `venue` is the shared counterparty of both
 * legs where one exists — commonly a router — not an attested DEX identity.
 */
export interface SwapRow {
  id: string;
  chainId: number;
  hash: string;
  timestamp: string;
  blockNumber: number;
  sold: Transfer;
  bought: Transfer;
  /** Shared counterparty across both legs, when both legs face the same address. */
  venue: Address | null;
  /** USD of the outgoing leg, when priced. Display annotation only. */
  usd: UsdValue | null;
  /** Further legs in the same transaction that are not part of the reported pair. */
  additionalLegs: number;
}

function groupKey(transfer: Transfer): string {
  return `${transfer.chainId}:${transfer.hash.toLowerCase()}`;
}

/** Largest leg first, so a multi-hop route reports its principal amounts. */
function byMagnitude(a: Transfer, b: Transfer): number {
  const left = BigInt(a.rawAmount);
  const right = BigInt(b.rawAmount);
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

/**
 * Derive two-sided transactions for `focus` from already-loaded evidence.
 * Pure over the supplied transfers: it never fetches, and a transaction whose other
 * leg was not loaded simply does not appear.
 */
export function deriveSwaps(
  transfers: Transfer[],
  focus: string,
  book: PriceBook = { quotes: {} },
): SwapRow[] {
  const address = normalizeAddress(focus);
  const groups = new Map<string, Transfer[]>();
  for (const transfer of transfers) {
    const key = groupKey(transfer);
    const existing = groups.get(key);
    if (existing) existing.push(transfer);
    else groups.set(key, [transfer]);
  }

  const rows: SwapRow[] = [];
  for (const [key, legs] of groups) {
    if (legs.length < 2) continue;
    const out = legs
      .filter((t) => normalizeAddress(t.from) === address)
      .sort(byMagnitude);
    const incoming = legs
      .filter((t) => normalizeAddress(t.to) === address)
      .sort(byMagnitude);
    if (!out.length || !incoming.length) continue;

    const sold = out[0];
    // A different asset on the way back is what distinguishes a swap from a pass-through.
    const bought =
      incoming.find((t) => assetKey(t.asset) !== assetKey(sold.asset)) ?? null;
    if (!bought) continue;

    const soldTo = normalizeAddress(sold.to);
    const boughtFrom = normalizeAddress(bought.from);
    const venue = soldTo === boughtFrom ? (soldTo as Address) : null;

    rows.push({
      id: key,
      chainId: sold.chainId,
      hash: sold.hash,
      timestamp: sold.timestamp,
      blockNumber: sold.blockNumber,
      sold,
      bought,
      venue,
      usd: usdValue(sold, book),
      additionalLegs: legs.length - 2,
    });
  }

  return rows.sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || b.blockNumber - a.blockNumber,
  );
}
