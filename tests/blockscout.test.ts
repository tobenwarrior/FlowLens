import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentService } from "../server/agent.ts";
import { createBlockscoutProvider } from "../server/blockscout.ts";
import { ProviderError } from "../server/history-provider.ts";
import { expandCase, providersFromEnvironment } from "../server/operations.ts";
import { demoProvider } from "../src/domain/demo.ts";
import {
  createInvestigation,
  expandInvestigation,
} from "../src/domain/engine.ts";
import type { Address } from "../src/domain/types.ts";

// Synthetic values in recorded Blockscout API v2 response shapes; see the fixture's _fixture note.
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/blockscout-eth.json", import.meta.url),
    "utf8",
  ),
);
const ROOT = fixture.root as Address;
const WALLET = ROOT.toLowerCase();
const OTHER = "0x9999999999999999999999999999999999999999";
const CALL = `0x${"c".repeat(64)}`;
const REFUND = `0x${"f".repeat(64)}`;
const terminal = { items: [], next_page_params: null };
type Data = typeof fixture;

function explorer(
  edit: (data: Data) => void = () => undefined,
  respond?: (url: URL) => Response | undefined,
) {
  const data: Data = structuredClone(fixture);
  edit(data);
  const calls: URL[] = [];
  const provider = createBlockscoutProvider({
    intervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const custom = respond?.(url);
      if (custom) return custom;
      const path = url.pathname.replace("/api/v2/", "");
      // Requests carrying next_page_params receive the terminal page.
      const resumed = url.searchParams.has("block_number");
      if (path.endsWith("/transactions"))
        return Response.json(resumed ? terminal : data.transactions);
      if (path.endsWith("/token-transfers"))
        return Response.json(resumed ? terminal : data.tokenTransfers);
      if (path.endsWith("/internal-transactions"))
        return Response.json(resumed ? terminal : data.internalTransactions);
      const trace = /^transactions\/(0x[0-9a-f]{64})\/raw-trace$/.exec(path);
      if (trace) return Response.json(data.rawTraces[trace[1]] ?? []);
      return new Response("missing", { status: 404 });
    },
  });
  return { calls, data, provider };
}
const failsWith =
  (code: string, retryable = false) =>
  (error: unknown) =>
    error instanceof ProviderError &&
    error.code === code &&
    error.retryable === retryable;

// Synthetic values in recorded Derive Chain (957) v12 shapes: no items_count echo, callTracer traces.
const derive = JSON.parse(
  readFileSync(
    new URL("./fixtures/blockscout-derive.json", import.meta.url),
    "utf8",
  ),
);
const DERIVE_ROOT = derive.root as Address;
const DERIVE_WALLET = DERIVE_ROOT.toLowerCase();
const hash = (c: string) => `0x${c.repeat(64)}`;
type DeriveData = typeof derive;
type Item = Record<string, number>;
const position = (q: URLSearchParams) => [
  Number(q.get("block_number")),
  Number(q.get("index")),
];
const DERIVE_STREAMS: Record<
  string,
  {
    data: "transactions" | "tokenTransfers" | "internalTransactions";
    key: (item: Item) => number[];
    after: (q: URLSearchParams) => number[];
    next: (item: Item & { hash: string; fee: { value: string } }) => object;
  }
> = {
  transactions: {
    data: "transactions",
    key: (r) => [r.block_number, r.position],
    after: position,
    next: (r) => ({
      index: r.position,
      value: r.value,
      hash: r.hash,
      inserted_at: "2026-10-06T13:50:54.589543Z",
      block_number: r.block_number,
      fee: r.fee.value,
    }),
  },
  "token-transfers": {
    data: "tokenTransfers",
    key: (r) => [r.block_number, r.log_index],
    after: position,
    next: (r) => ({ index: r.log_index, block_number: r.block_number }),
  },
  "internal-transactions": {
    data: "internalTransactions",
    key: (r) => [r.block_number, r.transaction_index, r.index],
    after: (q) => [
      Number(q.get("block_number")),
      Number(q.get("transaction_index")),
      Number(q.get("index")),
    ],
    next: (r) => ({
      index: r.index,
      block_number: r.block_number,
      transaction_index: r.transaction_index,
      include_zero_value: true,
    }),
  },
};
const earlier = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
/** A v12 explorer like explorer.derive.xyz: keyset pages that honour items_count without echoing it. */
function deriveExplorer(
  edit: (data: DeriveData) => void = () => undefined,
  respond?: (url: URL) => Response | undefined,
) {
  const data: DeriveData = structuredClone(derive);
  edit(data);
  const calls: URL[] = [];
  const provider = createBlockscoutProvider({
    intervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      const custom = respond?.(url);
      if (custom) return custom;
      const path = url.pathname.replace("/api/v2/", "");
      const trace = /^transactions\/(0x[0-9a-f]{64})\/raw-trace$/.exec(path);
      if (trace) return Response.json(data.rawTraces[trace[1]] ?? {});
      const stream = DERIVE_STREAMS[path.split("/")[2]];
      if (!stream || path.split("/")[1] !== DERIVE_WALLET)
        return new Response("missing", { status: 404 });
      const q = url.searchParams;
      const after = q.has("block_number") ? stream.after(q) : null;
      const items = (data[stream.data].items as Item[]).filter(
        (item) => !after || earlier(stream.key(item), after),
      );
      const page = items.slice(0, Number(q.get("items_count") ?? 50));
      return Response.json({
        items: page,
        next_page_params:
          items.length > page.length
            ? stream.next(page[page.length - 1] as never)
            : null,
        ...(stream.data === "internalTransactions"
          ? { meta: data.internalTransactions.meta }
          : {}),
      });
    },
  });
  return { calls, data, provider };
}

test("keyless Blockscout pages normalize native, ERC20 and trace-checked internal evidence", async () => {
  const { calls, provider } = explorer();
  const page = await provider.fetchPage({ address: ROOT, chainId: 1 });
  const byId = Object.fromEntries(page.transfers.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), [
    `1:0x${"a".repeat(64)}:native:0:native`,
    `1:0x${"b".repeat(64)}:native:0:native`,
    `1:${CALL}:erc20:4:0x3333333333333333333333333333333333333333`,
    `1:${CALL}:internal:trace.0.0:native`,
    `1:0x${"e".repeat(64)}:erc20:12:0x3333333333333333333333333333333333333333`,
    `1:${REFUND}:internal:trace.0:native`,
  ]);
  const inbound = byId[`1:0x${"b".repeat(64)}:native:0:native`];
  assert.equal(inbound.rawAmount, "9007199254740993000");
  assert.equal(inbound.to, WALLET);
  assert.equal(inbound.timestamp, "2026-10-02T00:00:00.000Z");
  assert.equal(inbound.source, "Blockscout API v2 (eth.blockscout.com)");
  const token =
    byId[`1:${CALL}:erc20:4:0x3333333333333333333333333333333333333333`];
  assert.deepEqual(token.asset, {
    chainId: 1,
    contract: "0x3333333333333333333333333333333333333333",
    decimals: 6,
    symbol: "SYNUSD",
  });
  const internal = byId[`1:${CALL}:internal:trace.0.0:native`];
  assert.equal(internal.rawAmount, "250000000000000000");
  assert.equal(internal.from, "0x4444444444444444444444444444444444444444");
  assert.deepEqual(page.streams, ["native", "erc20", "internal"]);
  assert.equal(page.exhausted, false);
  assert.ok(page.cursor);
  assert.ok(page.warnings.some((w) => w.includes("through block 20000300")));
  assert.ok(page.warnings.some((w) => w.includes("NFTs")));
  // Failed and zero-value rows are expected exclusions, not malformed omissions.
  assert.ok(!page.warnings.some((w) => /was (omitted|excluded)/.test(w)));
  assert.deepEqual(
    calls.map((url) => `${url.host}${url.pathname}${url.search}`),
    [
      `eth.blockscout.com/api/v2/addresses/${WALLET}/transactions`,
      `eth.blockscout.com/api/v2/addresses/${WALLET}/token-transfers?type=ERC-20`,
      `eth.blockscout.com/api/v2/addresses/${WALLET}/internal-transactions`,
      `eth.blockscout.com/api/v2/transactions/${CALL}/raw-trace`,
      `eth.blockscout.com/api/v2/transactions/${REFUND}/raw-trace`,
    ],
  );
});

test("pages are sliced to the page size, resume after the last consumed row and pass next_page_params back verbatim", async () => {
  const { calls, data, provider } = explorer();
  const first = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 2,
  });
  assert.deepEqual(
    first.transfers.filter((t) => t.kind === "native").map((t) => t.hash),
    [`0x${"a".repeat(64)}`, `0x${"b".repeat(64)}`],
  );
  // A row indexed after the first page sits above the window and is never consumed.
  data.transactions.items.unshift({
    ...structuredClone(data.transactions.items[1]),
    hash: `0x${"1".repeat(64)}`,
    block_number: 20000400,
  });
  const second = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    cursor: first.cursor,
  });
  assert.deepEqual(
    second.transfers.filter((t) => t.kind === "native"),
    [],
    "remaining rows are a zero-value call and a failed transaction",
  );
  const resumed = calls.filter((url) => url.searchParams.has("block_number"));
  assert.equal(resumed.length, 1, "token stream moved to its next page");
  assert.deepEqual(Object.fromEntries(resumed[0].searchParams), {
    index: "4",
    block_number: "20000200",
    type: "ERC-20",
  });
  const third = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    cursor: second.cursor,
  });
  const native = calls.filter((url) => url.pathname.endsWith("/transactions"));
  assert.deepEqual(
    Object.fromEntries(native[native.length - 1].searchParams),
    Object.fromEntries(
      Object.entries(fixture.transactions.next_page_params).map(([k, v]) => [
        k,
        String(v),
      ]),
    ),
  );
  assert.equal(third.exhausted, true);
  assert.equal(third.cursor, null);
  assert.ok(
    third.warnings.some((w) => w.includes("does not establish complete")),
  );
});

test("cursors bind provider, chain, wallet and page size; tampering fails before any request", async () => {
  const { calls, provider } = explorer();
  const first = await provider.fetchPage({
    address: ROOT,
    chainId: 1,
    pageSize: 2,
  });
  const before = calls.length;
  const decoded = JSON.parse(
    Buffer.from(first.cursor!, "base64url").toString("utf8"),
  );
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const query of [
    { address: OTHER as Address, cursor: first.cursor },
    { address: ROOT, cursor: first.cursor, pageSize: 3 },
    {
      address: ROOT,
      cursor: encode({
        ...decoded,
        native: { ...decoded.native, params: { block_number: { $gt: 1 } } },
      }),
    },
    {
      address: ROOT,
      cursor: encode({ ...decoded, provider: "etherscan-v2" }),
    },
    { address: ROOT, cursor: encode({ ...decoded, injected: true }) },
    { address: ROOT, cursor: "not-a-cursor" },
  ])
    await assert.rejects(
      provider.fetchPage({ chainId: 1, ...query }),
      failsWith("INVALID_CURSOR"),
    );
  assert.equal(calls.length, before);
});

test("untrusted pagination state, misordered rows and oversized pages fail the page without retries", async () => {
  const cases: [(data: Data) => void, string][] = [
    [
      (data) => {
        data.transactions.next_page_params = { index: { nested: 1 } };
      },
      "INVALID_PROVIDER_DATA",
    ],
    [
      (data) => {
        data.transactions.next_page_params = { "block-number&x": 1 };
      },
      "INVALID_PROVIDER_DATA",
    ],
    [
      (data) => {
        data.transactions.items.reverse();
      },
      "INVALID_PROVIDER_DATA",
    ],
  ];
  for (const [edit, code] of cases) {
    const { calls, provider } = explorer(edit);
    await assert.rejects(
      provider.fetchPage({ address: ROOT, chainId: 1 }),
      failsWith(code),
    );
    assert.equal(calls.length, 1);
  }
  const { calls, provider } = explorer(undefined, () =>
    Response.json(terminal, {
      headers: { "content-length": String(4_000_001) },
    }),
  );
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1 }),
    failsWith("PROVIDER_RESPONSE_TOO_LARGE"),
  );
  assert.equal(calls.length, 1);
});

test("HTTP failures stay explicit: throttles are retryable, browser challenges are denied, nothing retries", async () => {
  const cases: [Response | Error, string, boolean][] = [
    [new Response("slow down", { status: 429 }), "RATE_LIMITED", true],
    [
      new Response("<!DOCTYPE html><title>Just a moment...</title>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
      "ACCESS_DENIED",
      false,
    ],
    [new Response("{}", { status: 422 }), "PROVIDER_ERROR", false],
    [new Response("down", { status: 503 }), "PROVIDER_HTTP_ERROR", true],
    [new TypeError("fetch failed"), "NETWORK_ERROR", true],
  ];
  for (const [outcome, code, retryable] of cases) {
    const { calls, provider } = explorer(undefined, () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    await assert.rejects(
      provider.fetchPage({ address: ROOT, chainId: 1 }),
      (error: unknown) =>
        failsWith(code, retryable)(error) &&
        !(error as Error).message.includes("Just a moment"),
    );
    assert.equal(calls.length, 1);
  }
});

test("internal transfers inside reverted calls are excluded and trace disagreements fail the page", async () => {
  for (const frame of [0, 1]) {
    const { provider } = explorer((data) => {
      data.rawTraces[CALL][frame].error = "Reverted";
      delete data.rawTraces[CALL][frame].result;
    });
    const page = await provider.fetchPage({ address: ROOT, chainId: 1 });
    const internal = page.transfers.filter((t) => t.kind === "internal");
    assert.deepEqual(
      internal.map((t) => t.eventIndex),
      ["trace.0"],
      "only the transfer from the successful transaction remains",
    );
    assert.ok(page.warnings.some((w) => w.includes("reverted")));
  }
  const mismatched = explorer((data) => {
    data.rawTraces[CALL][2].action.value = "0x1";
  });
  await assert.rejects(
    mismatched.provider.fetchPage({ address: ROOT, chainId: 1 }),
    failsWith("TRACE_MISMATCH", true),
  );
  const missing = explorer((data) => {
    data.rawTraces[CALL] = [];
  });
  await assert.rejects(
    missing.provider.fetchPage({ address: ROOT, chainId: 1 }),
    failsWith("TRACE_UNAVAILABLE", true),
  );
  const oversized = explorer(undefined, (url) =>
    url.pathname.endsWith(`${CALL}/raw-trace`)
      ? Response.json([], { headers: { "content-length": "4000001" } })
      : undefined,
  );
  const page = await oversized.provider.fetchPage({
    address: ROOT,
    chainId: 1,
  });
  assert.deepEqual(
    page.transfers.filter((t) => t.kind === "internal").map((t) => t.hash),
    [REFUND],
  );
  assert.ok(page.warnings.some((w) => w.includes("exceeds the response")));
});

test("non-moving and root-call internal rows need no trace request", async () => {
  const { calls, provider } = explorer((data) => {
    data.internalTransactions.items[0].type = "delegatecall";
    data.internalTransactions.items[1].index = 0;
  });
  const page = await provider.fetchPage({ address: ROOT, chainId: 1 });
  assert.equal(page.transfers.filter((t) => t.kind === "internal").length, 0);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/raw-trace")).length,
    0,
  );
});

test("unsupported chains and page sizes fail before any request", async () => {
  const { calls, provider } = explorer();
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 42161 }),
    failsWith("UNSUPPORTED_CHAIN"),
  );
  await assert.rejects(
    provider.fetchPage({ address: ROOT, chainId: 1, pageSize: 11 }),
    failsWith("INVALID_PAGE_SIZE"),
  );
  assert.equal(calls.length, 0);
});

test("engine expansion records Blockscout coverage per stream and exhausts on terminal pages", async () => {
  const { provider } = explorer();
  const value = await expandInvestigation(
    createInvestigation(ROOT, "live"),
    provider,
    { address: ROOT, chainId: 1, pageSize: 10 },
    { maxPages: 3, maxNodes: 80 },
  );
  assert.equal(value.transfers.length, 6);
  assert.equal(value.coverage.length, 1);
  assert.equal(value.coverage[0].provider, "blockscout-v2");
  assert.equal(value.coverage[0].status, "exhausted");
  assert.equal(value.coverage[0].pagesLoaded, 2);
  assert.deepEqual(value.coverage[0].streams, ["native", "erc20", "internal"]);
});

test("Derive Chain history goes to explorer.derive.xyz with items_count and checks internal rows against callTracer trees", async () => {
  const { calls, provider } = deriveExplorer();
  const page = await provider.fetchPage({ address: DERIVE_ROOT, chainId: 957 });
  const token = "0x3333333333333333333333333333333333333333";
  const byId = Object.fromEntries(page.transfers.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), [
    `957:${hash("1")}:native:0:native`,
    `957:${hash("2")}:erc20:9:${token}`,
    `957:${hash("2")}:internal:trace.1.1:native`,
    `957:${hash("3")}:native:0:native`,
    `957:${hash("4")}:erc20:4:${token}`,
    `957:${hash("4")}:internal:trace.1:native`,
  ]);
  const internal = byId[`957:${hash("2")}:internal:trace.1.1:native`];
  assert.equal(internal.rawAmount, "50000000000000000");
  assert.equal(internal.to, DERIVE_WALLET);
  assert.deepEqual(internal.asset, {
    chainId: 957,
    contract: null,
    decimals: 18,
    symbol: "ETH",
  });
  assert.equal(internal.source, "Blockscout API v2 (explorer.derive.xyz)");
  assert.equal(page.exhausted, true);
  assert.equal(page.cursor, null);
  assert.ok(page.warnings.some((w) => w.includes("Derive Chain subaccounts")));
  assert.ok(!page.warnings.some((w) => /was (omitted|excluded)/.test(w)));
  assert.deepEqual(
    calls.map((url) => `${url.host}${url.pathname}${url.search}`),
    [
      `explorer.derive.xyz/api/v2/addresses/${DERIVE_WALLET}/transactions?items_count=10`,
      `explorer.derive.xyz/api/v2/addresses/${DERIVE_WALLET}/token-transfers?type=ERC-20&items_count=10`,
      `explorer.derive.xyz/api/v2/addresses/${DERIVE_WALLET}/internal-transactions?items_count=10`,
      `explorer.derive.xyz/api/v2/transactions/${hash("2")}/raw-trace`,
      `explorer.derive.xyz/api/v2/transactions/${hash("4")}/raw-trace`,
    ],
  );
});

test("Derive pages resume strictly after the last row, repeating items_count beside next_page_params", async () => {
  const { calls, data, provider } = deriveExplorer();
  const pages = [
    await provider.fetchPage({
      address: DERIVE_ROOT,
      chainId: 957,
      pageSize: 1,
    }),
  ];
  // A row indexed after the first page sits above the window and is never consumed.
  data.transactions.items.unshift({
    ...structuredClone(data.transactions.items[0]),
    hash: hash("9"),
    block_number: 46000400,
  });
  while (pages[pages.length - 1].cursor)
    pages.push(
      await provider.fetchPage({
        address: DERIVE_ROOT,
        chainId: 957,
        cursor: pages[pages.length - 1].cursor,
      }),
    );
  assert.deepEqual(
    pages.map((page) => page.transfers.map((t) => `${t.kind}:${t.hash[2]}`)),
    [
      ["native:1", "erc20:2", "internal:2"],
      ["erc20:4"],
      ["native:3", "internal:4"],
    ],
    "the second native and internal rows are a zero-value call and a static call",
  );
  assert.equal(pages[2].exhausted, true);
  const history = calls.filter((url) => !url.pathname.endsWith("/raw-trace"));
  assert.ok(
    history.every((url) => url.searchParams.get("items_count") === "1"),
  );
  const resumed = history.filter((url) => url.searchParams.has("block_number"));
  assert.deepEqual(
    Object.fromEntries(
      resumed.find((url) => url.pathname.endsWith("/transactions"))!
        .searchParams,
    ),
    {
      index: "1",
      value: "200000000000000000",
      hash: hash("1"),
      inserted_at: "2026-10-06T13:50:54.589543Z",
      block_number: "46000305",
      fee: "21000000000",
      items_count: "1",
    },
  );
  assert.equal(
    resumed
      .find((url) => url.pathname.endsWith("/internal-transactions"))!
      .searchParams.get("include_zero_value"),
    "true",
  );
  const before = calls.length;
  await assert.rejects(
    provider.fetchPage({
      address: DERIVE_ROOT,
      chainId: 1,
      cursor: pages[0].cursor,
    }),
    failsWith("INVALID_CURSOR"),
  );
  assert.equal(calls.length, before);
});

test("Derive internal rows under a reverted callTracer frame are excluded; disagreements and missing trees fail the page", async () => {
  for (const revert of [
    (data: DeriveData) => (data.rawTraces[hash("2")].error = "reverted"),
    (data: DeriveData) =>
      (data.rawTraces[hash("2")].calls[1].error = "execution reverted"),
  ]) {
    const { provider } = deriveExplorer(revert);
    const page = await provider.fetchPage({
      address: DERIVE_ROOT,
      chainId: 957,
    });
    assert.deepEqual(
      page.transfers.filter((t) => t.kind === "internal").map((t) => t.hash),
      [hash("4")],
    );
    assert.ok(page.warnings.some((w) => w.includes("reverted")));
  }
  const failures: [(data: DeriveData) => void, string][] = [
    [
      (data) => (data.rawTraces[hash("2")].calls[1].calls[1].value = "0x1"),
      "TRACE_MISMATCH",
    ],
    // Index 3 is the delegatecall in pre-order, so a listing that points at it disagrees.
    [
      (data) => (data.internalTransactions.items[0].index = 3),
      "TRACE_MISMATCH",
    ],
    [(data) => (data.rawTraces[hash("2")].calls = "0x"), "TRACE_MISMATCH"],
    [(data) => (data.rawTraces[hash("2")] = {}), "TRACE_UNAVAILABLE"],
  ];
  for (const [edit, code] of failures) {
    const { provider } = deriveExplorer(edit);
    await assert.rejects(
      provider.fetchPage({ address: DERIVE_ROOT, chainId: 957 }),
      failsWith(code, true),
    );
  }
});

test("engine expansion on Derive records blockscout-v2 coverage for chain 957 across resumed pages", async () => {
  const { provider } = deriveExplorer();
  const value = await expandCase(
    createInvestigation(DERIVE_ROOT, "live"),
    { address: DERIVE_ROOT, chainId: 957, maxPages: 3, pageSize: 1 },
    { demo: demoProvider, live: new Map([[957, provider]]) },
  );
  assert.equal(value.transfers.length, 6);
  assert.ok(value.transfers.every((t) => t.chainId === 957));
  assert.equal(value.coverage.length, 1);
  assert.equal(value.coverage[0].chainId, 957);
  assert.equal(value.coverage[0].provider, "blockscout-v2");
  assert.equal(value.coverage[0].status, "exhausted");
  assert.equal(value.coverage[0].pagesLoaded, 3);
});

test("FLOWLENS_BLOCKSCOUT=off keeps Derive expansions away from explorer.derive.xyz, key or not", async () => {
  const saved = {
    fetch: globalThis.fetch,
    key: process.env.ETHERSCAN_API_KEY,
    blockscout: process.env.FLOWLENS_BLOCKSCOUT,
  };
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    throw new TypeError("no network in tests");
  }) as typeof fetch;
  try {
    for (const key of ["", "dummy-key"]) {
      process.env.ETHERSCAN_API_KEY = key;
      process.env.FLOWLENS_BLOCKSCOUT = "off";
      await assert.rejects(
        expandCase(
          createInvestigation(DERIVE_ROOT, "live"),
          { address: DERIVE_ROOT, chainId: 957 },
          providersFromEnvironment(),
        ),
        (error: unknown) =>
          failsWith("PROVIDER_DISABLED")(error) &&
          (error as Error).message.includes("FLOWLENS_BLOCKSCOUT=off"),
      );
    }
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [
      ["ETHERSCAN_API_KEY", saved.key],
      ["FLOWLENS_BLOCKSCOUT", saved.blockscout],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("a key keeps Etherscan the default on its chains, Blockscout serves keyless Ethereum and Derive, and the switch turns it off", () => {
  const saved = {
    key: process.env.ETHERSCAN_API_KEY,
    blockscout: process.env.FLOWLENS_BLOCKSCOUT,
  };
  const routes = (key: string, blockscout: string) => {
    process.env.ETHERSCAN_API_KEY = key;
    process.env.FLOWLENS_BLOCKSCOUT = blockscout;
    return Object.fromEntries(
      [...providersFromEnvironment().live].map(([chain, p]) => [chain, p.id]),
    );
  };
  try {
    assert.deepEqual(routes("", ""), {
      1: "blockscout-v2",
      957: "blockscout-v2",
    });
    // Etherscan has no Derive Chain history, so Derive stays on Blockscout with a key.
    assert.deepEqual(routes("dummy-key", ""), {
      1: "etherscan-v2",
      957: "blockscout-v2",
      42161: "etherscan-v2",
    });
    assert.deepEqual(routes("dummy-key", "off"), {
      1: "etherscan-v2",
      42161: "etherscan-v2",
    });
    assert.deepEqual(routes("", "off"), {});
    assert.throws(() => routes("", "maybe"), /FLOWLENS_BLOCKSCOUT/);
  } finally {
    for (const [name, value] of [
      ["ETHERSCAN_API_KEY", saved.key],
      ["FLOWLENS_BLOCKSCOUT", saved.blockscout],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("status reports which provider serves each chain and unserved chains ask for a key without a request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowlens-blockscout-"));
  try {
    const { calls, provider } = explorer();
    const providers = { demo: demoProvider, live: new Map([[1, provider]]) };
    const service = createAgentService({
      dataDir: dir,
      labelFile: join(dir, "labels.json"),
      providers,
    });
    const status = (await service.call("status", {})) as {
      liveAvailable: boolean;
      providers: { live: Record<string, unknown> };
    };
    assert.equal(status.liveAvailable, true);
    assert.deepEqual(status.providers.live, {
      available: true,
      chains: [1],
      routes: [{ chainId: 1, provider: "blockscout-v2" }],
    });
    await assert.rejects(
      expandCase(
        createInvestigation(ROOT, "live"),
        { address: ROOT, chainId: 42161 },
        providers,
      ),
      (error: unknown) =>
        failsWith("KEY_REQUIRED")(error) &&
        (error as Error).message.includes("ETHERSCAN_API_KEY"),
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
