import type {
  Address,
  TraceProvider,
  TraceQuery,
  Transfer,
  TransferPage,
} from "../src/domain/types.ts";
import {
  address,
  boundedJson,
  integer,
  ProviderError,
  row,
  tokenSymbol,
  uint,
  type Row,
} from "./history-provider.ts";

export { ProviderError };
const ENDPOINT = "https://api.etherscan.io/v2/api";
export const ETHERSCAN_CHAINS = [1, 42161];
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_RECEIPT_LOGS = 2_000;
const MAX_HISTORY_ROWS = 10_000;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WARNINGS = [
  "Internal transfers, NFTs, fees, bridge matches and labels are not covered by this adapter.",
  "Results are indexed provider evidence, not independent chain verification. Reorganizations and indexing gaps remain possible.",
  "Gross transfer flows are not buys, sells, profit, unique capital or proof of ownership.",
];
function maxHistoryPage(size: number): number {
  return Math.floor(MAX_HISTORY_ROWS / size);
}
function capWarning(stream: "native" | "erc20"): string {
  return `The ${stream} history stream reached Etherscan's ${MAX_HISTORY_ROWS.toLocaleString("en-US")}-row window; remaining history is unknown and requires another adapter.`;
}
function historyWindowLimit(stream: "native" | "erc20"): ProviderError {
  return new ProviderError(
    "HISTORY_WINDOW_LIMIT",
    `The ${stream} history stream reached Etherscan's ${MAX_HISTORY_ROWS.toLocaleString("en-US")}-row window; remaining history is unknown and no over-cap request was made.`,
    false,
  );
}
interface Cursor {
  v: 1;
  chain: number;
  address: string;
  size: number;
  end: number;
  native: number;
  token: number;
  nativeDone: boolean;
  tokenDone: boolean;
  provider?: string;
}
function decodeCursor(
  value: string,
  query: TraceQuery,
  size: number,
  provider?: string,
): Cursor {
  try {
    const maxPage = maxHistoryPage(size);
    const validPage = (page: number, done: boolean) =>
      Number.isSafeInteger(page) &&
      page >= 1 &&
      (page <= maxPage || (page === maxPage + 1 && !done));
    if (value.length > 1024) throw new Error();
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      cursor.v !== 1 ||
      cursor.chain !== query.chainId ||
      cursor.address !== query.address.toLowerCase() ||
      cursor.size !== size ||
      !Number.isSafeInteger(cursor.end) ||
      cursor.end < 0 ||
      !validPage(cursor.native, cursor.nativeDone) ||
      !validPage(cursor.token, cursor.tokenDone) ||
      typeof cursor.nativeDone !== "boolean" ||
      typeof cursor.tokenDone !== "boolean" ||
      (provider !== undefined && cursor.provider !== provider)
    )
      throw new Error();
    return cursor;
  } catch {
    throw new ProviderError(
      "INVALID_CURSOR",
      "Invalid cursor or cursor belongs to a different address, chain or page size.",
    );
  }
}
/** Allowlisted V2 history. Credentials never enter the evidence contract. */
export function createEtherscanProvider(
  options: {
    key?: string;
    fetch?: typeof fetch;
    intervalMs?: number;
    request?: EtherscanActionRequest;
    chains?: readonly number[];
    id?: string;
    source?: string;
    cursorProvider?: string;
    maxResponseBytes?: number;
    maxReceiptLogs?: number;
  } = {},
): TraceProvider {
  const fetcher = options.fetch ?? fetch;
  const key = options.key ?? process.env.ETHERSCAN_API_KEY ?? "";
  const interval = options.intervalMs ?? 1000;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;
  async function restRequest(
    chainId: number,
    parameters: Record<string, string>,
  ): Promise<Row> {
    const task = queue.then(async () => {
      const wait = Math.max(0, lastCall + interval - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastCall = Date.now();
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({
        chainid: String(chainId),
        apikey: key,
        ...parameters,
      }).toString();
      try {
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(12000),
          redirect: "error",
        });
        if (response.status === 429)
          throw new ProviderError(
            "RATE_LIMITED",
            "Provider rate limit reached; resume later using the saved cursor.",
            true,
          );
        if (!response.ok)
          throw new ProviderError(
            "PROVIDER_HTTP_ERROR",
            `Provider returned HTTP ${response.status}; no page was committed.`,
            response.status >= 500,
          );
        const body = row(await boundedJson(response, maxResponseBytes));
        if (body.error || body.status === "0") {
          const detail =
            `${body.message ?? ""} ${body.result ?? ""}`.toLowerCase();
          if (
            detail.includes("no transactions found") ||
            detail.includes("no records found")
          )
            return { status: "1", result: [] };
          if (detail.includes("rate limit"))
            throw new ProviderError(
              "RATE_LIMITED",
              "Provider rate limit reached; resume later using the saved cursor.",
              true,
            );
          if (
            /free api access|not supported.*chain|upgrade|invalid api key|missing.*api key|unauthorized|denied/.test(
              detail,
            )
          )
            throw new ProviderError(
              "ACCESS_DENIED",
              "Provider denied access for this key or chain. Check your permitted API plan; this is not evidence of no activity.",
            );
          throw new ProviderError(
            "PROVIDER_ERROR",
            "Provider rejected this request; no page was committed.",
          );
        }
        return body;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "NETWORK_ERROR",
          "Provider request failed or timed out; no page was committed. Resume later.",
          true,
        );
      }
    });
    queue = task.catch(() => undefined);
    return task;
  }
  const request = options.request ?? restRequest;
  const chains = options.chains ?? ETHERSCAN_CHAINS;
  const providerId = options.id ?? "etherscan-v2";
  const sourceName = options.source ?? "Etherscan V2";
  const cursorProvider = options.cursorProvider;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxReceiptLogs = options.maxReceiptLogs ?? DEFAULT_MAX_RECEIPT_LOGS;
  async function fetchPage(query: TraceQuery): Promise<TransferPage> {
    if (!options.request && !key)
      throw new ProviderError(
        "KEY_REQUIRED",
        "Set ETHERSCAN_API_KEY in the local server environment to enable live tracing.",
      );
    if (!chains.includes(query.chainId))
      throw new ProviderError(
        "UNSUPPORTED_CHAIN",
        "Live tracing supports Ethereum (1) and Arbitrum One (42161) only in this slice. Base, BSC and Optimism history may require a paid provider plan and are not enabled.",
      );
    const wallet = address(query.address);
    let size = query.pageSize ?? 10;
    if (query.cursor && query.pageSize === undefined) {
      try {
        size = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString("utf8"),
        ).size;
      } catch {
        /* decodeCursor reports the boundary error below. */
      }
    }
    if (!Number.isInteger(size) || size < 1 || size > 10)
      throw new ProviderError(
        "INVALID_PAGE_SIZE",
        "Live page size must be an integer from 1 to 10 rows per stream.",
      );
    let cursor: Cursor;
    if (query.cursor)
      cursor = decodeCursor(query.cursor, query, size, cursorProvider);
    else {
      const anchor = await request(query.chainId, {
        module: "proxy",
        action: "eth_blockNumber",
      });
      if (
        typeof anchor.result !== "string" ||
        !/^0x[0-9a-f]+$/i.test(anchor.result)
      )
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          "Provider did not return a valid block anchor.",
        );
      cursor = {
        v: 1,
        chain: query.chainId,
        address: wallet,
        size,
        end: integer(BigInt(anchor.result)),
        native: 1,
        token: 1,
        nativeDone: false,
        tokenDone: false,
        ...(cursorProvider ? { provider: cursorProvider } : {}),
      };
    }
    const warnings = [
      ...WARNINGS,
      `Frozen history window: block 0 through ${cursor.end}; newer blocks require a new investigation.`,
    ];
    const transfers: Transfer[] = [];
    const retrievedAt = new Date().toISOString();
    const maxPage = maxHistoryPage(size);
    const history = async (action: string, page: number): Promise<Row[]> => {
      const stream = action === "txlist" ? "native" : "erc20";
      if (page > maxPage) throw historyWindowLimit(stream);
      const result = await request(query.chainId, {
        module: "account",
        action,
        address: wallet,
        startblock: "0",
        endblock: String(cursor.end),
        sort: "desc",
        page: String(page),
        offset: String(size),
      });
      if (!Array.isArray(result.result) || result.result.length > size)
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          "Provider returned an invalid history page.",
        );
      const records = result.result.map(row);
      for (const record of records) {
        if (integer(record.blockNumber) > cursor.end)
          throw new ProviderError(
            "INVALID_PROVIDER_DATA",
            "Provider returned a history row beyond the frozen block window.",
          );
      }
      return records;
    };
    const make = (
      record: Row,
      kind: "native" | "erc20",
      eventIndex: string,
      amount: string,
      contract: Address | null,
      decimals: number,
      symbol: string,
      from: Address,
      to: Address,
    ): Transfer => {
      if (typeof record.hash !== "string" || !HASH.test(record.hash))
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          "Provider returned a malformed transaction hash.",
        );
      const timestamp = new Date(
        integer(record.timeStamp, 8640000000000) * 1000,
      ).toISOString();
      return {
        id: `${query.chainId}:${record.hash.toLowerCase()}:${kind}:${eventIndex}:${contract ?? "native"}`,
        chainId: query.chainId,
        hash: record.hash.toLowerCase(),
        kind,
        eventIndex,
        from,
        to,
        asset: { chainId: query.chainId, contract, decimals, symbol },
        rawAmount: amount,
        timestamp,
        blockNumber: integer(record.blockNumber),
        status: "success",
        source: sourceName,
        retrievedAt,
      };
    };
    if (!cursor.nativeDone) {
      const nativePage = cursor.native;
      const records = await history("txlist", nativePage);
      for (const record of records) {
        if (
          record.isError === "1" ||
          record.txreceipt_status === "0" ||
          record.value === "0"
        )
          continue;
        try {
          if (record.isError !== "0" && record.txreceipt_status !== "1")
            throw new Error();
          const from = address(record.from);
          const to = address(record.to || record.contractAddress);
          if (from !== wallet && to !== wallet) throw new Error();
          transfers.push(
            make(
              record,
              "native",
              "0",
              uint(record.value),
              null,
              18,
              "ETH",
              from,
              to,
            ),
          );
        } catch {
          warnings.push(
            "A malformed or unconfirmed native provider row was omitted.",
          );
        }
      }
      cursor.nativeDone = records.length < size;
      if (!cursor.nativeDone) cursor.native++;
      if (!cursor.nativeDone && nativePage === maxPage)
        warnings.push(capWarning("native"));
    }
    if (!cursor.tokenDone) {
      const tokenPage = cursor.token;
      const records = await history("tokentx", tokenPage);
      const byHash = new Map<string, Row[]>();
      for (const record of records) {
        if (typeof record.hash !== "string" || !HASH.test(record.hash)) {
          warnings.push("A malformed token provider row was omitted.");
          continue;
        }
        const hash = record.hash.toLowerCase();
        byHash.set(hash, [...(byHash.get(hash) ?? []), record]);
      }
      // History omits logIndex. Receipts supply canonical event identities.
      for (const [hash, metadata] of byHash) {
        const receipt = row(
          (
            await request(query.chainId, {
              module: "proxy",
              action: "eth_getTransactionReceipt",
              txhash: hash,
            })
          ).result,
        );
        if (
          !["0x0", "0x1"].includes(String(receipt.status)) ||
          !Array.isArray(receipt.logs)
        )
          throw new ProviderError(
            "RECEIPT_UNAVAILABLE",
            "A required token receipt is not available; no page was committed. Resume later using the saved cursor.",
            true,
          );
        const mismatch = () =>
          new ProviderError(
            "RECEIPT_MISMATCH",
            "Token receipt identity does not match the requested history transaction and block; no page was committed. Resume after provider indexing stabilizes.",
            true,
          );
        let receiptBlock: number;
        try {
          if (
            typeof receipt.transactionHash !== "string" ||
            receipt.transactionHash.toLowerCase() !== hash ||
            typeof receipt.blockNumber !== "string" ||
            !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)
          )
            throw new Error();
          receiptBlock = integer(BigInt(receipt.blockNumber));
          if (
            receiptBlock > cursor.end ||
            metadata.some(
              (record) => integer(uint(record.blockNumber)) !== receiptBlock,
            )
          )
            throw new Error();
        } catch {
          throw mismatch();
        }
        if (receipt.status === "0x0") continue;
        if (receipt.logs.length > maxReceiptLogs)
          throw new ProviderError(
            "RECEIPT_TOO_LARGE",
            "A token receipt exceeds the bounded log budget; this page needs another adapter.",
          );
        for (const rawLog of receipt.logs) {
          const log = row(rawLog);
          // Identity errors are page failures, not malformed-event omissions: otherwise the cursor could skip missing evidence.
          try {
            if (
              log.removed === true ||
              (log.transactionHash !== undefined &&
                (typeof log.transactionHash !== "string" ||
                  log.transactionHash.toLowerCase() !== hash))
            )
              throw new Error();
            if (
              log.blockNumber !== undefined &&
              (typeof log.blockNumber !== "string" ||
                !/^0x[0-9a-f]+$/i.test(log.blockNumber) ||
                integer(BigInt(log.blockNumber)) !== receiptBlock)
            )
              throw new Error();
          } catch {
            throw mismatch();
          }
          try {
            const topics = log.topics;
            if (
              !Array.isArray(topics) ||
              topics.length !== 3 ||
              topics[0] !== TRANSFER_TOPIC
            )
              continue;
            if (
              !topics
                .slice(1)
                .every(
                  (t) =>
                    typeof t === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(t),
                )
            )
              throw new Error();
            const from = address(`0x${topics[1].slice(-40)}`);
            const to = address(`0x${topics[2].slice(-40)}`);
            if (from !== wallet && to !== wallet) continue;
            const contract = address(log.address);
            const meta = metadata.find(
              (m) => String(m.contractAddress).toLowerCase() === contract,
            );
            if (!meta) {
              warnings.push(
                "A receipt token without metadata on this history page was omitted.",
              );
              continue;
            }
            if (
              typeof log.data !== "string" ||
              !/^0x[0-9a-f]{1,64}$/i.test(log.data) ||
              typeof log.logIndex !== "string" ||
              !/^0x[0-9a-f]+$/i.test(log.logIndex)
            )
              throw new Error();
            transfers.push(
              make(
                meta,
                "erc20",
                BigInt(log.logIndex).toString(),
                BigInt(log.data).toString(),
                contract,
                integer(meta.tokenDecimal, 255),
                tokenSymbol(meta.tokenSymbol),
                from,
                to,
              ),
            );
          } catch {
            warnings.push("A malformed ERC20 receipt log was omitted.");
          }
        }
      }
      cursor.tokenDone = records.length < size;
      if (!cursor.tokenDone) cursor.token++;
      if (!cursor.tokenDone && tokenPage === maxPage)
        warnings.push(capWarning("erc20"));
    }
    const exhausted = cursor.nativeDone && cursor.tokenDone;
    if (exhausted)
      warnings.push(
        "Configured history streams returned terminal pages; omitted streams remain uncovered. This does not establish complete wallet history.",
      );
    const observed = new Map<string, Transfer>();
    for (const transfer of transfers) {
      const previous = observed.get(transfer.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(transfer))
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          "Provider returned conflicting facts for one canonical event; no page was committed.",
        );
      observed.set(transfer.id, transfer);
    }
    const unique = [...observed.values()];
    const nodes = [...new Set(unique.flatMap((t) => [t.from, t.to]))].map(
      (address) => ({ address, chainId: query.chainId }),
    );
    return {
      transfers: unique,
      nodes,
      cursor: exhausted
        ? null
        : Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      warnings: [...new Set(warnings)],
      streams: ["native", "erc20"],
      exhausted,
    };
  }
  return { id: providerId, mode: "live", fetchPage };
}

export type EtherscanActionRequest = (
  chainId: number,
  parameters: Record<string, string>,
) => Promise<Row>;
