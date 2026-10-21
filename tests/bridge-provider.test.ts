import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from "viem";
import { acquireBridgeEvidence } from "../server/bridge-provider.ts";
import { matchBridgeEvidence } from "../src/domain/bridges.ts";
import { RpcProviderError, type RpcClient } from "../server/rpc.ts";

const H = `0x${"1".repeat(64)}` as Hex,
  B = `0x${"2".repeat(64)}` as Hex;
const sender = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  recipient = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const registry = {
  1: {
    domain: 0,
    token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    messenger: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
    transmitter: "0x0a992d191deec32afe36203ad87d7d289a738f81",
  },
  8453: {
    domain: 6,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    messenger: "0x1682ae6375c4e4a97e4b583bc394c861a46d8962",
    transmitter: "0xad09780d193884d503182ad4588450c416d6f9d4",
  },
} as const;
const V2M = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
  V2T = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const word = (address: string) =>
  `0x${address.slice(2).padStart(64, "0")}` as Hex;
function message(
  version: 1 | 2,
  destination = 6,
  nonce = version === 1 ? 9n : 0n,
  token: string = registry[1].token,
) {
  const body = encodePacked(
    ["uint32", "bytes32", "bytes32", "uint256", "bytes32"],
    [version - 1, word(token), word(recipient), 1000001n, word(sender)],
  );
  const fullBody =
    version === 1
      ? body
      : (`${body}${encodePacked(["uint256", "uint256", "uint256"], [100n, nonce === 0n ? 0n : 10n, 0n]).slice(2)}` as Hex);
  const header =
    version === 1
      ? encodePacked(
          [
            "uint32",
            "uint32",
            "uint32",
            "uint64",
            "bytes32",
            "bytes32",
            "bytes32",
          ],
          [
            0,
            0,
            destination,
            nonce,
            word(registry[1].messenger),
            word(registry[8453].messenger),
            word("0x0000000000000000000000000000000000000000"),
          ],
        )
      : encodePacked(
          [
            "uint32",
            "uint32",
            "uint32",
            "bytes32",
            "bytes32",
            "bytes32",
            "bytes32",
            "uint32",
            "uint32",
          ],
          [
            1,
            0,
            destination,
            word(`0x${nonce.toString(16)}`),
            word(V2M),
            word(V2M),
            word("0x0000000000000000000000000000000000000000"),
            1000,
            nonce === 0n ? 0 : 2000,
          ],
        );
  return { body: fullBody, bytes: `${header}${fullBody.slice(2)}` as Hex };
}
function log(
  address: string,
  index: number,
  topics: ReturnType<typeof encodeEventTopics>,
  data: Hex,
) {
  return {
    address,
    logIndex: `0x${index.toString(16)}`,
    topics,
    data,
    transactionHash: H,
    blockHash: B,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    removed: false,
  };
}
function sent(version: 1 | 2 = 1, bytes = message(version).bytes, index = 1) {
  return log(
    version === 1 ? registry[1].transmitter : V2T,
    index,
    encodeEventTopics({
      abi: parseAbi(["event MessageSent(bytes message)"]),
      eventName: "MessageSent",
    }),
    encodeAbiParameters(parseAbiParameters("bytes"), [bytes]),
  );
}
const DEPOSIT_CALL = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken) returns (uint64)",
]);
const V2_DEPOSIT_CALL = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
]);
function depositInput(version: 1 | 2) {
  return version === 1
    ? encodeFunctionData({
        abi: DEPOSIT_CALL,
        functionName: "depositForBurn",
        args: [1000001n, 6, word(recipient), registry[1].token],
      })
    : encodeFunctionData({
        abi: V2_DEPOSIT_CALL,
        functionName: "depositForBurn",
        args: [
          1000001n,
          6,
          word(recipient),
          registry[1].token,
          word("0x0"),
          100n,
          1000,
        ],
      });
}
function depositEvent(version: 1 | 2, index = 2) {
  return version === 1
    ? log(
        registry[1].messenger,
        index,
        encodeEventTopics({
          abi: parseAbi([
            "event DepositForBurn(uint64 indexed nonce,address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller)",
          ]),
          eventName: "DepositForBurn",
          args: { nonce: 9n, burnToken: registry[1].token, depositor: sender },
        }),
        encodeAbiParameters(
          parseAbiParameters("uint256,bytes32,uint32,bytes32,bytes32"),
          [
            1000001n,
            word(recipient),
            6,
            word(registry[8453].messenger),
            word("0x0"),
          ],
        ),
      )
    : log(
        V2M,
        index,
        encodeEventTopics({
          abi: parseAbi([
            "event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)",
          ]),
          eventName: "DepositForBurn",
          args: {
            burnToken: registry[1].token,
            depositor: sender,
            minFinalityThreshold: 1000,
          },
        }),
        encodeAbiParameters(
          parseAbiParameters(
            "uint256,bytes32,uint32,bytes32,bytes32,uint256,bytes",
          ),
          [1000001n, word(recipient), 6, word(V2M), word("0x0"), 100n, "0x"],
        ),
      );
}
const sourceLogs = (version: 1 | 2 = 1) => [
  sent(version),
  depositEvent(version),
];
function destination(version: 1 | 2 = 1) {
  const msg = message(version, 6, 9n);
  const received =
    version === 1
      ? log(
          registry[8453].transmitter,
          2,
          encodeEventTopics({
            abi: parseAbi([
              "event MessageReceived(address indexed caller,uint32 sourceDomain,uint64 indexed nonce,bytes32 sender,bytes messageBody)",
            ]),
            eventName: "MessageReceived",
            args: { caller: sender, nonce: 9n },
          }),
          encodeAbiParameters(parseAbiParameters("uint32,bytes32,bytes"), [
            0,
            word(registry[1].messenger),
            msg.body,
          ]),
        )
      : log(
          V2T,
          2,
          encodeEventTopics({
            abi: parseAbi([
              "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
            ]),
            eventName: "MessageReceived",
            args: {
              caller: sender,
              nonce: word("0x9"),
              finalityThresholdExecuted: 2000,
            },
          }),
          encodeAbiParameters(parseAbiParameters("uint32,bytes32,bytes"), [
            0,
            word(V2M),
            msg.body,
          ]),
        );
  const mint = log(
    version === 1 ? registry[8453].messenger : V2M,
    1,
    encodeEventTopics({
      abi: parseAbi([
        version === 1
          ? "event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken)"
          : "event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken,uint256 feeCollected)",
      ]),
      eventName: "MintAndWithdraw",
      args: { mintRecipient: recipient, mintToken: registry[8453].token },
    }),
    encodeAbiParameters(
      parseAbiParameters(version === 1 ? "uint256" : "uint256,uint256"),
      version === 1 ? [1000001n] : [999991n, 10n],
    ),
  );
  const input = encodeFunctionData({
    abi: parseAbi([
      "function receiveMessage(bytes message,bytes attestation) returns (bool)",
    ]),
    functionName: "receiveMessage",
    args: [msg.bytes, "0x"],
  });
  return { received, mint, input, msg };
}
function rpcFixture(
  chainId = 1,
  logs: unknown[] = sourceLogs(),
  overrides: {
    tx?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    block?: Record<string, unknown>;
    chain?: string;
    fail?: string;
  } = {},
) {
  const calls: string[] = [];
  const version = logs.some((x) => (x as { address?: string }).address === V2T)
    ? 2
    : 1;
  const rpc: RpcClient = {
    chainId,
    source: "Injected RPC",
    sourceUrl: "https://example.test/rpc",
    async request(method) {
      calls.push(method);
      if (overrides.fail === method)
        throw new RpcProviderError(
          "RPC_RATE_LIMITED",
          "https://secret:key@example.test/path?key=hide",
          true,
        );
      if (method === "eth_chainId")
        return overrides.chain ?? `0x${chainId.toString(16)}`;
      if (method === "eth_getTransactionByHash")
        return {
          hash: H,
          blockHash: B,
          blockNumber: "0x64",
          from: sender,
          to: version === 1 ? registry[1].messenger : V2M,
          transactionIndex: "0x0",
          chainId: `0x${chainId.toString(16)}`,
          input: depositInput(version),
          ...overrides.tx,
        };
      if (method === "eth_getTransactionReceipt")
        return {
          transactionHash: H,
          blockHash: B,
          blockNumber: "0x64",
          from: sender,
          to: version === 1 ? registry[1].messenger : V2M,
          status: "0x1",
          transactionIndex: "0x0",
          logs,
          ...overrides.receipt,
        };
      if (method === "eth_getBlockByNumber")
        return {
          hash: B,
          number: "0x64",
          timestamp: "0x68f60f00",
          transactions: [H],
          ...overrides.block,
        };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  return { rpc, calls };
}

test("official CCTP v1 source retains exact raw USDC/domain/nonce identity and transaction scope", async () => {
  const f = rpcFixture();
  const r = await acquireBridgeEvidence({ chainId: 1, hash: H }, f);
  assert.deepEqual(r.errors, []);
  assert.equal(r.scope, "transaction");
  const o = r.bundle.observations[0];
  assert.equal(o.role, "source");
  assert.equal(o.rawAmount, "1000001");
  assert.equal(o.asset.contract, registry[1].token);
  assert.deepEqual(o.message, {
    protocol: "cctp",
    version: 1,
    sourceDomain: 0,
    destinationDomain: 6,
    nonce: "9",
    messageHash: keccak256(message(1).bytes),
  });
  assert.equal(o.sender, sender);
  assert.equal(o.recipient, recipient);
  assert.equal(o.provenance.synthetic, false);
  assert.equal(r.bundle.mode, "private");
  assert.equal(
    matchBridgeEvidence(r.bundle).matches[0].status,
    "unmatched-source",
  );
  assert.equal(matchBridgeEvidence(r.bundle).completeHistory, false);
  assert.equal(f.calls.length, 4);
});
test("v2 source placeholder nonce is never emitted as shared protocol identity", async () => {
  const r = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(1, sourceLogs(2)),
  );
  assert.equal(r.bundle.observations.length, 1);
  const m = r.bundle.observations[0].message;
  assert.equal(m.protocol, "cctp");
  if (m.protocol === "cctp") {
    assert.equal(m.version, 2);
    assert.equal(m.nonce, undefined);
  }
  assert.ok(r.warnings.some((x) => /offchain|placeholder/i.test(x)));
});
for (const version of [1, 2] as const)
  test(`v${version} direct receiveMessage matches exact calldata/event identity and logged native USDC mint`, async () => {
    const d = destination(version),
      to = version === 1 ? registry[8453].transmitter : V2T;
    const r = await acquireBridgeEvidence(
      { chainId: 8453, hash: H },
      rpcFixture(8453, [d.mint, d.received], {
        tx: { to, input: d.input },
        receipt: { to },
      }),
    );
    assert.deepEqual(r.errors, []);
    assert.equal(r.bundle.observations.length, version === 1 ? 1 : 2);
    const o = r.bundle.observations[0];
    assert.equal(o.role, "destination");
    assert.equal(o.rawAmount, version === 1 ? "1000001" : "999991");
    assert.equal(o.asset.contract, registry[8453].token);
    assert.equal(o.independentCredit?.status, "unverified");
    if (version === 2) {
      const fee = r.bundle.observations.find((x) => x.role === "fee")!;
      assert.equal(fee.rawAmount, "10");
      assert.equal(fee.feeSide, "destination");
      assert.equal(fee.logIndex, 1);
      assert.equal(fee.recipient, undefined);
      assert.ok(
        r.bundle.coverage.some(
          (x) => x.stream === "fee" && x.status === "partial",
        ),
      );
    }
    assert.equal(
      matchBridgeEvidence(r.bundle).matches[0].status,
      "unmatched-destination",
    );
  });
test("unattributed destination mint preserves received event identity without inventing an amount", async () => {
  const d = destination();
  const r = await acquireBridgeEvidence(
    { chainId: 8453, hash: H },
    rpcFixture(8453, [d.received]),
  );
  assert.equal(r.bundle.observations.length, 0);
  assert.equal(r.events[0].name, "MessageReceived");
  assert.equal(r.events[0].nonce, "9");
  assert.ok(r.warnings.some((x) => /mint|amount/i.test(x)));
});
test("additional malformed known-contract logs prevent unique destination attribution", async () => {
  const d = destination(),
    to = registry[8453].transmitter;
  const extra = { ...d.mint, logIndex: "0x3", data: "0x1234" };
  const r = await acquireBridgeEvidence(
    { chainId: 8453, hash: H },
    rpcFixture(8453, [d.mint, d.received, extra], {
      tx: { to, input: d.input },
      receipt: { to },
    }),
  );
  assert.equal(r.bundle.observations.length, 0);
  assert.ok(
    r.events.some((x) => x.name === "MessageReceived" && x.nonce === "9"),
  );
});
test("separately acquired legacy endpoints join by exact message and reconcile registered raw USDC", async () => {
  const source = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(),
  );
  const d = destination(),
    to = registry[8453].transmitter;
  const target = await acquireBridgeEvidence(
    { chainId: 8453, hash: H },
    rpcFixture(8453, [d.mint, d.received], {
      tx: { to, input: d.input },
      receipt: { to },
    }),
  );
  const analysis = matchBridgeEvidence({
    ...source.bundle,
    observations: [
      ...source.bundle.observations,
      ...target.bundle.observations,
    ],
  });
  assert.equal(analysis.matches.length, 1);
  assert.equal(analysis.matches[0].status, "matched");
  assert.equal(analysis.matches[0].amountReconciliation.status, "balanced");
  assert.equal(analysis.matches[0].independentCredit.status, "unverified");
});
test("v2 source emitted-message hash never silently joins the mutated attested destination", async () => {
  const source = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(1, sourceLogs(2)),
  );
  const d = destination(2),
    to = V2T;
  const target = await acquireBridgeEvidence(
    { chainId: 8453, hash: H },
    rpcFixture(8453, [d.mint, d.received], {
      tx: { to, input: d.input },
      receipt: { to },
    }),
  );
  const analysis = matchBridgeEvidence({
    ...source.bundle,
    observations: [
      ...source.bundle.observations,
      ...target.bundle.observations,
    ],
  });
  assert.deepEqual(analysis.matches.map((x) => x.status).sort(), [
    "unmatched-destination",
    "unmatched-source",
  ]);
});
test("equal amounts from different message nonces never form a bridge join", async () => {
  const source = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(),
  );
  const d = destination();
  d.received.topics = encodeEventTopics({
    abi: parseAbi([
      "event MessageReceived(address indexed caller,uint32 sourceDomain,uint64 indexed nonce,bytes32 sender,bytes messageBody)",
    ]),
    eventName: "MessageReceived",
    args: { caller: sender, nonce: 10n },
  });
  const to = registry[8453].transmitter;
  const r = await acquireBridgeEvidence(
    { chainId: 8453, hash: H },
    rpcFixture(8453, [d.mint, d.received], {
      tx: { to, input: d.input },
      receipt: { to },
    }),
  );
  assert.equal(r.bundle.observations.length, 0);
  assert.equal(source.bundle.observations.length, 1);
});
test("replacement MessageSent and DepositForBurn without a direct burn call never become a new source movement", async () => {
  const replaced = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(1, sourceLogs(), {
      tx: {
        input: encodeFunctionData({
          abi: parseAbi([
            "function replaceDepositForBurn(bytes originalMessage,bytes originalAttestation,bytes32 newDestinationCaller,bytes32 newMintRecipient)",
          ]),
          functionName: "replaceDepositForBurn",
          args: [message(1).bytes, "0x", word("0x0"), word(recipient)],
        }),
      },
    }),
  );
  assert.equal(replaced.bundle.observations.length, 0);
  assert.ok(
    replaced.events.some((x) => x.name === "MessageSent" && !x.normalized),
  );
  const noDeposit = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(1, [sent()]),
  );
  assert.equal(noDeposit.bundle.observations.length, 0);
});
test("source deposit calldata sender and exact event nonce must agree", async () => {
  const wrongNonce = depositEvent(1);
  wrongNonce.topics = encodeEventTopics({
    abi: parseAbi([
      "event DepositForBurn(uint64 indexed nonce,address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller)",
    ]),
    eventName: "DepositForBurn",
    args: { nonce: 10n, burnToken: registry[1].token, depositor: sender },
  });
  for (const f of [
    rpcFixture(1, [sent(), wrongNonce]),
    rpcFixture(1, sourceLogs(), {
      tx: { from: recipient },
      receipt: { from: recipient },
    }),
  ]) {
    const r = await acquireBridgeEvidence({ chainId: 1, hash: H }, f);
    assert.equal(r.bundle.observations.length, 0);
  }
});
test("transport issue retryability is retained without raw provider errors", async () => {
  const r = await acquireBridgeEvidence(
    { chainId: 1, hash: H },
    rpcFixture(1, sourceLogs(), { fail: "eth_getTransactionReceipt" }),
  );
  assert.deepEqual(r.issues, [{ code: "RPC_RATE_LIMITED", retryable: true }]);
});
for (const [name, change] of [
  ["wrong chain", { chain: "0x2105" }],
  ["receipt hash", { receipt: { transactionHash: B } }],
  ["block hash", { block: { hash: H } }],
  ["canonical membership", { block: { transactions: [B] } }],
  ["receipt status", { receipt: { status: "0x2" } }],
] as const)
  test(`${name} failure accepts no bridge events`, async () => {
    const r = await acquireBridgeEvidence(
      { chainId: 1, hash: H },
      rpcFixture(1, [sent()], change),
    );
    assert.equal(r.bundle.observations.length, 0);
    assert.equal(r.events.length, 0);
    assert.ok(r.errors.length > 0);
  });
test("reverted, pending and transport-unavailable transactions retain precise empty coverage", async () => {
  for (const changes of [
    { receipt: { status: "0x0" } },
    { tx: { blockHash: null } },
    { fail: "eth_getTransactionReceipt" },
  ]) {
    const r = await acquireBridgeEvidence(
      { chainId: 1, hash: H },
      rpcFixture(1, [sent()], changes),
    );
    assert.equal(r.bundle.observations.length, 0);
    assert.ok(
      r.bundle.coverage.every((x) => x.status !== "supplied-scope-exhausted"),
    );
    assert.ok(!JSON.stringify(r).includes("secret:key"));
  }
});
test("fake emitters, unknown USDC, malformed payloads and unsupported domains stay unavailable", async () => {
  for (const event of [
    { ...sent(), address: sender },
    sent(1, message(1, 6, 9n, sender).bytes),
    sent(1, "0x1234"),
    sent(1, message(2).bytes),
    sent(1, message(1, 99).bytes),
    sent(1, message(1, 0).bytes),
  ]) {
    const r = await acquireBridgeEvidence(
      { chainId: 1, hash: H },
      rpcFixture(1, [event]),
    );
    assert.equal(r.bundle.observations.length, 0);
  }
});
test("log budget preserves preceding observations with explicit partial coverage", async () => {
  const r = await acquireBridgeEvidence(
    { chainId: 1, hash: H, maxLogs: 2 },
    rpcFixture(1, [...sourceLogs(), sent(1, message(1, 6, 10n).bytes, 3)]),
  );
  assert.equal(r.bundle.observations.length, 1);
  assert.ok(r.warnings.some((x) => /budget|limit/i.test(x)));
  assert.ok(
    r.bundle.coverage
      .filter((x) => x.stream === "source")
      .every((x) => x.status === "partial"),
  );
});
test("unsupported chains and bad input make no network calls", async () => {
  const f = rpcFixture(999);
  const r = await acquireBridgeEvidence({ chainId: 999, hash: H }, f);
  assert.equal(f.calls.length, 0);
  assert.equal(r.bundle.observations.length, 0);
  assert.ok(r.bundle.coverage.every((x) => x.status === "unavailable"));
  await assert.rejects(
    () => acquireBridgeEvidence({ chainId: 1, hash: "bad" }, f),
    /hash/i,
  );
  await assert.rejects(
    () => acquireBridgeEvidence({ chainId: 1, hash: H, maxLogs: 2001 }, f),
    /maxLogs/i,
  );
});
