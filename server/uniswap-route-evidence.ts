import type { Address, Transfer } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";
import {
  extractReceiptSwapProceeds,
  type CanonicalPoolTokens,
  type ReceiptSwapRoute,
  type SwapProceeds,
  type SwapReceipt,
} from "./swap-proceeds.ts";

const CHAIN_ID = 1;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x[0-9a-f]*$/i;
const HEX_QUANTITY = /^0x[0-9a-f]+$/i;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V2_SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const V3_FEE_SELECTOR = "0xddca3f43";
const MAX_RECEIPT_LOGS = 256;
const MAX_SWAP_CANDIDATES = 16;
const MAX_POOL_RPC_CONCURRENCY = 4;

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

// Mainnet deployments from Uniswap's maintained deployment sources:
// - https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts
// - https://github.com/Uniswap/v3-periphery/blob/main/deploys.md
// - https://github.com/Uniswap/swap-router-contracts/releases
// - https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/mainnet.json
export const UNISWAP_V2_ROUTER_02 =
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d" as Address;
export const UNISWAP_V3_SWAP_ROUTER =
  "0xe592427a0aece92de3edee1f18e0157c05861564" as Address;
export const UNISWAP_V3_SWAP_ROUTER_02 =
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45" as Address;
export const UNISWAP_UNIVERSAL_ROUTER_V1 =
  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b" as Address;
export const UNISWAP_UNIVERSAL_ROUTER_V1_2 =
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad" as Address;
export const UNISWAP_UNIVERSAL_ROUTER_V2 =
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af" as Address;
export const UNISWAP_UNIVERSAL_ROUTER_V2_1_1 =
  "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca" as Address;
export const UNISWAP_UNIVERSAL_ROUTER_V2_1_2 =
  "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85" as Address;

export const DEFAULT_UNISWAP_MAINNET_ROUTERS: readonly Address[] =
  Object.freeze([
    UNISWAP_V2_ROUTER_02,
    UNISWAP_V3_SWAP_ROUTER,
    UNISWAP_V3_SWAP_ROUTER_02,
    UNISWAP_UNIVERSAL_ROUTER_V1,
    UNISWAP_UNIVERSAL_ROUTER_V1_2,
    UNISWAP_UNIVERSAL_ROUTER_V2,
    UNISWAP_UNIVERSAL_ROUTER_V2_1_1,
    UNISWAP_UNIVERSAL_ROUTER_V2_1_2,
  ]);

export const UNISWAP_V2_FACTORY =
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f" as Address;
export const UNISWAP_V3_FACTORY =
  "0x1f98431c8ad98523631ae4a59f267346ea31f984" as Address;
export const UNISWAP_V2_GET_PAIR_SELECTOR = "0xe6a43905";
export const UNISWAP_V3_GET_POOL_SELECTOR = "0x1698ee82";

export type UniswapPoolVersion = "v2" | "v3";
export type UniswapRouteEvidenceStatus =
  "verified" | "not-found" | "unavailable";
export type UniswapRouteEvidenceReason =
  | "invalid-transfer"
  | "unsupported-router"
  | "receipt-unavailable"
  | "receipt-invalid"
  | "receipt-too-large"
  | "failed-transaction"
  | "no-v2-v3-swap"
  | "candidate-cap"
  | "no-matching-route"
  | "provider-unavailable";

export interface UniswapRouteLeg {
  router: Address;
  pool: Address;
  version: UniswapPoolVersion;
  token: Address;
  walletAmount: string;
  poolAmount: string;
  walletTransferLogIndex: number;
  routerTransferLogIndex: number;
  swapLogIndex: number;
}

export interface UniswapRouteEvidence {
  status: UniswapRouteEvidenceStatus;
  reason?: UniswapRouteEvidenceReason;
  transactionHash: `0x${string}` | null;
  blockNumber: number | null;
  router: Address | null;
  legs: UniswapRouteLeg[];
  /** Receipt-bound pool output; never implies wallet custody. */
  poolOutputs?: SwapProceeds[];
}

interface RouteLog {
  address: Address;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  removed: boolean;
}

interface RouteReceipt {
  transactionHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  status: bigint;
  logs: RouteLog[];
}

interface SwapCandidate {
  pool: Address;
  version: UniswapPoolVersion;
  log: RouteLog;
}

interface CanonicalPool {
  pool: Address;
  version: UniswapPoolVersion;
  tokenIndex: 0 | 1;
  token0: Address;
  token1: Address;
}

type PoolCheck =
  | { status: "verified"; pool: CanonicalPool }
  | { status: "not-found" }
  | { status: "failed" };

function normalizedAddress(value: unknown): Address | null {
  return typeof value === "string" && ADDRESS.test(value)
    ? (value.toLowerCase() as Address)
    : null;
}

function quantity(value: unknown): number | null {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) return null;
  try {
    const result = BigInt(value);
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
  } catch {
    return null;
  }
}

function topicAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(value))
    return null;
  return `0x${value.slice(-40)}`.toLowerCase() as Address;
}

function paddedAddress(value: Address): string {
  return `0x${value.slice(2).padStart(64, "0")}`;
}

function decodeUint(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value))
    return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function decodeAddressResult(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value))
    return null;
  return `0x${value.slice(-40)}`.toLowerCase() as Address;
}

function decodeSigned(value: unknown): bigint | null {
  const unsigned = decodeUint(value);
  if (unsigned === null) return null;
  return unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
}

function word(data: string, index: number): string | null {
  if (!/^0x[0-9a-f]+$/i.test(data)) return null;
  const start = 2 + index * 64;
  const end = start + 64;
  return data.length >= end ? `0x${data.slice(start, end)}` : null;
}

function parseRouteLog(value: unknown): RouteLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const address = normalizedAddress(item.address);
  const blockNumber = quantity(item.blockNumber);
  const logIndex = quantity(item.logIndex);
  if (
    !address ||
    blockNumber === null ||
    logIndex === null ||
    typeof item.blockHash !== "string" ||
    !HASH.test(item.blockHash) ||
    typeof item.transactionHash !== "string" ||
    !HASH.test(item.transactionHash) ||
    !Array.isArray(item.topics) ||
    item.topics.some(
      (topic) => typeof topic !== "string" || !HEX.test(topic),
    ) ||
    typeof item.data !== "string" ||
    !HEX.test(item.data) ||
    (item.removed !== undefined && typeof item.removed !== "boolean")
  )
    return null;
  return {
    address,
    topics: item.topics as string[],
    data: item.data,
    blockNumber,
    blockHash: item.blockHash.toLowerCase() as `0x${string}`,
    transactionHash: item.transactionHash.toLowerCase() as `0x${string}`,
    logIndex,
    removed: item.removed === true,
  };
}

function parseReceipt(
  value: unknown,
):
  | { kind: "ok"; receipt: RouteReceipt }
  | { kind: "failed" }
  | { kind: "invalid" }
  | { kind: "too-large" } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "invalid" };
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.logs)) return { kind: "invalid" };
  if (item.logs.length > MAX_RECEIPT_LOGS) return { kind: "too-large" };
  const blockNumber = quantity(item.blockNumber);
  if (
    blockNumber === null ||
    typeof item.transactionHash !== "string" ||
    !HASH.test(item.transactionHash) ||
    typeof item.blockHash !== "string" ||
    !HASH.test(item.blockHash) ||
    typeof item.status !== "string" ||
    !HEX_QUANTITY.test(item.status)
  )
    return { kind: "invalid" };
  let status: bigint;
  try {
    status = BigInt(item.status);
  } catch {
    return { kind: "invalid" };
  }
  if (status === 0n) return { kind: "failed" };
  if (status !== 1n) return { kind: "invalid" };
  const logs = item.logs.map(parseRouteLog);
  if (logs.some((log): log is null => log === null)) return { kind: "invalid" };
  return {
    kind: "ok",
    receipt: {
      transactionHash: item.transactionHash.toLowerCase() as `0x${string}`,
      blockNumber,
      blockHash: item.blockHash.toLowerCase() as `0x${string}`,
      status,
      logs: logs as RouteLog[],
    },
  };
}

function candidate(value: RouteLog): SwapCandidate | null {
  if (value.removed || value.topics.length !== 3) return null;
  const topic = value.topics[0]?.toLowerCase();
  if (
    topic === V2_SWAP_TOPIC &&
    /^0x[0-9a-f]{256}$/i.test(value.data) &&
    topicAddress(value.topics[1]) &&
    topicAddress(value.topics[2])
  )
    return { pool: value.address, version: "v2", log: value };
  if (
    topic === V3_SWAP_TOPIC &&
    /^0x[0-9a-f]{320}$/i.test(value.data) &&
    topicAddress(value.topics[1]) &&
    topicAddress(value.topics[2])
  )
    return { pool: value.address, version: "v3", log: value };
  return null;
}

function transferAt(
  receipt: RouteReceipt,
  transfer: Transfer,
  router: Address,
): RouteLog | null {
  const eventIndex = transfer.eventIndex.match(/^log\.(\d+)$/);
  if (!eventIndex) return null;
  const expectedLogIndex = Number(eventIndex[1]);
  if (!Number.isSafeInteger(expectedLogIndex)) return null;
  const token = transfer.asset.contract?.toLowerCase();
  if (!token) return null;
  for (const log of receipt.logs) {
    if (
      log.removed ||
      log.address !== token ||
      log.blockNumber !== transfer.blockNumber ||
      log.blockHash !== receipt.blockHash ||
      log.transactionHash !== transfer.hash.toLowerCase() ||
      log.logIndex !== expectedLogIndex ||
      log.topics.length < 3 ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
      !/^0x[0-9a-f]{64}$/i.test(log.data) ||
      topicAddress(log.topics[1]) !== transfer.from.toLowerCase() ||
      topicAddress(log.topics[2]) !== router
    )
      continue;
    try {
      if (BigInt(log.data) !== BigInt(transfer.rawAmount)) continue;
    } catch {
      continue;
    }
    return log;
  }
  return null;
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await operation(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return output;
}

async function canonicalPool(
  rpc: RpcClient,
  candidateValue: SwapCandidate,
  token: Address,
  blockTag: string,
): Promise<PoolCheck> {
  try {
    const pairResults = await Promise.all([
      rpc.request("eth_call", [
        { to: candidateValue.pool, data: TOKEN0_SELECTOR },
        blockTag,
      ]),
      rpc.request("eth_call", [
        { to: candidateValue.pool, data: TOKEN1_SELECTOR },
        blockTag,
      ]),
      ...(candidateValue.version === "v3"
        ? [
            rpc.request("eth_call", [
              { to: candidateValue.pool, data: V3_FEE_SELECTOR },
              blockTag,
            ]),
          ]
        : []),
    ]);
    const token0 = decodeAddressResult(pairResults[0]);
    const token1 = decodeAddressResult(pairResults[1]);
    if (
      !token0 ||
      !token1 ||
      token0 === ZERO_ADDRESS ||
      token1 === ZERO_ADDRESS
    )
      return { status: "not-found" };
    const tokenIndex = token0 === token ? 0 : token1 === token ? 1 : null;
    if (tokenIndex === null) return { status: "not-found" };
    let factoryCall: string;
    let factory: Address;
    if (candidateValue.version === "v2") {
      factory = UNISWAP_V2_FACTORY;
      factoryCall = `${UNISWAP_V2_GET_PAIR_SELECTOR}${paddedAddress(token0).slice(2)}${paddedAddress(token1).slice(2)}`;
    } else {
      const fee = decodeUint(pairResults[2]);
      if (fee === null || fee < 1n || fee > 0xffffffn)
        return { status: "not-found" };
      factory = UNISWAP_V3_FACTORY;
      factoryCall = `${UNISWAP_V3_GET_POOL_SELECTOR}${paddedAddress(token0).slice(2)}${paddedAddress(token1).slice(2)}${fee.toString(16).padStart(64, "0")}`;
    }
    const canonical = await rpc.request("eth_call", [
      { to: factory, data: factoryCall },
      blockTag,
    ]);
    const resolved = decodeAddressResult(canonical);
    if (resolved !== candidateValue.pool) return { status: "not-found" };
    return {
      status: "verified",
      pool: {
        pool: candidateValue.pool,
        version: candidateValue.version,
        tokenIndex,
        token0,
        token1,
      },
    };
  } catch {
    return { status: "failed" };
  }
}

function swapInputAmount(
  candidateValue: SwapCandidate,
  tokenIndex: 0 | 1,
): bigint | null {
  const input = word(candidateValue.log.data, tokenIndex);
  if (input === null) return null;
  return candidateValue.version === "v2"
    ? decodeUint(input)
    : decodeSigned(input);
}

function poolOutputsForRoute(
  receipt: RouteReceipt,
  candidates: SwapCandidate[],
  checks: PoolCheck[],
  legs: UniswapRouteLeg[],
): SwapProceeds[] {
  const poolTokens = new Map<Address, CanonicalPoolTokens>();
  checks.forEach((check) => {
    if (check.status !== "verified") return;
    poolTokens.set(check.pool.pool, {
      token0: check.pool.token0,
      token1: check.pool.token1,
    });
  });
  const route: ReceiptSwapRoute = {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    legs: legs.map((leg) => {
      const candidateValue = candidates.find(
        (candidate) =>
          candidate.pool === leg.pool &&
          candidate.version === leg.version &&
          candidate.log.logIndex === leg.swapLogIndex,
      );
      const outputRecipient = candidateValue
        ? topicAddress(candidateValue.log.topics[2])
        : null;
      return {
        pool: leg.pool,
        version: leg.version,
        token: leg.token,
        poolAmount: leg.poolAmount,
        swapLogIndex: leg.swapLogIndex,
        ...(outputRecipient ? { outputRecipient } : {}),
      };
    }),
  };
  const receiptForProceeds: SwapReceipt = {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: "0x1",
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: log.logIndex,
      removed: log.removed,
    })),
  };
  return extractReceiptSwapProceeds(receiptForProceeds, route, poolTokens);
}

function notFound(
  reason: UniswapRouteEvidenceReason,
  router: Address | null,
  transactionHash: `0x${string}` | null = null,
  blockNumber: number | null = null,
): UniswapRouteEvidence {
  return {
    status: "not-found",
    reason,
    transactionHash,
    blockNumber,
    router,
    legs: [],
  };
}

function unavailable(
  reason: UniswapRouteEvidenceReason,
  router: Address | null,
  transactionHash: `0x${string}` | null = null,
  blockNumber: number | null = null,
): UniswapRouteEvidence {
  return {
    status: "unavailable",
    reason,
    transactionHash,
    blockNumber,
    router,
    legs: [],
  };
}

/**
 * Verify only a direct, receipt-visible wallet -> known Uniswap router ->
 * canonical V2/V3 pool route. This deliberately does not trace calldata,
 * Permit2, aggregators, V4 singleton pools, or arbitrary intermediary calls.
 */
export async function detectUniswapRouteEvidence(
  rpc: RpcClient,
  transfer: Transfer,
): Promise<UniswapRouteEvidence> {
  const token = transfer.asset.contract?.toLowerCase() as Address | null;
  const router = normalizedAddress(transfer.to);
  if (
    rpc.chainId !== CHAIN_ID ||
    transfer.chainId !== CHAIN_ID ||
    transfer.kind !== "erc20" ||
    transfer.status !== "success" ||
    !HASH.test(transfer.hash) ||
    !normalizedAddress(transfer.from) ||
    !token ||
    !ADDRESS.test(token) ||
    transfer.blockNumber < 0 ||
    !Number.isSafeInteger(transfer.blockNumber) ||
    !/^log\.\d+$/.test(transfer.eventIndex) ||
    !/^\d+$/.test(transfer.rawAmount) ||
    BigInt(transfer.rawAmount) < 1n
  )
    return notFound("invalid-transfer", router);
  if (!router || !DEFAULT_UNISWAP_MAINNET_ROUTERS.includes(router))
    return notFound(
      "unsupported-router",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  let rawReceipt: unknown;
  try {
    rawReceipt = await rpc.request("eth_getTransactionReceipt", [
      transfer.hash,
    ]);
  } catch {
    return unavailable(
      "receipt-unavailable",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  }
  if (rawReceipt === null)
    return unavailable(
      "receipt-unavailable",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  const parsed = parseReceipt(rawReceipt);
  if (parsed.kind === "failed")
    return notFound(
      "failed-transaction",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  if (parsed.kind === "too-large")
    return unavailable(
      "receipt-too-large",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  if (parsed.kind === "invalid")
    return unavailable(
      "receipt-invalid",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  const receipt = parsed.receipt;
  if (
    receipt.transactionHash !== transfer.hash.toLowerCase() ||
    receipt.blockNumber !== transfer.blockNumber
  )
    return unavailable(
      "receipt-invalid",
      router,
      transfer.hash as `0x${string}`,
      transfer.blockNumber,
    );
  const walletTransfer = transferAt(receipt, transfer, router);
  if (!walletTransfer)
    return notFound(
      "no-matching-route",
      router,
      receipt.transactionHash,
      receipt.blockNumber,
    );
  const candidates = receipt.logs
    .map(candidate)
    .filter((item): item is SwapCandidate => item !== null);
  if (!candidates.length)
    return notFound(
      "no-v2-v3-swap",
      router,
      receipt.transactionHash,
      receipt.blockNumber,
    );
  if (candidates.length > MAX_SWAP_CANDIDATES)
    return unavailable(
      "candidate-cap",
      router,
      receipt.transactionHash,
      receipt.blockNumber,
    );
  const checks = await mapConcurrent(
    candidates,
    MAX_POOL_RPC_CONCURRENCY,
    (item) =>
      canonicalPool(rpc, item, token, `0x${transfer.blockNumber.toString(16)}`),
  );
  const legs: UniswapRouteLeg[] = [];
  let failures = 0;
  checks.forEach((check, index) => {
    if (check.status === "failed") {
      failures += 1;
      return;
    }
    if (check.status !== "verified") return;
    const candidateValue = candidates[index];
    const routeTransfer = receipt.logs.find((log) => {
      if (
        log.removed ||
        log.address !== token ||
        log.blockNumber !== receipt.blockNumber ||
        log.blockHash !== receipt.blockHash ||
        log.transactionHash !== receipt.transactionHash ||
        log.logIndex <= walletTransfer.logIndex ||
        log.logIndex >= candidateValue.log.logIndex ||
        log.topics.length < 3 ||
        log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
        !/^0x[0-9a-f]{64}$/i.test(log.data) ||
        topicAddress(log.topics[1]) !== router ||
        topicAddress(log.topics[2]) !== check.pool.pool
      )
        return false;
      try {
        return BigInt(log.data) === BigInt(transfer.rawAmount);
      } catch {
        return false;
      }
    });
    if (!routeTransfer) return;
    const inputAmount = swapInputAmount(candidateValue, check.pool.tokenIndex);
    if (inputAmount === null || inputAmount <= 0n) return;
    if (inputAmount !== BigInt(transfer.rawAmount)) return;
    legs.push({
      router,
      pool: check.pool.pool,
      version: check.pool.version,
      token,
      walletAmount: transfer.rawAmount,
      poolAmount: BigInt(routeTransfer.data).toString(),
      walletTransferLogIndex: walletTransfer.logIndex,
      routerTransferLogIndex: routeTransfer.logIndex,
      swapLogIndex: candidateValue.log.logIndex,
    });
  });
  if (legs.length)
    return {
      status: "verified",
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      router,
      legs,
      poolOutputs: poolOutputsForRoute(receipt, candidates, checks, legs),
    };
  if (failures) {
    return unavailable(
      "provider-unavailable",
      router,
      receipt.transactionHash,
      receipt.blockNumber,
    );
  }
  return notFound(
    "no-matching-route",
    router,
    receipt.transactionHash,
    receipt.blockNumber,
  );
}
