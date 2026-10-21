import { createAgentService, AgentOperationError } from "./agent.ts";
import { analyzeProtocolEvidence } from "../src/domain/protocols.ts";
import { visibleTransfers } from "../src/domain/wallet-flows.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import {
  aggregateFlows,
  buildEdges,
  filterTransfers,
  parseInvestigation,
} from "../src/domain/engine.ts";
import {
  CaseBusyError,
  CaseStore,
  nextRevision,
  validCaseId,
  withFileLock,
} from "./store.ts";
import {
  expandCase,
  operationSchema,
  providersFromEnvironment,
  startInvestigation,
} from "./operations.ts";
import type { Providers } from "./operations.ts";
import { ProviderError } from "./etherscan.ts";
import type { Acquirer } from "./acquire.ts";

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const localHost = (host: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
function guard(req: IncomingMessage) {
  if (!localHost(req.headers.host ?? ""))
    throw new HttpError(403, "LOCAL_ONLY", "Only loopback hosts are allowed.");
  if (req.headers.origin) {
    try {
      const url = new URL(req.headers.origin);
      if (url.protocol !== "http:" || !localHost(url.host)) throw new Error();
    } catch {
      throw new HttpError(
        403,
        "ORIGIN_DENIED",
        "Only local browser origins are allowed.",
      );
    }
  }
  if (
    !["GET", "HEAD"].includes(req.method ?? "") &&
    !req.headers["content-type"]?.startsWith("application/json")
  )
    throw new HttpError(
      415,
      "JSON_REQUIRED",
      "Mutations require application/json.",
    );
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 5_000_000)
      throw new HttpError(
        413,
        "BODY_TOO_LARGE",
        "Request exceeds the 5 MB limit.",
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON.",
    );
  }
}
function send(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
export interface ApiOptions {
  dataDir: string;
  distDir?: string;
  providers?: Providers;
  liveEnabled?: boolean;
  acquirer?: Acquirer;
}
/** Local only; caller must bind to 127.0.0.1. Browser mutations are same-local-origin JSON. */
export function createApiServer(options: ApiOptions) {
  const store = new CaseStore(options.dataDir);
  const providers = options.providers ?? providersFromEnvironment();
  if (options.liveEnabled !== undefined)
    providers.liveEnabled = options.liveEnabled;
  const agentService = createAgentService({
    dataDir: options.dataDir,
    providers,
    acquirer: options.acquirer,
  });
  const locks = new Map<string, Promise<unknown>>();
  async function exclusive<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => withFileLock(store.path(id), operation));
    locks.set(id, current);
    try {
      return await current;
    } finally {
      if (locks.get(id) === current) locks.delete(id);
    }
  }
  return createServer(async (req, res) => {
    try {
      guard(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const method = req.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/status")
        return send(res, 200, {
          ...((await agentService.call("status", {})) as Record<
            string,
            unknown
          >),
          version: 1,
          bind: "127.0.0.1",
          liveAvailable: providers.liveEnabled,
          arkham: {
            available: false,
            reason:
              "Optional permitted enrichment is not implemented. No proprietary labels are bundled.",
          },
          limits: operationSchema.limits,
        });
      if (method === "GET" && url.pathname === "/api/schema")
        return send(res, 200, operationSchema);
      if (method === "POST" && url.pathname === "/api/replay")
        return send(
          res,
          200,
          await agentService.call("replay", await body(req)),
        );
      if (method === "POST" && url.pathname === "/api/acquire")
        return send(
          res,
          200,
          await agentService.call("acquire", await body(req)),
        );
      if (parts[0] === "api" && parts[1] === "investigations") {
        if (parts.length === 2 && method === "GET")
          return send(res, 200, await store.list());
        if (parts.length === 2 && method === "POST") {
          const input = await body(req);
          if (!input || typeof input !== "object")
            throw new Error("Create request must be an object");
          const value = input as Record<string, unknown>;
          const result = await startInvestigation(
            value.root,
            value.mode,
            value.title,
            providers,
            value.historyMode,
          );
          await store.save(result);
          return send(res, 201, result);
        }
        const id = parts[2];
        if (!id || !validCaseId(id))
          throw new HttpError(
            400,
            "INVALID_CASE_ID",
            "Invalid investigation ID",
          );
        if (parts.length === 4 && parts[3] === "wallet" && method === "GET") {
          const query: Record<string, unknown> = {
            caseId: id,
            address: url.searchParams.get("address"),
          };
          for (const key of [
            "asset",
            "direction",
            "from",
            "to",
            "expectedRevision",
          ])
            if (url.searchParams.has(key))
              query[key] = url.searchParams.get(key);
          for (const key of ["chainId", "offset", "pageSize"])
            if (url.searchParams.has(key))
              query[key] = Number(url.searchParams.get(key));
          return send(res, 200, await agentService.call("wallet", query));
        }
        if (
          parts.length === 4 &&
          ["annotate", "visibility"].includes(parts[3]) &&
          method === "POST"
        ) {
          const input = await body(req);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new HttpError(
              400,
              "INVALID_ARGUMENT",
              "Workspace request must be an object.",
            );
          return send(
            res,
            200,
            await agentService.call(parts[3], { ...input, caseId: id }),
          );
        }
        if (parts.length === 4 && parts[3] === "replay" && method === "POST") {
          const input = await body(req);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new HttpError(
              400,
              "INVALID_ARGUMENT",
              "Replay request must be an object.",
            );
          return send(
            res,
            200,
            await agentService.call("replay", { ...input, caseId: id }),
          );
        }
        if (parts.length === 4 && parts[3] === "acquire" && method === "POST") {
          const input = await body(req);
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new HttpError(
              400,
              "INVALID_ARGUMENT",
              "Acquisition request must be an object.",
            );
          return send(
            res,
            200,
            await agentService.call("acquire", { ...input, caseId: id }),
          );
        }
        if (
          parts.length === 4 &&
          parts[3] === "protocols" &&
          method === "GET"
        ) {
          const value = await store.read(id);
          return send(res, 200, {
            caseId: id,
            mode: value.mode,
            analysis: value.protocolEvidence
              ? analyzeProtocolEvidence(value.protocolEvidence)
              : null,
            liveTraceProvider: false,
            transactionTraceCapability:
              "public capability probe; endpoint support is not guaranteed",
          });
        }
        if (parts.length === 3 && method === "GET")
          return send(res, 200, await store.read(id));
        if (parts.length === 3 && method === "PUT") {
          const value = parseInvestigation(await body(req));
          if (value.id !== id)
            throw new Error("Investigation ID must match its URL");
          const result = await exclusive(id, async () => {
            let previous;
            try {
              previous = await store.read(id);
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
              throw new HttpError(
                409,
                "CASE_IDENTITY_CONFLICT",
                "An existing investigation cannot change its root or mode. Create a separate case.",
              );
            if (previous && previous.updatedAt !== value.updatedAt)
              throw new HttpError(
                409,
                "CASE_CONFLICT",
                "Investigation changed since this snapshot was fetched. Reload the latest case before saving.",
              );
            const next = {
              ...value,
              updatedAt: nextRevision(previous?.updatedAt ?? value.updatedAt),
            };
            await store.save(next);
            return next;
          });
          return send(res, 200, result);
        }
        if (parts.length === 4 && parts[3] === "expand" && method === "POST") {
          const input = await body(req);
          const value = await exclusive(id, async () => {
            const current = await store.read(id);
            const next = await expandCase(current, input, providers);
            next.updatedAt = nextRevision(current.updatedAt);
            await store.save(next);
            return next;
          });
          return send(res, 200, value);
        }
        if (method === "GET" && parts[3] === "export" && parts.length === 4)
          return send(res, 200, await store.read(id), {
            "content-disposition": `attachment; filename="flowlens-${id}.json"`,
          });
        if (method === "GET" && parts[3] === "evidence" && parts.length === 5) {
          const value = await store.read(id);
          const transfer = value.transfers.find((t) => t.id === parts[4]);
          if (!transfer)
            throw new HttpError(
              404,
              "EVIDENCE_NOT_FOUND",
              "Evidence ID was not found in this investigation.",
            );
          return send(res, 200, transfer);
        }
        if (method === "GET" && parts[3] === "graph" && parts.length === 4) {
          const value = await store.read(id);
          const direction = url.searchParams.get("direction") ?? "all";
          if (!["all", "in", "out"].includes(direction))
            throw new Error("Direction must be all, in or out");
          const chain = url.searchParams.get("chainId");
          if (chain !== null && !["1", "8453", "42161"].includes(chain))
            throw new Error("Chain ID must be 1, 8453 or 42161");
          const transfers = filterTransfers(value.transfers, value.root, {
            ...(chain ? { chainId: Number(chain) } : {}),
            direction: direction as "all" | "in" | "out",
            asset: url.searchParams.get("asset") ?? undefined,
            from: url.searchParams.get("from") ?? undefined,
            to: url.searchParams.get("to") ?? undefined,
          });
          const visible = visibleTransfers(value, transfers);
          return send(res, 200, {
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
            flows: aggregateFlows(transfers, value.root),
            coverage: value.coverage,
          });
        }
        throw new HttpError(
          404,
          "NOT_FOUND",
          "Unknown investigation operation.",
        );
      }
      if (url.pathname.startsWith("/api/"))
        throw new HttpError(404, "NOT_FOUND", "Unknown API operation.");
      if (method === "GET" && options.distDir) {
        const directory = resolve(options.distDir);
        const path = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
        if (path !== directory && !path.startsWith(`${directory}${sep}`))
          throw new HttpError(403, "INVALID_PATH", "Invalid asset path.");
        const file = extname(path) ? path : resolve(directory, "index.html");
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        const bytes = await readFile(file);
        res.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(bytes);
        return;
      }
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Build the app or use the local Vite preview.",
      );
    } catch (error) {
      const missing =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT";
      const agentStatus =
        error instanceof AgentOperationError
          ? (
              {
                CASE_NOT_FOUND: 404,
                EVIDENCE_NOT_FOUND: 404,
                CASE_CONFLICT: 409,
                CASE_IDENTITY_CONFLICT: 409,
                CASE_BUSY: 409,
                INVALID_EVIDENCE_CONFLICT: 409,
                KEY_REQUIRED: 503,
                INPUT_TOO_LARGE: 413,
              } as Record<string, number>
            )[error.code]
          : undefined;
      const status =
        agentStatus ??
        (error instanceof HttpError
          ? error.status
          : error instanceof CaseBusyError ||
              (error instanceof AgentOperationError &&
                ["CASE_BUSY", "CASE_CONFLICT"].includes(error.code))
            ? 409
            : missing
              ? 404
              : (error instanceof ProviderError ||
                    error instanceof AgentOperationError) &&
                  error.code === "KEY_REQUIRED"
                ? 503
                : 400);
      const code =
        error instanceof HttpError ||
        error instanceof ProviderError ||
        error instanceof AgentOperationError ||
        error instanceof CaseBusyError
          ? error.code
          : missing
            ? "NOT_FOUND"
            : "INVALID_REQUEST";
      const message =
        error instanceof HttpError || error instanceof ProviderError
          ? error.message
          : missing
            ? "Investigation or asset not found."
            : error instanceof Error
              ? error.message
              : "Request failed.";
      send(res, status, {
        error: {
          code,
          message: message.slice(0, 500),
          retryable:
            error instanceof CaseBusyError ||
            ((error instanceof ProviderError ||
              error instanceof AgentOperationError) &&
              error.retryable),
        },
      });
    }
  });
}
