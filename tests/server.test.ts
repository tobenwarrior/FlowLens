import test from "node:test";
import assert from "node:assert/strict";
import { createEtherscanProvider, ProviderError } from "../server/etherscan.ts";
import {
  createInvestigation,
  expandInvestigation,
} from "../src/domain/engine.ts";

const ROOT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"a".repeat(64)}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const receiptLog = {
  address: CONTRACT,
  transactionHash: HASH,
  blockNumber: "0xa",
  topics: [transferTopic, topic(OTHER), topic(ROOT)],
  data: "0xb71b00",
  logIndex: "0x7",
};
const receipt = {
  status: "0x1",
  transactionHash: HASH,
  blockNumber: "0xa",
  logs: [receiptLog],
};
const native = {
  blockNumber: "10",
  timeStamp: "1700000000",
  hash: HASH,
  from: OTHER,
  to: ROOT,
  value: "9007199254740993000",
  isError: "0",
  txreceipt_status: "1",
};

test("live provider requires a user key without making any network request", async () => {
  let calls = 0;
  const provider = createEtherscanProvider({
    key: "",
    fetch: async () => {
      calls++;
      return new Response("{}");
    },
    intervalMs: 0,
  });
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1 }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "KEY_REQUIRED",
  );
  assert.equal(calls, 0);
});

test("native and ERC20 evidence retain integer precision, chain and actual log index", async () => {
  const actions: string[] = [];
  const provider = createEtherscanProvider({
    key: "private-key",
    intervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("action")!;
      actions.push(action);
      const value =
        action === "eth_blockNumber"
          ? { result: "0x14" }
          : action === "txlist"
            ? { status: "1", result: [native] }
            : action === "tokentx"
              ? {
                  status: "1",
                  result: [
                    {
                      ...native,
                      contractAddress: CONTRACT,
                      tokenDecimal: "6",
                      tokenSymbol: "USDC",
                      value: "12000000",
                    },
                  ],
                }
              : { result: receipt };
      return Response.json(value);
    },
  });
  const page = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 2,
  });
  assert.equal(page.transfers.length, 2);
  assert.equal(page.transfers[0].rawAmount, "9007199254740993000");
  assert.equal(page.transfers[1].eventIndex, "7");
  assert.equal(page.transfers[1].rawAmount, "12000000");
  assert.equal(page.transfers[1].asset.contract, CONTRACT);
  assert.equal(page.transfers[1].chainId, 1);
  assert.ok(page.warnings.some((w) => w.includes("Internal")));
  assert.deepEqual(actions, [
    "eth_blockNumber",
    "txlist",
    "tokentx",
    "eth_getTransactionReceipt",
  ]);
});

test("cursor pins chain/address/page size and frozen block; tampering is rejected before calls", async () => {
  const urls: URL[] = [];
  const provider = createEtherscanProvider({
    key: "key",
    intervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(
        url.searchParams.get("action") === "eth_blockNumber"
          ? { result: "0x14" }
          : {
              status: "1",
              result:
                url.searchParams.get("action") === "txlist" ? [native] : [],
            },
      );
    },
  });
  const first = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 1,
  });
  assert.ok(first.cursor);
  await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    cursor: first.cursor,
    pageSize: 1,
  });
  const second = urls.filter(
    (u) => u.searchParams.get("action") === "txlist",
  )[1];
  assert.equal(second.searchParams.get("page"), "2");
  assert.equal(second.searchParams.get("endblock"), "20");
  const before = urls.length;
  await assert.rejects(
    provider.fetchPage({
      address: OTHER,
      chainId: 1,
      cursor: first.cursor,
      pageSize: 1,
    }),
    /cursor/i,
  );
  assert.equal(urls.length, before);
});

test("provider access denial is explicit and never exposes server key or raw response", async () => {
  const provider = createEtherscanProvider({
    key: "secret-123",
    intervalMs: 0,
    fetch: async () =>
      Response.json({
        status: "0",
        message: "NOTOK",
        result: "Free API access is not supported for this chain secret-123",
      }),
  });
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 42161 }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "ACCESS_DENIED" &&
      !error.message.includes("secret-123"),
  );
});

test("out-of-scope chain and page budget fail before network", async () => {
  let calls = 0;
  const provider = createEtherscanProvider({
    key: "key",
    intervalMs: 0,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 56 }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "UNSUPPORTED_CHAIN",
  );
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1, pageSize: 100 }),
    /page size/i,
  );
  assert.equal(calls, 0);
});

test("failed transactions and malformed provider rows never become successful evidence", async () => {
  const provider = createEtherscanProvider({
    key: "key",
    intervalMs: 0,
    fetch: async (input) => {
      const action = new URL(String(input)).searchParams.get("action");
      return Response.json(
        action === "eth_blockNumber"
          ? { result: "0x14" }
          : {
              status: "1",
              result:
                action === "txlist"
                  ? [
                      { ...native, isError: "1" },
                      { ...native, hash: "bad" },
                    ]
                  : [],
            },
      );
    },
  });
  const page = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 3,
  });
  assert.equal(page.transfers.length, 0);
  assert.ok(page.warnings.some((w) => w.includes("malformed")));
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApiServer } from "../server/api.ts";
import type { AddressInfo } from "node:net";

async function withApi(fn: (base: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-test-"));
  const server = createApiServer({ dataDir: dir, liveEnabled: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
}
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("HTTP status and schema are machine readable without disclosing credentials", async () =>
  withApi(async (base) => {
    const response = await fetch(`${base}/api/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.providers.live.available, false);
    assert.equal(status.bind, "127.0.0.1");
    const schema = await (await fetch(`${base}/api/schema`)).json();
    assert.equal(schema.version, 1);
    assert.ok(schema.operations.includes("expand"));
  }));

test("API persists a demo investigation and exposes evidence IDs and JSON export", async () =>
  withApi(async (base, dir) => {
    const created = await fetch(
      `${base}/api/investigations`,
      json({ root: ROOT, mode: "demo" }),
    );
    assert.equal(created.status, 201);
    const value = await created.json();
    assert.equal(value.mode, "demo");
    assert.ok(value.transfers.length > 0);
    const stored = JSON.parse(
      await readFile(join(dir, `${value.id}.json`), "utf8"),
    );
    assert.equal(stored.id, value.id);
    const evidence = await fetch(
      `${base}/api/investigations/${value.id}/evidence/${encodeURIComponent(value.transfers[0].id)}`,
    );
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json()).id, value.transfers[0].id);
    value.notes = "A preserved local investigation note";
    const saved = await fetch(`${base}/api/investigations/${value.id}`, {
      ...json(value),
      method: "PUT",
    });
    assert.equal(saved.status, 200);
    const exported = await fetch(
      `${base}/api/investigations/${value.id}/export`,
    );
    assert.equal((await exported.json()).notes, value.notes);
    const listed = await (await fetch(`${base}/api/investigations`)).json();
    assert.equal(listed[0].id, value.id);
  }));

test("API rejects remote origin, form mutation, malformed address and invalid budget", async () =>
  withApi(async (base) => {
    assert.equal(
      (
        await fetch(`${base}/api/investigations`, {
          ...json({ root: ROOT, mode: "demo" }),
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/investigations`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "mode=demo",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/investigations`,
          json({ root: "invalid", mode: "demo" }),
        )
      ).status,
      400,
    );
    const value = await (
      await fetch(
        `${base}/api/investigations`,
        json({ root: ROOT, mode: "demo" }),
      )
    ).json();
    assert.equal(
      (
        await fetch(
          `${base}/api/investigations/${value.id}/expand`,
          json({ address: ROOT, chainId: 1, maxPages: 999 }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/investigations/${value.id}/expand`,
          json({ address: ROOT, chainId: 56, maxPages: 1 }),
        )
      ).status,
      400,
    );
  }));

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("CLI creates, resumes and exports a case without clicking the UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-cli-"));
  const file = join(dir, "case.json");
  try {
    const created = JSON.parse(
      (
        await exec(process.execPath, [
          "server/cli.ts",
          "create",
          "--mode",
          "demo",
          "--file",
          file,
        ])
      ).stdout,
    );
    assert.equal(created.mode, "demo");
    assert.ok(created.transfers.length > 0);
    const expanded = JSON.parse(
      (
        await exec(process.execPath, [
          "server/cli.ts",
          "expand",
          "--file",
          file,
          "--address",
          ROOT,
          "--chain",
          "1",
          "--pages",
          "1",
        ])
      ).stdout,
    );
    assert.ok(expanded.transfers.length >= created.transfers.length);
    const exported = JSON.parse(
      (
        await exec(process.execPath, [
          "server/cli.ts",
          "export",
          "--file",
          file,
        ])
      ).stdout,
    );
    assert.equal(exported.id, created.id);
    assert.equal(exported.transfers.length, expanded.transfers.length);
    const inspected = JSON.parse(
      (
        await exec(process.execPath, [
          "server/cli.ts",
          "inspect",
          "--file",
          file,
        ])
      ).stdout,
    );
    assert.equal(inspected.id, created.id);
    assert.ok(Array.isArray(inspected.coverage));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API live mode without permitted key is unavailable rather than empty live data", async () =>
  withApi(async (base) => {
    const result = await fetch(
      `${base}/api/investigations`,
      json({ root: ROOT, mode: "live" }),
    );
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, "KEY_REQUIRED");
  }));

test("missing ERC20 receipt is retryable and does not advance the history cursor", async () => {
  const provider = createEtherscanProvider({
    key: "key",
    intervalMs: 0,
    fetch: async (input) => {
      const action = new URL(String(input)).searchParams.get("action");
      return Response.json(
        action === "eth_blockNumber"
          ? { result: "0x14" }
          : action === "txlist"
            ? { status: "1", result: [] }
            : action === "tokentx"
              ? {
                  status: "1",
                  result: [
                    {
                      ...native,
                      contractAddress: CONTRACT,
                      tokenDecimal: "6",
                      tokenSymbol: "USDC",
                    },
                  ],
                }
              : { result: null },
      );
    },
  });
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1, pageSize: 2 }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "RECEIPT_UNAVAILABLE" &&
      error.retryable,
  );
});

test("concurrent API expansions serialize against the last committed cursor", async () =>
  withApi(async (base) => {
    const initial = await (
      await fetch(
        `${base}/api/investigations`,
        json({ root: ROOT, mode: "demo" }),
      )
    ).json();
    const initialPages = initial.coverage.find(
      (c: { chainId: number }) => c.chainId === 1,
    ).pagesLoaded;
    const request = () =>
      fetch(
        `${base}/api/investigations/${initial.id}/expand`,
        json({ address: ROOT, chainId: 1, maxPages: 1 }),
      );
    const results = await Promise.all([request(), request()]);
    assert.ok(results.every((r) => r.ok));
    const final = await (
      await fetch(`${base}/api/investigations/${initial.id}`)
    ).json();
    assert.ok(
      final.coverage.find((c: { chainId: number }) => c.chainId === 1)
        .pagesLoaded > initialPages,
    );
    assert.equal(
      new Set(final.transfers.map((t: { id: string }) => t.id)).size,
      final.transfers.length,
    );
  }));

test("stale full snapshot saves cannot overwrite evidence committed by a later expansion", async () =>
  withApi(async (base) => {
    const initial = await (
      await fetch(
        `${base}/api/investigations`,
        json({ root: ROOT, mode: "demo" }),
      )
    ).json();
    await fetch(
      `${base}/api/investigations/${initial.id}/expand`,
      json({ address: ROOT, chainId: 1, maxPages: 1 }),
    );
    initial.notes = "Stale annotation";
    const rejected = await fetch(`${base}/api/investigations/${initial.id}`, {
      ...json(initial),
      method: "PUT",
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, "CASE_CONFLICT");
    const current = await (
      await fetch(`${base}/api/investigations/${initial.id}`)
    ).json();
    current.notes = "Fresh annotation";
    const saved = await fetch(`${base}/api/investigations/${initial.id}`, {
      ...json(current),
      method: "PUT",
    });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.notes, "Fresh annotation");
    assert.ok(Date.parse(result.updatedAt) > Date.parse(current.updatedAt));
  }));

import { writeFile } from "node:fs/promises";

test("API honors on-disk CLI lock rather than racing a shared case file", async () =>
  withApi(async (base, dir) => {
    const value = await (
      await fetch(
        `${base}/api/investigations`,
        json({ root: ROOT, mode: "demo" }),
      )
    ).json();
    await writeFile(join(dir, `${value.id}.json.lock`), "");
    const response = await fetch(
      `${base}/api/investigations/${value.id}/expand`,
      json({ address: ROOT, chainId: 1 }),
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "CASE_BUSY");
  }));

test("native contract-creation funding uses the actual created contract address", async () => {
  const provider = createEtherscanProvider({
    key: "key",
    intervalMs: 0,
    fetch: async (input) => {
      const action = new URL(String(input)).searchParams.get("action");
      return Response.json(
        action === "eth_blockNumber"
          ? { result: "0x14" }
          : {
              status: "1",
              result:
                action === "txlist"
                  ? [
                      {
                        ...native,
                        from: ROOT,
                        to: "",
                        contractAddress: CONTRACT,
                      },
                    ]
                  : [],
            },
      );
    },
  });
  const page = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 2,
  });
  assert.equal(page.transfers.length, 1);
  assert.equal(page.transfers[0].to, CONTRACT);
});

test("receipt identity mismatches reject the whole page rather than attaching another transaction logs", async () => {
  const otherHash = `0x${"b".repeat(64)}`;
  const variants = [
    { ...receipt, transactionHash: otherHash },
    { ...receipt, blockNumber: "0x11" },
    { ...receipt, transactionHash: undefined },
    { ...receipt, blockNumber: undefined },
    { ...receipt, logs: [{ ...receiptLog, transactionHash: otherHash }] },
    { ...receipt, logs: [{ ...receiptLog, blockNumber: "0x11" }] },
    { ...receipt, logs: [{ ...receiptLog, removed: true }] },
  ];
  for (const invalid of variants) {
    const provider = createEtherscanProvider({
      key: "key",
      intervalMs: 0,
      fetch: async (input) => {
        const action = new URL(String(input)).searchParams.get("action");
        return Response.json(
          action === "eth_blockNumber"
            ? { result: "0x14" }
            : action === "txlist"
              ? { status: "1", result: [native] }
              : action === "tokentx"
                ? {
                    status: "1",
                    result: [
                      {
                        ...native,
                        contractAddress: CONTRACT,
                        tokenDecimal: "6",
                        tokenSymbol: "USDC",
                      },
                    ],
                  }
                : { result: invalid },
        );
      },
    });
    await assert.rejects(
      provider.fetchPage({ address: ROOT, chainId: 1, pageSize: 2 }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === "RECEIPT_MISMATCH" &&
        error.retryable,
    );
  }
});

test("API and CLI expose shared JSON Schema request and evidence contracts", async () =>
  withApi(async (base) => {
    const schema = await (await fetch(`${base}/api/schema`)).json();
    assert.equal(
      schema.jsonSchema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    const defs = schema.jsonSchema.$defs;
    assert.deepEqual(defs.CreateRequest.required, ["root", "mode"]);
    assert.equal(defs.ExpandRequest.properties.maxPages.maximum, 3);
    assert.deepEqual(
      defs.ExpandLiveRequest.properties.chainId.enum,
      [1, 42161],
    );
    assert.equal(defs.ExpandLiveRequest.properties.pageSize.maximum, 10);
    assert.deepEqual(schema.limits.liveChains, [1, 42161]);
    for (const field of [
      "id",
      "chainId",
      "hash",
      "kind",
      "eventIndex",
      "from",
      "to",
      "asset",
      "rawAmount",
      "timestamp",
      "source",
      "retrievedAt",
    ])
      assert.ok(defs.Transfer.required.includes(field));
    assert.deepEqual(defs.Transfer.properties.status.enum, ["success"]);
    for (const field of [
      "version",
      "root",
      "mode",
      "transfers",
      "nodes",
      "coverage",
      "expanded",
      "pinned",
      "hidden",
      "notes",
    ])
      assert.ok(defs.Investigation.required.includes(field));
    assert.equal(schema.contracts.create.method, "POST");
    assert.equal(schema.contracts.create.path, "/api/investigations");
    assert.equal(
      schema.contracts.expand.bodySchema.$ref,
      `${schema.jsonSchema.$id}#/$defs/ExpandRequest`,
    );
    assert.equal(
      schema.contracts.graph.querySchema.$ref,
      `${schema.jsonSchema.$id}#/$defs/GraphFilters`,
    );
    assert.equal(
      schema.contracts.evidence.responseSchema.$ref,
      `${schema.jsonSchema.$id}#/$defs/Transfer`,
    );
    assert.equal(defs.Investigation.additionalProperties, true);
    assert.equal(defs.Investigation["x-unknownFields"], "stripped");
    assert.equal(
      defs.Coverage.properties.errorCode.pattern,
      "^[A-Z0-9_]{1,64}$",
    );
    assert.equal(defs.Coverage.properties.retryable.type, "boolean");
    const cli = JSON.parse(
      (await exec(process.execPath, ["server/cli.ts", "schema"])).stdout,
    );
    assert.deepEqual(cli, schema);
  }));

test("HTTP replay stores protocol evidence independently and rejects case relabeling", () =>
  withApi(async (base) => {
    const created = await fetch(
      `${base}/api/investigations`,
      json({ root: ROOT, mode: "demo" }),
    ).then((r) => r.json());
    const stateless = await fetch(
      `${base}/api/replay`,
      json({ fixture: "protocols-v1" }),
    );
    assert.equal(stateless.status, 200);
    assert.equal((await stateless.json()).mode, "synthetic");
    const attached = await fetch(
      `${base}/api/investigations/${created.id}/replay`,
      json({ fixture: "protocols-v1" }),
    );
    assert.equal(attached.status, 200);
    assert.equal((await attached.json()).indexedHistoryChanged, false);
    const persisted = await fetch(
      `${base}/api/investigations/${created.id}`,
    ).then((r) => r.json());
    assert.equal(persisted.protocolEvidence.mode, "synthetic");
    assert.equal(persisted.transfers.length, 16);
    const analysis = await fetch(
      `${base}/api/investigations/${created.id}/protocols`,
    ).then((r) => r.json());
    assert.equal(analysis.analysis.safe.executionCount, 11);
    assert.equal(analysis.liveTraceProvider, false);
    const changed = await fetch(`${base}/api/investigations/${created.id}`, {
      ...json({ ...persisted, root: OTHER }),
      method: "PUT",
    });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "CASE_IDENTITY_CONFLICT");
    const missing = await fetch(
      `${base}/api/investigations/missing/replay`,
      json({ fixture: "protocols-v1" }),
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "CASE_NOT_FOUND");
  }));

test("Etherscan rejects declared oversized responses before consuming their body", async () => {
  let pulled = false;
  const response = new Response(
    new ReadableStream({
      type: "bytes",
      pull(controller) {
        pulled = true;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ result: "0x14" })),
        );
        controller.close();
      },
    }),
    { headers: { "content-length": "2000001" } },
  );
  let calls = 0;
  const provider = createEtherscanProvider({
    key: "test-key",
    intervalMs: 0,
    fetch: async () =>
      ++calls === 1 ? response : Response.json({ status: "1", result: [] }),
  });
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1 }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_RESPONSE_TOO_LARGE" &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
  assert.equal(pulled, false);
});

test("Etherscan cancels oversized chunked responses and preserves the last committed page", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ status: "1", result: [], padding: "x".repeat(3000000) }),
  );
  let cancelled = false;
  const provider = createEtherscanProvider({
    key: "test-key",
    intervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input)),
        action = url.searchParams.get("action"),
        page = Number(url.searchParams.get("page"));
      if (action === "eth_blockNumber")
        return Response.json({ result: "0x14" });
      if (action === "txlist")
        return Response.json({
          status: "1",
          result: [
            {
              ...native,
              ...(page === 2 ? { hash: `0x${"b".repeat(64)}` } : {}),
            },
          ],
        });
      if (action === "eth_getTransactionReceipt")
        return Response.json({ result: receipt });
      if (page === 1)
        return Response.json({
          status: "1",
          result: [
            {
              ...native,
              contractAddress: CONTRACT,
              tokenDecimal: "6",
              tokenSymbol: "TEST",
            },
          ],
        });
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end = Math.min(offset + 200000, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const first = await expandInvestigation(
    createInvestigation(ROOT, "live"),
    provider,
    { address: ROOT, chainId: 1, pageSize: 1 },
  );
  assert.equal(first.coverage[0].pagesLoaded, 1);
  assert.ok(first.coverage[0].cursor);
  assert.equal(first.transfers.length, 2);
  const second = await expandInvestigation(first, provider, {
    address: ROOT,
    chainId: 1,
    pageSize: 1,
  });
  assert.equal(cancelled, true);
  assert.equal(second.coverage[0].status, "error");
  assert.equal(second.coverage[0].errorCode, "PROVIDER_RESPONSE_TOO_LARGE");
  assert.equal(second.coverage[0].retryable, false);
  assert.equal(second.coverage[0].cursor, first.coverage[0].cursor);
  assert.equal(second.coverage[0].pagesLoaded, first.coverage[0].pagesLoaded);
  assert.deepEqual(second.transfers, first.transfers);
});

function duplicateReceiptProvider(amounts: number[]) {
  return createEtherscanProvider({
    key: "test-key",
    intervalMs: 0,
    fetch: async (input) => {
      const action = new URL(String(input)).searchParams.get("action");
      return Response.json(
        action === "eth_blockNumber"
          ? { result: "0x14" }
          : action === "txlist"
            ? { status: "1", result: [] }
            : action === "tokentx"
              ? {
                  status: "1",
                  result: [
                    {
                      ...native,
                      contractAddress: CONTRACT,
                      tokenDecimal: "6",
                      tokenSymbol: "TEST",
                    },
                  ],
                }
              : {
                  result: {
                    ...receipt,
                    logs: amounts.map((amount) => ({
                      ...receiptLog,
                      data: `0x${BigInt(amount).toString(16).padStart(64, "0")}`,
                    })),
                  },
                },
      );
    },
  });
}

test("Etherscan exact duplicate event identities never inflate totals", async () => {
  const page = await duplicateReceiptProvider([1, 1]).fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 2,
  });
  assert.equal(page.transfers.length, 1);
  assert.equal(page.transfers[0].rawAmount, "1");
});

test("Etherscan rejects conflicting same-ID event facts without committing evidence or a cursor", async () => {
  const value = await expandInvestigation(
    createInvestigation(ROOT, "live"),
    duplicateReceiptProvider([1, 2]),
    { address: ROOT, chainId: 1, pageSize: 2 },
  );
  assert.equal(value.coverage[0].status, "error");
  assert.equal(value.coverage[0].errorCode, "INVALID_PROVIDER_DATA");
  assert.equal(value.coverage[0].retryable, false);
  assert.equal(value.coverage[0].pagesLoaded, 0);
  assert.equal(value.coverage[0].cursor, null);
  assert.equal(value.transfers.length, 0);
});
