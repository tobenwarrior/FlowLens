import {
  parseInternalEvidence,
  type InternalEvidenceBundle,
  type InternalProvenance,
  type InternalTrace,
  type InternalTraceType,
} from "../src/domain/internal.ts";
import type { Address } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";

export interface InternalTraceCapability {
  method: "debug_traceTransaction";
  tracer: "callTracer";
  chainId: number;
  transactionHash: string;
  scope: "transaction";
  status: "available" | "unsupported" | "unavailable" | "error";
  completeTree: boolean;
  fullWalletHistory: false;
  retryable: boolean;
  errorCode?: string;
  warnings: string[];
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const TYPES = new Set<InternalTraceType>([
  "CALL",
  "STATICCALL",
  "DELEGATECALL",
  "CALLCODE",
  "CREATE",
  "CREATE2",
  "SELFDESTRUCT",
]);
const NONMOVING = new Set(["STATICCALL", "DELEGATECALL", "CALLCODE"]);
const MAX_TRACES = 2000;
const MAX_DEPTH = 32;
const SCOPE_WARNING =
  "Only the requested transaction was inspected. Other transactions in this block and full wallet history remain uninspected.";
const SOURCE_WARNING =
  "Transaction, receipt, block and traces are observations from one RPC source, not independent cryptographic verification; reorganizations and provider omissions remain possible.";
type Row = Record<string, unknown>;

class EvidenceError extends Error {
  code: string;
  retryable: boolean;
  unavailable: boolean;
  constructor(code: string, retryable = false, unavailable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.unavailable = unavailable;
  }
}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return value as Row;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return value.toLowerCase();
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return value.toLowerCase() as Address;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 66 || !QUANTITY.test(value))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return BigInt(value);
}
function integer(value: unknown): number {
  const n = quantity(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return Number(n);
}
function same(value: unknown, expected: unknown): void {
  if (value !== expected)
    throw new EvidenceError("TRACE_IDENTITY_MISMATCH", true);
}
function frameType(value: unknown): InternalTraceType {
  // Geth documents SUICIDE as the legacy name for the refund-recipient frame.
  const type = value === "SUICIDE" ? "SELFDESTRUCT" : value;
  if (typeof type !== "string" || !TYPES.has(type as InternalTraceType))
    throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  return type as InternalTraceType;
}
function frameSuccess(frame: Row): boolean {
  for (const name of ["error", "revertReason"]) {
    if (frame[name] !== undefined && typeof frame[name] !== "string")
      throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
  }
  return !frame.error && !frame.revertReason;
}
function frameValue(frame: Row, type: InternalTraceType): string {
  // Static/delegate/callcode frames can omit value; none directly moves native balance.
  if (frame.value === undefined && NONMOVING.has(type)) return "0";
  return quantity(frame.value).toString();
}
function providerName(rpc: RpcClient): string {
  return typeof rpc.source === "string" &&
    /^[a-zA-Z0-9 ()_.:-]{1,100}$/.test(rpc.source)
    ? rpc.source
    : "Configured RPC";
}
function provenance(rpc: RpcClient): InternalProvenance {
  const p: InternalProvenance = {
    source: `${providerName(rpc)}: debug_traceTransaction/callTracer`,
    retrievedAt: new Date().toISOString(),
    synthetic: false,
  };
  if (typeof rpc.sourceUrl === "string" && rpc.sourceUrl.length <= 2048) {
    try {
      const url = new URL(rpc.sourceUrl);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        p.sourceUrl = url.toString();
    } catch {
      /* Optional metadata never prevents acquisition. */
    }
  }
  return p;
}

/** Read one mined transaction through the configured RPC. Never scans a wallet or retries/falls back. */
export async function acquireInternalTraceEvidence(
  input: {
    chainId: number;
    hash: string;
    address?: string;
    maxTraces?: number;
  },
  deps: { rpc: RpcClient },
): Promise<{
  bundle: InternalEvidenceBundle;
  capability: InternalTraceCapability;
}> {
  const { rpc } = deps;
  if (![1, 8453, 42161].includes(input.chainId))
    throw new TypeError(
      "Trace acquisition supports Ethereum, Base and Arbitrum One native ETH only.",
    );
  if (typeof input.hash !== "string" || !HASH.test(input.hash))
    throw new TypeError("A 32-byte transaction hash is required.");
  if (
    input.address !== undefined &&
    (typeof input.address !== "string" || !ADDRESS.test(input.address))
  )
    throw new TypeError("A valid optional scope address is required.");
  const maxTraces = input.maxTraces ?? 500;
  if (
    !Number.isSafeInteger(maxTraces) ||
    maxTraces < 1 ||
    maxTraces > MAX_TRACES
  )
    throw new TypeError(
      `maxTraces must be an integer between 1 and ${MAX_TRACES}.`,
    );
  const txHash = input.hash.toLowerCase();
  let scopeAddress =
    input.address === undefined ? undefined : address(input.address);
  let blockNumber: number | null = null;
  let stage: "preflight" | "trace" = "preflight";
  const p = provenance(rpc);
  const warnings = new Set([SCOPE_WARNING, SOURCE_WARNING]);
  const capability: InternalTraceCapability = {
    method: "debug_traceTransaction",
    tracer: "callTracer",
    chainId: input.chainId,
    transactionHash: txHash,
    scope: "transaction",
    status: "error",
    completeTree: false,
    fullWalletHistory: false,
    retryable: false,
    warnings: [],
  };
  function finish(
    traces: InternalTrace[],
    status: "partial" | "unavailable" | "error",
    supplied: boolean,
  ) {
    const notes = [...warnings];
    capability.warnings = notes;
    const bundle: InternalEvidenceBundle = {
      version: 1,
      mode: "private",
      traces,
      coverage:
        scopeAddress === undefined
          ? []
          : [
              {
                id: `rpc-internal:${input.chainId}:${txHash}:${scopeAddress}`,
                chainId: input.chainId,
                address: scopeAddress,
                provider: `${providerName(rpc)} callTracer`,
                traceProvider: supplied,
                blockFrom: blockNumber,
                blockTo: blockNumber,
                status,
                cursor: null,
                recordsObserved: traces.filter(
                  (t) => t.from === scopeAddress || t.to === scopeAddress,
                ).length,
                warnings: notes,
                provenance: { ...p },
              },
            ],
    };
    return { bundle: parseInternalEvidence(bundle, "private"), capability };
  }
  try {
    same(rpc.chainId, input.chainId);
    same(integer(await rpc.request("eth_chainId", [])), input.chainId);
    const [txInput, receiptInput] = await Promise.all([
      rpc.request("eth_getTransactionByHash", [txHash]),
      rpc.request("eth_getTransactionReceipt", [txHash]),
    ]);
    if (txInput === null || receiptInput === null)
      throw new EvidenceError("TRACE_TRANSACTION_UNAVAILABLE", true, true);
    const tx = row(txInput),
      receipt = row(receiptInput);
    same(hash(tx.hash), txHash);
    same(hash(receipt.transactionHash), txHash);
    if (tx.chainId !== undefined) same(integer(tx.chainId), input.chainId);
    if (tx.blockNumber === null || tx.blockHash === null)
      throw new EvidenceError("TRACE_TRANSACTION_UNAVAILABLE", true, true);
    const txBlock = integer(tx.blockNumber),
      blockHash = hash(tx.blockHash);
    same(hash(receipt.blockHash), blockHash);
    same(integer(receipt.blockNumber), txBlock);
    const txFrom = address(tx.from),
      txTo = tx.to === null ? null : address(tx.to);
    same(address(receipt.from), txFrom);
    same(receipt.to === null ? null : address(receipt.to), txTo);
    if (
      tx.transactionIndex !== undefined &&
      receipt.transactionIndex !== undefined
    )
      same(integer(receipt.transactionIndex), integer(tx.transactionIndex));
    const txValue = quantity(tx.value).toString();
    const status = integer(receipt.status);
    if (status !== 0 && status !== 1)
      throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
    const transactionSuccess = status === 1;
    const created =
      receipt.contractAddress == null ? null : address(receipt.contractAddress);
    if (txTo !== null && created !== null)
      throw new EvidenceError("TRACE_IDENTITY_MISMATCH", true);
    if (txTo === null && transactionSuccess && created === null)
      throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
    scopeAddress ??= txFrom;
    const block = row(
      await rpc.request("eth_getBlockByNumber", [tx.blockNumber, false]),
    );
    same(hash(block.hash), blockHash);
    same(integer(block.number), txBlock);
    if (
      !Array.isArray(block.transactions) ||
      block.transactions.length > 50_000 ||
      !block.transactions.some(
        (h) => typeof h === "string" && h.toLowerCase() === txHash,
      )
    )
      throw new EvidenceError("TRACE_IDENTITY_MISMATCH", true);
    const seconds = integer(block.timestamp);
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime()) || seconds > 253402300799)
      throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
    const timestamp = date.toISOString();
    blockNumber = txBlock;
    stage = "trace";
    const rawTrace = await rpc.request("debug_traceTransaction", [
      txHash,
      {
        tracer: "callTracer",
        timeout: "5s",
        tracerConfig: { onlyTopCall: false, withLog: false },
      },
    ]);
    const root = row(rawTrace),
      rootType = frameType(root.type);
    if (root.calls !== undefined && !Array.isArray(root.calls))
      throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
    same(address(root.from), txFrom);
    same(frameValue(root, rootType), txValue);
    same(frameSuccess(root), transactionSuccess);
    if (txTo === null) {
      if (rootType !== "CREATE")
        throw new EvidenceError("TRACE_IDENTITY_MISMATCH", true);
      if (created !== null) same(address(root.to), created);
    } else {
      same(rootType, "CALL");
      same(address(root.to), txTo);
    }
    const traces: InternalTrace[] = [];
    let completeTree = true;
    const stack: { value: unknown; path: number[] }[] = [
      { value: root, path: [] },
    ];
    const seen = new WeakSet<object>();
    let visited = 0;
    function omit(note: string) {
      completeTree = false;
      warnings.add(note);
    }
    while (stack.length && visited < maxTraces) {
      const { value, path } = stack.pop()!;
      visited++;
      if (path.length > MAX_DEPTH || `trace.${path.join(".")}`.length > 100) {
        omit(
          "Trace depth or canonical identity limit reached; that subtree was omitted.",
        );
        continue;
      }
      let f: Row,
        type: InternalTraceType,
        from: Address,
        to: Address,
        rawValue: string,
        success: boolean;
      try {
        f = row(value);
        if (seen.has(f)) throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
        seen.add(f);
        type = frameType(f.type);
        from = address(f.from);
        to = address(f.to);
        rawValue = frameValue(f, type);
        success = frameSuccess(f);
        if (f.calls !== undefined && !Array.isArray(f.calls))
          throw new EvidenceError("INVALID_TRACE_PROVIDER_DATA");
      } catch {
        omit(
          "A malformed frame or unknown CREATE destination and its descendants were omitted; no recipient or value was invented.",
        );
        continue;
      }
      if (type === "SELFDESTRUCT") {
        warnings.add(
          "SELFDESTRUCT is an observed balance refund, not proof of account deletion. EIP-6780 and chain fork rules affect its semantics; same-address refunds are omitted because this model cannot establish their net balance effect.",
        );
        if (from === to) {
          omit(
            "A same-address SELFDESTRUCT frame was omitted because fork and same-transaction creation semantics are unresolved.",
          );
          continue;
        }
      }
      traces.push({
        id: `${input.chainId}:${txHash}:trace:${path.length ? path.join(".") : "root"}`,
        chainId: input.chainId,
        hash: txHash,
        blockNumber: txBlock,
        timestamp,
        traceAddress: path,
        type,
        from,
        to,
        rawValue,
        success,
        transactionSuccess,
        nativeAsset: { symbol: "ETH", decimals: 18 },
        provenance: { ...p },
      });
      const children = (f.calls ?? []) as unknown[];
      // Reserve bounded work while retaining original sibling indices and every retained ancestor.
      const room = Math.max(0, maxTraces - visited - stack.length);
      const keep = Math.min(children.length, room);
      if (keep < children.length)
        omit(
          "Trace frame count limit reached; additional frames were omitted.",
        );
      for (let i = keep - 1; i >= 0; i--)
        stack.push({ value: children[i], path: [...path, i] });
    }
    if (stack.length)
      omit("Trace frame count limit reached; additional frames were omitted.");
    capability.status = "available";
    capability.completeTree = completeTree;
    return finish(traces, "partial", true);
  } catch (error) {
    const e =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const unsupported =
      stage === "trace" &&
      (e.code === "RPC_METHOD_UNSUPPORTED" || e.rpcCode === -32601);
    const unavailable = error instanceof EvidenceError && error.unavailable;
    capability.status = unsupported
      ? "unsupported"
      : unavailable
        ? "unavailable"
        : "error";
    capability.completeTree = false;
    capability.retryable = e.retryable === true;
    capability.errorCode =
      typeof e.code === "string" && /^[A-Z0-9_]{1,60}$/.test(e.code)
        ? e.code
        : "TRACE_PROVIDER_ERROR";
    warnings.add(
      unsupported
        ? "The configured RPC explicitly does not support debug_traceTransaction/callTracer. Internal trace evidence is unavailable; no fallback or history scan was attempted."
        : unavailable
          ? "A mined transaction and receipt are not currently available. No trace was requested."
          : "Trace acquisition failed validation or the RPC request failed. No internal movements were accepted; provider error text is omitted to protect endpoint credentials.",
    );
    return finish(
      [],
      unsupported || unavailable ? "unavailable" : "error",
      stage === "trace" && !unsupported,
    );
  }
}
