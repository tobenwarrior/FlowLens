import { usdValue, type PriceBook } from "./pricing.ts";
import type { Transfer } from "./types.ts";

/**
 * A view filter for dust and spam. It hides loaded evidence from the graph and
 * tables; it never deletes it, and nothing here decides that a transfer is spam.
 */
export interface ValueFilter {
  /** Smallest USD value kept among priced transfers; 0 keeps them all. */
  minUsd: number;
  /** Drop transfers of zero tokens, the usual shape of address poisoning. */
  hideZero: boolean;
  /** Drop transfers with no price, such as unsolicited airdrop tokens. */
  hideUnpriced: boolean;
}

export const ANY_VALUE: ValueFilter = {
  minUsd: 0,
  hideZero: false,
  hideUnpriced: false,
};

const isZero = (raw: string) => /^0*$/.test(raw);

export function filterByValue(
  transfers: Transfer[],
  book: PriceBook,
  filter: ValueFilter,
): Transfer[] {
  const priceMatters = filter.minUsd > 0 || filter.hideUnpriced;
  return transfers.filter((transfer) => {
    if ((filter.hideZero || filter.minUsd > 0) && isZero(transfer.rawAmount))
      return false;
    if (!priceMatters) return true;
    const usd = usdValue(transfer, book);
    if (!usd) return !filter.hideUnpriced;
    return Number(usd.amount) >= filter.minUsd;
  });
}
