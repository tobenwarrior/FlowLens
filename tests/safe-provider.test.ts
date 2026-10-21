import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acquireSafeEvidence,
  SafeProviderError,
} from "../server/safe-provider.ts";
import { parseSafeEvidence, analyzeSafeEvidence } from "../src/domain/safe.ts";
import { mergeProtocolEvidence } from "../src/domain/protocols.ts";

const SAFE = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const BLOCK = `0x${"a".repeat(64)}`;
const HASH = `0x${"b".repeat(64)}`;
const SAFE_HASH = `0x${"c".repeat(64)}`;
const word = (n: number) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const params = {
  to: OWNER,
  value: "0",
  data: "0x",
  operation: 0,
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: SAFE,
  refundReceiver: SAFE,
  nonce: "0",
};
const EXEC_ABI = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
function directFixture(signature: `0x${string}`) {
  const input = encodeFunctionData({
    abi: EXEC_ABI,
    functionName: "execTransaction",
    args: [OWNER, 0n, "0x", 0, 0n, 0n, 0n, SAFE, SAFE, signature],
  });
  const receipt = {
    transactionHash: HASH,
    blockNumber: "0x5a",
    blockHash: BLOCK,
    status: "0x1",
    transactionIndex: "0x1",
    logs: [
      {
        address: SAFE,
        transactionHash: HASH,
        blockNumber: "0x5a",
        blockHash: BLOCK,
        logIndex: "0x2",
        topics: [keccak256(stringToHex("ExecutionSuccess(bytes32,uint256)"))],
        data: encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [SAFE_HASH as `0x${string}`, 0n],
        ),
      },
    ],
  };
  return { input, receipt };
}
const txRow = (overrides: Record<string, unknown> = {}) => ({
  ...params,
  safe: SAFE,
  safeTxHash: SAFE_HASH,
  transactionHash: HASH,
  isExecuted: true,
  isSuccessful: true,
  blockNumber: 90,
  confirmationsRequired: 1,
  confirmations: [
    { owner: OWNER, signatureType: "EOA", signature: `0x${"1".repeat(130)}` },
  ],
  signatures: `0x${"1".repeat(130)}`,
  ...overrides,
});
function rpc(overrides: Record<string, unknown> = {}) {
  const requests: { method: string; params: unknown[] }[] = [];
  return {
    chainId: 1,
    source: "Injected read-only RPC",
    sourceUrl: "https://ethereum-rpc.publicnode.com",
    requests,
    async request(method: string, args: unknown[]) {
      requests.push({ method, params: args });
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return typeof value === "function" ? value(args) : value;
      }
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_blockNumber") return "0x64";
      if (method === "eth_getBlockByNumber")
        return {
          number: args[0],
          hash: BLOCK,
          transactions: [SAFE_HASH, HASH],
        };
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        const data = (args[0] as { data: string }).data;
        if (data === "0xa0e67e2b")
          return encodeAbiParameters([{ type: "address[]" }], [[OWNER]]);
        if (data === "0xe75235b8") return word(1);
        if (data === "0xaffed0e0") return word(7);
        return SAFE_HASH;
      }
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
}
function history(pages: unknown[], status = 200) {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    return new Response(
      JSON.stringify(pages[Math.min(urls.length - 1, pages.length - 1)]),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

test("Safe snapshot freezes all state reads to one canonical hash and preserves nonce/provenance", async () => {
  const client = rpc();
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, includeHistory: false },
    { rpc: client },
  );
  assert.equal(result.snapshot?.nonce, "7");
  assert.equal(result.snapshot?.blockNumber, 100);
  assert.equal(result.bundle.mode, "private");
  assert.equal(result.bundle.configurations[0].kind, "at-block");
  assert.deepEqual(result.bundle.configurations[0].owners, [OWNER]);
  assert.equal(result.bundle.configurations[0].threshold, 1);
  assert.equal(result.bundle.configurations[0].provenance.synthetic, false);
  assert.equal(
    result.bundle.configurations[0].provenance.sourceUrl,
    "https://ethereum-rpc.publicnode.com",
  );
  const stateReads = client.requests.filter((r) =>
    ["eth_getCode", "eth_call"].includes(r.method),
  );
  assert.ok(
    stateReads.every(
      (r) =>
        JSON.stringify(r.params[1]) ===
        JSON.stringify({ blockHash: BLOCK, requireCanonical: true }),
    ),
  );
  assert.equal(result.bundle.configurationEvents.length, 0);
  assert.equal(
    result.bundle.coverage.find((c) => c.stream === "configuration-events")
      ?.status,
    "unsupported",
  );
  assert.deepEqual(parseSafeEvidence(result.bundle, "private"), result.bundle);
});

test("invalid input, cross-chain transport and future blocks cannot acquire evidence", async () => {
  for (const input of [
    { address: "not-an-address", chainId: 1 },
    { address: SAFE, chainId: 0 },
    { address: SAFE, chainId: 1, maxPages: 4 },
    { address: SAFE, chainId: 1, blockNumber: -1 },
    { address: SAFE, chainId: 1, cursor: "https://attacker.invalid" },
  ]) {
    const client = rpc();
    await assert.rejects(
      acquireSafeEvidence(input, { rpc: client }),
      SafeProviderError,
    );
    assert.equal(client.requests.length, 0);
  }
  await assert.rejects(
    acquireSafeEvidence({ address: SAFE, chainId: 42161 }, { rpc: rpc() }),
    /chain/i,
  );
  const mismatch = await acquireSafeEvidence(
    { address: SAFE, chainId: 1 },
    { rpc: rpc({ eth_chainId: "0xa4b1" }) },
  );
  assert.equal(mismatch.bundle.configurations.length, 0);
  assert.equal(mismatch.errors[0]?.code, "RPC_CHAIN_MISMATCH");
  const future = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, blockNumber: 101 },
    { rpc: rpc() },
  );
  assert.equal(future.errors[0]?.code, "RPC_BLOCK_UNAVAILABLE");
});

test("empty code, malformed contract ABI and unavailable archive state remain explicit gaps", async () => {
  for (const override of [
    { eth_getCode: "0x" },
    { eth_call: "0x1234" },
    {
      eth_getCode: Object.assign(new Error("sensitive provider URL"), {
        code: "RPC_BLOCK_UNAVAILABLE",
        retryable: false,
      }),
    },
  ]) {
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, blockNumber: 50, includeHistory: false },
      { rpc: rpc(override) },
    );
    assert.equal(result.bundle.configurations.length, 0);
    assert.ok(result.errors.length);
    assert.equal(
      result.bundle.coverage.find((c) => c.stream === "configurations")?.status,
      "error",
    );
    assert.ok(
      !JSON.stringify(result.errors).includes("sensitive provider URL"),
    );
  }
});

test("service confirmations never become execution signers or historical owner configuration", async () => {
  const source = history([{ count: 1, next: null, results: [txRow()] }]);
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, includeHistory: true },
    { rpc: rpc(), fetch: source.fetch },
  );
  assert.equal(result.bundle.executions.length, 1);
  assert.equal(result.materials[0]?.confirmations.length, 1);
  assert.equal(result.bundle.executions[0].signatures.length, 0);
  assert.equal(result.bundle.executions[0].signatureCoverage, "unavailable");
  assert.equal(result.bundle.executions[0].configurationEvidenceId, undefined);
  assert.equal(result.verification.independentlyVerifiedSignatures, false);
  assert.equal(
    analyzeSafeEvidence(result.bundle).executions[0].configuredThreshold,
    null,
  );
  assert.equal(result.history.status, "service-exhausted");
  assert.equal(
    result.bundle.coverage.find((c) => c.stream === "executions")?.status,
    "partial",
  );
  assert.match(
    source.urls[0],
    /^https:\/\/api\.safe\.global\/tx-service\/eth\/api\/v2\/safes\//,
  );
});

test("history enforces the frozen block and rejects cross-Safe rows atomically", async () => {
  const source = history([
    {
      count: 2,
      next: null,
      results: [
        txRow(),
        txRow({
          blockNumber: 101,
          safeTxHash: `0x${"d".repeat(64)}`,
          nonce: "1",
        }),
      ],
    },
  ]);
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, includeHistory: true },
    { rpc: rpc(), fetch: source.fetch },
  );
  assert.equal(result.bundle.executions.length, 1);
  const invalid = history([
    {
      count: 2,
      next: null,
      results: [txRow(), txRow({ safe: OWNER, nonce: "1" })],
    },
  ]);
  const rejected = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, includeHistory: true },
    { rpc: rpc(), fetch: invalid.fetch },
  );
  assert.equal(rejected.bundle.executions.length, 0);
  assert.equal(rejected.history.status, "error");
});

test("history denial and rate limiting stop immediately without fallback or retry", async () => {
  for (const [status, code] of [
    [401, "SAFE_ACCESS_DENIED"],
    [403, "SAFE_ACCESS_DENIED"],
    [429, "SAFE_RATE_LIMITED"],
  ] as const) {
    const source = history([{ detail: "denied" }], status);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, includeHistory: true, maxPages: 3 },
      { rpc: rpc(), fetch: source.fetch },
    );
    assert.equal(source.urls.length, 1);
    assert.equal(result.errors[0]?.code, code);
    assert.equal(result.bundle.configurations.length, 1);
    assert.equal(result.bundle.executions.length, 0);
  }
});

test("a first-page rate-limit cursor can resume without discarding its block fence", async () => {
  const limited = history([{ detail: "rate limited" }], 429);
  const first = await acquireSafeEvidence(
    { address: SAFE, chainId: 1 },
    { rpc: rpc(), fetch: limited.fetch },
  );
  assert.ok(first.cursor);
  const source = history([{ count: 1, next: null, results: [txRow()] }]);
  const resumed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: first.cursor! },
    { rpc: rpc({ eth_blockNumber: "0xc8" }), fetch: source.fetch },
  );
  assert.equal(resumed.snapshot?.blockNumber, 100);
  assert.equal(
    resumed.bundle.configurations[0].id,
    first.bundle.configurations[0].id,
  );
  assert.equal(
    resumed.bundle.configurations[0].kind,
    first.bundle.configurations[0].kind,
  );
  assert.equal(resumed.bundle.executions.length, 1);
  assert.equal(new URL(source.urls[0]).searchParams.get("offset"), "0");
});

test("changed canonical block hashes cannot resume a prior history cursor", async () => {
  const source = history([
    {
      count: 6,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=5`,
      results: [txRow()],
    },
  ]);
  const first = await acquireSafeEvidence(
    { address: SAFE, chainId: 1 },
    { rpc: rpc(), fetch: source.fetch },
  );
  const forbiddenFetch = (async () => {
    throw new Error("History must not be fetched across a reorganization");
  }) as typeof fetch;
  const changed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: first.cursor! },
    {
      rpc: rpc({ eth_getBlockByNumber: { number: "0x64", hash: HASH } }),
      fetch: forbiddenFetch,
    },
  );
  assert.equal(changed.errors[0]?.code, "SAFE_CURSOR_REORG");
  assert.equal(changed.bundle.executions.length, 0);
});

test("backward nonce order and repeated Safe hashes under different nonces reject whole pages", async () => {
  for (const rows of [
    [txRow({ nonce: "1" }), txRow({ nonce: "0", safeTxHash: HASH })],
    [txRow(), txRow({ nonce: "1" })],
    [txRow(), txRow({ transactionHash: SAFE_HASH })],
  ]) {
    const source = history([{ count: 2, next: null, results: rows }]);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1 },
      { rpc: rpc(), fetch: source.fetch },
    );
    assert.equal(result.history.status, "error");
    assert.equal(result.bundle.executions.length, 0);
  }
});

test("untrusted pagination destinations and changed query filters never get followed", async () => {
  for (const next of [
    "https://attacker.invalid/stolen",
    `https://api.safe.global/tx-service/arb1/api/v2/safes/${SAFE}/multisig-transactions/?offset=5`,
    `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=false&offset=5`,
  ]) {
    const source = history([{ count: 6, next, results: [txRow()] }]);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, includeHistory: true, maxPages: 3 },
      { rpc: rpc(), fetch: source.fetch },
    );
    assert.equal(source.urls.length, 1);
    assert.equal(result.history.status, "error");
    assert.equal(result.bundle.executions.length, 0);
  }
});

test("Safe cursor resumes a pinned scope and refuses changes to address, chain or block", async () => {
  const first = history([
    {
      count: 6,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=5`,
      results: [txRow()],
    },
  ]);
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, includeHistory: true },
    { rpc: rpc(), fetch: first.fetch },
  );
  assert.ok(result.cursor);
  assert.equal(
    result.bundle.coverage.find((c) => c.stream === "executions")?.provenance
      .sourceUrl,
    first.urls[0],
  );
  const second = history([
    {
      count: 6,
      next: null,
      results: [txRow({ nonce: "1", safeTxHash: `0x${"d".repeat(64)}` })],
    },
  ]);
  const resumed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: result.cursor!, includeHistory: true },
    { rpc: rpc({ eth_blockNumber: "0xc8" }), fetch: second.fetch },
  );
  assert.equal(resumed.snapshot?.blockNumber, 100);
  assert.equal(new URL(second.urls[0]).searchParams.get("offset"), "5");
  for (const changes of [
    { address: OWNER },
    { chainId: 42161 },
    { blockNumber: 99 },
  ]) {
    await assert.rejects(
      acquireSafeEvidence(
        { address: SAFE, chainId: 1, cursor: result.cursor!, ...changes },
        { rpc: rpc() },
      ),
      /cursor|chain/i,
    );
  }
});

test("optional EOA proof requires direct Safe calldata, matching receipt and contract-bound digest", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const signature = await account.sign({ hash: SAFE_HASH as `0x${string}` });
  const { input, receipt } = directFixture(signature);
  for (const [target, returnedDigest, expected] of [
    [SAFE, SAFE_HASH, "verified-eoa"],
    [OWNER, SAFE_HASH, "unverified"],
    [SAFE, HASH, "unverified"],
  ] as const) {
    const source = history([
      {
        count: 1,
        next: null,
        results: [
          txRow({
            signatures: signature,
            confirmations: [
              { owner: account.address, signatureType: "EOA", signature },
            ],
          }),
        ],
      },
    ]);
    const client = rpc({
      eth_getTransactionByHash: {
        hash: HASH,
        to: target,
        blockNumber: "0x5a",
        blockHash: BLOCK,
        transactionIndex: "0x1",
        input,
      },
      eth_getTransactionReceipt: receipt,
    });
    const original = client.request.bind(client);
    client.request = async (method, args) =>
      method === "eth_call" && (args[0] as { data: string }).data.length > 10
        ? returnedDigest
        : original(method, args);
    const result = await acquireSafeEvidence(
      {
        address: SAFE,
        chainId: 1,
        includeHistory: true,
        verifySignatures: true,
      },
      { rpc: client, fetch: source.fetch },
    );
    assert.equal(result.verification.observations[0]?.status, expected);
    if (expected === "verified-eoa") {
      assert.equal(
        result.verification.observations[0].recoveredSigner,
        account.address.toLowerCase(),
      );
      assert.equal(
        result.verification.observations[0].digestBoundToSafeContract,
        true,
      );
      assert.equal(
        result.bundle.executions[0].signatures[0].signer,
        account.address.toLowerCase(),
      );
      assert.equal(
        result.bundle.executions[0].configurationEvidenceId,
        undefined,
      );
    } else assert.equal(result.bundle.executions[0].signatures.length, 0);
  }
});

test("eth_sign recovery uses the prefixed digest and respects a cross-signature verification budget", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const standard = await account.signMessage({
    message: { raw: SAFE_HASH as `0x${string}` },
  });
  const signature =
    `${standard.slice(0, -2)}${(Number.parseInt(standard.slice(-2), 16) + 4).toString(16)}` as `0x${string}`;
  const approved =
    `0x${OWNER.slice(2).padStart(64, "0")}${"0".repeat(64)}01` as `0x${string}`;
  const packed =
    `${signature}${approved.slice(2)}${signature.slice(2)}` as `0x${string}`;
  const { input, receipt } = directFixture(packed);
  const source = history([
    {
      count: 1,
      next: null,
      results: [txRow({ signatures: packed, confirmations: [] })],
    },
  ]);
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, verifySignatures: true, maxSignatures: 2 },
    {
      rpc: rpc({
        eth_getTransactionByHash: {
          hash: HASH,
          to: SAFE,
          blockNumber: "0x5a",
          blockHash: BLOCK,
          transactionIndex: "0x1",
          input,
        },
        eth_getTransactionReceipt: receipt,
      }),
      fetch: source.fetch,
    },
  );
  assert.equal(result.verification.observations.length, 2);
  assert.equal(result.verification.observations[0].status, "verified-eoa");
  assert.equal(result.verification.observations[0].signatureType, "eth_sign");
  assert.equal(
    result.verification.observations[0].recoveredSigner,
    account.address.toLowerCase(),
  );
  assert.equal(result.verification.observations[1].status, "unverified");
  assert.equal(
    result.verification.observations[1].signatureType,
    "approved-hash",
  );
  assert.equal(result.bundle.executions[0].signatures.length, 1);
  assert.equal(result.bundle.executions[0].signatureCoverage, "partial");
});

test("contract and unknown packed signatures remain explicitly unverified after hash binding", async () => {
  const contract =
    `0x${OWNER.slice(2).padStart(64, "0")}${BigInt(65).toString(16).padStart(64, "0")}00${BigInt(1).toString(16).padStart(64, "0")}ff` as `0x${string}`;
  const unknown = `0x${"1".repeat(128)}02` as `0x${string}`;
  for (const [packed, expectedType] of [
    [contract, "contract"],
    [unknown, "unknown"],
  ] as const) {
    const { input, receipt } = directFixture(packed);
    const source = history([
      {
        count: 1,
        next: null,
        results: [txRow({ signatures: packed, confirmations: [] })],
      },
    ]);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, verifySignatures: true },
      {
        rpc: rpc({
          eth_getTransactionByHash: {
            hash: HASH,
            to: SAFE,
            blockNumber: "0x5a",
            blockHash: BLOCK,
            transactionIndex: "0x1",
            input,
          },
          eth_getTransactionReceipt: receipt,
        }),
        fetch: source.fetch,
      },
    );
    assert.equal(result.verification.observations[0].status, "unverified");
    assert.equal(
      result.verification.observations[0].signatureType,
      expectedType,
    );
    assert.equal(
      result.verification.observations[0].digestBoundToSafeContract,
      true,
    );
    assert.equal(
      result.verification.observations[0].recoveredSigner,
      undefined,
    );
    assert.equal(result.bundle.executions[0].signatures.length, 0);
  }
});

test("receipt events, calldata, source bytes and contradictory claimed owners cannot produce a false proof", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const signature = await account.sign({ hash: SAFE_HASH as `0x${string}` });
  const { input, receipt } = directFixture(signature);
  const alternatives = [
    { receipt: { ...receipt, status: "0x0" } },
    { receipt: { ...receipt, logs: [] } },
    { receipt: { ...receipt, logs: [receipt.logs[0], receipt.logs[0]] } },
    { receipt: { ...receipt, blockHash: HASH } },
    { row: { value: "1" } },
    { row: { signatures: `0x${"0".repeat(130)}` } },
    {
      row: {
        confirmations: [{ owner: OWNER, signatureType: "EOA", signature }],
      },
    },
  ];
  for (const variant of alternatives) {
    const source = history([
      {
        count: 1,
        next: null,
        results: [
          txRow({ signatures: signature, confirmations: [], ...variant.row }),
        ],
      },
    ]);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, verifySignatures: true },
      {
        rpc: rpc({
          eth_getTransactionByHash: {
            hash: HASH,
            to: SAFE,
            blockNumber: "0x5a",
            blockHash: BLOCK,
            transactionIndex: "0x1",
            input,
          },
          eth_getTransactionReceipt: variant.receipt ?? receipt,
        }),
        fetch: source.fetch,
      },
    );
    assert.ok(result.verification.observations.length > 0);
    assert.ok(
      result.verification.observations.every((v) => v.status === "unverified"),
    );
    assert.equal(result.bundle.executions[0].signatures.length, 0);
  }
});

test("EOA proofs require canonical block membership and matching transaction indexes", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const signature = await account.sign({ hash: SAFE_HASH as `0x${string}` });
  const { input, receipt } = directFixture(signature);
  for (const variant of [
    { index: "0x0" },
    { receiptIndex: "0x0" },
    { transactions: [SAFE_HASH, SAFE_HASH] },
    { transactions: undefined },
  ]) {
    const source = history([
      {
        count: 1,
        next: null,
        results: [txRow({ signatures: signature, confirmations: [] })],
      },
    ]);
    const result = await acquireSafeEvidence(
      { address: SAFE, chainId: 1, verifySignatures: true },
      {
        rpc: rpc({
          eth_getBlockByNumber: (args: unknown[]) => ({
            number: args[0],
            hash: BLOCK,
            transactions:
              "transactions" in variant
                ? variant.transactions
                : [SAFE_HASH, HASH],
          }),
          eth_getTransactionByHash: {
            hash: HASH,
            to: SAFE,
            blockNumber: "0x5a",
            blockHash: BLOCK,
            transactionIndex: variant.index ?? "0x1",
            input,
          },
          eth_getTransactionReceipt: {
            ...receipt,
            transactionIndex: variant.receiptIndex ?? "0x1",
          },
        }),
        fetch: source.fetch,
      },
    );
    assert.ok(result.verification.observations.length > 0);
    assert.ok(
      result.verification.observations.every((p) => p.status === "unverified"),
    );
    assert.equal(result.bundle.executions[0].signatures.length, 0);
  }
});

test("recoverable extra calldata signatures never become confirmed quorum participation", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const extra = privateKeyToAccount(`0x${"2".repeat(64)}`);
  const first = await account.sign({ hash: SAFE_HASH as `0x${string}` });
  const second = await extra.sign({ hash: SAFE_HASH as `0x${string}` });
  const packed = `${first}${second.slice(2)}` as `0x${string}`;
  const { input, receipt } = directFixture(packed);
  const source = history([
    {
      count: 1,
      next: null,
      results: [
        txRow({
          signatures: packed,
          confirmationsRequired: 1,
          confirmations: [],
        }),
      ],
    },
  ]);
  const result = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, verifySignatures: true },
    {
      rpc: rpc({
        eth_getTransactionByHash: {
          hash: HASH,
          to: SAFE,
          blockNumber: "0x5a",
          blockHash: BLOCK,
          transactionIndex: "0x1",
          input,
        },
        eth_getTransactionReceipt: receipt,
      }),
      fetch: source.fetch,
    },
  );
  assert.equal(result.verification.observations.length, 2);
  assert.ok(
    result.verification.observations.every(
      (p) => p.status === "verified-eoa" && p.participation === "unresolved",
    ),
  );
  const retained = parseSafeEvidence(result.bundle, "private");
  assert.ok(
    retained.executions[0].signatures.every(
      (s) => s.participation === "calldata-only",
    ),
  );
  const historical = {
    ...retained.configurations[0],
    id: "historical-prefix-test",
    blockNumber: 80,
    owners: [account.address, extra.address],
    threshold: 1,
  };
  const replay = parseSafeEvidence(
    {
      ...retained,
      configurations: [historical],
      executions: [
        { ...retained.executions[0], configurationEvidenceId: historical.id },
      ],
    },
    "private",
  );
  const analysis = analyzeSafeEvidence(replay).executions[0];
  assert.deepEqual(analysis.observedConfiguredSigners, []);
  assert.equal(analysis.thresholdObservation, "signature-evidence-unavailable");
  assert.ok(analysis.warnings.some((w) => /participation/i.test(w)));
});

test("actual provider pages merge without changing frozen configuration or losing prior history", async () => {
  const source = history([
    {
      count: 11,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=5`,
      results: [txRow()],
    },
    {
      count: 11,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=10`,
      results: [
        txRow({ nonce: "1", safeTxHash: HASH, transactionHash: SAFE_HASH }),
      ],
    },
  ]);
  const first = await acquireSafeEvidence(
    { address: SAFE, chainId: 1 },
    { rpc: rpc(), fetch: source.fetch },
  );
  const second = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: first.cursor! },
    { rpc: rpc({ eth_blockNumber: "0xc8" }), fetch: source.fetch },
  );
  const initial = mergeProtocolEvidence(undefined, {
    version: 1,
    mode: "private",
    safe: first.bundle,
  });
  const merged = mergeProtocolEvidence(initial, {
    version: 1,
    mode: "private",
    safe: second.bundle,
  });
  assert.equal(merged.safe!.configurations.length, 1);
  assert.equal(merged.safe!.configurations[0].kind, "at-block");
  assert.equal(merged.safe!.configurations[0].blockNumber, 100);
  assert.deepEqual(
    merged.safe!.executions.map((e) => e.nonce),
    ["0", "1"],
  );
  const stream = merged.safe!.coverage.find((c) => c.stream === "executions")!;
  assert.equal(stream.cursor, second.cursor);
  assert.equal(stream.provenance.sourceUrl, source.urls[1]);
  assert.equal(
    new URL(stream.provenance.sourceUrl!).searchParams.get("offset"),
    "5",
  );
  assert.equal(
    mergeProtocolEvidence(merged, {
      version: 1,
      mode: "private",
      safe: second.bundle,
    }).safe!.executions.length,
    2,
  );
});

test("actual provider verification enriches a prior indexed execution through protocol merge", async () => {
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const signature = await account.sign({ hash: SAFE_HASH as `0x${string}` });
  const { input, receipt } = directFixture(signature);
  const source = history([
    {
      count: 1,
      next: null,
      results: [txRow({ signatures: signature, confirmations: [] })],
    },
  ]);
  const makeRpc = () =>
    rpc({
      eth_getTransactionByHash: {
        hash: HASH,
        to: SAFE,
        blockNumber: "0x5a",
        blockHash: BLOCK,
        transactionIndex: "0x1",
        input,
      },
      eth_getTransactionReceipt: receipt,
    });
  const first = await acquireSafeEvidence(
    { address: SAFE, chainId: 1 },
    { rpc: makeRpc(), fetch: source.fetch },
  );
  const verified = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, blockNumber: 100, verifySignatures: true },
    { rpc: makeRpc(), fetch: source.fetch },
  );
  assert.equal(first.bundle.executions[0].transactionIndex, undefined);
  assert.equal(verified.bundle.executions[0].transactionIndex, 1);
  const initial = mergeProtocolEvidence(undefined, {
    version: 1,
    mode: "private",
    safe: first.bundle,
  });
  const merged = mergeProtocolEvidence(initial, {
    version: 1,
    mode: "private",
    safe: verified.bundle,
  });
  assert.equal(merged.safe!.executions.length, 1);
  assert.equal(merged.safe!.executions[0].transactionIndex, 1);
  assert.equal(
    merged.safe!.executions[0].signatures[0].participation,
    "calldata-only",
  );
  assert.equal(
    merged.safe!.executions[0].signatures[0].signer,
    account.address.toLowerCase(),
  );
  const repeated = mergeProtocolEvidence(merged, initial);
  assert.equal(repeated.safe!.executions[0].transactionIndex, 1);
  assert.equal(
    repeated.safe!.executions[0].signatures[0].participation,
    "calldata-only",
  );
});

test("actual provider preflight failure preserves successful history coverage and can resume through merge", async () => {
  const source = history([
    {
      count: 6,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=5`,
      results: [txRow()],
    },
    {
      count: 6,
      next: null,
      results: [
        txRow({ nonce: "1", safeTxHash: HASH, transactionHash: SAFE_HASH }),
      ],
    },
  ]);
  const first = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, blockNumber: 100 },
    { rpc: rpc(), fetch: source.fetch },
  );
  const goodCoverage = first.bundle.coverage.find(
    (c) => c.stream === "executions",
  )!;
  const initial = mergeProtocolEvidence(undefined, {
    version: 1,
    mode: "private",
    safe: first.bundle,
  });
  const outage = Object.assign(new Error("private transport details"), {
    code: "RPC_NETWORK_ERROR",
    retryable: true,
  });
  const failed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: first.cursor! },
    { rpc: rpc({ eth_chainId: outage }), fetch: source.fetch },
  );
  assert.equal(failed.errors[0]?.code, "RPC_NETWORK_ERROR");
  assert.equal(source.urls.length, 1);
  const afterFailure = mergeProtocolEvidence(initial, {
    version: 1,
    mode: "private",
    safe: failed.bundle,
  });
  assert.equal(afterFailure.safe!.executions.length, 1);
  assert.equal(
    afterFailure.safe!.coverage.find((c) => c.id === goodCoverage.id)?.cursor,
    first.cursor,
  );
  assert.ok(
    afterFailure.safe!.coverage.some(
      (c) =>
        c.stream === "executions" &&
        c.status === "error" &&
        c.id !== goodCoverage.id,
    ),
  );
  const resumed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, cursor: first.cursor! },
    { rpc: rpc(), fetch: source.fetch },
  );
  const complete = mergeProtocolEvidence(afterFailure, {
    version: 1,
    mode: "private",
    safe: resumed.bundle,
  });
  assert.deepEqual(
    complete.safe!.executions.map((e) => e.nonce),
    ["0", "1"],
  );
  assert.equal(
    complete.safe!.coverage.find((c) => c.id === goodCoverage.id)?.cursor,
    null,
  );
  assert.equal(new URL(source.urls[1]).searchParams.get("offset"), "5");
});

test("actual configuration-only acquisition can add and resume history without changing provenance", async () => {
  const source = history([
    {
      count: 6,
      next: `https://api.safe.global/tx-service/eth/api/v2/safes/${SAFE}/multisig-transactions/?executed=true&trusted=false&ordering=nonce%2Ccreated&limit=5&offset=5`,
      results: [txRow()],
    },
    {
      count: 6,
      next: null,
      results: [
        txRow({ nonce: "1", safeTxHash: HASH, transactionHash: SAFE_HASH }),
      ],
    },
  ]);
  const configuration = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, blockNumber: 100, includeHistory: false },
    { rpc: rpc(), fetch: source.fetch },
  );
  assert.equal(source.urls.length, 0);
  const indexed = await acquireSafeEvidence(
    { address: SAFE, chainId: 1, blockNumber: 100, includeHistory: true },
    { rpc: rpc(), fetch: source.fetch },
  );
  const bundle = (safe: typeof configuration.bundle) => ({
    version: 1 as const,
    mode: "private" as const,
    safe,
  });
  const merged = mergeProtocolEvidence(
    bundle(configuration.bundle),
    bundle(indexed.bundle),
  );
  assert.equal(merged.safe!.configurations.length, 1);
  assert.equal(merged.safe!.executions.length, 1);
  const good = indexed.bundle.coverage.find((c) => c.stream === "executions")!;
  assert.ok(good.cursor);
  assert.equal(
    merged.safe!.coverage.find((c) => c.id === good.id)?.cursor,
    indexed.cursor,
  );
  assert.ok(
    merged.safe!.coverage.some(
      (c) =>
        c.stream === "executions" &&
        c.status === "unsupported" &&
        c.provenance.source ===
          "Flowlens acquisition coverage: history not requested",
    ),
  );
  const afterConfigurationOnly = mergeProtocolEvidence(
    merged,
    bundle(configuration.bundle),
  );
  assert.equal(
    afterConfigurationOnly.safe!.coverage.find((c) => c.id === good.id)?.cursor,
    indexed.cursor,
  );
  const resumed = await acquireSafeEvidence(
    {
      address: SAFE,
      chainId: 1,
      cursor: indexed.cursor!,
      includeHistory: true,
    },
    { rpc: rpc(), fetch: source.fetch },
  );
  const complete = mergeProtocolEvidence(
    afterConfigurationOnly,
    bundle(resumed.bundle),
  );
  assert.deepEqual(
    complete.safe!.executions.map((e) => e.nonce),
    ["0", "1"],
  );
  assert.equal(
    complete.safe!.coverage.find((c) => c.id === good.id)?.cursor,
    null,
  );
  assert.equal(new URL(source.urls[1]).searchParams.get("offset"), "5");
});
