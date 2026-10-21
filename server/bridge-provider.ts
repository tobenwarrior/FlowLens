import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  toEventSelector,
  type AbiEvent,
  type Hex,
} from "viem";
import {
  parseBridgeEvidence,
  type BridgeEvidenceBundle,
  type BridgeMessage,
  type BridgeObservation,
  type BridgeProvenance,
} from "../src/domain/bridges.ts";
import type { Address, Asset } from "../src/domain/types.ts";
import type { RpcClient } from "./rpc.ts";

export interface BridgeAcquisitionInput {
  chainId: number;
  hash: string;
  maxLogs?: number;
}
export interface BridgeProviderEvent {
  name:
    "MessageSent" | "MessageReceived" | "MintAndWithdraw" | "DepositForBurn";
  protocolVersion: 1 | 2;
  chainId: number;
  transactionHash: string;
  logIndex: number;
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: string;
  messageHash?: string;
  normalized: boolean;
}
export interface BridgeAcquisitionResult {
  bundle: BridgeEvidenceBundle;
  scope: "transaction";
  warnings: string[];
  errors: string[];
  issues: { code: string; retryable: boolean }[];
  events: BridgeProviderEvent[];
}
// Circle official mainnet contract, domain and native-USDC registries; checked 2026-10-21.
const REGISTRY: Readonly<
  Record<
    number,
    { domain: number; token: string; messenger: string; transmitter: string }
  >
> = {
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
  42161: {
    domain: 3,
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    messenger: "0x19330d10d9cc8751218eaf51e8885d058642e08a",
    transmitter: "0xc30362313fbba5cf9163f0bb16a0e01f01a896ca",
  },
};
const V2_MESSENGER = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const V2_TRANSMITTER = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const USDC_SOURCE =
  "https://developers.circle.com/stablecoins/usdc-contract-addresses";
const HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const SENT = parseAbi(["event MessageSent(bytes message)"])[0];
const RECEIVED = {
  1: parseAbi([
    "event MessageReceived(address indexed caller,uint32 sourceDomain,uint64 indexed nonce,bytes32 sender,bytes messageBody)",
  ])[0],
  2: parseAbi([
    "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
  ])[0],
};
const MINTED = {
  1: parseAbi([
    "event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken)",
  ])[0],
  2: parseAbi([
    "event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken,uint256 feeCollected)",
  ])[0],
};
const RECEIVE_CALL = parseAbi([
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
]);
const DEPOSITED = {
  1: parseAbi([
    "event DepositForBurn(uint64 indexed nonce,address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller)",
  ])[0],
  2: parseAbi([
    "event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)",
  ])[0],
};
const DEPOSIT_CALL = {
  1: parseAbi([
    "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken) returns (uint64)",
    "function depositForBurnWithCaller(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller) returns (uint64)",
  ]),
  2: parseAbi([
    "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
    "function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)",
  ]),
};
const SCOPE =
  "Only the requested transaction receipt was inspected. No destination search, address history scan or complete-history claim is made.";
const SOURCE =
  "Transaction, receipt and canonical block checks use one RPC source. Provider omissions, dishonesty and later reorganizations remain possible.";
type Row = Record<string, unknown>;
class EvidenceFailure extends Error {
  code: string;
  unavailable: boolean;
  constructor(code: string, unavailable = false) {
    super(code);
    this.code = code;
    this.unavailable = unavailable;
  }
}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
  return value as Row;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
  return value.toLowerCase();
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
  return value.toLowerCase() as Address;
}
function bytes(value: unknown, max = 32768): Hex {
  if (
    typeof value !== "string" ||
    value.length > 2 + max * 2 ||
    !/^0x(?:[0-9a-f]{2})*$/i.test(value)
  )
    throw new EvidenceFailure("BRIDGE_MALFORMED_MESSAGE");
  return value.toLowerCase() as Hex;
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    value.length > 66 ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  )
    throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
  return BigInt(value);
}
function integer(value: unknown): number {
  const n = quantity(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
  return Number(n);
}
function same(actual: unknown, expected: unknown): void {
  if (actual !== expected)
    throw new EvidenceFailure("BRIDGE_IDENTITY_MISMATCH");
}
function slice(value: Hex, offset: number, length: number): Hex {
  const part = value.slice(2 + offset * 2, 2 + (offset + length) * 2);
  if (part.length !== length * 2)
    throw new EvidenceFailure("BRIDGE_MALFORMED_MESSAGE");
  return `0x${part}`;
}
function uint(value: Hex, offset: number, length: number): bigint {
  return BigInt(slice(value, offset, length));
}
function wordAddress(value: unknown): Address {
  const word = hash(value);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word))
    throw new EvidenceFailure("BRIDGE_NON_EVM_ADDRESS");
  return address(`0x${word.slice(-40)}`);
}
function chainForDomain(domain: number): number {
  const chain = Object.keys(REGISTRY).find(
    (id) => REGISTRY[Number(id)].domain === domain,
  );
  if (!chain) throw new EvidenceFailure("BRIDGE_UNSUPPORTED_DOMAIN", true);
  return Number(chain);
}
function messenger(chainId: number, version: 1 | 2): string {
  return version === 1 ? REGISTRY[chainId].messenger : V2_MESSENGER;
}
function asset(chainId: number): Asset {
  return {
    chainId,
    contract: REGISTRY[chainId].token as Address,
    symbol: "USDC",
    decimals: 6,
  };
}
interface Burn {
  token: Address;
  recipient: Address;
  sender: Address;
  amount: bigint;
  fee: bigint;
}
function burnBody(value: Hex, version: 1 | 2): Burn {
  const length = (value.length - 2) / 2;
  if (
    (version === 1 ? length !== 132 : length < 228) ||
    uint(value, 0, 4) !== BigInt(version - 1)
  )
    throw new EvidenceFailure("BRIDGE_MALFORMED_MESSAGE");
  const amount = uint(value, 68, 32),
    fee = version === 1 ? 0n : uint(value, 164, 32);
  if (
    amount === 0n ||
    fee > amount ||
    (version === 2 && fee > uint(value, 132, 32))
  )
    throw new EvidenceFailure("BRIDGE_INVALID_BURN_AMOUNT");
  return {
    token: wordAddress(slice(value, 4, 32)),
    recipient: wordAddress(slice(value, 36, 32)),
    sender: wordAddress(slice(value, 100, 32)),
    amount,
    fee,
  };
}
interface ParsedMessage {
  message: Extract<BridgeMessage, { protocol: "cctp" }>;
  sourceChainId: number;
  destinationChainId: number;
  body: Hex;
  sender: Address;
  recipient: Address;
  finality: number;
  burn: Burn;
}
function parseMessage(value: Hex, version: 1 | 2): ParsedMessage {
  const header = version === 1 ? 116 : 148;
  if (uint(value, 0, 4) !== BigInt(version - 1))
    throw new EvidenceFailure("BRIDGE_UNSUPPORTED_WIRE_VERSION");
  const sourceDomain = Number(uint(value, 4, 4)),
    destinationDomain = Number(uint(value, 8, 4));
  if (sourceDomain === destinationDomain)
    throw new EvidenceFailure("BRIDGE_INVALID_ROUTE");
  const sourceChainId = chainForDomain(sourceDomain),
    destinationChainId = chainForDomain(destinationDomain);
  const body = `0x${value.slice(2 + header * 2)}` as Hex;
  const sender = wordAddress(slice(value, version === 1 ? 20 : 44, 32)),
    recipient = wordAddress(slice(value, version === 1 ? 52 : 76, 32));
  same(sender, messenger(sourceChainId, version));
  same(recipient, messenger(destinationChainId, version));
  const burn = burnBody(body, version);
  same(burn.token, REGISTRY[sourceChainId].token);
  const nonce =
    version === 1 ? uint(value, 12, 8).toString() : slice(value, 12, 32);
  return {
    sourceChainId,
    destinationChainId,
    body,
    sender,
    recipient,
    burn,
    finality: version === 1 ? 0 : Number(uint(value, 144, 4)),
    message: {
      protocol: "cctp",
      version,
      sourceDomain,
      destinationDomain,
      ...(version === 2 && nonce === ZERO_WORD ? {} : { nonce }),
      messageHash: keccak256(value),
    },
  };
}
function eventArgs(log: Row, abi: AbiEvent): Row {
  const data = bytes(log.data),
    topics = log.topics;
  if (
    !Array.isArray(topics) ||
    topics.length !== 1 + abi.inputs.filter((x) => x.indexed).length
  )
    throw new EvidenceFailure("BRIDGE_MALFORMED_EVENT");
  const validatedTopics = topics.map(hash) as [Hex, ...Hex[]];
  const decoded = decodeEventLog({
    abi: [abi],
    topics: validatedTopics,
    data,
    strict: true,
  }).args as Row;
  const unindexed = abi.inputs.filter((x) => !x.indexed);
  same(
    encodeAbiParameters(
      unindexed,
      unindexed.map((x) => decoded[x.name!]),
    ),
    data,
  );
  let index = 1;
  for (const input of abi.inputs.filter((x) => x.indexed))
    same(
      encodeAbiParameters([input], [decoded[input.name!]]),
      validatedTopics[index++],
    );
  return decoded;
}
function provenance(rpc: RpcClient): BridgeProvenance {
  const name =
    typeof rpc.source === "string" &&
    /^[a-zA-Z0-9 ()_.:-]{1,100}$/.test(rpc.source)
      ? rpc.source
      : "Configured RPC";
  const p: BridgeProvenance = {
    source: `${name}: transaction receipt CCTP events`,
    retrievedAt: new Date().toISOString(),
    synthetic: false,
  };
  try {
    const url = new URL(rpc.sourceUrl ?? "");
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.toString().length <= 2048
    )
      p.sourceUrl = url.toString();
  } catch {
    /* Optional metadata must not leak credentials or prevent reads. */
  }
  return p;
}

/** Read-only acquisition of one known transaction. Never scans another chain or queries attestation services. */
export async function acquireBridgeEvidence(
  input: BridgeAcquisitionInput,
  deps: { rpc: RpcClient },
): Promise<BridgeAcquisitionResult> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId < 1)
    throw new TypeError("A positive chainId is required.");
  if (typeof input.hash !== "string" || !HASH.test(input.hash))
    throw new TypeError("A 32-byte transaction hash is required.");
  const maxLogs = input.maxLogs ?? 256;
  if (!Number.isSafeInteger(maxLogs) || maxLogs < 1 || maxLogs > 2000)
    throw new TypeError("maxLogs must be between 1 and 2000.");
  const { rpc } = deps,
    txHash = input.hash.toLowerCase(),
    p = provenance(rpc);
  const warnings = new Set([
    SCOPE,
    SOURCE,
    "Bridge transport or a mint to a recipient does not establish independent customer credit or ownership.",
  ]);
  const errors: string[] = [],
    issues: BridgeAcquisitionResult["issues"] = [],
    observations: BridgeObservation[] = [],
    events: BridgeProviderEvent[] = [];
  let blockNumber: number | null = null,
    status: "partial" | "unavailable" | "error" = "unavailable";
  const mappings = new Map<
    string,
    BridgeEvidenceBundle["assetMappings"][number]
  >();
  function finish(): BridgeAcquisitionResult {
    const notes = [...warnings];
    const coverage: BridgeEvidenceBundle["coverage"] = (
      ["source", "destination", "fee", "independent-credit"] as const
    ).map((stream) => ({
      id: `rpc-cctp:${input.chainId}:${txHash}:${stream}`,
      chainId: input.chainId,
      protocol: "cctp",
      stream,
      status:
        stream === "independent-credit" ||
        (stream === "fee" && !observations.some((x) => x.role === "fee"))
          ? "unavailable"
          : status,
      blockFrom: blockNumber,
      blockTo: blockNumber,
      warnings: notes,
      provenance: { ...p },
    }));
    return {
      bundle: parseBridgeEvidence(
        {
          version: 1,
          mode: "private",
          observations,
          assetMappings: [...mappings.values()],
          coverage,
        },
        "private",
      ),
      scope: "transaction",
      warnings: notes,
      errors,
      issues,
      events,
    };
  }
  if (!REGISTRY[input.chainId]) {
    warnings.add(
      "CCTP acquisition is unavailable for this chain. Only Ethereum, Base and Arbitrum One mainnets are registered.",
    );
    return finish();
  }
  try {
    same(rpc.chainId, input.chainId);
    same(integer(await rpc.request("eth_chainId", [])), input.chainId);
    const [txValue, receiptValue] = await Promise.all([
      rpc.request("eth_getTransactionByHash", [txHash]),
      rpc.request("eth_getTransactionReceipt", [txHash]),
    ]);
    if (txValue === null || receiptValue === null)
      throw new EvidenceFailure("BRIDGE_TRANSACTION_UNAVAILABLE", true);
    const tx = row(txValue),
      receipt = row(receiptValue);
    same(hash(tx.hash), txHash);
    same(hash(receipt.transactionHash), txHash);
    if (tx.blockHash === null || tx.blockNumber === null)
      throw new EvidenceFailure("BRIDGE_TRANSACTION_PENDING", true);
    if (tx.chainId !== undefined) same(integer(tx.chainId), input.chainId);
    const txBlock = integer(tx.blockNumber),
      blockHash = hash(tx.blockHash);
    same(hash(receipt.blockHash), blockHash);
    same(integer(receipt.blockNumber), txBlock);
    same(address(receipt.from), address(tx.from));
    same(
      receipt.to === null ? null : address(receipt.to),
      tx.to === null ? null : address(tx.to),
    );
    const txIndex = integer(tx.transactionIndex);
    same(integer(receipt.transactionIndex), txIndex);
    const receiptStatus = integer(receipt.status);
    if (receiptStatus !== 0 && receiptStatus !== 1)
      throw new EvidenceFailure("BRIDGE_INVALID_RECEIPT_STATUS");
    const block = row(
      await rpc.request("eth_getBlockByNumber", [tx.blockNumber, false]),
    );
    same(hash(block.hash), blockHash);
    same(integer(block.number), txBlock);
    if (
      !Array.isArray(block.transactions) ||
      block.transactions.length > 50000 ||
      hash(block.transactions[txIndex]) !== txHash
    )
      throw new EvidenceFailure("BRIDGE_CANONICAL_MEMBERSHIP_MISMATCH");
    const seconds = integer(block.timestamp);
    if (seconds > 253402300799)
      throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
    const timestamp = new Date(seconds * 1000).toISOString();
    blockNumber = txBlock;
    if (receiptStatus === 0) {
      warnings.add(
        "The canonical receipt reports a reverted transaction. No bridge movements were accepted.",
      );
      status = "partial";
      return finish();
    }
    if (!Array.isArray(receipt.logs))
      throw new EvidenceFailure("BRIDGE_INVALID_PROVIDER_DATA");
    const logs = receipt.logs.slice(0, maxLogs).map(row),
      seenIndices = new Set<number>();
    // Validate the entire inspected prefix before accepting any of its bridge events.
    let previousIndex = -1;
    for (const l of logs) {
      same(hash(l.transactionHash), txHash);
      same(hash(l.blockHash), blockHash);
      same(integer(l.blockNumber), txBlock);
      same(integer(l.transactionIndex), txIndex);
      if (l.removed !== false) throw new EvidenceFailure("BRIDGE_REMOVED_LOG");
      const index = integer(l.logIndex);
      if (seenIndices.has(index) || index <= previousIndex)
        throw new EvidenceFailure("BRIDGE_LOG_IDENTITY_MISMATCH");
      seenIndices.add(index);
      previousIndex = index;
      address(l.address);
    }
    status = "partial";
    const capped = receipt.logs.length > maxLogs;
    let malformedKnownEvent = false;
    if (capped)
      warnings.add(
        "Receipt log budget reached; additional logs were omitted and destination normalization is unavailable.",
      );
    const received: {
      summary: BridgeProviderEvent;
      args: Row;
      version: 1 | 2;
    }[] = [];
    const minted: {
      summary: BridgeProviderEvent;
      args: Row;
      version: 1 | 2;
    }[] = [];
    const outgoing: {
      summary: BridgeProviderEvent;
      parsed: ParsedMessage;
      payload: Hex;
    }[] = [];
    const deposited: {
      summary: BridgeProviderEvent;
      args: Row;
      version: 1 | 2;
    }[] = [];
    function normalize(
      parsed: ParsedMessage,
      role: "source" | "destination",
      summary: BridgeProviderEvent,
      amount: bigint,
    ) {
      observations.push({
        id: `rpc-cctp:${input.chainId}:${txHash}:${summary.logIndex}`,
        role,
        chainId: input.chainId,
        txHash,
        logIndex: summary.logIndex,
        blockNumber: txBlock,
        timestamp,
        rawAmount: amount.toString(),
        asset: asset(input.chainId),
        route: {
          sourceChainId: parsed.sourceChainId,
          destinationChainId: parsed.destinationChainId,
        },
        message: parsed.message,
        sender: parsed.burn.sender,
        recipient: parsed.burn.recipient,
        recipientScope: "unknown",
        provenance: { ...p },
        ...(role === "destination"
          ? {
              independentCredit: {
                status: "unverified" as const,
                evidence: [],
              },
            }
          : {}),
      });
      summary.normalized = true;
      const id = `circle-native-usdc:${parsed.sourceChainId}:${parsed.destinationChainId}`;
      mappings.set(id, {
        id,
        sourceAsset: asset(parsed.sourceChainId),
        destinationAsset: asset(parsed.destinationChainId),
        sourceUnits: "1",
        destinationUnits: "1",
        provenance: {
          ...p,
          source: "Circle native USDC contract registry, checked 2026-10-21",
          sourceUrl: USDC_SOURCE,
        },
      });
    }
    for (const l of logs) {
      const emitter = address(l.address),
        topic =
          Array.isArray(l.topics) && typeof l.topics[0] === "string"
            ? l.topics[0].toLowerCase()
            : "";
      const version =
        emitter === REGISTRY[input.chainId].transmitter ||
        emitter === REGISTRY[input.chainId].messenger
          ? 1
          : emitter === V2_TRANSMITTER || emitter === V2_MESSENGER
            ? 2
            : undefined;
      if (!version) continue;
      const isTransmitter =
        emitter ===
        (version === 1 ? REGISTRY[input.chainId].transmitter : V2_TRANSMITTER);
      const abi = isTransmitter
        ? topic === toEventSelector(SENT)
          ? SENT
          : topic === toEventSelector(RECEIVED[version])
            ? RECEIVED[version]
            : undefined
        : topic === toEventSelector(MINTED[version])
          ? MINTED[version]
          : topic === toEventSelector(DEPOSITED[version])
            ? DEPOSITED[version]
            : undefined;
      if (!abi) continue;
      try {
        const args = eventArgs(l, abi),
          summary: BridgeProviderEvent = {
            name: abi.name as BridgeProviderEvent["name"],
            protocolVersion: version,
            chainId: input.chainId,
            transactionHash: txHash,
            logIndex: integer(l.logIndex),
            normalized: false,
          };
        events.push(summary);
        if (abi.name === "MessageSent") {
          const payload = bytes(args.message);
          summary.messageHash = keccak256(payload);
          const parsed = parseMessage(payload, version);
          Object.assign(summary, {
            sourceDomain: parsed.message.sourceDomain,
            destinationDomain: parsed.message.destinationDomain,
            ...(parsed.message.nonce === undefined
              ? {}
              : { nonce: parsed.message.nonce }),
          });
          same(parsed.sourceChainId, input.chainId);
          if (version === 2) {
            same(slice(payload, 12, 32), ZERO_WORD);
            same(parsed.finality, 0);
            same(parsed.burn.fee, 0n);
            same(uint(parsed.body, 196, 32), 0n);
            warnings.add(
              "CCTP v2 source MessageSent has a zero placeholder nonce assigned offchain later. Its raw emitted hash is retained, but cannot identify the destination attested message without additional exact evidence.",
            );
          }
          outgoing.push({ summary, parsed, payload });
        } else if (abi.name === "MessageReceived") {
          summary.sourceDomain = Number(args.sourceDomain);
          summary.destinationDomain = REGISTRY[input.chainId].domain;
          summary.nonce =
            version === 1
              ? (args.nonce as bigint).toString()
              : hash(args.nonce);
          received.push({ summary, args, version });
        } else if (abi.name === "DepositForBurn")
          deposited.push({ summary, args, version });
        else minted.push({ summary, args, version });
      } catch {
        malformedKnownEvent = true;
        warnings.add(
          "A known-contract event had malformed or unsupported payload, route or token identity; it was not normalized.",
        );
      }
    }
    if (outgoing.length) {
      try {
        if (
          malformedKnownEvent ||
          outgoing.length !== 1 ||
          deposited.length !== 1
        )
          throw new EvidenceFailure("BRIDGE_SOURCE_BURN_UNAVAILABLE", true);
        const sent = outgoing[0],
          deposit = deposited[0],
          parsed = sent.parsed,
          version = sent.summary.protocolVersion;
        same(deposit.version, version);
        same(address(tx.to), messenger(input.chainId, version));
        same(address(tx.from), parsed.burn.sender);
        const call = decodeFunctionData({
          abi: DEPOSIT_CALL[version],
          data: bytes(tx.input, 100000),
        });
        const values = call.args;
        same(values[0], parsed.burn.amount);
        same(Number(values[1]), parsed.message.destinationDomain);
        same(wordAddress(values[2]), parsed.burn.recipient);
        same(address(values[3]), parsed.burn.token);
        const destinationCaller = slice(
          sent.payload,
          version === 1 ? 84 : 108,
          32,
        );
        same(
          version === 1 && call.functionName === "depositForBurn"
            ? ZERO_WORD
            : values[4],
          destinationCaller,
        );
        same(address(deposit.args.burnToken), parsed.burn.token);
        same(address(deposit.args.depositor), parsed.burn.sender);
        same(deposit.args.amount, parsed.burn.amount);
        same(wordAddress(deposit.args.mintRecipient), parsed.burn.recipient);
        same(
          Number(deposit.args.destinationDomain),
          parsed.message.destinationDomain,
        );
        same(
          wordAddress(deposit.args.destinationTokenMessenger),
          parsed.recipient,
        );
        same(deposit.args.destinationCaller, destinationCaller);
        if (sent.summary.logIndex >= deposit.summary.logIndex)
          throw new EvidenceFailure("BRIDGE_SOURCE_BURN_UNAVAILABLE", true);
        if (version === 1)
          same((deposit.args.nonce as bigint).toString(), parsed.message.nonce);
        else {
          same(values[5], uint(parsed.body, 132, 32));
          same(Number(values[6]), Number(uint(sent.payload, 140, 4)));
          same(deposit.args.maxFee, values[5]);
          same(Number(deposit.args.minFinalityThreshold), Number(values[6]));
          const hook = `0x${parsed.body.slice(2 + 228 * 2)}`;
          same(
            call.functionName === "depositForBurnWithHook" ? values[7] : "0x",
            hook,
          );
          same(deposit.args.hookData, hook);
        }
        normalize(parsed, "source", sent.summary, parsed.burn.amount);
        deposit.summary.normalized = true;
      } catch {
        warnings.add(
          "MessageSent identity is retained, but a matching direct official depositForBurn call and DepositForBurn event could not establish a new burn. Replacement messages and wrappers remain message-only; no source transfer amount was inferred.",
        );
      }
    }
    if (received.length) {
      try {
        if (
          capped ||
          malformedKnownEvent ||
          received.length !== 1 ||
          minted.length !== 1
        )
          throw new EvidenceFailure(
            "BRIDGE_MINT_ATTRIBUTION_UNAVAILABLE",
            true,
          );
        const receive = received[0],
          mint = minted[0],
          version = receive.version;
        same(mint.version, version);
        same(
          address(tx.to),
          version === 1 ? REGISTRY[input.chainId].transmitter : V2_TRANSMITTER,
        );
        const call = decodeFunctionData({
          abi: RECEIVE_CALL,
          data: bytes(tx.input, 100000),
        });
        const parsed = parseMessage(bytes(call.args[0]), version);
        same(parsed.destinationChainId, input.chainId);
        same(parsed.message.sourceDomain, receive.summary.sourceDomain);
        same(parsed.message.nonce, receive.summary.nonce);
        same(parsed.sender, wordAddress(receive.args.sender));
        same(parsed.body, bytes(receive.args.messageBody));
        same(address(receive.args.caller), address(tx.from));
        if (version === 2)
          same(parsed.finality, Number(receive.args.finalityThresholdExecuted));
        if (mint.summary.logIndex >= receive.summary.logIndex)
          throw new EvidenceFailure(
            "BRIDGE_MINT_ATTRIBUTION_UNAVAILABLE",
            true,
          );
        same(address(mint.args.mintRecipient), parsed.burn.recipient);
        same(address(mint.args.mintToken), REGISTRY[input.chainId].token);
        same(mint.args.amount, parsed.burn.amount - parsed.burn.fee);
        if (version === 2) same(mint.args.feeCollected, parsed.burn.fee);
        Object.assign(receive.summary, {
          messageHash: parsed.message.messageHash,
        });
        normalize(
          parsed,
          "destination",
          receive.summary,
          mint.args.amount as bigint,
        );
        mint.summary.normalized = true;
        if (parsed.burn.fee !== 0n) {
          observations.push({
            id: `rpc-cctp:${input.chainId}:${txHash}:${mint.summary.logIndex}`,
            role: "fee",
            feeSide: "destination",
            chainId: input.chainId,
            txHash,
            logIndex: mint.summary.logIndex,
            blockNumber: txBlock,
            timestamp,
            rawAmount: parsed.burn.fee.toString(),
            asset: asset(input.chainId),
            route: {
              sourceChainId: parsed.sourceChainId,
              destinationChainId: parsed.destinationChainId,
            },
            message: parsed.message,
            provenance: { ...p },
          });
        }
      } catch {
        warnings.add(
          "MessageReceived identity is retained, but a unique direct receiveMessage call and official native-USDC mint could not be attributed exactly. Destination asset/amount remains unavailable; no amount or time matching was used.",
        );
      }
    }
    if (!events.length)
      warnings.add(
        "No supported official CCTP events were observed in the inspected receipt log prefix.",
      );
  } catch (error) {
    const e = error && typeof error === "object" ? (error as Row) : {};
    const code =
      typeof e.code === "string" && /^[A-Z0-9_]{1,80}$/.test(e.code)
        ? e.code
        : "BRIDGE_PROVIDER_ERROR";
    errors.push(code);
    issues.push({
      code,
      retryable:
        e.retryable === true ||
        (error instanceof EvidenceFailure &&
          [
            "BRIDGE_TRANSACTION_UNAVAILABLE",
            "BRIDGE_TRANSACTION_PENDING",
          ].includes(error.code)),
    });
    status =
      error instanceof EvidenceFailure && error.unavailable
        ? "unavailable"
        : "error";
    warnings.add(
      "Transaction acquisition failed or identity validation was unavailable. No bridge events were accepted; raw provider error text is omitted.",
    );
    observations.length = 0;
    events.length = 0;
    mappings.clear();
  }
  return finish();
}
