import { quoteFor, wholeUnits } from "./pricing.ts";
import type { PriceBook } from "./pricing.ts";
import type { WalletCounterparty } from "./wallet-flows.ts";

/**
 * Counterparties ordered for reading, over already-loaded evidence.
 *
 * Ranking is by USD moved in both directions where prices exist, because a wallet that
 * sent and received a million is more worth looking at than one that received a dollar
 * ten times. Where a counterparty has no priced asset it cannot join that ordering, so
 * it sorts after the priced ones by transfer count and reports no USD rather than a
 * zero that would read as "worthless".
 */
export interface RankedCounterparty {
  counterparty: WalletCounterparty;
  /** USD received from this counterparty, or null when nothing it moved is priced. */
  usdIn: number | null;
  usdOut: number | null;
  /** Both directions added: the ranking key, not a net position. */
  usdVolume: number | null;
}

export interface CounterpartyRanking {
  rows: RankedCounterparty[];
  /** How the returned order was decided. */
  basis: "usd-volume" | "transfer-count";
  /** Counterparties with no priced asset, which the USD order cannot include. */
  unpriced: number;
  /** Counterparties beyond the requested limit. */
  omitted: number;
}

function usdTotals(
  counterparty: WalletCounterparty,
  book: PriceBook,
): { usdIn: number | null; usdOut: number | null } {
  let inTotal = 0;
  let outTotal = 0;
  let priced = false;
  for (const flow of counterparty.flows) {
    const quote = quoteFor(flow.asset, book);
    if (!quote) continue;
    const rate = Number(quote.usd);
    if (!Number.isFinite(rate)) continue;
    priced = true;
    inTotal += wholeUnits(flow.inflow, flow.asset.decimals) * rate;
    outTotal += wholeUnits(flow.outflow, flow.asset.decimals) * rate;
  }
  return priced
    ? { usdIn: inTotal, usdOut: outTotal }
    : { usdIn: null, usdOut: null };
}

export function rankCounterparties(
  counterparties: WalletCounterparty[],
  book: PriceBook = { quotes: {} },
  limit = 8,
): CounterpartyRanking {
  const bounded = Math.min(Math.max(limit, 1), 100);
  const ranked: RankedCounterparty[] = counterparties.map((counterparty) => {
    const { usdIn, usdOut } = usdTotals(counterparty, book);
    return {
      counterparty,
      usdIn,
      usdOut,
      usdVolume: usdIn === null || usdOut === null ? null : usdIn + usdOut,
    };
  });

  const anyPriced = ranked.some((row) => row.usdVolume !== null);
  ranked.sort((a, b) => {
    if (anyPriced && (a.usdVolume !== null || b.usdVolume !== null)) {
      // A priced counterparty always precedes an unpriced one: the unpriced row has no
      // value to compare, which is not the same as having a small one.
      if (a.usdVolume === null) return 1;
      if (b.usdVolume === null) return -1;
      if (b.usdVolume !== a.usdVolume) return b.usdVolume - a.usdVolume;
    }
    if (b.counterparty.transferCount !== a.counterparty.transferCount)
      return b.counterparty.transferCount - a.counterparty.transferCount;
    // Stable final tiebreak so repeated reads agree.
    return a.counterparty.key < b.counterparty.key ? -1 : 1;
  });

  return {
    rows: ranked.slice(0, bounded),
    basis: anyPriced ? "usd-volume" : "transfer-count",
    unpriced: ranked.filter((row) => row.usdVolume === null).length,
    omitted: Math.max(0, ranked.length - bounded),
  };
}
