import type { Address, Asset, Transfer } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";

const CHAIN_ID = 1;
const ETH_ASSET: Asset = {
  chainId: CHAIN_ID,
  symbol: "ETH",
  decimals: 18,
  contract: null,
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_MAX_BLOCK_SPAN = 20;
const DEFAULT_MAX_RECEIPT_CHECKS = 64;
const DEFAULT_MAX_TRANSACTIONS = 20_000;

export interface NativeLeadScanOptions {
  /** Explicitly tracked wallets whose outgoing ETH may fund a new lead. */
  trackedWallets: readonly Address[];
  fromBlock: number;
  toBlock?: number;
  confirmations?: number;
  maxBlockSpan?: number;
  maxReceiptChecks?: number;
  maxTransactions?: number;
  retrievedAt?: () => string;
}

export interface NativeLeadScanResult {
  /** Successful, top-level outgoing transactions from tracked wallets only. */
  transfers: Transfer[];
  head: number;
  target: number;
  fromBlock: number;
  toBlock: number;
  /** Hash of the final block actually scanned; null when no block was scanned. */
  lastBlockHash: `0x${string}` | null;
  warnings: string[];
}

export class NativeLeadScanError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "NativeLeadScanError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface BlockTransaction {
  hash: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: number;
  transactionIndex: number;
  from: Address;
  to: Address | null;
  value: bigint;
}

interface NativeBlock {
  number: number;
  hash: `0x${string}`;
  timestamp: number;
  transactions: BlockTransaction[];
}

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function parseHex(value: unknown, label: string): number {
  if (typeof value !== "string" || !HEX.test(value))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Malformed ${label}.`,
      false,
    );
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new NativeLeadScanError("MALFORMED_RPC", `Invalid ${label}.`, false);
  return parsed;
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Malformed ${label}.`,
      false,
    );
  return value.toLowerCase() as Address;
}

function parseHash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !HASH.test(value))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Malformed ${label}.`,
      false,
    );
  return value.toLowerCase() as `0x${string}`;
}

function parseValue(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !HEX.test(value))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Malformed ${label}.`,
      false,
    );
  try {
    return BigInt(value);
  } catch {
    throw new NativeLeadScanError("MALFORMED_RPC", `Invalid ${label}.`, false);
  }
}

async function request(
  rpc: RpcClient,
  method: string,
  params: unknown[],
): Promise<unknown> {
  try {
    return await rpc.request(method, params);
  } catch (error) {
    if (error instanceof NativeLeadScanError) throw error;
    throw new NativeLeadScanError(
      "RPC_UNAVAILABLE",
      `${method} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readHead(rpc: RpcClient): Promise<number> {
  return parseHex(await request(rpc, "eth_blockNumber", []), "chain head");
}

async function readBlock(
  rpc: RpcClient,
  blockNumber: number,
  maxTransactions: number,
): Promise<NativeBlock> {
  const raw = await request(rpc, "eth_getBlockByNumber", [
    hex(blockNumber),
    true,
  ]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Missing block ${blockNumber}.`,
      false,
    );
  const row = raw as Record<string, unknown>;
  const number = parseHex(row.number, "block number");
  const hash = parseHash(row.hash, "block hash");
  const timestamp = parseHex(row.timestamp, "block timestamp");
  if (number !== blockNumber)
    throw new NativeLeadScanError(
      "BLOCK_IDENTITY",
      `Block ${blockNumber} returned a different number.`,
    );
  if (!Array.isArray(row.transactions))
    throw new NativeLeadScanError(
      "MALFORMED_RPC",
      `Block ${blockNumber} has no full transactions.`,
      false,
    );
  if (row.transactions.length > maxTransactions)
    throw new NativeLeadScanError(
      "TRANSACTION_CAP",
      `Block ${blockNumber} exceeds the transaction bound.`,
    );
  const transactions: BlockTransaction[] = [];
  for (const item of row.transactions) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new NativeLeadScanError(
        "MALFORMED_RPC",
        `Block ${blockNumber} contains a transaction hash instead of a full transaction.`,
        false,
      );
    const tx = item as Record<string, unknown>;
    const txHash = parseHash(tx.hash, "transaction hash");
    const txBlockHash = parseHash(tx.blockHash, "transaction block hash");
    const txBlock = parseHex(tx.blockNumber, "transaction block number");
    const txIndex = parseHex(tx.transactionIndex, "transaction index");
    if (txBlock !== blockNumber || txBlockHash !== hash)
      throw new NativeLeadScanError(
        "BLOCK_IDENTITY",
        `Transaction ${txHash} is not anchored to block ${blockNumber}.`,
      );
    transactions.push({
      hash: txHash,
      blockHash: txBlockHash,
      blockNumber: txBlock,
      transactionIndex: txIndex,
      from: parseAddress(tx.from, "transaction sender"),
      to: tx.to === null ? null : parseAddress(tx.to, "transaction recipient"),
      value: parseValue(tx.value, "transaction value"),
    });
  }
  return { number, hash, timestamp, transactions };
}

async function receiptIsExact(
  rpc: RpcClient,
  transaction: BlockTransaction,
  block: NativeBlock,
): Promise<boolean> {
  const raw = await request(rpc, "eth_getTransactionReceipt", [
    transaction.hash,
  ]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new NativeLeadScanError(
      "RECEIPT_UNAVAILABLE",
      `Receipt for ${transaction.hash} is unavailable.`,
    );
  const receipt = raw as Record<string, unknown>;
  if (
    parseHash(receipt.transactionHash, "receipt transaction hash") !==
    transaction.hash
  )
    throw new NativeLeadScanError(
      "RECEIPT_IDENTITY",
      `Receipt for ${transaction.hash} has a different transaction hash.`,
    );
  if (parseHash(receipt.blockHash, "receipt block hash") !== block.hash)
    throw new NativeLeadScanError(
      "RECEIPT_IDENTITY",
      `Receipt for ${transaction.hash} has a different block hash.`,
    );
  if (parseHex(receipt.blockNumber, "receipt block number") !== block.number)
    throw new NativeLeadScanError(
      "RECEIPT_IDENTITY",
      `Receipt for ${transaction.hash} has a different block number.`,
    );
  if (typeof receipt.status !== "string" || !HEX.test(receipt.status))
    return false;
  return BigInt(receipt.status) === 1n;
}

export async function scanNativeLeadTransfers(
  rpc: RpcClient,
  options: NativeLeadScanOptions,
): Promise<NativeLeadScanResult> {
  if (rpc.chainId !== CHAIN_ID)
    throw new NativeLeadScanError(
      "UNSUPPORTED_CHAIN",
      "Native lead scanning requires Ethereum mainnet.",
      false,
    );
  const confirmations = options.confirmations ?? DEFAULT_CONFIRMATIONS;
  const maxBlockSpan = options.maxBlockSpan ?? DEFAULT_MAX_BLOCK_SPAN;
  const maxReceiptChecks =
    options.maxReceiptChecks ?? DEFAULT_MAX_RECEIPT_CHECKS;
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  if (!Number.isInteger(options.fromBlock) || options.fromBlock < 0)
    throw new NativeLeadScanError(
      "INVALID_RANGE",
      "fromBlock must be a non-negative integer.",
      false,
    );
  if (
    !Number.isInteger(confirmations) ||
    confirmations < 0 ||
    confirmations > 12
  )
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "confirmations must be between 0 and 12.",
      false,
    );
  if (!Number.isInteger(maxBlockSpan) || maxBlockSpan < 1 || maxBlockSpan > 200)
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "maxBlockSpan must be between 1 and 200.",
      false,
    );
  if (
    !Number.isInteger(maxReceiptChecks) ||
    maxReceiptChecks < 1 ||
    maxReceiptChecks > 256
  )
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "maxReceiptChecks must be between 1 and 256.",
      false,
    );
  if (
    !Number.isInteger(maxTransactions) ||
    maxTransactions < 1 ||
    maxTransactions > 100_000
  )
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "maxTransactions must be between 1 and 100000.",
      false,
    );
  if (!Array.isArray(options.trackedWallets))
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "trackedWallets must be an array.",
      false,
    );
  const tracked = new Set<Address>();
  for (const [index, wallet] of options.trackedWallets.entries()) {
    if (typeof wallet !== "string" || !ADDRESS.test(wallet))
      throw new NativeLeadScanError(
        "INVALID_CONFIG",
        `trackedWallets[${index}] is not an Ethereum address.`,
        false,
      );
    tracked.add(wallet.toLowerCase() as Address);
  }
  if (!tracked.size)
    throw new NativeLeadScanError(
      "INVALID_CONFIG",
      "trackedWallets cannot be empty.",
      false,
    );
  const head = await readHead(rpc);
  const target = head - confirmations;
  if (target < options.fromBlock)
    return {
      transfers: [],
      head,
      target,
      fromBlock: options.fromBlock,
      toBlock: options.fromBlock - 1,
      lastBlockHash: null,
      warnings: [],
    };
  const requestedTo =
    options.toBlock === undefined ? target : Math.min(options.toBlock, target);
  if (requestedTo < options.fromBlock)
    return {
      transfers: [],
      head,
      target,
      fromBlock: options.fromBlock,
      toBlock: options.fromBlock - 1,
      lastBlockHash: null,
      warnings: [],
    };
  const toBlock = Math.min(requestedTo, options.fromBlock + maxBlockSpan - 1);
  const blocks: NativeBlock[] = [];
  let candidateCount = 0;
  let transactionCount = 0;
  for (
    let blockNumber = options.fromBlock;
    blockNumber <= toBlock;
    blockNumber++
  ) {
    const block = await readBlock(rpc, blockNumber, maxTransactions);
    blocks.push(block);
    transactionCount += block.transactions.length;
    if (transactionCount > maxTransactions)
      throw new NativeLeadScanError(
        "TRANSACTION_CAP",
        `Native scan exceeded the transaction bound of ${maxTransactions}.`,
      );
    candidateCount += block.transactions.filter(
      (tx) => tx.value > 0n && tx.to !== null && tracked.has(tx.from),
    ).length;
  }
  if (candidateCount > maxReceiptChecks)
    throw new NativeLeadScanError(
      "RECEIPT_CAP",
      `Native scan found ${candidateCount} candidate transactions; receipt bound is ${maxReceiptChecks}.`,
    );
  const retrievedAt = options.retrievedAt ?? (() => new Date().toISOString());
  const transfers: Transfer[] = [];
  for (const block of blocks) {
    for (const tx of block.transactions) {
      if (tx.value <= 0n || tx.to === null || !tracked.has(tx.from)) continue;
      if (!(await receiptIsExact(rpc, tx, block))) continue;
      transfers.push({
        id: `${CHAIN_ID}:${tx.hash}:native:${tx.transactionIndex}:native`,
        chainId: CHAIN_ID,
        hash: tx.hash,
        kind: "native",
        eventIndex: `tx.${tx.transactionIndex}`,
        from: tx.from,
        to: tx.to,
        asset: ETH_ASSET,
        rawAmount: tx.value.toString(),
        timestamp: new Date(block.timestamp * 1000).toISOString(),
        blockNumber: block.number,
        status: "success",
        source: "Ethereum JSON-RPC full block transaction scan",
        retrievedAt: retrievedAt(),
      });
    }
  }
  return {
    transfers,
    head,
    target,
    fromBlock: options.fromBlock,
    toBlock,
    lastBlockHash: blocks.at(-1)?.hash ?? null,
    warnings:
      requestedTo > toBlock
        ? [
            `Native scan bounded to blocks ${options.fromBlock}-${toBlock}; caller must resume at ${toBlock + 1}.`,
          ]
        : [],
  };
}
