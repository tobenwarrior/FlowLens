import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hashMessage,
  keccak256,
  parseAbi,
  recoverAddress,
  stringToHex,
} from "viem";
import type { Hex } from "viem";
import { parseSafeEvidence } from "../src/domain/safe.ts";
import type {
  SafeEvidenceBundle,
  SafeExecution,
  SafeProvenance,
} from "../src/domain/safe.ts";
import type { Address } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";

const ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
const PAGE_SIZE = 5;
const MAX_PAGES = 3;
const MAX_SIGNATURES = 5;
const MAX_VERIFICATION_TRANSACTIONS = 5;
const MAX_BODY_BYTES = 500_000;
const SERVICES: Record<number, string> = {
  1: "https://api.safe.global/tx-service/eth/api",
  42161: "https://api.safe.global/tx-service/arb1/api",
};
const HASH = /^0x[0-9a-f]{64}$/i;
const SUCCESS = keccak256(stringToHex("ExecutionSuccess(bytes32,uint256)"));
const FAILURE = keccak256(stringToHex("ExecutionFailure(bytes32,uint256)"));
type Row = Record<string, unknown>;
type Stage = "snapshot" | "history" | "verification";
interface Issue {
  code: string;
  message: string;
  retryable: boolean;
  stage: Stage;
}
interface Cursor {
  v: 1;
  chainId: number;
  address: Address;
  blockNumber: number;
  blockHash: string;
  offset: number;
  lastNonce?: string;
}
interface TransactionParameters {
  to: Address;
  value: string;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
}
export interface SafeAcquisitionInput {
  address: string;
  chainId: number;
  blockNumber?: number;
  maxPages?: number;
  cursor?: string;
  includeHistory?: boolean;
  verifySignatures?: boolean;
  maxSignatures?: number;
}
export interface SafeConfirmationMaterial {
  owner: Address;
  signatureType: string;
  signature?: Hex;
  provenance: SafeProvenance;
}
export interface SafeTransactionMaterial {
  executionId: string;
  safeTxHash: string;
  blockNumber: number;
  parameters: TransactionParameters;
  executionSignatures?: Hex;
  confirmations: SafeConfirmationMaterial[];
  provenance: SafeProvenance;
}
export interface SafeSignatureProof {
  signatureId: string;
  executionId: string;
  status: "verified-eoa" | "unverified";
  reason: string;
  digestBoundToSafeContract: boolean;
  recoveredSigner?: Address;
  signatureType?: "eoa" | "eth_sign" | "contract" | "approved-hash" | "unknown";
  scope: "direct-execution-calldata";
  participation: "unresolved";
  provenance: SafeProvenance;
}
export interface SafeAcquisitionResult {
  bundle: SafeEvidenceBundle;
  cursor: string | null;
  snapshot?: {
    blockNumber: number;
    blockHash: string;
    nonce: string;
    contractIdentification: "safe-interface-compatible";
  };
  history: {
    status: "not-requested" | "partial" | "service-exhausted" | "error";
    pagesFetched: number;
    recordsFetched: number;
  };
  materials: SafeTransactionMaterial[];
  errors: Issue[];
  warnings: string[];
  verification: {
    independentlyVerifiedSignatures: false;
    safeTransactionHashes: "source-reported-unless-individually-contract-bound";
    observations: SafeSignatureProof[];
  };
}
export class SafeProviderError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "SafeProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}
const fail = (code: string, message: string): never => {
  throw new SafeProviderError(code, message);
};
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Expected a structured provider response.",
    );
  return value as Row;
}
function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Provider returned an invalid integer.",
    );
  return value;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value))
    return fail("INVALID_SAFE_PROVIDER_DATA", "Invalid EVM address.");
  return value.toLowerCase() as Address;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Provider returned an invalid hash.",
    );
  return value.toLowerCase();
}
function hex(value: unknown, maxBytes = 100_000): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value) ||
    value.length > 2 + maxBytes * 2
  )
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Provider returned malformed or oversized bytes.",
    );
  return value.toLowerCase() as Hex;
}
function uint(value: unknown): string {
  if (typeof value === "number") value = String(integer(value));
  if (
    typeof value !== "string" ||
    !/^\d{1,78}$/.test(value) ||
    BigInt(value) >= 2n ** 256n
  )
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Provider returned an invalid unsigned integer.",
    );
  return BigInt(value).toString();
}
function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Provider returned an invalid RPC quantity.",
    );
  return integer(Number(BigInt(value)));
}
function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    // Configured RPC clients provide public metadata, never their credential-bearing transport URL.
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
function provenance(source: string, sourceUrl?: string): SafeProvenance {
  return {
    source,
    retrievedAt: new Date().toISOString(),
    synthetic: false,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
function issue(error: unknown, stage: Stage): Issue {
  const e =
    error && typeof error === "object"
      ? (error as { code?: unknown; retryable?: unknown })
      : {};
  const code =
    typeof e.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)
      ? e.code
      : "SAFE_ACQUISITION_FAILED";
  const messages: Record<string, string> = {
    SAFE_ACCESS_DENIED:
      "Safe service access was denied; no alternate endpoint or credentials were attempted.",
    SAFE_RATE_LIMITED:
      "Safe service rate or quota limit reached; no retry was attempted.",
    SAFE_NOT_CONTRACT:
      "No contract bytecode exists at the requested frozen block.",
    RPC_CHAIN_MISMATCH:
      "RPC chain identity does not match the requested chain.",
    RPC_BLOCK_UNAVAILABLE:
      "The requested canonical block or historical state is unavailable.",
    SAFE_CURSOR_REORG:
      "The cursor's block hash no longer matches the canonical block.",
    INVALID_SAFE_PAGINATION:
      "Safe service pagination changed the request scope or did not advance safely.",
    INVALID_SAFE_PROVIDER_DATA:
      "Safe provider data failed validation; the affected page was not retained.",
  };
  return {
    code,
    message:
      messages[code] ?? `Safe ${stage} acquisition is unavailable (${code}).`,
    retryable: e.retryable === true,
    stage,
  };
}
function decodeCursor(
  value: string,
  a: Address,
  chainId: number,
  block?: number,
): Cursor {
  try {
    if (value.length > 2048 || !/^[\w-]+$/.test(value)) throw new Error();
    const c = row(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (c.v !== 1 || c.address !== a || c.chainId !== chainId)
      throw new Error();
    const blockNumber = integer(c.blockNumber),
      blockHash = hash(c.blockHash),
      offset = integer(c.offset, 0, 100_000);
    if (
      offset % PAGE_SIZE !== 0 ||
      (block !== undefined && block !== blockNumber)
    )
      throw new Error();
    return {
      v: 1,
      chainId,
      address: a,
      blockNumber,
      blockHash,
      offset,
      ...(c.lastNonce === undefined ? {} : { lastNonce: uint(c.lastNonce) }),
    };
  } catch {
    return fail(
      "INVALID_SAFE_CURSOR",
      "Invalid cursor or cursor belongs to a different Safe, chain or block.",
    );
  }
}
const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString("base64url");
function serviceUrl(chainId: number, a: Address, offset: number): URL {
  const url = new URL(
    `${SERVICES[chainId]}/v2/safes/${getAddress(a)}/multisig-transactions/`,
  );
  for (const [key, value] of Object.entries({
    executed: "true",
    trusted: "false",
    ordering: "nonce,created",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  }))
    url.searchParams.set(key, value);
  return url;
}
function nextOffset(
  value: unknown,
  current: URL,
  offset: number,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048)
    return fail("INVALID_SAFE_PAGINATION", "Invalid next page.");
  let next: URL;
  try {
    next = new URL(value);
  } catch {
    return fail("INVALID_SAFE_PAGINATION", "Invalid next page URL.");
  }
  if (
    next.origin !== current.origin ||
    next.pathname !== current.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    next.searchParams.size !== current.searchParams.size
  )
    return fail(
      "INVALID_SAFE_PAGINATION",
      "Pagination crossed the allowlisted scope.",
    );
  for (const [k, v] of current.searchParams)
    if (
      k !== "offset" &&
      (next.searchParams.getAll(k).length !== 1 ||
        next.searchParams.get(k) !== v)
    )
      return fail(
        "INVALID_SAFE_PAGINATION",
        "Pagination changed an immutable filter.",
      );
  const raw = next.searchParams.get("offset");
  if (
    !raw ||
    !/^\d+$/.test(raw) ||
    next.searchParams.getAll("offset").length !== 1 ||
    Number(raw) !== offset + PAGE_SIZE ||
    Number(raw) > 100_000
  )
    return fail(
      "INVALID_SAFE_PAGINATION",
      "Pagination did not advance by one bounded page.",
    );
  return Number(raw);
}
let serviceQueue: Promise<void> = Promise.resolve();
let lastServiceRequest = 0;
async function pacedRequest<T>(run: () => Promise<T>): Promise<T> {
  const previous = serviceQueue;
  let release!: () => void;
  serviceQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const delay = Math.max(0, lastServiceRequest + 600 - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastServiceRequest = Date.now();
    return await run();
  } finally {
    release();
  }
}
async function fetchPage(url: URL, fetcher: typeof fetch): Promise<Row> {
  return pacedRequest(async () => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SafeProviderError(
        "SAFE_NETWORK_ERROR",
        "Safe service request failed.",
        true,
      );
    }
    if ([401, 403].includes(response.status))
      return fail("SAFE_ACCESS_DENIED", "Safe service denied access.");
    if (response.status === 429)
      throw new SafeProviderError(
        "SAFE_RATE_LIMITED",
        "Safe service rate limit reached.",
        true,
      );
    if (!response.ok)
      throw new SafeProviderError(
        "SAFE_HTTP_ERROR",
        "Safe service returned an HTTP error.",
        response.status >= 500,
      );
    if (response.url && response.url !== url.toString())
      return fail("INVALID_SAFE_PAGINATION", "Unexpected response URL.");
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_BODY_BYTES)
      return fail(
        "INVALID_SAFE_PROVIDER_DATA",
        "Safe service response exceeds the byte budget.",
      );
    const reader = response.body?.getReader();
    if (!reader)
      return fail("INVALID_SAFE_PROVIDER_DATA", "Empty Safe service response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return fail(
            "INVALID_SAFE_PROVIDER_DATA",
            "Safe service response exceeds the byte budget.",
          );
        }
        chunks.push(part.value);
      }
      return row(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof SafeProviderError) throw error;
      return fail("INVALID_SAFE_PROVIDER_DATA", "Malformed Safe service JSON.");
    } finally {
      reader.releaseLock();
    }
  });
}
function parameters(r: Row): TransactionParameters {
  const operation = integer(r.operation, 0, 1) as 0 | 1;
  return {
    to: address(r.to),
    value: uint(r.value),
    data: hex(r.data ?? "0x"),
    operation,
    safeTxGas: uint(r.safeTxGas),
    baseGas: uint(r.baseGas),
    gasPrice: uint(r.gasPrice),
    gasToken: address(r.gasToken),
    refundReceiver: address(r.refundReceiver),
    nonce: uint(r.nonce),
  };
}
function historyRecord(
  value: unknown,
  a: Address,
  chainId: number,
  p: SafeProvenance,
): { execution: SafeExecution; material: SafeTransactionMaterial } {
  const r = row(value);
  if (address(r.safe) !== a || r.isExecuted !== true)
    return fail(
      "INVALID_SAFE_PROVIDER_DATA",
      "Safe history scope does not match the request.",
    );
  const safeTxHash = hash(r.safeTxHash),
    transactionHash = hash(r.transactionHash),
    blockNumber = integer(r.blockNumber);
  const id = `safe:${chainId}:${safeTxHash}:execution`;
  if (
    r.isSuccessful !== true &&
    r.isSuccessful !== false &&
    r.isSuccessful !== null
  )
    return fail("INVALID_SAFE_PROVIDER_DATA", "Unknown execution status.");
  if (!Array.isArray(r.confirmations) || r.confirmations.length > 100)
    return fail("INVALID_SAFE_PROVIDER_DATA", "Malformed confirmation list.");
  const confirmations = r.confirmations.map((value) => {
    const c = row(value);
    if (typeof c.signatureType !== "string" || c.signatureType.length > 40)
      return fail("INVALID_SAFE_PROVIDER_DATA", "Malformed signature type.");
    return {
      owner: address(c.owner),
      signatureType: c.signatureType,
      ...(c.signature == null ? {} : { signature: hex(c.signature, 10_000) }),
      provenance: p,
    };
  });
  return {
    execution: {
      id,
      chainId,
      safeAddress: a,
      provenance: p,
      transactionHash,
      safeTxHash,
      executionIndex: `safe-tx:${safeTxHash}`,
      blockNumber,
      nonce: uint(r.nonce),
      status:
        r.isSuccessful === true
          ? "success"
          : r.isSuccessful === false
            ? "failure"
            : "unknown",
      authorizationPath: "owner-signatures",
      signatures: [],
      signatureCoverage: "unavailable",
    },
    material: {
      executionId: id,
      safeTxHash,
      blockNumber,
      parameters: parameters(r),
      ...(r.signatures == null
        ? {}
        : { executionSignatures: hex(r.signatures) }),
      confirmations,
      provenance: p,
    },
  };
}
function contractArgs(p: TransactionParameters) {
  return [
    getAddress(p.to),
    BigInt(p.value),
    p.data,
    p.operation,
    BigInt(p.safeTxGas),
    BigInt(p.baseGas),
    BigInt(p.gasPrice),
    getAddress(p.gasToken),
    getAddress(p.refundReceiver),
    BigInt(p.nonce),
  ] as const;
}
function packedSignatures(
  value: Hex,
): { raw: Hex; type: SafeSignatureProof["signatureType"]; signer?: Address }[] {
  const bytes = value.slice(2),
    total = bytes.length / 2;
  let end = total;
  const result: {
    raw: Hex;
    type: SafeSignatureProof["signatureType"];
    signer?: Address;
  }[] = [];
  for (let offset = 0; offset < end; offset += 65) {
    if (offset + 65 > end || result.length >= 100)
      return fail(
        "INVALID_SAFE_SIGNATURES",
        "Malformed packed signature boundary.",
      );
    const raw = `0x${bytes.slice(offset * 2, (offset + 65) * 2)}` as Hex;
    const v = Number.parseInt(raw.slice(-2), 16);
    const type: SafeSignatureProof["signatureType"] =
      v === 27 || v === 28
        ? "eoa"
        : v === 31 || v === 32
          ? "eth_sign"
          : v === 0
            ? "contract"
            : v === 1
              ? "approved-hash"
              : "unknown";
    let signer: Address | undefined;
    if (v === 0 || v === 1) {
      if (!/^0{24}$/i.test(raw.slice(2, 26)))
        return fail("INVALID_SAFE_SIGNATURES", "Malformed encoded signer.");
      signer = address(`0x${raw.slice(26, 66)}`);
      if (v === 0) {
        const dynamicOffset = Number(BigInt(`0x${raw.slice(66, 130)}`));
        if (
          !Number.isSafeInteger(dynamicOffset) ||
          dynamicOffset < offset + 65 ||
          dynamicOffset > total - 32 ||
          dynamicOffset % 65 !== 0
        )
          return fail(
            "INVALID_SAFE_SIGNATURES",
            "Malformed contract signature offset.",
          );
        end = Math.min(end, dynamicOffset);
        const dynamicLength = Number(
          BigInt(
            `0x${bytes.slice(dynamicOffset * 2, (dynamicOffset + 32) * 2)}`,
          ),
        );
        if (
          !Number.isSafeInteger(dynamicLength) ||
          dynamicOffset + 32 + dynamicLength > total
        )
          return fail(
            "INVALID_SAFE_SIGNATURES",
            "Malformed contract signature data.",
          );
      }
    }
    result.push({ raw, type, ...(signer ? { signer } : {}) });
  }
  return result;
}

/** Read-only, bounded acquisition. Source reports and individual EOA proofs remain separate. */
export async function acquireSafeEvidence(
  input: SafeAcquisitionInput,
  deps: { rpc: RpcClient; fetch?: typeof fetch },
): Promise<SafeAcquisitionResult> {
  let a: Address;
  try {
    a = address(input.address);
    integer(input.chainId, 1);
    if (!SERVICES[input.chainId]) throw new Error();
    if (input.blockNumber !== undefined) integer(input.blockNumber);
    if (input.maxPages !== undefined) integer(input.maxPages, 1, MAX_PAGES);
    if (input.maxSignatures !== undefined)
      integer(input.maxSignatures, 1, MAX_SIGNATURES);
    for (const v of [input.includeHistory, input.verifySignatures])
      if (v !== undefined && typeof v !== "boolean") throw new Error();
  } catch {
    return fail(
      "INVALID_SAFE_REQUEST",
      "Invalid Safe address, supported chain, block or acquisition budget.",
    );
  }
  if (deps.rpc.chainId !== input.chainId)
    return fail(
      "RPC_CHAIN_MISMATCH",
      "Configured RPC chain does not match the requested chain.",
    );
  const previous =
    input.cursor === undefined
      ? undefined
      : decodeCursor(input.cursor, a, input.chainId, input.blockNumber);
  const includeHistory = input.includeHistory ?? true;
  if (previous && !includeHistory)
    return fail(
      "INVALID_SAFE_CURSOR",
      "A history cursor requires history acquisition.",
    );
  const bundle: SafeEvidenceBundle = {
    version: 1,
    mode: "private",
    configurations: [],
    executions: [],
    configurationEvents: [],
    coverage: [],
    labels: [],
  };
  const result: SafeAcquisitionResult = {
    bundle,
    cursor: null,
    history: {
      status: includeHistory ? "partial" : "not-requested",
      pagesFetched: 0,
      recordsFetched: 0,
    },
    materials: [],
    errors: [],
    warnings: [
      "Safe interface compatibility does not authenticate a deployed Safe implementation, beneficial ownership or control.",
      "A frozen snapshot is end-of-block configuration; it is never applied to earlier or same-block executions.",
      "Service confirmations are collected observations, not proof of inclusion among execution signatures.",
      "Service pagination, module executions, configuration-change events and chain history completeness remain separate coverage gaps.",
    ],
    verification: {
      independentlyVerifiedSignatures: false,
      safeTransactionHashes:
        "source-reported-unless-individually-contract-bound",
      observations: [],
    },
  };
  const rpcP = () =>
    provenance(
      deps.rpc.source || `Configured chain ${input.chainId} JSON-RPC`,
      safeSourceUrl(deps.rpc.sourceUrl),
    );
  let blockNumber = previous?.blockNumber ?? input.blockNumber ?? 0;
  let blockHash: string;
  const blockHashes = new Map<number, string>();
  const canonicalTransactions = new Map<number, string[]>();
  let calls = 0;
  async function request(method: string, params: unknown[]) {
    if (++calls > 32)
      return fail(
        "SAFE_RPC_BUDGET_EXCEEDED",
        "Safe acquisition RPC budget exhausted.",
      );
    return deps.rpc.request(method, params);
  }
  async function blockAt(number: number): Promise<string> {
    const cached = blockHashes.get(number);
    if (cached) return cached;
    const b = row(
      await request("eth_getBlockByNumber", [
        `0x${number.toString(16)}`,
        false,
      ]),
    );
    if (quantity(b.number) !== number)
      return fail(
        "RPC_BLOCK_UNAVAILABLE",
        "Requested block identity is unavailable.",
      );
    const value = hash(b.hash);
    if (b.transactions !== undefined) {
      if (!Array.isArray(b.transactions) || b.transactions.length > 50_000)
        return fail(
          "INVALID_SAFE_PROVIDER_DATA",
          "Malformed canonical block transaction list.",
        );
      canonicalTransactions.set(number, b.transactions.map(hash));
    }
    blockHashes.set(number, value);
    return value;
  }
  function coverage(
    stream: SafeEvidenceBundle["coverage"][number]["stream"],
    status: SafeEvidenceBundle["coverage"][number]["status"],
    from = 0,
    p = rpcP(),
    scope?: "preflight-error" | "not-requested",
  ) {
    bundle.coverage.push({
      id: `safe:${input.chainId}:${a}:coverage:${stream}:${blockNumber}${scope ? `:${scope}` : ""}`,
      chainId: input.chainId,
      safeAddress: a,
      provenance: p,
      stream,
      fromBlock: from,
      toBlock: blockNumber,
      status,
      cursor: stream === "executions" ? result.cursor : null,
    });
  }
  try {
    if (quantity(await request("eth_chainId", [])) !== input.chainId)
      return fail("RPC_CHAIN_MISMATCH", "RPC chain mismatch.");
    const head = quantity(await request("eth_blockNumber", []));
    blockNumber = previous?.blockNumber ?? input.blockNumber ?? head;
    if (blockNumber > head)
      return fail("RPC_BLOCK_UNAVAILABLE", "Requested block is in the future.");
    blockHash = await blockAt(blockNumber);
    if (previous && previous.blockHash !== blockHash)
      return fail("SAFE_CURSOR_REORG", "Pinned block hash changed.");
  } catch (error) {
    result.errors.push(issue(error, "snapshot"));
    result.history.status = includeHistory ? "error" : "not-requested";
    coverage("configurations", "error", blockNumber, rpcP(), "preflight-error");
    coverage(
      "executions",
      includeHistory ? "error" : "unsupported",
      0,
      rpcP(),
      "preflight-error",
    );
    coverage(
      "configuration-events",
      "unsupported",
      0,
      rpcP(),
      "preflight-error",
    );
    coverage("signatures", "unsupported", 0, rpcP(), "preflight-error");
    result.bundle = parseSafeEvidence(bundle, "private");
    return result;
  }
  const frozen = { blockHash, requireCanonical: true };
  try {
    const code = hex(await request("eth_getCode", [a, frozen]));
    if (code === "0x")
      return fail("SAFE_NOT_CONTRACT", "No code at frozen block.");
    const ownerBytes = hex(
      await request("eth_call", [
        {
          to: a,
          data: encodeFunctionData({ abi: ABI, functionName: "getOwners" }),
        },
        frozen,
      ]),
    );
    const thresholdBytes = hex(
      await request("eth_call", [
        {
          to: a,
          data: encodeFunctionData({ abi: ABI, functionName: "getThreshold" }),
        },
        frozen,
      ]),
    );
    const nonceBytes = hex(
      await request("eth_call", [
        {
          to: a,
          data: encodeFunctionData({ abi: ABI, functionName: "nonce" }),
        },
        frozen,
      ]),
    );
    const owners = decodeFunctionResult({
      abi: ABI,
      functionName: "getOwners",
      data: ownerBytes,
    }).map(address);
    const threshold = Number(
      decodeFunctionResult({
        abi: ABI,
        functionName: "getThreshold",
        data: thresholdBytes,
      }),
    );
    const nonce = decodeFunctionResult({
      abi: ABI,
      functionName: "nonce",
      data: nonceBytes,
    }).toString();
    if (
      !owners.length ||
      owners.length > 100 ||
      owners.some((v) => BigInt(v) < 2n) ||
      new Set(owners).size !== owners.length
    )
      return fail(
        "INVALID_SAFE_PROVIDER_DATA",
        "Invalid Safe owner configuration.",
      );
    integer(threshold, 1, owners.length);
    bundle.configurations.push({
      id: `safe:${input.chainId}:${a}:config:${blockNumber}`,
      chainId: input.chainId,
      safeAddress: a,
      provenance: rpcP(),
      kind: "at-block",
      blockNumber,
      owners,
      threshold,
    });
    result.snapshot = {
      blockNumber,
      blockHash,
      nonce,
      contractIdentification: "safe-interface-compatible",
    };
    coverage("configurations", "exhausted", blockNumber);
  } catch (error) {
    result.errors.push(issue(error, "snapshot"));
    coverage("configurations", "error", blockNumber);
  }
  let offset = previous?.offset ?? 0,
    lastNonce = previous?.lastNonce;
  const seen = new Map<string, string>();
  const seenHashes = new Set<string>();
  let lastHistoryUrl: string | undefined;
  const historyP = () =>
    provenance(
      includeHistory
        ? "Safe Transaction Service (source-reported indexed multisig history)"
        : "Flowlens acquisition coverage: history not requested",
      lastHistoryUrl,
    );
  if (includeHistory) {
    for (let page = 0; page < (input.maxPages ?? 1); page++) {
      const url = serviceUrl(input.chainId, a, offset);
      result.cursor = encodeCursor({
        v: 1,
        chainId: input.chainId,
        address: a,
        blockNumber,
        blockHash,
        offset,
        ...(lastNonce ? { lastNonce } : {}),
      });
      try {
        lastHistoryUrl = url.toString();
        const response = await fetchPage(url, deps.fetch ?? globalThis.fetch);
        if (
          !Array.isArray(response.results) ||
          response.results.length > PAGE_SIZE
        )
          return fail(
            "INVALID_SAFE_PROVIDER_DATA",
            "Safe page exceeded the record budget.",
          );
        integer(response.count);
        const next = nextOffset(response.next, url, offset);
        if (next !== null && !response.results.length)
          return fail(
            "INVALID_SAFE_PAGINATION",
            "Empty page cannot advance history.",
          );
        const records = response.results.map((value) =>
          historyRecord(
            value,
            a,
            input.chainId,
            provenance(
              "Safe Transaction Service (source-reported indexed multisig history)",
              url.toString(),
            ),
          ),
        );
        let latest = lastNonce;
        const additions: typeof records = [];
        const nextSeen = new Map(seen);
        const nextHashes = new Set(seenHashes);
        for (const entry of records) {
          const nonce = entry.material.parameters.nonce;
          if (latest !== undefined && BigInt(nonce) < BigInt(latest))
            return fail(
              "INVALID_SAFE_PROVIDER_DATA",
              "Safe history ordering moved backwards.",
            );
          const fingerprint = JSON.stringify({
            execution: { ...entry.execution, provenance: undefined },
            material: {
              ...entry.material,
              provenance: undefined,
              confirmations: entry.material.confirmations.map(
                ({ provenance: _p, ...c }) => c,
              ),
            },
          });
          const prior = nextSeen.get(nonce);
          if (prior && prior !== fingerprint)
            return fail(
              "INVALID_SAFE_PROVIDER_DATA",
              "Conflicting Safe execution identity.",
            );
          if (
            !prior &&
            latest !== undefined &&
            BigInt(nonce) === BigInt(latest)
          )
            return fail(
              "INVALID_SAFE_PROVIDER_DATA",
              "A resumed page repeated the prior nonce.",
            );
          if (!prior && nextHashes.has(entry.material.safeTxHash))
            return fail(
              "INVALID_SAFE_PROVIDER_DATA",
              "A Safe transaction hash cannot identify different nonces.",
            );
          if (!prior && entry.execution.blockNumber <= blockNumber)
            additions.push(entry);
          nextSeen.set(nonce, fingerprint);
          nextHashes.add(entry.material.safeTxHash);
          latest = nonce;
        }
        bundle.executions.push(...additions.map((v) => v.execution));
        result.materials.push(...additions.map((v) => v.material));
        seen.clear();
        for (const [key, value] of nextSeen) seen.set(key, value);
        seenHashes.clear();
        for (const value of nextHashes) seenHashes.add(value);
        result.history.pagesFetched++;
        result.history.recordsFetched += records.length;
        lastNonce = latest;
        if (next === null) {
          result.cursor = null;
          result.history.status = "service-exhausted";
          break;
        }
        offset = next;
        result.cursor = encodeCursor({
          v: 1,
          chainId: input.chainId,
          address: a,
          blockNumber,
          blockHash,
          offset,
          ...(lastNonce ? { lastNonce } : {}),
        });
      } catch (error) {
        result.errors.push(issue(error, "history"));
        result.history.status = "error";
        break;
      }
    }
  }
  coverage(
    "executions",
    includeHistory
      ? result.history.status === "error"
        ? "error"
        : "partial"
      : "unsupported",
    0,
    historyP(),
    includeHistory ? undefined : "not-requested",
  );
  coverage("configuration-events", "unsupported");
  coverage(
    "signatures",
    includeHistory ? "partial" : "unsupported",
    0,
    historyP(),
    includeHistory ? undefined : "not-requested",
  );

  if (input.verifySignatures && includeHistory) {
    let remaining = input.maxSignatures ?? 2;
    for (const material of result.materials.slice(
      0,
      MAX_VERIFICATION_TRANSACTIONS,
    )) {
      if (remaining <= 0) break;
      const execution = bundle.executions.find(
        (e) => e.id === material.executionId,
      )!;
      const proofP = () =>
        provenance(
          `${deps.rpc.source || "Configured JSON-RPC"}: direct execution calldata, receipt and historical Safe hash`,
          safeSourceUrl(deps.rpc.sourceUrl),
        );
      const unverified = (reason: string, bound = false) =>
        result.verification.observations.push({
          signatureId: `${execution.id}:proof`,
          executionId: execution.id,
          status: "unverified",
          reason,
          digestBoundToSafeContract: bound,
          scope: "direct-execution-calldata",
          participation: "unresolved",
          provenance: proofP(),
        });
      try {
        const executionBlockHash = await blockAt(material.blockNumber);
        const tx = row(
          await request("eth_getTransactionByHash", [
            execution.transactionHash,
          ]),
        );
        if (
          hash(tx.hash) !== execution.transactionHash ||
          address(tx.to) !== a ||
          quantity(tx.blockNumber) !== material.blockNumber ||
          hash(tx.blockHash) !== executionBlockHash
        ) {
          unverified(
            "Direct transaction destination or block identity does not match this Safe execution.",
          );
          continue;
        }
        const receipt = row(
          await request("eth_getTransactionReceipt", [
            execution.transactionHash,
          ]),
        );
        if (
          hash(receipt.transactionHash) !== execution.transactionHash ||
          quantity(receipt.blockNumber) !== material.blockNumber ||
          hash(receipt.blockHash) !== executionBlockHash ||
          quantity(receipt.status) !== 1 ||
          !Array.isArray(receipt.logs) ||
          receipt.logs.length > 10_000
        ) {
          unverified("Matching successful outer receipt is unavailable.");
          continue;
        }
        const transactionIndex = quantity(tx.transactionIndex);
        if (
          quantity(receipt.transactionIndex) !== transactionIndex ||
          canonicalTransactions.get(material.blockNumber)?.[
            transactionIndex
          ] !== execution.transactionHash ||
          (tx.chainId !== undefined && quantity(tx.chainId) !== input.chainId)
        ) {
          unverified(
            "Transaction and receipt indexes do not establish matching canonical block membership.",
          );
          continue;
        }
        const decoded = decodeFunctionData({ abi: ABI, data: hex(tx.input) });
        if (decoded.functionName !== "execTransaction") {
          unverified("The direct call is not Safe execTransaction.");
          continue;
        }
        const expected = contractArgs(material.parameters).slice(0, 9);
        if (
          !decoded.args ||
          decoded.args
            .slice(0, 9)
            .some(
              (v, i) =>
                String(v).toLowerCase() !== String(expected[i]).toLowerCase(),
            )
        ) {
          unverified(
            "Execution calldata parameters differ from indexed transaction material.",
          );
          continue;
        }
        const logs = receipt.logs.filter((value) => {
          const l = row(value);
          if (
            typeof l.address !== "string" ||
            l.address.toLowerCase() !== a ||
            !Array.isArray(l.topics) ||
            l.topics.length !== 1 ||
            ![SUCCESS, FAILURE].includes(
              String(l.topics[0]).toLowerCase() as Hex,
            )
          )
            return false;
          const [eventHash] = decodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint256" }],
            hex(l.data),
          );
          return eventHash.toLowerCase() === material.safeTxHash;
        });
        if (logs.length !== 1) {
          unverified("A unique matching Safe execution event is unavailable.");
          continue;
        }
        const log = row(logs[0]);
        if (
          (log.transactionHash !== undefined &&
            hash(log.transactionHash) !== execution.transactionHash) ||
          (log.blockHash !== undefined &&
            hash(log.blockHash) !== executionBlockHash) ||
          (log.blockNumber !== undefined &&
            quantity(log.blockNumber) !== material.blockNumber) ||
          (log.transactionIndex !== undefined &&
            quantity(log.transactionIndex) !== transactionIndex) ||
          log.removed === true
        ) {
          unverified(
            "Safe event identity does not match the canonical receipt.",
          );
          continue;
        }
        const eventSuccess =
          String((log.topics as unknown[])[0]).toLowerCase() === SUCCESS;
        if (
          execution.status !== "unknown" &&
          eventSuccess !== (execution.status === "success")
        ) {
          unverified(
            "Safe event conflicts with the source-reported execution status.",
          );
          continue;
        }
        const digestBytes = hex(
          await request("eth_call", [
            {
              to: a,
              data: encodeFunctionData({
                abi: ABI,
                functionName: "getTransactionHash",
                args: contractArgs(material.parameters),
              }),
            },
            { blockHash: executionBlockHash, requireCanonical: true },
          ]),
        );
        const digest = decodeFunctionResult({
          abi: ABI,
          functionName: "getTransactionHash",
          data: digestBytes,
        });
        if (digest.toLowerCase() !== material.safeTxHash) {
          unverified(
            "Contract-computed Safe transaction hash does not match the indexed hash.",
          );
          continue;
        }
        const packed = hex(decoded.args[9]);
        if (
          material.executionSignatures !== undefined &&
          packed !== material.executionSignatures
        ) {
          unverified(
            "Indexed execution signatures differ from direct calldata signatures.",
            true,
          );
          continue;
        }
        const signatures = packedSignatures(packed);
        execution.transactionIndex = transactionIndex;
        for (
          let index = 0;
          index < signatures.length && remaining > 0;
          index++, remaining--
        ) {
          const signature = signatures[index],
            id = `${execution.id}:signature:${index}`;
          const proof: SafeSignatureProof = {
            signatureId: id,
            executionId: execution.id,
            status: "unverified",
            reason: "This signature type needs a separate validation path.",
            digestBoundToSafeContract: true,
            signatureType: signature.type,
            scope: "direct-execution-calldata",
            participation: "unresolved",
            provenance: proofP(),
          };
          if (signature.type === "eoa" || signature.type === "eth_sign") {
            const v = Number.parseInt(signature.raw.slice(-2), 16);
            const normalized = (
              signature.type === "eth_sign"
                ? `${signature.raw.slice(0, -2)}${(v - 4).toString(16)}`
                : signature.raw
            ) as Hex;
            try {
              const signer = address(
                await recoverAddress({
                  hash:
                    signature.type === "eth_sign"
                      ? hashMessage({ raw: digest })
                      : digest,
                  signature: normalized,
                }),
              );
              const claimed = material.confirmations.filter(
                (c) => c.signature === signature.raw,
              );
              if (claimed.some((c) => c.owner !== signer))
                proof.reason =
                  "Recovered signer conflicts with a source-reported owner for these same signature bytes.";
              else {
                proof.status = "verified-eoa";
                proof.recoveredSigner = signer;
                proof.reason =
                  "EOA recovery verified signature bytes in matching direct calldata against the historical contract-bound digest. Participation in the Safe's consumed signature prefix is unresolved; configured quorum and ownership are not established.";
                execution.signatures.push({
                  id,
                  signer,
                  type: "eoa",
                  observation: "source-recovered",
                  participation: "calldata-only",
                  provenance: proofP(),
                });
              }
            } catch {
              proof.reason = "EOA signature recovery failed.";
            }
          }
          result.verification.observations.push(proof);
        }
        execution.signatureCoverage = execution.signatures.length
          ? "partial"
          : "unavailable";
      } catch (error) {
        result.errors.push(issue(error, "verification"));
        unverified(
          "Execution material or historical signature verification is unavailable.",
        );
      }
    }
    result.warnings.push(
      "Individual EOA proofs cover direct execTransaction calldata only. Recoverable suffix signatures may not have been consumed by the Safe; participation remains unresolved and calldata-only identities are excluded from quorum comparisons. Contract signatures, approved hashes, modules, batching and unexamined signatures remain unverified.",
    );
  }
  result.bundle = parseSafeEvidence(bundle, "private");
  return result;
}
