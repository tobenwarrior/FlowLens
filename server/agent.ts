import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { annotateWallet, setVisibility } from "../src/domain/workspace.ts";
import { walletFlows, visibleTransfers } from "../src/domain/wallet-flows.ts";
import { createHash } from "node:crypto";
import {
  aggregateFlows,
  buildEdges,
  filterTransfers,
  normalizeAddress,
  parseInvestigation,
} from "../src/domain/engine.ts";
import {
  analyzeProtocolEvidence,
  createSyntheticProtocolEvidence,
  parseProtocolEvidence,
  mergeProtocolEvidence,
} from "../src/domain/protocols.ts";
import type { Investigation, Label, TraceFilter } from "../src/domain/types.ts";
import {
  expandCase,
  operationSchema,
  providersFromEnvironment,
  startInvestigation,
} from "./operations.ts";
import type { Providers } from "./operations.ts";
import {
  CaseBusyError,
  CaseStore,
  nextRevision,
  validCaseId,
  withFileLock,
} from "./store.ts";
import { LabelStore } from "./label-store.ts";
import type { StoredLabel } from "./label-store.ts";
import {
  DEFAULT_PUBLIC_LABEL_FILE,
  applyPublicLabels,
  loadPublicLabels,
  publicLabelEntries,
  publicLabelKey,
} from "./public-labels.ts";
import type { PublicLabelEntry } from "./public-labels.ts";
import { fetchOnChainPrices } from "./price-provider.ts";
import { distinctLookups, fetchHistoricalPrices } from "./historical-price.ts";
import { ProviderError } from "./etherscan.ts";
import { RpcProviderError } from "./rpc.ts";
import {
  acquireProtocolEvidence,
  parseAcquisitionInput,
  AcquisitionError,
} from "./acquire.ts";
import type { Acquirer } from "./acquire.ts";
import { inspectDerive, parseDeriveQuery } from "./derive-provider.ts";
import { createHypercoreProvider } from "./hypercore-provider.ts";
import type { HypercoreProvider } from "./hypercore-provider.ts";
import { acquireHypercoreHistory } from "./hypercore-acquisition.ts";

export class AgentOperationError extends Error {
  code: string;
  retryable: boolean;
  details?: unknown;
  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.name = "AgentOperationError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AgentOperationError(
      "INVALID_ARGUMENT",
      "Tool arguments must be an object.",
    );
  return input as Record<string, unknown>;
}
function text(input: unknown, name: string, max = 2048): string {
  if (typeof input !== "string" || !input.length || input.length > max)
    throw new AgentOperationError(
      "INVALID_ARGUMENT",
      `${name} must be a nonempty string of at most ${max} characters.`,
    );
  return input;
}
function caseId(input: unknown): string {
  const value = text(input, "caseId", 100);
  if (!validCaseId(value))
    throw new AgentOperationError("INVALID_ARGUMENT", "Invalid case ID.");
  return value;
}
function safeMessage(error: Error) {
  return error.message
    .replace(/((?:api[_-]?key|token|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}
function errorFor(error: unknown): AgentOperationError {
  if (error instanceof AgentOperationError) return error;
  if (
    error instanceof ProviderError ||
    error instanceof RpcProviderError ||
    error instanceof AcquisitionError
  )
    return new AgentOperationError(
      error.code,
      safeMessage(error),
      error.retryable,
    );
  if (
    error instanceof Error &&
    "code" in error &&
    [
      "INVALID_SAFE_EVIDENCE",
      "INVALID_BRIDGE_EVIDENCE",
      "INVALID_INTERNAL_EVIDENCE",
      "INVALID_EVIDENCE_CONFLICT",
    ].includes(String(error.code))
  )
    return new AgentOperationError(
      String(error.code),
      safeMessage(error),
      false,
    );
  if (error instanceof CaseBusyError)
    return new AgentOperationError(error.code, error.message, true);
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT")
      return new AgentOperationError(
        "CASE_NOT_FOUND",
        "Investigation was not found.",
      );
    if (["EACCES", "EPERM", "EIO", "ENOSPC"].includes(String(error.code)))
      return new AgentOperationError(
        "LOCAL_STORAGE_ERROR",
        "Local investigation storage is unavailable. Check file access and free space.",
      );
  }
  return new AgentOperationError(
    "INVALID_ARGUMENT",
    error instanceof Error
      ? safeMessage(error)
      : "The operation could not be completed.",
  );
}
export interface AgentServiceOptions {
  dataDir?: string;
  labelFile?: string;
  /** Tracked shared catalogue; injectable for isolated tests/review tooling. */
  publicLabelFile?: string;
  providers?: Providers;
  acquirer?: Acquirer;
  deriveInspector?: typeof inspectDerive;
  hypercoreProvider?: HypercoreProvider;
}

function canonicalPath(path: string): string {
  const unresolved: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      return resolve(realpathSync(current), ...unresolved);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(current, ...unresolved);
      unresolved.unshift(basename(current));
      current = parent;
    }
  }
}

/** One service boundary shared by MCP and local replay API; never accepts arbitrary paths or endpoints. */
export function createAgentService(options: AgentServiceOptions = {}) {
  const privateLabelFile = resolve(
    options.labelFile ??
      process.env.FLOWLENS_LABEL_FILE ??
      ".local/labels.json",
  );
  const publicLabelFile = resolve(
    options.publicLabelFile ?? DEFAULT_PUBLIC_LABEL_FILE,
  );
  let publicFileIsSymlink = false;
  try {
    publicFileIsSymlink = lstatSync(publicLabelFile).isSymbolicLink();
  } catch {
    // A missing catalogue is allowed; validation reports it explicitly.
  }
  if (publicFileIsSymlink)
    throw new Error(
      "Tracked public wallet-label catalogue path must not be a symbolic link",
    );
  if (canonicalPath(privateLabelFile) === canonicalPath(publicLabelFile))
    throw new Error(
      "Private label storage must not use the tracked public wallet-label catalogue path",
    );
  const store = new CaseStore(
    options.dataDir ?? resolve(process.env.FLOWLENS_DATA_DIR ?? ".local/cases"),
  );
  // Attribution outlives any one case, so it lives beside them rather than inside them.
  const labels = new LabelStore(privateLabelFile);
  // Wallets named in an earlier investigation arrive already labelled, which is the point
  // of remembering them. A label the case already holds always wins, a live case never
  // takes a synthetic or demo one, and a store that cannot be read changes nothing.
  const remembered = async (value: Investigation) => {
    const accept =
      value.mode === "live"
        ? (label: NonNullable<Investigation["nodes"][number]["label"]>) =>
            label.confidence !== "synthetic" && label.kind !== "demo"
        : () => true;
    // The shared file is independent of private case storage. A malformed or
    // unavailable catalogue must not make a private trace fail, and a private
    // read failure must not hide a valid shared label.
    let shared = new Map<string, PublicLabelEntry>();
    try {
      shared = await loadPublicLabels(publicLabelFile);
    } catch {
      /* Keep the empty map; private labels remain independently usable. */
    }
    try {
      return await labels.resolve(value.nodes, accept, shared);
    } catch {
      return applyPublicLabels(value.nodes, shared, accept);
    }
  };
  const providers = options.providers ?? providersFromEnvironment();
  const acquirer = options.acquirer ?? acquireProtocolEvidence;
  const hypercoreProvider =
    options.hypercoreProvider ?? createHypercoreProvider();
  const mutate = async <T>(id: string, run: () => Promise<T>) =>
    withFileLock(store.path(id), run);
  const searchLabels = async (query: {
    query?: string;
    chainId?: number;
    address?: string;
    kind?: Label["kind"];
    limit?: number;
  }) => {
    const address = query.address ? normalizeAddress(query.address) : undefined;
    let privateAll: StoredLabel[] = [];
    let privateLabels: StoredLabel[] = [];
    try {
      privateAll = [...(await labels.read()).values()];
      const text = query.query?.trim().toLowerCase();
      privateLabels = privateAll
        .filter(
          (entry) =>
            (query.chainId === undefined || entry.chainId === query.chainId) &&
            (!address || entry.address === address) &&
            (!query.kind || entry.label.kind === query.kind) &&
            (!text || entry.label.text.toLowerCase().includes(text)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      // The shared catalogue remains searchable when private storage is
      // unavailable or corrupt.
    }
    let shared = new Map<string, PublicLabelEntry>();
    try {
      shared = await loadPublicLabels(publicLabelFile);
    } catch {
      // Private label search remains useful when the independent shared file is
      // unavailable or fails validation.
    }
    const text = query.query?.trim().toLowerCase();
    const privateKeys = new Set(
      privateAll.map((entry) => publicLabelKey(entry.chainId, entry.address)),
    );
    const sharedLabels = publicLabelEntries(shared).filter((entry) => {
      if (privateKeys.has(publicLabelKey(entry.chainId, entry.address)))
        return false;
      if (query.chainId !== undefined && entry.chainId !== query.chainId)
        return false;
      if (address && entry.address !== address) return false;
      if (query.kind && entry.label.kind !== query.kind) return false;
      if (text && !entry.label.text.toLowerCase().includes(text)) return false;
      return true;
    });
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    return [...privateLabels, ...sharedLabels].slice(0, limit);
  };
  async function run(operation: string, args: unknown): Promise<unknown> {
    const input = object(args ?? {});
    if (Buffer.byteLength(JSON.stringify(input)) > 5_000_000)
      throw new AgentOperationError(
        "INPUT_TOO_LARGE",
        "Tool arguments exceed the 5 MB limit.",
      );
    if (operation === "derive")
      return await (options.deriveInspector ?? inspectDerive)(
        parseDeriveQuery(input),
      );
    if (operation === "hypercore") {
      const { caseId: caseValue, ...query } = input;
      if (caseValue === undefined)
        return acquireHypercoreHistory(query, undefined, hypercoreProvider);
      const id = caseId(caseValue);
      return mutate(id, async () => {
        const current = await store.read(id);
        if (current.mode !== "live")
          throw new AgentOperationError(
            "INVALID_ARGUMENT",
            "Live HyperCore acquisition requires a live case",
          );
        const account =
          query.account === undefined
            ? current.root
            : normalizeAddress(query.account as string);
        if (account !== current.root)
          throw new AgentOperationError(
            "INVALID_ARGUMENT",
            "HyperCore account must match this case's focus wallet",
          );
        const result = await acquireHypercoreHistory(
          { ...query, account },
          current.protocolEvidence?.hypercore,
          hypercoreProvider,
        );
        if (!result.cached) {
          const protocolEvidence = mergeProtocolEvidence(
            current.protocolEvidence,
            {
              version: 1,
              mode: "private",
              hypercore: result.bundle,
            },
          );
          await store.save({
            ...current,
            protocolEvidence,
            updatedAt: nextRevision(current.updatedAt),
          });
        }
        return { ...result, caseId: id };
      });
    }
    if (operation === "status")
      return {
        version: 1,
        liveAvailable: providers.live.size > 0,
        providers: {
          demo: { available: true, synthetic: true },
          live: {
            available: providers.live.size > 0,
            chains: [...providers.live.keys()],
            // Which indexed-history provider answers each served chain; keys never appear here.
            routes: [...providers.live].map(([chainId, provider]) => ({
              chainId,
              provider: provider.id,
            })),
          },
          internal: {
            available: true,
            capability:
              "transaction-specific probe; endpoint support is not guaranteed",
            reason:
              "Public RPC is queried only for an explicitly supplied transaction. Full wallet internal history is unavailable.",
          },
          rpc: {
            available: true,
            chains: [1, 8453, 42161],
            credentials: false,
            scope: "explicit known evidence only",
          },
          safe: {
            available: true,
            chains: [1, 42161],
            scope:
              "configuration and bounded service history; signature verification is optional and limited",
          },
          bridge: {
            available: true,
            chains: [1, 8453, 42161],
            protocols: ["CCTP v1", "CCTP v2"],
            scope: "supplied transaction receipts only",
          },
          derive: {
            available: true,
            credentials: false,
            scopes: ["account", "margin", "trades"],
            scope:
              "explicit public venue reads; access is not guaranteed; no transfer or case mutation",
          },
          hypercore: {
            available: true,
            credentials: false,
            scope:
              "explicit non-funding ledger window; optional case attachment; not EVM transfers or proof of complete history",
          },
          arkham: { available: false },
        },
        limits: operationSchema.limits,
        replay: {
          version: 1,
          modes: ["synthetic", "private"],
          components: ["safe", "bridges", "internal", "hypercore"],
          independentAuthentication: false,
        },
      };
    if (operation === "schema")
      return {
        ...operationSchema,
        replay: {
          version: 1,
          modes: ["synthetic", "private"],
          fixture: "protocols-v1",
          source: "docs/safe-evidence.md and docs/bridge-internal-evidence.md",
          example: createSyntheticProtocolEvidence(),
        },
      };
    if (operation === "list") return await store.list();
    if (operation === "create") {
      const value = await startInvestigation(
        input.root,
        input.mode,
        input.title,
        providers,
        input.historyMode,
      );
      value.nodes = await remembered(value);
      await store.save(value);
      return value;
    }
    if (operation === "acquire") {
      const { caseId: target, ...request } = input;
      const query = parseAcquisitionInput(request);
      const id = target === undefined ? undefined : caseId(target);
      if (id) {
        const current = await store.read(id);
        if (current.mode !== "live")
          throw new AgentOperationError(
            "MODE_CONFLICT",
            "Live acquisition cannot enter a synthetic demo investigation. Create a live evidence-only case.",
          );
      }
      const result = await acquirer(query);
      const validated = parseProtocolEvidence(result.bundle, "private");
      if (!id)
        return {
          ...result,
          bundle: validated,
          version: 1,
          mode: "private",
          indexedHistoryChanged: false,
        };
      return mutate(id, async () => {
        const current = await store.read(id);
        if (current.mode !== "live")
          throw new AgentOperationError(
            "MODE_CONFLICT",
            "Live acquisition requires a live investigation.",
          );
        const merged = mergeProtocolEvidence(
          current.protocolEvidence,
          validated,
        );
        const next = parseInvestigation({
          ...current,
          protocolEvidence: merged,
          updatedAt: nextRevision(current.updatedAt),
        });
        await store.save(next);
        return {
          ...result,
          bundle: merged,
          analysis: analyzeProtocolEvidence(merged),
          version: 1,
          mode: "private",
          caseId: id,
          updatedAt: next.updatedAt,
          indexedHistoryChanged: false,
        };
      });
    }
    if (operation === "import") {
      const value = parseInvestigation(input.investigation);
      caseId(value.id);
      return mutate(value.id, async () => {
        let previous;
        try {
          previous = await store.read(value.id);
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
        if (
          previous &&
          (previous.root !== value.root || previous.mode !== value.mode)
        )
          throw new AgentOperationError(
            "CASE_IDENTITY_CONFLICT",
            "An existing investigation cannot change its root or mode. Create a separate case.",
          );
        if (previous && previous.updatedAt !== value.updatedAt)
          throw new AgentOperationError(
            "CASE_CONFLICT",
            "Investigation changed since this snapshot was exported. Fetch the latest revision before saving.",
            true,
            { caseId: value.id, currentRevision: previous.updatedAt },
          );
        const result = {
          ...value,
          updatedAt: nextRevision(previous?.updatedAt ?? value.updatedAt),
        };
        await store.save(result);
        return result;
      });
    }
    if (operation === "replay") {
      if ((input.bundle !== undefined) === (input.fixture !== undefined))
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Supply exactly one protocol evidence bundle or synthetic fixture.",
        );
      if (input.fixture !== undefined && input.fixture !== "protocols-v1")
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Unknown synthetic protocol fixture.",
        );
      const bundle = input.fixture
        ? createSyntheticProtocolEvidence()
        : parseProtocolEvidence(input.bundle);
      const analysis = analyzeProtocolEvidence(bundle);
      if (input.caseId === undefined)
        return { version: 1, mode: bundle.mode, analysis };
      const id = caseId(input.caseId);
      return mutate(id, async () => {
        const current = await store.read(id);
        const validated = parseProtocolEvidence(
          bundle,
          current.mode === "demo" ? "synthetic" : "private",
        );
        const next = parseInvestigation({
          ...current,
          protocolEvidence: validated,
          updatedAt: nextRevision(current.updatedAt),
        });
        await store.save(next);
        return {
          version: 1,
          mode: bundle.mode,
          analysis,
          caseId: id,
          updatedAt: next.updatedAt,
          indexedHistoryChanged: false,
        };
      });
    }
    // Spot USD over the same public RPC acquisition already uses. Explicitly invoked,
    // never fetched in the background, and bounded to a handful of assets per call.
    if (operation === "prices") {
      const chainId = input.chainId;
      if (!Number.isSafeInteger(chainId) || (chainId as number) < 1)
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Price lookup requires a positive integer chain ID.",
        );
      const assets = Array.isArray(input.assets) ? input.assets : [];
      if (assets.length > 50)
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Price lookup accepts at most 50 assets per call.",
        );
      const result = await fetchOnChainPrices(
        chainId as number,
        assets as never,
        { maxAssets: input.maxAssets as number | undefined },
      );
      return {
        ...result,
        scope: "spot-price",
        basis:
          "Spot price at the current block from a single Uniswap V3 pool. Not a market rate, and applying it to an older transfer values that transfer at today's price.",
      };
    }

    // Prices read at each transfer's own block, so historical evidence is not valued
    // at today's rate. Explicit and bounded, like the spot lookup.
    if (operation === "prices_at_blocks") {
      const chainId = input.chainId;
      if (!Number.isSafeInteger(chainId) || (chainId as number) < 1)
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Historical price lookup requires a positive integer chain ID.",
        );
      const transfers = Array.isArray(input.transfers) ? input.transfers : [];
      if (transfers.length > 20_000)
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "Historical price lookup accepts at most 20000 transfers per call.",
        );
      const result = await fetchHistoricalPrices(
        chainId as number,
        transfers as never,
        { maxLookups: input.maxLookups as number | undefined },
      );
      return {
        ...result,
        distinctPairs: distinctLookups(chainId as number, transfers as never),
        scope: "at-block-price",
        basis:
          "Each quote is the pool's last swap at or before that transfer's block. Assets left unpriced keep the spot rate, which values them at today's price.",
      };
    }

    // Attribution the user or an agent can reuse in every later trace.
    if (operation === "label_put") {
      const entry = await labels.put({
        chainId: input.chainId as number,
        address: input.address as string,
        label: input.label,
      });
      return {
        entry,
        scope: "label-store",
        note: "Stored attribution. A label records who claimed what, not established ownership.",
      };
    }
    if (operation === "label_search")
      return {
        labels: await searchLabels({
          query: input.query as string | undefined,
          chainId: input.chainId as number | undefined,
          address: input.address as string | undefined,
          kind: input.kind as never,
          limit: input.limit as number | undefined,
        }),
        scope: "label-store+public-catalogue",
      };
    if (operation === "label_forget")
      return {
        removed: await labels.remove(
          input.chainId as number,
          input.address as string,
        ),
        scope: "label-store",
      };

    if (operation === "annotate" || operation === "visibility") {
      const id = caseId(input.caseId);
      return mutate(id, async () => {
        const current = await store.read(id);
        if (
          input.expectedRevision !== undefined &&
          text(input.expectedRevision, "expectedRevision", 40) !==
            current.updatedAt
        )
          throw new AgentOperationError(
            "CASE_CONFLICT",
            "Investigation changed; inspect the latest revision before updating workspace state.",
            true,
            { caseId: id, currentRevision: current.updatedAt },
          );
        const next =
          operation === "annotate"
            ? annotateWallet(current, input)
            : setVisibility(current, input);
        next.updatedAt = nextRevision(current.updatedAt);
        await store.save(next);
        // Keep the store in step with the case: a label attached here is remembered for
        // the next trace, and one removed here is forgotten, or the next expansion would
        // put it back.
        if (operation === "annotate")
          await (
            input.label
              ? labels.put({
                  chainId: input.chainId as number,
                  address: input.address as string,
                  label: input.label,
                })
              : labels.remove(input.chainId as number, input.address as string)
          )
            // The case is already saved; failing to update the store must not undo that.
            .catch(() => undefined);
        return next;
      });
    }
    if (
      !["inspect", "expand", "evidence", "graph", "wallet", "export"].includes(
        operation,
      )
    )
      throw new AgentOperationError(
        "UNKNOWN_OPERATION",
        "Unknown tracing operation.",
      );
    const id = caseId(input.caseId);
    if (operation === "expand")
      return mutate(id, async () => {
        const current = await store.read(id);
        const next = await expandCase(current, input, providers);
        next.nodes = await remembered(next);
        next.updatedAt = nextRevision(current.updatedAt);
        await store.save(next);
        return next;
      });
    const value = await store.read(id);
    if (operation === "export") return value;
    if (operation === "wallet") {
      if (
        typeof input.offset === "number" &&
        input.offset > 0 &&
        input.expectedRevision === undefined
      )
        throw new AgentOperationError(
          "INVALID_CURSOR",
          "Wallet pages after offset zero require expectedRevision from the first page.",
        );
      if (
        input.expectedRevision !== undefined &&
        text(input.expectedRevision, "expectedRevision", 40) !== value.updatedAt
      )
        throw new AgentOperationError(
          "CURSOR_STALE",
          "Investigation changed; restart the wallet page query at offset zero with the current revision.",
          true,
          { caseId: id, currentRevision: value.updatedAt },
        );
      const filter: TraceFilter = {};
      for (const key of ["asset", "from", "to"] as const)
        if (input[key] !== undefined) filter[key] = text(input[key], key, 300);
      if (input.direction !== undefined) {
        if (!["all", "in", "out"].includes(String(input.direction)))
          throw new AgentOperationError(
            "INVALID_ARGUMENT",
            "direction must be all, in or out.",
          );
        filter.direction = input.direction as TraceFilter["direction"];
      }
      return {
        ...walletFlows(value, {
          address: text(input.address, "address", 42),
          ...(input.chainId === undefined
            ? {}
            : { chainId: input.chainId as number }),
          ...(input.offset === undefined
            ? {}
            : { offset: input.offset as number }),
          ...(input.pageSize === undefined
            ? {}
            : { pageSize: input.pageSize as number }),
          filter,
        }),
        caseId: id,
        revision: value.updatedAt,
        coverageNote:
          "Only loaded transfer evidence is summarized. Hidden flows remain included in gross/net totals; pagination never establishes complete wallet history.",
      };
    }
    if (operation === "inspect")
      return {
        version: value.version,
        id: value.id,
        title: value.title,
        root: value.root,
        mode: value.mode,
        updatedAt: value.updatedAt,
        evidenceCount: value.transfers.length,
        nodeCount: value.nodes.length,
        coverage: value.coverage,
        flows: aggregateFlows(value.transfers, value.root),
        notes: value.notes,
        ...(value.protocolEvidence
          ? {
              protocolAnalysis: analyzeProtocolEvidence(value.protocolEvidence),
            }
          : {}),
      };
    if (operation === "evidence") {
      const evidence = value.transfers.find(
        (t) => t.id === text(input.evidenceId, "evidenceId", 300),
      );
      if (!evidence)
        throw new AgentOperationError(
          "EVIDENCE_NOT_FOUND",
          "Evidence ID was not found in this investigation.",
        );
      return evidence;
    }
    const filter: TraceFilter = {};
    if (input.chainId !== undefined) {
      if (!Number.isSafeInteger(input.chainId) || Number(input.chainId) < 1)
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "chainId must be a positive integer.",
        );
      filter.chainId = Number(input.chainId);
    }
    if (input.direction !== undefined) {
      if (!["all", "in", "out"].includes(String(input.direction)))
        throw new AgentOperationError(
          "INVALID_ARGUMENT",
          "direction must be all, in or out.",
        );
      filter.direction = input.direction as TraceFilter["direction"];
    }
    for (const key of ["asset", "from", "to"] as const)
      if (input[key] !== undefined) filter[key] = text(input[key], key, 300);
    const limit = input.limit ?? 100;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 250
    )
      throw new AgentOperationError(
        "INVALID_ARGUMENT",
        "Graph page limit must be an integer from 1 to 250.",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify(filter))
      .digest("hex");
    let offset = 0;
    if (input.cursor !== undefined) {
      try {
        const cursor = JSON.parse(
          Buffer.from(text(input.cursor, "cursor", 2048), "base64url").toString(
            "utf8",
          ),
        );
        if (
          cursor.caseId !== id ||
          cursor.filter !== digest ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw new Error();
        if (cursor.revision !== value.updatedAt)
          throw new AgentOperationError(
            "CURSOR_STALE",
            "Investigation changed; restart this graph page query to use its current revision.",
            true,
          );
        offset = cursor.offset;
      } catch (error) {
        if (error instanceof AgentOperationError) throw error;
        throw new AgentOperationError(
          "INVALID_CURSOR",
          "Graph cursor does not belong to this case and filter.",
        );
      }
    }
    const all = filterTransfers(value.transfers, value.root, filter)
      .slice()
      .sort(
        (a, b) =>
          b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id),
      );
    if (offset > all.length)
      throw new AgentOperationError(
        "INVALID_CURSOR",
        "Graph cursor exceeds the loaded result set.",
      );
    const transfers = all.slice(offset, offset + limit),
      end = offset + transfers.length,
      visible = visibleTransfers(value, transfers);
    const nextCursor =
      end < all.length
        ? Buffer.from(
            JSON.stringify({
              caseId: id,
              revision: value.updatedAt,
              filter: digest,
              offset: end,
            }),
          ).toString("base64url")
        : null;
    return {
      root: value.root,
      transfers,
      edges: buildEdges(visible),
      visibleTransferIds: visible.map((transfer) => transfer.id),
      hidden: {
        nodeKeys: value.hidden,
        transferIds: value.hiddenTransfers ?? [],
      },
      visibilityNote:
        "Visibility changes graph paths only; transfers and gross/net remain all filtered loaded evidence.",
      flows: aggregateFlows(all, value.root),
      coverage: value.coverage,
      page: {
        returned: transfers.length,
        totalMatching: all.length,
        nextCursor,
        limit,
        revision: value.updatedAt,
      },
      edgeScope:
        "Returned page only; additional loaded evidence may have more edges.",
      flowScope:
        "All filtered loaded evidence, per chain and asset; not full wallet history.",
    };
  }
  return {
    async call(operation: string, args: unknown = {}): Promise<unknown> {
      try {
        return await run(operation, args);
      } catch (error) {
        throw errorFor(error);
      }
    },
    /** For callers that load wallets outside `call`, such as the HTTP API. */
    applyRememberedLabels: remembered,
  };
}
