import { assetKey, formatUnits } from "./engine.ts";
import type { Asset, Transfer } from "./types.ts";

/**
 * USD is a presentation annotation, never an engine input. The domain keeps exact raw
 * integer amounts; a quote only decorates them for reading. Nothing here may feed back
 * into flow aggregation, cursors or coverage.
 */
export interface PriceQuote {
  /**
   * `assetKey(asset)` for a spot quote, or `assetKey(asset)@<block>` for one read at a
   * particular block. Chain-scoped either way, so the same symbol on two chains stays
   * distinct.
   */
  key: string;
  /** Decimal string, USD per whole unit of the asset. */
  usd: string;
  source: string;
  retrievedAt: string;
  confidence: "synthetic" | "reported" | "unverified";
  /**
   * What moment the price describes. "spot" is the price now, which values an old
   * transfer at today's rate; "at-block" was read at that transfer's own block.
   * Absent on fixtures, which are neither.
   */
  basis?: "spot" | "at-block";
  /** Set when basis is "at-block". */
  blockNumber?: number;
}

export interface PriceBook {
  quotes: Record<string, PriceQuote>;
}

export interface UsdValue {
  /** Decimal string. Derived for display; not evidence. */
  amount: string;
  quote: PriceQuote;
  /** True when the quote was read at this transfer's own block. */
  atBlock: boolean;
}

export const EMPTY_PRICE_BOOK: PriceBook = { quotes: {} };

export function priceBook(quotes: PriceQuote[]): PriceBook {
  const map: Record<string, PriceQuote> = {};
  for (const quote of quotes) map[quote.key] = quote;
  return { quotes: map };
}

function decimalToNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whole-unit amount of a transfer as a float, for display maths only. */
export function wholeUnits(rawAmount: string, decimals: number): number {
  return decimalToNumber(formatUnits(rawAmount, decimals));
}

/** Book key for a price read at one block. */
export function blockQuoteKey(asset: Asset, blockNumber: number): string {
  return `${assetKey(asset)}@${blockNumber}`;
}

/** Spot quote only. Aggregates spanning many blocks have no single historical rate. */
export function quoteFor(asset: Asset, book: PriceBook): PriceQuote | null {
  return book.quotes[assetKey(asset)] ?? null;
}

/**
 * A price for this transfer, preferring one read at its own block over the spot rate.
 * Falling back is deliberate and visible: `atBlock` tells the interface which it got,
 * so a historical transfer valued at today's price can say so.
 */
export function usdValue(transfer: Transfer, book: PriceBook): UsdValue | null {
  const atBlockQuote =
    book.quotes[blockQuoteKey(transfer.asset, transfer.blockNumber)] ?? null;
  const quote = atBlockQuote ?? quoteFor(transfer.asset, book);
  if (!quote) return null;
  const units = wholeUnits(transfer.rawAmount, transfer.asset.decimals);
  const amount = units * decimalToNumber(quote.usd);
  if (!Number.isFinite(amount)) return null;
  return {
    amount: amount.toString(),
    quote,
    atBlock: atBlockQuote !== null,
  };
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/**
 * Arkham-style compact magnitudes: 48023 -> "48.023K", 2000000 -> "2M".
 * `decimals` caps the fraction kept after scaling; trailing zeros are dropped.
 */
export function formatCompact(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (magnitude >= scale)
      return `${sign}${trimZeros((magnitude / scale).toFixed(decimals))}${suffix}`;
  }
  // Below 1 keep enough significant digits that dust stays readable rather than "0".
  if (magnitude < 1) {
    const places = Math.min(
      8,
      Math.max(2, Math.ceil(-Math.log10(magnitude)) + 1),
    );
    return `${sign}${trimZeros(magnitude.toFixed(places))}`;
  }
  return `${sign}${trimZeros(magnitude.toFixed(decimals))}`;
}

export function formatUsd(value: UsdValue | null): string {
  if (!value) return "—";
  const amount = decimalToNumber(value.amount);
  if (amount === 0) return "$0";
  return `$${formatCompact(amount, 2)}`;
}

/** Total USD across transfers that have quotes; returns null when none are priced. */
export function sumUsd(
  transfers: Transfer[],
  book: PriceBook,
): { amount: number; priced: number; unpriced: number } {
  let amount = 0;
  let priced = 0;
  let unpriced = 0;
  for (const transfer of transfers) {
    const value = usdValue(transfer, book);
    if (!value) {
      unpriced += 1;
      continue;
    }
    amount += decimalToNumber(value.amount);
    priced += 1;
  }
  return { amount, priced, unpriced };
}
