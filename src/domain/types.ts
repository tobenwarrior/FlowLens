import type { ProtocolEvidenceBundle } from "./protocols.ts";
export type Address = `0x${string}`;
export type TransferKind = "native" | "erc20" | "internal";
export interface Asset {
  chainId: number;
  symbol: string;
  decimals: number;
  contract: Address | null;
}
export interface Label {
  text: string;
  source: string;
  kind: "service" | "entity" | "prediction" | "user" | "demo";
  confidence: "verified" | "reported" | "unverified" | "synthetic";
  retrievedAt: string;
  sourceUrl?: string;
}
export interface WalletNode {
  address: Address;
  chainId: number;
  label?: Label;
  category?: "wallet" | "exchange" | "bridge" | "protocol";
}
export interface Transfer {
  id: string;
  chainId: number;
  hash: string;
  kind: TransferKind;
  eventIndex: string;
  from: Address;
  to: Address;
  asset: Asset;
  rawAmount: string;
  timestamp: string;
  blockNumber: number;
  status: "success";
  source: string;
  retrievedAt: string;
  synthetic?: boolean;
}
export interface Coverage {
  key: string;
  address: Address;
  chainId: number;
  provider: string;
  status: "partial" | "exhausted" | "error" | "unsupported";
  pagesLoaded: number;
  cursor: string | null;
  warnings: string[];
  streams: TransferKind[];
  updatedAt: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}
export interface Investigation {
  version: 1;
  id: string;
  title: string;
  root: Address;
  mode: "demo" | "live";
  createdAt: string;
  updatedAt: string;
  transfers: Transfer[];
  nodes: WalletNode[];
  coverage: Coverage[];
  expanded: string[];
  pinned: string[];
  hidden: string[];
  notes: string;
  protocolEvidence?: ProtocolEvidenceBundle;
}
export interface TraceQuery {
  address: Address;
  chainId: number;
  cursor?: string | null;
  pageSize?: number;
}
export interface TransferPage {
  transfers: Transfer[];
  nodes: WalletNode[];
  cursor: string | null;
  warnings: string[];
  streams: TransferKind[];
  exhausted: boolean;
}
export interface TraceProvider {
  id: string;
  mode: "demo" | "live";
  fetchPage(query: TraceQuery): Promise<TransferPage>;
}
export interface TraceFilter {
  chainId?: number;
  asset?: string;
  direction?: "all" | "in" | "out";
  from?: string;
  to?: string;
}
export interface FlowEdge {
  id: string;
  from: Address;
  to: Address;
  chainId: number;
  transfers: Transfer[];
}
export interface AssetFlow {
  asset: Asset;
  inflow: string;
  outflow: string;
  net: string;
}
export interface ExpansionBudget {
  maxPages: number;
  maxNodes: number;
}
