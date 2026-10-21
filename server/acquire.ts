import {
  analyzeProtocolEvidence,
  parseProtocolEvidence,
  type ProtocolEvidenceBundle,
} from "../src/domain/protocols.ts";
import {
  acquireSafeEvidence,
  type SafeAcquisitionInput,
  type SafeAcquisitionResult,
} from "./safe-provider.ts";
import {
  acquireBridgeEvidence,
  type BridgeAcquisitionInput,
  type BridgeAcquisitionResult,
} from "./bridge-provider.ts";
import { acquireInternalTraceEvidence } from "./trace-provider.ts";
import {
  createPublicRpcClient,
  RpcProviderError,
  type RpcClient,
} from "./rpc.ts";

type CommonInput = { chainId: 1 | 8453 | 42161; maxCalls: number };
export type AcquisitionInput =
  | (CommonInput & SafeAcquisitionInput & { kind: "safe" })
  | (CommonInput & BridgeAcquisitionInput & { kind: "bridge" })
  | (CommonInput & {
      kind: "internal";
      hash: string;
      address?: string;
      maxTraces?: number;
    });
export interface AcquisitionIssue {
  code: string;
  message: string;
  retryable: boolean;
  stage?: string;
}
type InternalAcquisitionResult = Awaited<
  ReturnType<typeof acquireInternalTraceEvidence>
>;
type CommonResult = {
  version: 1;
  mode: "private";
  bundle: ProtocolEvidenceBundle;
  analysis: ReturnType<typeof analyzeProtocolEvidence>;
  warnings: string[];
  errors: AcquisitionIssue[];
};
export type ProtocolAcquisitionResult = CommonResult &
  (
    | { kind: "safe"; acquisition: SafeAcquisitionResult }
    | { kind: "bridge"; acquisition: BridgeAcquisitionResult }
    | { kind: "internal"; acquisition: InternalAcquisitionResult }
  );
export type Acquirer = (input: unknown) => Promise<ProtocolAcquisitionResult>;
export interface AcquisitionDependencies {
  rpcFactory?: (chainId: number, options: { maxCalls: number }) => RpcClient;
  safeFetch?: typeof fetch;
}
export class AcquisitionError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AcquisitionError";
    this.code = code;
    this.retryable = retryable;
  }
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
function invalid(message: string): never {
  throw new AcquisitionError("INVALID_ARGUMENT", message);
}
function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalid(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function identifier(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    return invalid(`${name} is invalid.`);
  return value.toLowerCase();
}
/** Strict per-kind arguments; transport and credential options never enter this boundary. */
export function parseAcquisitionInput(input: unknown): AcquisitionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid("Acquisition arguments must be an object.");
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "safe" &&
    value.kind !== "bridge" &&
    value.kind !== "internal"
  )
    return invalid("kind must be safe, bridge or internal.");
  const keys = [
    "kind",
    "chainId",
    "maxCalls",
    ...(value.kind === "safe"
      ? [
          "address",
          "blockNumber",
          "maxPages",
          "cursor",
          "includeHistory",
          "verifySignatures",
          "maxSignatures",
        ]
      : value.kind === "bridge"
        ? ["hash", "maxLogs"]
        : ["hash", "address", "maxTraces"]),
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)))
    return invalid(
      "Acquisition arguments include an unsupported option for this kind.",
    );
  const chainId = integer(value.chainId, "chainId", 1, Number.MAX_SAFE_INTEGER);
  if (chainId !== 1 && chainId !== 8453 && chainId !== 42161)
    return invalid("Supported chain IDs are 1, 8453 and 42161.");
  const common: CommonInput = {
    chainId,
    maxCalls:
      value.maxCalls === undefined
        ? 32
        : integer(value.maxCalls, "maxCalls", 1, 64),
  };
  if (value.kind === "safe") {
    if (chainId === 8453)
      return invalid(
        "Safe acquisition currently supports chain IDs 1 and 42161.",
      );
    const result: AcquisitionInput & { kind: "safe" } = {
      ...common,
      kind: "safe",
      address: identifier(value.address, "address", ADDRESS),
    };
    if (value.blockNumber !== undefined)
      result.blockNumber = integer(
        value.blockNumber,
        "blockNumber",
        0,
        Number.MAX_SAFE_INTEGER,
      );
    if (value.maxPages !== undefined)
      result.maxPages = integer(value.maxPages, "maxPages", 1, 3);
    if (value.maxSignatures !== undefined)
      result.maxSignatures = integer(
        value.maxSignatures,
        "maxSignatures",
        1,
        5,
      );
    for (const key of ["includeHistory", "verifySignatures"] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== "boolean")
          return invalid(`${key} must be boolean.`);
        result[key] = value[key];
      }
    }
    if (result.includeHistory === false && result.verifySignatures === true)
      return invalid(
        "Signature verification requires Safe history acquisition.",
      );
    if (value.cursor !== undefined) {
      if (
        typeof value.cursor !== "string" ||
        !/^[\w-]{1,2048}$/.test(value.cursor)
      )
        return invalid("cursor must be bounded base64url state.");
      if (result.includeHistory === false)
        return invalid("A Safe cursor requires history acquisition.");
      result.cursor = value.cursor;
    }
    return result;
  }
  const txHash = identifier(value.hash, "hash", HASH);
  if (value.kind === "bridge")
    return {
      ...common,
      kind: "bridge",
      hash: txHash,
      ...(value.maxLogs === undefined
        ? {}
        : { maxLogs: integer(value.maxLogs, "maxLogs", 1, 2000) }),
    };
  return {
    ...common,
    kind: "internal",
    hash: txHash,
    ...(value.address === undefined
      ? {}
      : { address: identifier(value.address, "address", ADDRESS) }),
    ...(value.maxTraces === undefined
      ? {}
      : { maxTraces: integer(value.maxTraces, "maxTraces", 1, 2000) }),
  };
}
function code(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
    ? value
    : fallback;
}

/** Acquire one explicit scope, analyze it and return it. The caller owns persistence and mode separation. */
export async function acquireProtocolEvidence(
  input: unknown,
  deps: AcquisitionDependencies = {},
): Promise<ProtocolAcquisitionResult> {
  const request = parseAcquisitionInput(input);
  try {
    const client = (deps.rpcFactory ?? createPublicRpcClient)(request.chainId, {
      maxCalls: request.maxCalls,
    });
    if (client.chainId !== request.chainId)
      throw new AcquisitionError(
        "RPC_CHAIN_MISMATCH",
        "Configured RPC chain does not match the requested chain.",
      );
    let calls = 0;
    const rpc: RpcClient = {
      ...client,
      async request(method, params) {
        if (calls >= request.maxCalls)
          throw new RpcProviderError(
            "RPC_BUDGET_EXCEEDED",
            "Acquisition RPC request budget exhausted; no additional request was sent.",
          );
        calls++;
        return client.request(method, params);
      },
    };
    let providerResult:
      | { kind: "safe"; acquisition: SafeAcquisitionResult }
      | { kind: "bridge"; acquisition: BridgeAcquisitionResult }
      | { kind: "internal"; acquisition: InternalAcquisitionResult };
    let bundle: ProtocolEvidenceBundle;
    let warnings: string[];
    let errors: AcquisitionIssue[];
    if (request.kind === "safe") {
      const { kind: _kind, maxCalls: _maxCalls, ...options } = request;
      const acquisition = await acquireSafeEvidence(options, {
        rpc,
        ...(deps.safeFetch ? { fetch: deps.safeFetch } : {}),
      });
      providerResult = { kind: "safe", acquisition };
      bundle = { version: 1, mode: "private", safe: acquisition.bundle };
      warnings = acquisition.warnings;
      errors = acquisition.errors.map((e) => ({
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        stage: e.stage,
      }));
    } else if (request.kind === "bridge") {
      const { kind: _kind, maxCalls: _maxCalls, ...options } = request;
      const acquisition = await acquireBridgeEvidence(options, { rpc });
      providerResult = { kind: "bridge", acquisition };
      bundle = { version: 1, mode: "private", bridges: acquisition.bundle };
      warnings = acquisition.warnings;
      errors = acquisition.issues.map((e) => {
        const c = code(e.code, "BRIDGE_ACQUISITION_ERROR");
        return {
          code: c,
          message: `Bridge acquisition reported ${c}.`,
          retryable: e.retryable,
        };
      });
    } else {
      const { kind: _kind, maxCalls: _maxCalls, ...options } = request;
      const acquisition = await acquireInternalTraceEvidence(options, { rpc });
      providerResult = { kind: "internal", acquisition };
      bundle = { version: 1, mode: "private", internal: acquisition.bundle };
      warnings = acquisition.capability.warnings;
      errors =
        acquisition.capability.status === "available"
          ? []
          : [
              {
                code: code(
                  acquisition.capability.errorCode,
                  "INTERNAL_ACQUISITION_UNAVAILABLE",
                ),
                message: `Internal trace acquisition is ${acquisition.capability.status}.`,
                retryable: acquisition.capability.retryable,
              },
            ];
    }
    bundle = parseProtocolEvidence(bundle, "private");
    const analysis = analyzeProtocolEvidence(bundle);
    return {
      version: 1,
      mode: "private",
      ...providerResult,
      bundle,
      analysis,
      errors,
      warnings: [
        ...new Set([
          ...warnings,
          ...analysis.caveats,
          ...(analysis.safe?.warnings ?? []),
          ...(analysis.bridges?.warnings ?? []),
          ...(analysis.internal?.warnings ?? []),
        ]),
      ],
    };
  } catch (error) {
    if (error instanceof AcquisitionError) throw error;
    const e =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const c = code(e.code, "ACQUISITION_FAILED");
    throw new AcquisitionError(
      c,
      `Protocol acquisition could not be completed (${c}).`,
      e.retryable === true,
    );
  }
}
