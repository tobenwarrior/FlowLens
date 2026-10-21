import {
  assetKey,
  createInvestigation,
  expandInvestigation,
  normalizeAddress,
  transferId,
} from "./engine.ts";
import { priceBook } from "./pricing.ts";
import type { PriceBook } from "./pricing.ts";
import type {
  Address,
  Asset,
  TraceProvider,
  Transfer,
  WalletNode,
} from "./types.ts";

/** Entirely fictional evidence. These addresses, hashes and labels carry no attribution claims. */
export const DEMO_ROOT =
  "0x1111111111111111111111111111111111111111" as Address;
const NORTHSTAR = "0x2222222222222222222222222222222222222222" as Address;
const CEDAR = "0x3333333333333333333333333333333333333333" as Address;
const MERIDIAN = "0x4444444444444444444444444444444444444444" as Address;
const ORBIT = "0x5555555555555555555555555555555555555555" as Address;
const MAPLE = "0x6666666666666666666666666666666666666666" as Address;
const CYPRESS = "0x7777777777777777777777777777777777777777" as Address;
const PINE = "0x8888888888888888888888888888888888888888" as Address;
const RIVER = "0x9999999999999999999999999999999999999999" as Address;
const RETRIEVED = "2026-10-20T12:00:00.000Z";
const SOURCE = "Flowlens synthetic fixture v1";
const WARNING =
  "Synthetic demonstration only. Addresses, transactions, amounts and labels are fictional; no live chain evidence was retrieved.";
const ETH: Asset = { chainId: 1, symbol: "ETH", decimals: 18, contract: null };
const USDC: Asset = {
  chainId: 1,
  symbol: "USDC",
  decimals: 6,
  contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const BASE_ETH: Asset = { ...ETH, chainId: 8453 };
const BASE_USDC: Asset = {
  ...USDC,
  chainId: 8453,
  contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

function node(
  address: Address,
  chainId: number,
  text: string,
  category: WalletNode["category"] = "wallet",
): WalletNode {
  return {
    address,
    chainId,
    category,
    label: {
      text,
      source: SOURCE,
      kind: "demo",
      confidence: "synthetic",
      retrievedAt: RETRIEVED,
    },
  };
}
export const demoNodes: WalletNode[] = [
  node(DEMO_ROOT, 1, "Investigation wallet"),
  node(DEMO_ROOT, 8453, "Investigation wallet"),
  node(NORTHSTAR, 1, "Northstar Exchange · demo", "exchange"),
  node(CEDAR, 1, "Cedar wallet · demo"),
  node(MERIDIAN, 1, "Meridian Bridge · demo", "bridge"),
  node(ORBIT, 1, "Orbit protocol · demo", "protocol"),
  node(MERIDIAN, 8453, "Meridian Bridge · demo", "bridge"),
  node(MAPLE, 8453, "Maple wallet · demo"),
  node(CYPRESS, 8453, "Cypress wallet · demo"),
  node(PINE, 1, "Pine wallet · demo"),
  node(RIVER, 1, "River wallet · demo"),
  node(PINE, 8453, "Pine wallet · demo"),
];
function evidence(
  index: number,
  asset: Asset,
  from: Address,
  to: Address,
  rawAmount: string,
  day: number,
): Transfer {
  const transfer: Transfer = {
    id: "",
    chainId: asset.chainId,
    hash: `0x${index.toString(16).padStart(64, "0")}`,
    kind: asset.contract ? "erc20" : "native",
    eventIndex: "0",
    from,
    to,
    asset: { ...asset },
    rawAmount,
    timestamp: `2026-10-${day.toString().padStart(2, "0")}T${(8 + (index % 12)).toString().padStart(2, "0")}:24:00.000Z`,
    blockNumber: (asset.chainId === 1 ? 21_000_000 : 36_000_000) + index,
    status: "success",
    source: SOURCE,
    retrievedAt: RETRIEVED,
    synthetic: true,
  };
  transfer.id = transferId(transfer);
  return transfer;
}
/**
 * Two legs settled under one hash, so the swaps view has something to show. The pair is
 * still only two transfers: FlowLens reports that both moved in one transaction, never
 * that a trade was intended or a price agreed.
 */
function swapLeg(
  index: number,
  asset: Asset,
  from: Address,
  to: Address,
  rawAmount: string,
  day: number,
  eventIndex: string,
): Transfer {
  const transfer = evidence(index, asset, from, to, rawAmount, day);
  transfer.eventIndex = eventIndex;
  transfer.id = transferId(transfer);
  return transfer;
}

// Root history: 14 Ethereum and 12 Base transfers. Four second-hop transfers are revealed on expansion.
const FIXTURE: Transfer[] = [
  evidence(1, USDC, NORTHSTAR, DEMO_ROOT, "25000000000", 2),
  evidence(2, ETH, NORTHSTAR, DEMO_ROOT, "2500000000000000000", 3),
  evidence(3, USDC, DEMO_ROOT, CEDAR, "4200000000", 4),
  evidence(4, USDC, CEDAR, DEMO_ROOT, "1200000000", 5),
  evidence(5, USDC, DEMO_ROOT, MERIDIAN, "6000000000", 6),
  evidence(6, ETH, DEMO_ROOT, ORBIT, "400000000000000000", 7),
  evidence(7, USDC, NORTHSTAR, DEMO_ROOT, "18000000000", 8),
  evidence(8, USDC, DEMO_ROOT, ORBIT, "7500000000", 9),
  evidence(9, USDC, ORBIT, DEMO_ROOT, "800000000", 10),
  evidence(10, ETH, CEDAR, DEMO_ROOT, "150000000000000000", 12),
  evidence(11, USDC, NORTHSTAR, DEMO_ROOT, "12500000000", 14),
  evidence(12, USDC, DEMO_ROOT, MERIDIAN, "8250000000", 16),
  evidence(13, USDC, DEMO_ROOT, CEDAR, "2300000000", 18),
  evidence(14, ETH, DEMO_ROOT, ORBIT, "180000000000000000", 20),
  evidence(15, BASE_USDC, MERIDIAN, DEMO_ROOT, "5990000000", 6),
  evidence(16, BASE_ETH, MERIDIAN, DEMO_ROOT, "30000000000000000", 6),
  evidence(17, BASE_USDC, DEMO_ROOT, MAPLE, "1750000000", 7),
  evidence(18, BASE_USDC, MAPLE, DEMO_ROOT, "400000000", 8),
  evidence(19, BASE_USDC, DEMO_ROOT, CYPRESS, "1500000000", 9),
  evidence(20, BASE_USDC, CYPRESS, DEMO_ROOT, "250000000", 11),
  evidence(21, BASE_ETH, DEMO_ROOT, MAPLE, "1000000000000000", 12),
  evidence(22, BASE_USDC, MERIDIAN, DEMO_ROOT, "8235000000", 16),
  evidence(23, BASE_USDC, DEMO_ROOT, CYPRESS, "3200000000", 17),
  evidence(24, BASE_USDC, DEMO_ROOT, MAPLE, "2800000000", 18),
  evidence(25, BASE_USDC, CYPRESS, DEMO_ROOT, "750000000", 19),
  evidence(26, BASE_ETH, DEMO_ROOT, CYPRESS, "2000000000000000", 20),
  evidence(27, USDC, CEDAR, PINE, "1750000000", 19),
  evidence(28, USDC, RIVER, CEDAR, "900000000", 17),
  evidence(29, USDC, ORBIT, RIVER, "330000000", 18),
  evidence(30, BASE_USDC, CYPRESS, PINE, "1700000000", 19),
  // One transaction, both directions, two assets: the shape the swaps view reports.
  // Dated before the rest of the fixture so they sit on a later page and the first
  // page of the documented Northstar story stays exactly as it was.
  swapLeg(31, USDC, DEMO_ROOT, ORBIT, "9000000000", 1, "0"),
  swapLeg(31, ETH, ORBIT, DEMO_ROOT, "3700000000000000000", 1, "1"),
  swapLeg(32, BASE_USDC, DEMO_ROOT, CYPRESS, "2400000000", 1, "0"),
  swapLeg(32, BASE_ETH, CYPRESS, DEMO_ROOT, "980000000000000000", 1, "1"),
];

function encodeCursor(
  chainId: number,
  address: Address,
  offset: number,
): string {
  return `demo1.${btoa(JSON.stringify({ v: 1, chainId, address, offset }))}`;
}
function decodeCursor(
  cursor: string,
  chainId: number,
  address: Address,
  length: number,
): number {
  try {
    if (!cursor.startsWith("demo1.") || cursor.length > 1000) throw new Error();
    const value = JSON.parse(atob(cursor.slice(6)));
    if (
      value.v !== 1 ||
      value.chainId !== chainId ||
      value.address !== address ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      value.offset > length
    )
      throw new Error();
    if (encodeCursor(chainId, address, value.offset) !== cursor)
      throw new Error();
    return value.offset;
  } catch {
    throw new Error(
      "Invalid demo cursor or cursor belongs to another wallet/chain",
    );
  }
}
export const demoProvider: TraceProvider = {
  id: "synthetic-v1",
  mode: "demo",
  async fetchPage(query) {
    const address = normalizeAddress(query.address),
      size = query.pageSize ?? 12;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100)
      throw new Error("Demo page size must be between 1 and 100");
    if (![1, 8453].includes(query.chainId))
      throw new Error("Synthetic demo supports Ethereum and Base only");
    const history = FIXTURE.filter(
      (t) =>
        t.chainId === query.chainId && (t.from === address || t.to === address),
    ).sort(
      (a, b) =>
        b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id),
    );
    const offset = query.cursor
      ? decodeCursor(query.cursor, query.chainId, address, history.length)
      : 0;
    const transfers = history
        .slice(offset, offset + size)
        .map((t) => ({ ...t, asset: { ...t.asset } })),
      end = offset + transfers.length;
    const addresses = new Set([
      address,
      ...transfers.flatMap((t) => [t.from, t.to]),
    ]);
    return {
      transfers,
      nodes: demoNodes
        .filter((n) => n.chainId === query.chainId && addresses.has(n.address))
        .map((n) => ({ ...n, label: n.label ? { ...n.label } : undefined })),
      cursor:
        end < history.length ? encodeCursor(query.chainId, address, end) : null,
      exhausted: end >= history.length,
      warnings: [
        WARNING,
        "Native and ERC-20 fixture streams only; internal transfers, NFTs, fees and bridge message matching are outside this slice. Reaching the end means the synthetic page stream ended, not complete real-chain history.",
      ],
      streams: ["native", "erc20"],
    };
  },
};

export async function createDemoInvestigation() {
  let investigation = createInvestigation(
    DEMO_ROOT,
    "demo",
    "The Northstar trail",
  );
  investigation = await expandInvestigation(investigation, demoProvider, {
    address: DEMO_ROOT,
    chainId: 1,
    pageSize: 8,
  });
  return expandInvestigation(investigation, demoProvider, {
    address: DEMO_ROOT,
    chainId: 8453,
    pageSize: 8,
  });
}

/**
 * Invented prices for the synthetic fixture, so the USD column has something to render
 * without reaching a live price source. Marked `synthetic` so the interface can say so:
 * these are not quotes, and nothing here was observed on a market.
 */
export const demoPriceBook: PriceBook = priceBook([
  {
    key: assetKey(ETH),
    usd: "2400",
    source: SOURCE,
    retrievedAt: RETRIEVED,
    confidence: "synthetic",
  },
  {
    key: assetKey(USDC),
    usd: "1",
    source: SOURCE,
    retrievedAt: RETRIEVED,
    confidence: "synthetic",
  },
  {
    key: assetKey(BASE_ETH),
    usd: "2400",
    source: SOURCE,
    retrievedAt: RETRIEVED,
    confidence: "synthetic",
  },
  {
    key: assetKey(BASE_USDC),
    usd: "1",
    source: SOURCE,
    retrievedAt: RETRIEVED,
    confidence: "synthetic",
  },
]);
