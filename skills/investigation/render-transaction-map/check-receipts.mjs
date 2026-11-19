const hashPattern = /^0x[\da-f]{64}$/i;
const addressPattern = /^0x[\da-f]{40}$/i;
const quantityPattern = /^0x(?:0|[1-9a-f][\da-f]{0,63})$/i;
const decimalPattern = /^(?:0|[1-9]\d{0,77})$/;
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function normalize(value, pattern) {
  return typeof value === "string" && pattern.test(value)
    ? value.toLowerCase()
    : null;
}

function quantity(value) {
  return normalize(value, quantityPattern) === null ? null : BigInt(value);
}

function integer(value) {
  return typeof value === "string" && decimalPattern.test(value)
    ? BigInt(value)
    : null;
}

function sourceUrl(value) {
  const url = typeof value === "string" ? URL.parse(value) : null;
  return Boolean(
    url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  );
}

function transferLogMatches(receipt, row, blockHash, hash, amount, from, to) {
  const logIndex = integer(row.eventIndex);
  const contract = normalize(row.asset.contract, addressPattern);
  if (logIndex === null || !contract || !Array.isArray(receipt.logs))
    return false;
  const logs = receipt.logs.filter(
    (log) => quantity(log?.logIndex) === logIndex,
  );
  if (logs.length !== 1) return false;
  const [log] = logs;
  return (
    normalize(log.address, addressPattern) === contract &&
    normalize(log.transactionHash, hashPattern) === hash &&
    normalize(log.blockHash, hashPattern) === blockHash &&
    quantity(log.blockNumber) === BigInt(row.blockNumber) &&
    (log.removed === undefined || log.removed === false) &&
    Array.isArray(log.topics) &&
    log.topics.length === 3 &&
    normalize(log.topics[0], hashPattern) === transferTopic &&
    normalize(log.topics[1], hashPattern) ===
      `0x${from.slice(2).padStart(64, "0")}` &&
    normalize(log.topics[2], hashPattern) ===
      `0x${to.slice(2).padStart(64, "0")}` &&
    normalize(log.data, hashPattern) !== null &&
    BigInt(log.data) === amount
  );
}

function issue(row, proof) {
  if (!row || !["native", "erc20"].includes(row.kind))
    return "unsupported displayed evidence; use a separate trace or protocol ledger";
  if (row.synthetic === true) return "synthetic displayed evidence";
  if (!proof) return "missing receipt proof";
  const { transaction, receipt, block, sources } = proof;
  if (
    !["transaction", "receipt", "block"].every((part) =>
      sourceUrl(sources?.[part]),
    )
  )
    return "missing or invalid proof sources";
  const hash = normalize(row.hash, hashPattern);
  const blockHash = normalize(block?.hash, hashPattern);
  const from = normalize(row.from, addressPattern);
  const to = normalize(row.to, addressPattern);
  const amount = integer(row.rawAmount);
  if (
    !hash ||
    !from ||
    !to ||
    amount === null ||
    !Number.isSafeInteger(row.chainId) ||
    row.chainId <= 0 ||
    row.asset?.chainId !== row.chainId ||
    !Number.isSafeInteger(row.blockNumber) ||
    row.blockNumber < 0
  )
    return "invalid transfer identity";
  if (
    normalize(transaction?.hash, hashPattern) !== hash ||
    normalize(receipt?.transactionHash, hashPattern) !== hash ||
    (transaction?.chainId !== undefined &&
      quantity(transaction.chainId) !== BigInt(row.chainId))
  )
    return "transaction or receipt identity mismatch";
  if (row.status !== "success" || quantity(receipt?.status) !== 1n)
    return "unsuccessful receipt";
  if (
    !blockHash ||
    normalize(transaction.blockHash, hashPattern) !== blockHash ||
    normalize(receipt.blockHash, hashPattern) !== blockHash ||
    [block.number, transaction.blockNumber, receipt.blockNumber].some(
      (number) => quantity(number) !== BigInt(row.blockNumber),
    ) ||
    !Array.isArray(block.transactions) ||
    !block.transactions.some((item) => normalize(item, hashPattern) === hash)
  )
    return "block membership mismatch";
  const timestamp = Date.parse(row.timestamp);
  const blockTime = quantity(block.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    blockTime === null ||
    blockTime * 1000n !== BigInt(timestamp)
  )
    return "block timestamp mismatch";
  if (row.kind === "erc20") {
    if (!transferLogMatches(receipt, row, blockHash, hash, amount, from, to))
      return "ERC-20 Transfer log mismatch";
  } else if (
    row.asset.contract !== null ||
    row.asset.decimals !== 18 ||
    normalize(transaction.from, addressPattern) !== from ||
    normalize(
      transaction.to === null ? receipt.contractAddress : transaction.to,
      addressPattern,
    ) !== to ||
    quantity(transaction.value) !== amount
  ) {
    return "native transfer mismatch";
  }
  return null;
}

export function checkReceipts(proofs, drawn, events) {
  if (!Array.isArray(proofs)) throw new Error("Proofs must be an array");
  const byTransaction = new Map();
  for (const proof of proofs) {
    const hash = normalize(proof?.transaction?.hash, hashPattern);
    if (!hash || !Number.isSafeInteger(proof.chainId) || proof.chainId <= 0)
      throw new Error("Invalid transaction proof identity");
    const key = `${proof.chainId}:${hash}`;
    if (byTransaction.has(key))
      throw new Error(`Duplicate transaction proof: ${key}`);
    byTransaction.set(key, proof);
  }
  const unresolved = [];
  const verifiedMovements = new Set();
  for (const id of drawn) {
    const { transfer } = events.get(id);
    const hash = normalize(transfer?.hash, hashPattern);
    const reason = issue(
      transfer,
      byTransaction.get(`${transfer?.chainId}:${hash}`),
    );
    if (reason) {
      unresolved.push({ id, reason });
      continue;
    }
    const index = transfer.kind === "native" ? "0" : transfer.eventIndex;
    const movement = `${transfer.chainId}:${hash}:${transfer.kind}:${index}`;
    if (verifiedMovements.has(movement)) {
      unresolved.push({ id, reason: "duplicate displayed movement" });
      continue;
    }
    verifiedMovements.add(movement);
  }
  return { receiptVerified: drawn.size - unresolved.length, unresolved };
}
