import {
  analyzeInternalEvidence,
  type InternalTraceType,
} from "../src/domain/internal.ts";
import type { Address, Transfer } from "../src/domain/types.ts";
import { acquireInternalTraceEvidence } from "./trace-provider.ts";
import { createPublicRpcClient, type RpcClient } from "./rpc.ts";
import {
  address,
  integer,
  ProviderError,
  row,
  uint,
} from "./history-provider.ts";

const CHAIN_ID = 8453;
export type BaseInternalTraceProvider = "blockmachine" | "publicnode";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TYPES = new Set([
  "call",
  "staticcall",
  "delegatecall",
  "callcode",
  "create",
  "create2",
  "suicide",
  "selfdestruct",
]);
const MOVING = new Set([
  "call",
  "create",
  "create2",
  "suicide",
  "selfdestruct",
]);

export interface BaseInternalRecord {
  hash: string;
  wallet: Address;
  blockNumber: number;
  timestamp: string;
  from: Address;
  to: Address;
  rawAmount: string;
  type: string;
  traceId?: string;
  transactionIndex?: number;
  isError: boolean;
}

export interface BaseTransactionMetadata {
  hash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex?: number;
  from: Address;
  to: Address | null;
  value: string;
}

export interface BaseReceiptMetadata {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  transactionIndex?: number;
  status: 0 | 1;
  from: Address;
  to: Address | null;
}

export interface BaseInternalMetadata {
  transaction: BaseTransactionMetadata;
  receipt: BaseReceiptMetadata;
}

const invalid = (message: string) =>
  new ProviderError("INVALID_PROVIDER_DATA", message);
const mismatch = (message: string) =>
  new ProviderError("INTERNAL_METADATA_MISMATCH", message);

/** Stable trace-lane identity persisted in Base v2 cursors. */
export function baseInternalTraceProvider(): BaseInternalTraceProvider {
  const configured = process.env.FLOWLENS_BASE_RPC_PROVIDER;
  if (configured === undefined || configured === "") return "blockmachine";
  if (configured === "publicnode" || configured === "blockmachine")
    return configured;
  throw new ProviderError(
    "RPC_INVALID_PROVIDER",
    "FLOWLENS_BASE_RPC_PROVIDER must be empty, publicnode or blockmachine.",
  );
}

function parseQuantity(value: unknown, message: string): string {
  if (typeof value !== "string") throw invalid(message);
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    try {
      return BigInt(value).toString();
    } catch {
      throw invalid(message);
    }
  }
  return uint(value);
}

function parseHash(value: unknown, message: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw invalid(message);
  return value.toLowerCase();
}

function parseBlock(value: unknown, message: string): number {
  const quantity = parseQuantity(value, message);
  try {
    return integer(Number(quantity));
  } catch {
    throw invalid(message);
  }
}

function parseOptionalIndex(
  value: unknown,
  message: string,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseBlock(value, message);
}

function parseTimestamp(value: unknown): string {
  const seconds = parseBlock(
    value,
    "Base internal row has a malformed timestamp.",
  );
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime()))
    throw invalid("Base internal row has a malformed timestamp.");
  return date.toISOString();
}

function parseError(value: unknown): boolean {
  if (value === "0" || value === 0 || value === false) return false;
  if (value === "1" || value === 1 || value === true) return true;
  throw invalid("Base internal row has a malformed error flag.");
}

function expectedType(value: string): InternalTraceType | undefined {
  if (value === "call") return "CALL";
  if (value === "create") return "CREATE";
  if (value === "create2") return "CREATE2";
  if (value === "suicide" || value === "selfdestruct") return "SELFDESTRUCT";
  return undefined;
}

/** Normalize one Etherscan-compatible internal row; provider trace IDs remain data only. */
export function parseBaseInternalRecord(
  value: unknown,
  walletValue: string,
): BaseInternalRecord {
  const raw = row(value);
  const wallet = address(walletValue);
  const hash = parseHash(
    raw.hash,
    "Base internal row has a malformed transaction hash.",
  );
  const from = address(raw.from);
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (!TYPES.has(type))
    throw invalid("Base internal row has an unsupported call type.");
  const rawTo = raw.to;
  const creation = type === "create" || type === "create2";
  const toValue =
    creation && (rawTo === undefined || rawTo === null || rawTo === "")
      ? raw.contractAddress
      : rawTo;
  const to = address(toValue);
  if (from !== wallet && to !== wallet)
    throw new ProviderError(
      "WRONG_WALLET",
      "Base internal provider returned a row outside the requested wallet.",
    );
  const traceId = raw.traceId;
  if (
    traceId !== undefined &&
    (typeof traceId !== "string" || !/^[0-9_]{1,100}$/.test(traceId))
  )
    throw invalid("Base internal row has a malformed provider trace ID.");
  const transactionIndex = parseOptionalIndex(
    raw.transactionIndex,
    "Base internal row has a malformed transaction index.",
  );
  return {
    hash,
    wallet,
    blockNumber: parseBlock(
      raw.blockNumber,
      "Base internal row has a malformed block number.",
    ),
    timestamp: parseTimestamp(raw.timeStamp ?? raw.timestamp),
    from,
    to,
    rawAmount: uint(raw.value),
    type,
    ...(traceId === undefined ? {} : { traceId }),
    ...(transactionIndex === undefined ? {} : { transactionIndex }),
    isError: parseError(raw.isError ?? "0"),
  };
}

/** Stable bounded key used to reject duplicate rows when an internal page resumes. */
export function internalRecordFingerprint(record: BaseInternalRecord): string {
  return [
    record.blockNumber,
    record.hash,
    record.transactionIndex ?? "",
    record.traceId ?? "",
    record.from,
    record.to,
    record.rawAmount,
    record.type,
    record.isError ? "1" : "0",
  ].join(":");
}

function parseMetadataAddress(value: unknown, message: string): Address | null {
  if (value === null) return null;
  try {
    return address(value);
  } catch {
    throw invalid(message);
  }
}

/** Normalize keyless-MCP transaction metadata before it is compared to the internal index row. */
export function parseBaseTransactionMetadata(
  value: unknown,
): BaseTransactionMetadata {
  const raw = row(value);
  const transactionIndex = parseOptionalIndex(
    raw.transactionIndex,
    "Base transaction metadata has a malformed index.",
  );
  return {
    hash: parseHash(
      raw.hash,
      "Base transaction metadata has a malformed hash.",
    ),
    blockNumber: parseBlock(
      raw.blockNumber,
      "Base transaction metadata has a malformed block.",
    ),
    blockHash: parseHash(
      raw.blockHash,
      "Base transaction metadata has a malformed block hash.",
    ),
    ...(transactionIndex === undefined ? {} : { transactionIndex }),
    from: address(raw.from),
    to: parseMetadataAddress(
      raw.to,
      "Base transaction metadata has a malformed recipient.",
    ),
    value: parseQuantity(
      raw.value,
      "Base transaction metadata has a malformed value.",
    ),
  };
}

/** Normalize keyless-MCP receipt metadata before it is compared to the internal index row. */
export function parseBaseReceiptMetadata(value: unknown): BaseReceiptMetadata {
  const raw = row(value);
  const status = parseQuantity(
    raw.status,
    "Base receipt metadata has a malformed status.",
  );
  if (status !== "0" && status !== "1")
    throw invalid("Base receipt metadata has a malformed status.");
  const transactionIndex = parseOptionalIndex(
    raw.transactionIndex,
    "Base receipt metadata has a malformed index.",
  );
  return {
    transactionHash: parseHash(
      raw.transactionHash,
      "Base receipt metadata has a malformed hash.",
    ),
    blockNumber: parseBlock(
      raw.blockNumber,
      "Base receipt metadata has a malformed block.",
    ),
    blockHash: parseHash(
      raw.blockHash,
      "Base receipt metadata has a malformed block hash.",
    ),
    ...(transactionIndex === undefined ? {} : { transactionIndex }),
    status: status === "1" ? 1 : 0,
    from: address(raw.from),
    to: parseMetadataAddress(
      raw.to,
      "Base receipt metadata has a malformed recipient.",
    ),
  };
}

export function validateBaseInternalMetadata(
  record: BaseInternalRecord,
  metadata: BaseInternalMetadata,
): void {
  const tx = metadata.transaction;
  const receipt = metadata.receipt;
  if (
    tx.hash !== record.hash ||
    receipt.transactionHash !== record.hash ||
    tx.blockNumber !== record.blockNumber ||
    receipt.blockNumber !== record.blockNumber ||
    tx.blockHash !== receipt.blockHash ||
    (record.transactionIndex !== undefined &&
      (tx.transactionIndex !== record.transactionIndex ||
        receipt.transactionIndex !== record.transactionIndex)) ||
    (tx.transactionIndex !== undefined &&
      receipt.transactionIndex !== undefined &&
      tx.transactionIndex !== receipt.transactionIndex) ||
    receipt.status !== 1
  )
    throw mismatch(
      "Base internal listing and transaction receipt metadata disagree.",
    );
}

function bindMetadataRpc(
  rpc: RpcClient,
  metadata: BaseInternalMetadata,
): RpcClient {
  const sameIndex = (left: number | undefined, right: number | undefined) =>
    left === undefined || right === left;
  return {
    ...rpc,
    async request(method, params) {
      const value = await rpc.request(method, params);
      if (method === "eth_getTransactionByHash") {
        const actual = parseBaseTransactionMetadata(value);
        const expected = metadata.transaction;
        if (
          actual.hash !== expected.hash ||
          actual.blockNumber !== expected.blockNumber ||
          actual.blockHash !== expected.blockHash ||
          !sameIndex(expected.transactionIndex, actual.transactionIndex) ||
          actual.from !== expected.from ||
          actual.to !== expected.to ||
          actual.value !== expected.value
        )
          throw mismatch(
            "Official Base transaction metadata disagrees with the keyless index metadata.",
          );
      } else if (method === "eth_getTransactionReceipt") {
        const actual = parseBaseReceiptMetadata(value);
        const expected = metadata.receipt;
        if (
          actual.transactionHash !== expected.transactionHash ||
          actual.blockNumber !== expected.blockNumber ||
          actual.blockHash !== expected.blockHash ||
          !sameIndex(expected.transactionIndex, actual.transactionIndex) ||
          actual.status !== expected.status ||
          actual.from !== expected.from ||
          actual.to !== expected.to
        )
          throw mismatch(
            "Official Base receipt metadata disagrees with the keyless index metadata.",
          );
      }
      return value;
    },
  };
}

/** Fetch and normalize one canonical internal movement from the composite Base trace lane. */
export async function traceBaseInternalRecord(
  record: BaseInternalRecord,
  metadata: BaseInternalMetadata,
  deps: { rpc: RpcClient },
): Promise<Transfer | null> {
  if (deps.rpc.chainId !== CHAIN_ID)
    throw new ProviderError(
      "RPC_CHAIN_MISMATCH",
      "Base internal traces require a Base (8453) RPC lane.",
    );
  if (record.isError || record.rawAmount === "0" || !MOVING.has(record.type))
    throw new ProviderError(
      "INTERNAL_NOT_MOVING",
      "The indexed Base row is not a successful moving internal call.",
    );
  validateBaseInternalMetadata(record, metadata);
  const rpc = bindMetadataRpc(deps.rpc, metadata);
  const acquired = await acquireInternalTraceEvidence(
    {
      chainId: CHAIN_ID,
      hash: record.hash,
      address: record.wallet,
      maxTraces: 2_000,
    },
    { rpc },
  );
  if (acquired.capability.errorCode === "INTERNAL_METADATA_MISMATCH")
    throw mismatch(
      "Official Base transaction or receipt metadata disagrees with the keyless index metadata.",
    );
  if (
    acquired.capability.status !== "available" ||
    !acquired.capability.completeTree
  )
    throw new ProviderError(
      "INTERNAL_TRACE_INCOMPLETE",
      "The Base call trace was unavailable or bounded before its full tree was inspected; the internal row remains uncommitted.",
      acquired.capability.retryable,
    );
  const analysis = analyzeInternalEvidence(acquired.bundle);
  const root = acquired.bundle.traces.find(
    (trace) => trace.hash === record.hash && trace.traceAddress.length === 0,
  );
  if (
    !root ||
    root.blockNumber !== record.blockNumber ||
    root.timestamp !== record.timestamp
  )
    throw mismatch(
      "Base internal row timestamp or block does not match the canonical trace metadata.",
    );
  const wantedType = expectedType(record.type);
  const rootMatches =
    root.from === record.from &&
    root.to === record.to &&
    root.rawValue === record.rawAmount &&
    (!wantedType || root.type === wantedType);
  const matches = analysis.transfers.filter((transfer) => {
    if (
      transfer.chainId !== CHAIN_ID ||
      transfer.hash !== record.hash ||
      transfer.from !== record.from ||
      transfer.to !== record.to ||
      transfer.rawAmount !== record.rawAmount ||
      transfer.blockNumber !== record.blockNumber
    )
      return false;
    if (!wantedType) return true;
    return acquired.bundle.traces.some(
      (trace) =>
        trace.id.endsWith(`:${transfer.eventIndex.slice("trace.".length)}`) &&
        trace.id.includes(`:${record.hash}:trace:`) &&
        trace.type === wantedType,
    );
  });
  if (matches.length === 0 && rootMatches)
    if (record.traceId === "0")
      // The ordinary transaction stream owns the outer frame. Only the
      // provider's explicit root marker permits this exclusion; endpoints and
      // value alone are not enough to hide a genuine child row.
      return null;
    else
      throw new ProviderError(
        "INTERNAL_ROOT_ROW",
        "The indexed Base row matched only the outer transaction frame without an explicit provider root marker; it was not accepted as an internal transfer.",
      );
  if (matches.length !== 1)
    throw new ProviderError(
      "INTERNAL_TRACE_MISMATCH",
      "The Base call trace did not identify exactly one successful internal frame for the indexed row.",
      false,
    );
  const transfer = matches[0]!;
  return record.traceId
    ? {
        ...transfer,
        source: `${transfer.source}; MCP trace ID ${record.traceId}`.slice(
          0,
          200,
        ),
      }
    : transfer;
}

/**
 * Fixed composite lane: official Base RPC supplies transaction/receipt/block
 * identity while the configured trace lane supplies only callTracer output.
 * No caller-provided endpoint is accepted and no fallback is attempted.
 */
export function createBaseInternalRpcClient(
  options: {
    metadataRpc?: RpcClient;
    traceRpc?: RpcClient;
    maxDurationMs?: number;
  } = {},
): RpcClient {
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  const metadataRpc =
    options.metadataRpc ??
    createPublicRpcClient(CHAIN_ID, {
      baseProvider: "official",
      maxCalls: 32,
      // Base receipts with thousands of logs can exceed the ordinary 2 MB
      // wallet-history budget. Keep this explicit and below the RPC client's
      // hard 5 MB ceiling; the MCP lane has its own 8 MB response bound.
      maxResponseBytes: 5_000_000,
      maxDurationMs,
    });
  const configured = baseInternalTraceProvider();
  const traceRpc =
    options.traceRpc ??
    createPublicRpcClient(CHAIN_ID, {
      baseProvider: configured,
      maxCalls: 32,
      maxDurationMs,
    });
  if (metadataRpc.chainId !== CHAIN_ID || traceRpc.chainId !== CHAIN_ID)
    throw new ProviderError(
      "RPC_CHAIN_MISMATCH",
      "Base internal metadata and trace lanes must both be Base (8453).",
    );
  const traceName = traceRpc.source ?? "configured trace RPC";
  return {
    chainId: CHAIN_ID,
    source: `Base Official RPC metadata and ${traceName} callTracer`,
    async request(method, params) {
      return method === "debug_traceTransaction"
        ? traceRpc.request(method, params)
        : metadataRpc.request(method, params);
    },
  };
}
