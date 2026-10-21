import { resolve } from "node:path";
import { annotateWallet, setVisibility } from "../src/domain/workspace.ts";
import { walletFlows, visibleTransfers } from "../src/domain/wallet-flows.ts";
import { createHash } from "node:crypto";
import {
  aggregateFlows,
  buildEdges,
  filterTransfers,
  parseInvestigation,
} from "../src/domain/engine.ts";
import {
  analyzeProtocolEvidence,
  createSyntheticProtocolEvidence,
  parseProtocolEvidence,
  mergeProtocolEvidence,
} from "../src/domain/protocols.ts";
import type { TraceFilter } from "../src/domain/types.ts";
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
import { ProviderError } from "./etherscan.ts";
import { RpcProviderError } from "./rpc.ts";
import {
  acquireProtocolEvidence,
  parseAcquisitionInput,
  AcquisitionError,
} from "./acquire.ts";
import type { Acquirer } from "./acquire.ts";

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
  providers?: Providers;
  acquirer?: Acquirer;
}
/** One service boundary shared by MCP and local replay API; never accepts arbitrary paths or endpoints. */
export function createAgentService(options: AgentServiceOptions = {}) {
  const store = new CaseStore(
    options.dataDir ?? resolve(process.env.FLOWLENS_DATA_DIR ?? ".local/cases"),
  );
  // Attribution outlives any one case, so it lives beside them rather than inside them.
  const labels = new LabelStore(
    options.labelFile ??
      resolve(process.env.FLOWLENS_LABEL_FILE ?? ".local/labels.json"),
  );
  const providers = options.providers ?? providersFromEnvironment();
  const acquirer = options.acquirer ?? acquireProtocolEvidence;
  const mutate = async <T>(id: string, run: () => Promise<T>) =>
    withFileLock(store.path(id), run);
  async function run(operation: string, args: unknown): Promise<unknown> {
    const input = object(args ?? {});
    if (Buffer.byteLength(JSON.stringify(input)) > 5_000_000)
      throw new AgentOperationError(
        "INPUT_TOO_LARGE",
        "Tool arguments exceed the 5 MB limit.",
      );
    if (operation === "status")
      return {
        version: 1,
        liveAvailable: providers.liveEnabled,
        providers: {
          demo: { available: true, synthetic: true },
          live: {
            available: providers.liveEnabled,
            id: providers.live.id,
            chains: [1, 42161],
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
          arkham: { available: false },
        },
        limits: operationSchema.limits,
        replay: {
          version: 1,
          modes: ["synthetic", "private"],
          components: ["safe", "bridges", "internal"],
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
        labels: await labels.search({
          query: input.query as string | undefined,
          chainId: input.chainId as number | undefined,
          address: input.address as string | undefined,
          kind: input.kind as never,
          limit: input.limit as number | undefined,
        }),
        scope: "label-store",
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
        // Remember it outside the case too, so the next trace starts already knowing.
        if (operation === "annotate" && input.label)
          await labels
            .put({
              chainId: input.chainId as number,
              address: input.address as string,
              label: input.label,
            })
            // The case is already saved; failing to remember must not undo that.
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
        // Wallets named in an earlier investigation arrive already labelled, which is
        // the point of remembering them. A label the case already holds always wins.
        next.nodes = await labels.resolve(next.nodes).catch(() => next.nodes);
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
  };
}
