import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address } from "../src/domain/types.ts";
import { createPublicRpcClient } from "./rpc.ts";
import type { PublicRpcOptions, RpcClient } from "./rpc.ts";

const ETHEREUM_CHAIN_ID = 1;
const MULTICALL3_ADDRESS =
  "0xca11bde05977b3631167028862be2a173976ca11" as Address;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const MAX_WALLETS = 500;
const MAX_TOKENS = 100;
const MAX_CALLS = 2_000;
const MAX_CACHE_TTL_MS = 15 * 60_000;
const MAX_SYMBOL_LENGTH = 64;
const BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);
const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);

export type EntityTokenBalanceRpc = RpcClient;

export interface EntityTokenTarget {
  contract: Address | string;
  symbol?: string;
  decimals?: number;
}

export interface EntityTokenBalanceConfig {
  /** External scope only; this module does not infer ownership or EOA/contract status. */
  wallets: readonly (Address | string)[];
  tokens: readonly EntityTokenTarget[];
}

export interface EntityTokenBalanceOptions {
  rpcClient?: EntityTokenBalanceRpc;
  createRpcClient?: (
    chainId: number,
    options: PublicRpcOptions,
  ) => EntityTokenBalanceRpc;
  now?: () => string;
  cacheTtlMs?: number;
}

export interface EntityTokenBalanceIssue {
  wallet: Address | null;
  token: Address | null;
  code: string;
  message: string;
}

export interface EntityWalletTokenStatus {
  wallet: Address;
  status: "complete" | "partial" | "unavailable";
  successfulTokens: number;
  failedTokens: number;
}

export interface EntityTokenTotal {
  contract: Address;
  symbol: string;
  decimals: number | null;
  /** Null means no wallet call succeeded; zero is reserved for a confirmed zero. */
  rawBalance: string | null;
  amount: string | null;
  successfulWallets: number;
}

export interface EntityTokenBalanceResult {
  chainId: 1;
  retrievedAt: string;
  coverage: {
    requestedWallets: number;
    requestedTokens: number;
    requestedCalls: number;
    successfulCalls: number;
    failedCalls: number;
    complete: boolean;
    status: "complete" | "partial" | "error";
  };
  wallets: EntityWalletTokenStatus[];
  tokens: EntityTokenTotal[];
  issues: EntityTokenBalanceIssue[];
}

export interface EntityTokenBalanceReader {
  read(config: EntityTokenBalanceConfig): Promise<EntityTokenBalanceResult>;
}

interface NormalizedToken {
  contract: Address;
  symbol: string;
  decimals: number | null;
}

interface NormalizedConfig {
  wallets: Address[];
  tokens: NormalizedToken[];
}

interface AggregateRow {
  success: boolean;
  returnData: string;
}

function invalid(message: string): never {
  throw new Error(message);
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    invalid(`Invalid ${field}.`);
  return value.toLowerCase() as Address;
}

function validateDecimals(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 255
  )
    invalid("Token decimals must be an integer from 0 through 255.");
  return value as number;
}

function normalizeSymbol(value: unknown): string {
  if (value === undefined || value === null || value === "") return "TOKEN";
  if (
    typeof value !== "string" ||
    value.length > MAX_SYMBOL_LENGTH ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    invalid("Token symbols must be short printable ASCII text.");
  return value;
}

function normalizeConfig(config: EntityTokenBalanceConfig): NormalizedConfig {
  if (
    !config ||
    !Array.isArray(config.wallets) ||
    !Array.isArray(config.tokens)
  )
    invalid("Entity token balance config must contain wallets and tokens.");
  if (!config.wallets.length || !config.tokens.length)
    invalid("Entity token balance config needs at least one wallet and token.");
  if (config.wallets.length > MAX_WALLETS)
    invalid(`Entity token balance supports at most ${MAX_WALLETS} wallets.`);
  if (config.tokens.length > MAX_TOKENS)
    invalid(`Entity token balance supports at most ${MAX_TOKENS} tokens.`);

  const wallets = [
    ...new Set(
      config.wallets.map((value) => canonicalAddress(value, "wallet")),
    ),
  ];
  const tokens: NormalizedToken[] = [];
  const byContract = new Map<string, NormalizedToken>();
  for (const target of config.tokens) {
    if (!target || typeof target !== "object") invalid("Invalid token target.");
    const contract = canonicalAddress(target.contract, "token contract");
    const symbol = normalizeSymbol(target.symbol);
    const tokenDecimals = validateDecimals(target.decimals);
    const previous = byContract.get(contract);
    if (previous) {
      if (previous.symbol !== symbol || previous.decimals !== tokenDecimals)
        invalid(`Duplicate token metadata for ${contract}.`);
      continue;
    }
    const normalized: NormalizedToken = {
      contract,
      symbol,
      decimals: tokenDecimals,
    };
    byContract.set(contract, normalized);
    tokens.push(normalized);
  }
  if (wallets.length * tokens.length > MAX_CALLS)
    invalid(`Entity token balance supports at most ${MAX_CALLS} calls.`);
  return { wallets, tokens };
}

function cacheKey(config: NormalizedConfig): string {
  return JSON.stringify({
    wallets: config.wallets,
    tokens: config.tokens.map(({ contract, symbol, decimals }) => ({
      contract,
      symbol,
      decimals,
    })),
  });
}

function amount(raw: string, decimals: number | null): string | null {
  if (decimals === null) return null;
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function issueFromError(error: unknown): EntityTokenBalanceIssue {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "RPC_ERROR")
      : "RPC_ERROR";
  return {
    wallet: null,
    token: null,
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "RPC_ERROR",
    message:
      "Multicall3 balance batch was unavailable; no aggregate is complete.",
  };
}

function baseResult(
  config: NormalizedConfig,
  retrievedAt: string,
): EntityTokenBalanceResult {
  const requestedCalls = config.wallets.length * config.tokens.length;
  return {
    chainId: ETHEREUM_CHAIN_ID,
    retrievedAt,
    coverage: {
      requestedWallets: config.wallets.length,
      requestedTokens: config.tokens.length,
      requestedCalls,
      successfulCalls: 0,
      failedCalls: requestedCalls,
      complete: false,
      status: "error",
    },
    wallets: config.wallets.map((wallet) => ({
      wallet,
      status: "unavailable",
      successfulTokens: 0,
      failedTokens: config.tokens.length,
    })),
    tokens: config.tokens.map((token) => ({
      contract: token.contract,
      symbol: token.symbol,
      decimals: token.decimals,
      rawBalance: null,
      amount: null,
      successfulWallets: 0,
    })),
    issues: [],
  };
}

function decodeAggregate(value: unknown, expected: number): AggregateRow[] {
  if (typeof value !== "string" || !HEX.test(value))
    invalid("Multicall3 returned malformed data.");
  const decoded = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: value as `0x${string}`,
  });
  if (!Array.isArray(decoded) || decoded.length !== expected)
    invalid("Multicall3 returned an unexpected result count.");
  return decoded.map((entry) => {
    if (!entry || typeof entry !== "object")
      invalid("Multicall3 returned a malformed result row.");
    const row = entry as { success?: unknown; returnData?: unknown };
    if (typeof row.success !== "boolean" || typeof row.returnData !== "string")
      invalid("Multicall3 returned a malformed result row.");
    return { success: row.success, returnData: row.returnData };
  });
}

function decodeBalance(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    invalid("ERC-20 balanceOf returned malformed data.");
  const decoded = decodeFunctionResult({
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    data: value as `0x${string}`,
  });
  if (typeof decoded !== "bigint")
    invalid("ERC-20 balanceOf returned no uint256.");
  return decoded.toString();
}

async function readNormalized(
  config: NormalizedConfig,
  options: EntityTokenBalanceOptions,
): Promise<EntityTokenBalanceResult> {
  const retrievedAt = options.now?.() ?? new Date().toISOString();
  const result = baseResult(config, retrievedAt);
  const rpc =
    options.rpcClient ??
    (options.createRpcClient ?? createPublicRpcClient)(ETHEREUM_CHAIN_ID, {
      intervalMs: 0,
      maxCalls: 1,
      maxResponseBytes: 2_000_000,
      maxDurationMs: 20_000,
    });
  if (rpc.chainId !== ETHEREUM_CHAIN_ID)
    invalid("Entity token balance RPC chain must be Ethereum mainnet.");

  const calls: Array<{
    target: Address;
    allowFailure: true;
    callData: `0x${string}`;
  }> = [];
  for (const wallet of config.wallets)
    for (const token of config.tokens)
      calls.push({
        target: token.contract,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [wallet],
        }),
      });
  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [calls],
  });

  let rows: AggregateRow[];
  try {
    rows = decodeAggregate(
      await rpc.request("eth_call", [
        { to: MULTICALL3_ADDRESS, data },
        "latest",
      ]),
      calls.length,
    );
  } catch (error) {
    result.issues.push(issueFromError(error));
    return result;
  }

  const totals = config.tokens.map(() => 0n);
  const successfulWallets = config.tokens.map(() => 0);
  const walletStatuses = config.wallets.map(() => ({ success: 0, failed: 0 }));
  for (let index = 0; index < rows.length; index += 1) {
    const walletIndex = Math.floor(index / config.tokens.length);
    const tokenIndex = index % config.tokens.length;
    const wallet = config.wallets[walletIndex];
    const token = config.tokens[tokenIndex];
    const row = rows[index];
    if (!row.success) {
      walletStatuses[walletIndex].failed += 1;
      result.issues.push({
        wallet,
        token: token.contract,
        code: "CALL_FAILED",
        message: "ERC-20 balanceOf call failed inside Multicall3.",
      });
      continue;
    }
    let raw: string;
    try {
      raw = decodeBalance(row.returnData);
    } catch {
      walletStatuses[walletIndex].failed += 1;
      result.issues.push({
        wallet,
        token: token.contract,
        code: "INVALID_RETURN_DATA",
        message: "ERC-20 balanceOf returned invalid data inside Multicall3.",
      });
      continue;
    }
    walletStatuses[walletIndex].success += 1;
    totals[tokenIndex] += BigInt(raw);
    successfulWallets[tokenIndex] += 1;
  }
  result.coverage.successfulCalls = rows.length - result.issues.length;
  result.coverage.failedCalls = result.issues.length;
  result.coverage.complete = result.coverage.failedCalls === 0;
  result.coverage.status = result.coverage.complete ? "complete" : "partial";
  result.wallets = config.wallets.map((wallet, index) => {
    const status = walletStatuses[index];
    return {
      wallet,
      status:
        status.failed === 0
          ? "complete"
          : status.success === 0
            ? "unavailable"
            : "partial",
      successfulTokens: status.success,
      failedTokens: status.failed,
    };
  });
  result.tokens = config.tokens.map((token, index) => {
    const rawBalance =
      successfulWallets[index] === 0 ? null : totals[index].toString();
    return {
      contract: token.contract,
      symbol: token.symbol,
      decimals: token.decimals,
      rawBalance,
      amount: rawBalance === null ? null : amount(rawBalance, token.decimals),
      successfulWallets: successfulWallets[index],
    };
  });
  return result;
}

export function createEntityTokenBalanceReader(
  options: EntityTokenBalanceOptions = {},
): EntityTokenBalanceReader {
  const ttl = options.cacheTtlMs ?? 0;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_MS)
    invalid(`cacheTtlMs must be between 0 and ${MAX_CACHE_TTL_MS}.`);
  const inFlight = new Map<string, Promise<EntityTokenBalanceResult>>();
  const cached = new Map<
    string,
    { result: EntityTokenBalanceResult; expiresAt: number }
  >();
  return {
    async read(config) {
      const normalized = normalizeConfig(config);
      const key = cacheKey(normalized);
      const existing = inFlight.get(key);
      if (existing) return existing;
      const current = cached.get(key);
      if (current && current.expiresAt > Date.now())
        return Promise.resolve(current.result);
      const pending = readNormalized(normalized, options)
        .then((result) => {
          if (ttl > 0) cached.set(key, { result, expiresAt: Date.now() + ttl });
          return result;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, pending);
      return pending;
    },
  };
}

export function readEntityTokenBalances(
  config: EntityTokenBalanceConfig,
  options: EntityTokenBalanceOptions = {},
): Promise<EntityTokenBalanceResult> {
  return createEntityTokenBalanceReader(options).read(config);
}

function parseCommaList(value: string | undefined, field: string): string[] {
  if (!value?.trim()) invalid(`${field} is required.`);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function entityTokenBalanceConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EntityTokenBalanceConfig {
  const wallets = parseCommaList(
    env.FLOWLENS_ENTITY_ETHEREUM_ADDRESSES,
    "FLOWLENS_ENTITY_ETHEREUM_ADDRESSES",
  );
  const tokens = parseCommaList(
    env.FLOWLENS_ENTITY_ERC20_TOKENS,
    "FLOWLENS_ENTITY_ERC20_TOKENS",
  ).map((entry) => {
    const [contract, symbol, decimalsText, ...extra] = entry.split("|");
    if (extra.length || !contract)
      invalid(
        "FLOWLENS_ENTITY_ERC20_TOKENS entries use contract|symbol|decimals.",
      );
    if (decimalsText !== undefined && !/^\d{1,3}$/.test(decimalsText))
      invalid("FLOWLENS_ENTITY_ERC20_TOKENS decimals must be an integer.");
    return {
      contract,
      ...(symbol ? { symbol } : {}),
      ...(decimalsText !== undefined ? { decimals: Number(decimalsText) } : {}),
    };
  });
  return { wallets, tokens };
}
