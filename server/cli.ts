#!/usr/bin/env node
import {
  analyzeProtocolEvidence,
  createSyntheticProtocolEvidence,
  parseProtocolEvidence,
  mergeProtocolEvidence,
  EvidenceConflictError,
} from "../src/domain/protocols.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  aggregateFlows,
  buildEdges,
  filterTransfers,
} from "../src/domain/engine.ts";
import { DEMO_ROOT } from "../src/domain/demo.ts";
import {
  expandCase,
  operationSchema,
  providersFromEnvironment,
  startInvestigation,
} from "./operations.ts";
import {
  CaseBusyError,
  nextRevision,
  readSnapshot,
  readBoundedJsonFile,
  JsonFileError,
  withFileLock as lock,
  writeSnapshot,
} from "./store.ts";
import { ProviderError } from "./etherscan.ts";
import { RpcProviderError } from "./rpc.ts";
import { AgentOperationError, createAgentService } from "./agent.ts";
import { annotateWallet, setVisibility } from "../src/domain/workspace.ts";
import { visibleTransfers, walletFlows } from "../src/domain/wallet-flows.ts";
import {
  acquireProtocolEvidence,
  parseAcquisitionInput,
  AcquisitionError,
} from "./acquire.ts";

const args = process.argv.slice(2),
  command = args.shift() ?? "help";
const allowed = new Set([
  "--file",
  "--address",
  "--mode",
  "--chain",
  "--pages",
  "--page-size",
  "--title",
  "--id",
  "--asset",
  "--direction",
  "--from",
  "--to",
  "--protocol-file",
  "--fixture",
  "--history-mode",
  "--kind",
  "--hash",
  "--max-calls",
  "--block-number",
  "--cursor",
  "--include-history",
  "--verify-signatures",
  "--max-signatures",
  "--max-logs",
  "--max-traces",
  "--label-file",
  "--remove",
  "--node-keys",
  "--transfer-ids",
  "--visible",
  "--expected-revision",
  "--offset",
]);
const flags: Record<string, string> = {};
function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
async function main() {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith("--"))
      throw new Error(`Unknown or incomplete option: ${name}`);
    if (flags[name] !== undefined) throw new Error(`Duplicate option: ${name}`);
    flags[name] = value;
  }
  if (command === "help") {
    print({
      name: "flowlens",
      usage: "node server/cli.ts <operation> [options]",
      operations: {
        status: "No arguments; provider availability and limits.",
        schema: "No arguments; machine contract.",
        create:
          "--mode demo|live --file PATH [--address EVM] [--title TEXT] [--history-mode indexed|evidence-only]",
        expand:
          "--file PATH --address EVM --chain 1|8453|42161 [--pages 1..3] [--page-size N]",
        annotate:
          "--file PATH --chain N --address EVM (--label-file PATH | --remove true) [--expected-revision ISO_TIMESTAMP]; local attribution assertion, not ownership authentication.",
        visibility:
          "--file PATH [--node-keys JSON_ARRAY] [--transfer-ids JSON_ARRAY] --visible true|false [--expected-revision ISO_TIMESTAMP]; changes graph visibility without deleting evidence.",
        wallet:
          "--file PATH --address EVM [--chain N] [--asset CONTRACT_KEY] [--direction all|in|out] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--offset N --expected-revision ISO_TIMESTAMP] [--page-size 1..100]; later pages require the previous result revision; loaded wallet-relative inflows/outflows and counterparties, no provider query.",
        inspect: "--file PATH",
        evidence: "--file PATH --id EVIDENCE_ID",
        graph:
          "--file PATH [--chain N] [--asset CONTRACT_KEY] [--direction all|in|out] [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
        export: "--file PATH",
        replay:
          "--fixture protocols-v1 | --protocol-file PATH [--file CASE_PATH]",
        acquire:
          "--kind safe|bridge|internal --chain 1|8453|42161 --address EVM|--hash TX [--file LIVE_CASE_PATH] [--max-calls 1..64]; Safe optional --pages 1..3 --cursor TOKEN --verify-signatures true|false --max-signatures 1..5 --include-history true|false --block-number N; bridge --max-logs 1..2000; internal --max-traces 1..2000. Explicit queries disclose identifiers to fixed public providers.",
      },
      exitCodes: {
        0: "success; coverage may still be partial",
        1: "validation, unavailable provider or operation error",
        2: "saved investigation contains provider/coverage error; resume after resolving it",
      },
    });
    return;
  }
  const providers = providersFromEnvironment();
  if (command === "status") {
    print(await createAgentService({ providers }).call("status"));
    return;
  }
  if (command === "schema") {
    print(operationSchema);
    return;
  }
  if (command === "acquire") {
    const request: Record<string, unknown> = {
      kind: flags["--kind"],
      chainId: Number(flags["--chain"]),
    };
    for (const [flag, key] of [
      ["--address", "address"],
      ["--hash", "hash"],
      ["--cursor", "cursor"],
    ])
      if (flags[flag] !== undefined) request[key] = flags[flag];
    for (const [flag, key] of [
      ["--max-calls", "maxCalls"],
      ["--pages", "maxPages"],
      ["--block-number", "blockNumber"],
      ["--max-signatures", "maxSignatures"],
      ["--max-logs", "maxLogs"],
      ["--max-traces", "maxTraces"],
    ])
      if (flags[flag] !== undefined) request[key] = Number(flags[flag]);
    for (const [flag, key] of [
      ["--include-history", "includeHistory"],
      ["--verify-signatures", "verifySignatures"],
    ]) {
      if (flags[flag] === undefined) continue;
      if (!["true", "false"].includes(flags[flag]))
        throw new Error(`${flag} must be true or false`);
      request[key] = flags[flag] === "true";
    }
    const query = parseAcquisitionInput(request);
    const path = flags["--file"] ? resolve(flags["--file"]) : undefined;
    if (path && (await readSnapshot(path)).mode !== "live")
      throw new Error(
        "Live acquisition requires a live investigation; demo cases cannot query public providers.",
      );
    const result = await acquireProtocolEvidence(query);
    if (!path)
      print({
        ...result,
        version: 1,
        mode: "private",
        indexedHistoryChanged: false,
      });
    else {
      const value = await lock(path, async () => {
        const current = await readSnapshot(path);
        if (current.mode !== "live")
          throw new Error("Live acquisition requires a live investigation");
        const merged = mergeProtocolEvidence(
          current.protocolEvidence,
          result.bundle,
        );
        const next = {
          ...current,
          protocolEvidence: merged,
          updatedAt: nextRevision(current.updatedAt),
        };
        await writeSnapshot(path, next);
        return next;
      });
      print({
        ...result,
        bundle: value.protocolEvidence,
        analysis: analyzeProtocolEvidence(value.protocolEvidence!),
        version: 1,
        mode: "private",
        caseId: value.id,
        updatedAt: value.updatedAt,
        indexedHistoryChanged: false,
      });
    }
    if (result.errors.length) process.exitCode = 2;
    return;
  }
  if (command === "replay") {
    if (Boolean(flags["--fixture"]) === Boolean(flags["--protocol-file"]))
      throw new Error(
        "Supply exactly one --fixture protocols-v1 or --protocol-file PATH",
      );
    if (flags["--fixture"] && flags["--fixture"] !== "protocols-v1")
      throw new Error("Unknown synthetic replay fixture");
    let bundle;
    if (flags["--protocol-file"]) {
      const path = resolve(flags["--protocol-file"]);
      bundle = parseProtocolEvidence(
        await readBoundedJsonFile(path, "Protocol evidence"),
      );
    } else bundle = createSyntheticProtocolEvidence();
    const analysis = analyzeProtocolEvidence(bundle);
    if (!flags["--file"]) {
      print({ version: 1, mode: bundle.mode, analysis });
      return;
    }
    const path = resolve(flags["--file"]);
    const value = await lock(path, async () => {
      const current = await readSnapshot(path);
      const validated = parseProtocolEvidence(
        bundle,
        current.mode === "demo" ? "synthetic" : "private",
      );
      const next = {
        ...current,
        protocolEvidence: validated,
        updatedAt: nextRevision(current.updatedAt),
      };
      await writeSnapshot(path, next);
      return next;
    });
    print({
      version: 1,
      mode: bundle.mode,
      analysis,
      caseId: value.id,
      updatedAt: value.updatedAt,
      indexedHistoryChanged: false,
    });
    return;
  }
  if (
    ![
      "create",
      "expand",
      "inspect",
      "export",
      "evidence",
      "graph",
      "annotate",
      "visibility",
      "wallet",
    ].includes(command)
  )
    throw new Error(
      "Unknown operation. Use help for the machine-readable CLI contract.",
    );
  if (!flags["--file"]) throw new Error("--file PATH is required");
  const path = resolve(flags["--file"]);
  if (command === "create") {
    const mode = flags["--mode"] ?? "demo";
    const value = await lock(path, async () => {
      let exists = false;
      try {
        await access(path);
        exists = true;
      } catch {
        /* New file. */
      }
      if (exists)
        throw new Error(
          "Target investigation file already exists. Choose a new file or resume it with expand.",
        );
      const created = await startInvestigation(
        flags["--address"] ?? DEMO_ROOT,
        mode,
        flags["--title"],
        providers,
        flags["--history-mode"],
      );
      await writeSnapshot(path, created);
      return created;
    });
    print(value);
    if (value.coverage.some((c) => c.status === "error")) process.exitCode = 2;
    return;
  }
  if (command === "annotate" || command === "visibility") {
    let label: unknown;
    if (command === "annotate") {
      if (!flags["--chain"] || !flags["--address"])
        throw new Error("Annotation requires --chain and --address");
      if (Boolean(flags["--label-file"]) === Boolean(flags["--remove"]))
        throw new Error(
          "Supply exactly one --label-file PATH or --remove true",
        );
      if (flags["--remove"] && flags["--remove"] !== "true")
        throw new Error("--remove must be true");
      label = flags["--label-file"]
        ? await readBoundedJsonFile(
            resolve(flags["--label-file"]),
            "Wallet label",
          )
        : null;
    } else if (!["true", "false"].includes(flags["--visible"])) {
      throw new Error("--visible must be true or false");
    }
    const selection = (flag: string): string[] | undefined => {
      if (flags[flag] === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(flags[flag]);
      } catch {
        throw new Error(`${flag} must be a JSON array of strings`);
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length > 20_000 ||
        parsed.some((item) => typeof item !== "string")
      )
        throw new Error(`${flag} must be a bounded JSON array of strings`);
      return parsed;
    };
    const nodeKeys = selection("--node-keys"),
      transferIds = selection("--transfer-ids");
    const value = await lock(path, async () => {
      const current = await readSnapshot(path);
      if (
        flags["--expected-revision"] !== undefined &&
        flags["--expected-revision"] !== current.updatedAt
      )
        throw new AgentOperationError(
          "CASE_CONFLICT",
          "Investigation changed. Fetch the latest revision before changing workspace controls.",
          true,
        );
      const next =
        command === "annotate"
          ? annotateWallet(current, {
              chainId: Number(flags["--chain"]),
              address: flags["--address"],
              label,
            })
          : setVisibility(current, {
              ...(nodeKeys === undefined ? {} : { nodeKeys }),
              ...(transferIds === undefined ? {} : { transferIds }),
              visible: flags["--visible"] === "true",
            });
      next.updatedAt = nextRevision(current.updatedAt);
      await writeSnapshot(path, next);
      return next;
    });
    print(value);
    return;
  }
  if (command === "expand") {
    if (!flags["--address"] || !flags["--chain"])
      throw new Error("Expansion requires --address and --chain");
    const value = await lock(path, async () => {
      const current = await readSnapshot(path);
      const next = await expandCase(
        current,
        {
          address: flags["--address"],
          chainId: Number(flags["--chain"]),
          maxPages: Number(flags["--pages"] ?? 1),
          ...(flags["--page-size"]
            ? { pageSize: Number(flags["--page-size"]) }
            : {}),
        },
        providers,
      );
      next.updatedAt = nextRevision(current.updatedAt);
      await writeSnapshot(path, next);
      return next;
    });
    print(value);
    if (value.coverage.some((c) => c.status === "error")) process.exitCode = 2;
    return;
  }
  const value = await readSnapshot(path);
  if (command === "export") {
    print(value);
    return;
  }
  if (command === "evidence") {
    const evidence = value.transfers.find((t) => t.id === flags["--id"]);
    if (!evidence)
      throw new Error("Evidence ID was not found in this investigation");
    print(evidence);
    return;
  }
  if (command === "wallet") {
    if (!flags["--address"])
      throw new Error("Wallet inspection requires --address");
    const offset = Number(flags["--offset"] ?? 0);
    const expectedRevision = flags["--expected-revision"];
    if (offset > 0 && expectedRevision === undefined)
      throw new AgentOperationError(
        "INVALID_CURSOR",
        "Wallet pages after the first require --expected-revision from the previous result.",
      );
    if (expectedRevision !== undefined && expectedRevision !== value.updatedAt)
      throw new AgentOperationError(
        "CURSOR_STALE",
        "Investigation changed; restart the wallet query at offset 0 to use its current revision.",
        true,
      );
    print({
      caseId: value.id,
      revision: value.updatedAt,
      ...walletFlows(value, {
        address: flags["--address"],
        ...(flags["--chain"] ? { chainId: Number(flags["--chain"]) } : {}),
        filter: {
          ...(flags["--asset"] ? { asset: flags["--asset"] } : {}),
          ...(flags["--direction"]
            ? { direction: flags["--direction"] as "all" | "in" | "out" }
            : {}),
          ...(flags["--from"] ? { from: flags["--from"] } : {}),
          ...(flags["--to"] ? { to: flags["--to"] } : {}),
        },
        ...(flags["--offset"] !== undefined
          ? { offset: Number(flags["--offset"]) }
          : {}),
        ...(flags["--page-size"] !== undefined
          ? { pageSize: Number(flags["--page-size"]) }
          : {}),
      }),
    });
    return;
  }
  if (command === "graph") {
    const direction = flags["--direction"] ?? "all";
    if (!["all", "in", "out"].includes(direction))
      throw new Error("Direction must be all, in or out");
    const chain = flags["--chain"];
    if (chain && !["1", "8453", "42161"].includes(chain))
      throw new Error("Chain must be 1, 8453 or 42161");
    const transfers = filterTransfers(value.transfers, value.root, {
      ...(chain ? { chainId: Number(chain) } : {}),
      asset: flags["--asset"],
      direction: direction as "all" | "in" | "out",
      from: flags["--from"],
      to: flags["--to"],
    });
    const visible = visibleTransfers(value, transfers);
    print({
      root: value.root,
      transfers,
      edges: buildEdges(visible),
      flows: aggregateFlows(transfers, value.root),
      coverage: value.coverage,
      visibleTransferIds: visible.map((t) => t.id),
      hidden: {
        nodeKeys: value.hidden,
        transferIds: value.hiddenTransfers ?? [],
      },
      visibilityNote:
        "Visibility changes graph paths only; transfers and gross/net remain all filtered loaded evidence.",
    });
    return;
  }
  print({
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
      ? { protocolAnalysis: analyzeProtocolEvidence(value.protocolEvidence) }
      : {}),
  });
}
main().catch((error) => {
  const code =
    error instanceof ProviderError ||
    error instanceof RpcProviderError ||
    error instanceof AcquisitionError ||
    error instanceof CaseBusyError ||
    error instanceof EvidenceConflictError ||
    error instanceof JsonFileError ||
    error instanceof AgentOperationError
      ? error.code
      : "INVALID_OPERATION";
  const message = error instanceof Error ? error.message : "Operation failed";
  process.stderr.write(
    `${JSON.stringify({ error: { code, message: message.slice(0, 500), retryable: error instanceof CaseBusyError || (error instanceof AgentOperationError && error.retryable) || ((error instanceof ProviderError || error instanceof RpcProviderError || error instanceof AcquisitionError) && error.retryable) } })}\n`,
  );
  process.exitCode = 1;
});
