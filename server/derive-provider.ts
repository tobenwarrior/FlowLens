import { boundedJson, ProviderError } from "./history-provider.ts";

const API = "https://api.derive.xyz/v3/public";
const MAX_BYTES = 2_000_000;
const DEADLINE_MS = 12_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
let nextRequestAt = 0;

type AccountQuery = { kind: "account"; wallet: string };
type MarginQuery = { kind: "margin"; subaccountId: number };
type TradesQuery = {
  kind: "trades";
  subaccountId: number;
  page: number;
  pageSize: number;
  toTimestamp: number;
};
export type DeriveQuery = AccountQuery | MarginQuery | TradesQuery;
type Scalar = string | number | boolean | null;
type ProviderRecord = Record<string, Scalar>;
type AccountData = { wallet: string; subaccount_ids: number[] };
type MarginData = {
  [key: string]: unknown;
  subaccount_id: number;
  currency: string[];
  subaccount_value: string;
  valuation_timestamp: number;
  positions: ProviderRecord[];
  collaterals: ProviderRecord[];
};
type Trade = ProviderRecord & {
  trade_id: string;
  instrument_name: string;
  timestamp: number;
  trade_price: string;
  trade_amount: string;
  direction: string;
  wallet: string;
  subaccount_id: number;
};
type TradesData = {
  trades: Trade[];
  pagination: { num_pages: number; count: number };
};
type Coverage = {
  status: "complete" | "partial" | "snapshot";
  scope: string;
  page?: number;
  pageSize?: number;
  toTimestamp?: number;
  returned?: number;
  nextPage: number | null;
  nextQuery?: TradesQuery;
  terminalPage?: boolean;
};
type ResultBase = {
  version: 1;
  source: "Derive public API";
  sourceUrl: string;
  retrievedAt: string;
  httpStatus: number;
  request: {
    method: "POST";
    url: string;
    parameters: Record<string, string | number>;
  };
};
export type DeriveInspectionResult =
  | (ResultBase & { kind: "account"; data: AccountData; coverage: Coverage })
  | (ResultBase & { kind: "margin"; data: MarginData; coverage: Coverage })
  | (ResultBase & { kind: "trades"; data: TradesData; coverage: Coverage });
export type DeriveFetch = typeof fetch;
export interface DeriveInspectionOptions {
  fetch?: DeriveFetch;
  signal?: AbortSignal;
}

export function parseDeriveQuery(input: unknown): DeriveQuery {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProviderError(
      "INVALID_ARGUMENT",
      "Derive query must be an object.",
    );
  const value = input as Record<string, unknown>;
  if (value.kind === "account") {
    if (Object.keys(value).some((key) => !["kind", "wallet"].includes(key)))
      throw new ProviderError(
        "INVALID_ARGUMENT",
        "Unsupported Derive account query field.",
      );
    if (typeof value.wallet !== "string" || !ADDRESS.test(value.wallet))
      throw new ProviderError(
        "INVALID_ARGUMENT",
        "wallet must be a valid EVM address.",
      );
    return { kind: "account", wallet: value.wallet.toLowerCase() };
  }
  if (value.kind !== "margin" && value.kind !== "trades")
    throw new ProviderError(
      "INVALID_ARGUMENT",
      "kind must be account, margin or trades.",
    );
  const allowed =
    value.kind === "margin"
      ? ["kind", "subaccountId"]
      : ["kind", "subaccountId", "page", "pageSize", "toTimestamp"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ProviderError(
      "INVALID_ARGUMENT",
      "Unsupported Derive query field.",
    );
  const subaccountId = positiveInteger(
    value.subaccountId,
    "subaccountId",
    Number.MAX_SAFE_INTEGER,
  );
  if (value.kind === "margin") return { kind: "margin", subaccountId };
  return {
    kind: "trades",
    subaccountId,
    page:
      value.page === undefined
        ? 1
        : positiveInteger(value.page, "page", Number.MAX_SAFE_INTEGER),
    pageSize:
      value.pageSize === undefined
        ? 100
        : positiveInteger(value.pageSize, "pageSize", 100),
    toTimestamp:
      value.toTimestamp === undefined
        ? Date.now()
        : nonNegativeInteger(value.toTimestamp, "toTimestamp"),
  };
}

function positiveInteger(value: unknown, name: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new ProviderError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer no greater than ${max}.`,
    );
  return value;
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      `Derive returned an invalid ${name}.`,
    );
  return value as Record<string, unknown>;
}
function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      `Derive returned an invalid ${name}.`,
    );
  return value;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      `Derive returned an invalid ${name}.`,
    );
  return value;
}
function pick(value: unknown, keys: readonly string[]): ProviderRecord {
  const source = record(value, "record"),
    selected: ProviderRecord = {};
  for (const key of keys) {
    const item = source[key];
    if (item === undefined) continue;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      typeof item === "number"
    )
      selected[key] = item;
    else
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive returned an invalid record field.",
      );
  }
  return selected;
}
const MARGIN_FIELDS = [
  "subaccount_id",
  "risk_universe_id",
  "margin_type",
  "subaccount_value",
  "maintenance_margin",
  "initial_margin",
  "is_delayed_liquidation",
  "has_delayed_liquidation",
  "regular_margin_flagged_sec",
  "valuation_timestamp",
] as const;
const POSITION_FIELDS = [
  "instrument_type",
  "instrument_name",
  "amount",
  "average_price",
  "average_price_excl_fees",
  "mark_price",
  "index_price",
  "mark_value",
  "amount_step",
  "creation_timestamp",
  "cumulative_funding",
  "pending_funding",
  "net_settlements",
  "initial_margin",
  "maintenance_margin",
  "open_orders_margin",
  "realized_pnl",
  "realized_pnl_excl_fees",
  "total_fees",
  "unrealized_pnl",
  "unrealized_pnl_excl_fees",
  "delta",
  "gamma",
  "vega",
  "theta",
  "leverage",
  "liquidation_price",
] as const;
const COLLATERAL_FIELDS = [
  "amount",
  "amount_step",
  "asset_name",
  "asset_type",
  "average_price",
  "average_price_excl_fees",
  "creation_timestamp",
  "cumulative_interest",
  "currency",
  "delta",
  "delta_currency",
  "initial_margin",
  "maintenance_margin",
  "mark_price",
  "mark_value",
  "open_orders_margin",
  "pending_interest",
  "realized_pnl",
  "realized_pnl_excl_fees",
  "total_fees",
  "unrealized_pnl",
  "unrealized_pnl_excl_fees",
] as const;
const TRADE_FIELDS = [
  "trade_id",
  "instrument_name",
  "timestamp",
  "trade_price",
  "trade_amount",
  "mark_price",
  "index_price",
  "direction",
  "quote_id",
  "rfq_id",
  "wallet",
  "subaccount_id",
  "batch_status",
  "tx_hash",
  "trade_fee",
  "expected_rebate",
  "liquidity_role",
  "realized_pnl",
  "realized_pnl_excl_fees",
  "extra_fee",
] as const;

async function pace(signal: AbortSignal): Promise<void> {
  const turn = pacingQueue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > DEADLINE_MS)
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        "Derive request deadline exceeded.",
        true,
      );
    if (wait)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        const abort = () => {
          clearTimeout(timer);
          reject(
            new ProviderError(
              "PROVIDER_TIMEOUT",
              "Derive request deadline exceeded.",
              true,
            ),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    if (signal.aborted)
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        "Derive request deadline exceeded.",
        true,
      );
    nextRequestAt = Date.now() + 1000;
  });
  pacingQueue = turn.catch(() => undefined);
  return turn;
}
async function acquire(
  query: DeriveQuery,
  fetcher: DeriveFetch,
  externalSignal?: AbortSignal,
) {
  const method =
    query.kind === "account"
      ? "get_subaccounts"
      : query.kind === "margin"
        ? "margin_watch"
        : "get_trade_history";
  const url = `${API}/${method}`;
  const parameters: Record<string, string | number> =
    query.kind === "account"
      ? { wallet: query.wallet }
      : query.kind === "margin"
        ? { subaccount_id: query.subaccountId }
        : {
            subaccount_id: query.subaccountId,
            page: query.page,
            page_size: query.pageSize,
            to_timestamp: query.toTimestamp,
          };
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    await pace(signal);
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(parameters),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403)
        throw new ProviderError(
          "PROVIDER_ACCESS_DENIED",
          "Derive public API denied this request; no retry or fallback was attempted.",
        );
      throw new ProviderError(
        "PROVIDER_HTTP_ERROR",
        `Derive returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    const body = await boundedJson(response, MAX_BYTES);
    const envelope = record(body, "response");
    if (envelope.error !== undefined)
      throw new ProviderError(
        "PROVIDER_ERROR",
        "Derive public API returned an error.",
      );
    return {
      url,
      parameters,
      value: envelope.result ?? body,
      httpStatus: response.status,
      retrievedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (externalSignal?.aborted)
      throw new ProviderError(
        "PROVIDER_ABORTED",
        "Derive request was cancelled.",
      );
    if (controller.signal.aborted)
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        "Derive request deadline exceeded.",
        true,
      );
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "Derive public API request failed.",
      true,
    );
  } finally {
    clearTimeout(deadline);
  }
}

export async function inspectDerive(
  input: unknown,
  options: DeriveInspectionOptions = {},
): Promise<DeriveInspectionResult> {
  const query = parseDeriveQuery(input);
  const { url, parameters, value, retrievedAt, httpStatus } = await acquire(
    query,
    options.fetch ?? fetch,
    options.signal,
  );
  const base: ResultBase = {
    version: 1,
    source: "Derive public API",
    sourceUrl: url,
    retrievedAt,
    httpStatus,
    request: { method: "POST", url, parameters },
  };
  if (query.kind === "account") {
    const data = record(value, "account result");
    if (!Array.isArray(data.subaccount_ids))
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive account response omitted subaccount_ids.",
      );
    const wallet = requiredString(data.wallet, "account wallet").toLowerCase();
    if (wallet !== query.wallet)
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive account response wallet did not match the request.",
      );
    return {
      ...base,
      kind: "account",
      data: {
        wallet,
        subaccount_ids: data.subaccount_ids.map((id) =>
          safeInteger(id, "subaccount ID"),
        ),
      },
      coverage: {
        status: "complete",
        scope:
          "provider-reported wallet/subaccount association; not chain control or beneficial ownership",
        returned: data.subaccount_ids.length,
        nextPage: null,
      },
    };
  }
  if (query.kind === "margin") {
    const data = record(value, "margin result");
    if (!Array.isArray(data.positions) || !Array.isArray(data.collaterals))
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive margin response omitted positions or collaterals.",
      );
    const selected = pick(data, MARGIN_FIELDS);
    validateExactFields(
      selected,
      ["subaccount_value", "maintenance_margin", "initial_margin"],
      ["subaccount_id", "risk_universe_id", "valuation_timestamp"],
      ["margin_type"],
      ["is_delayed_liquidation", "has_delayed_liquidation"],
      [],
      ["regular_margin_flagged_sec"],
    );
    if (
      !Array.isArray(data.currency) ||
      data.currency.some((item) => typeof item !== "string")
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive returned an invalid currency list.",
      );
    if (
      selected.subaccount_id !== query.subaccountId ||
      typeof selected.valuation_timestamp !== "number"
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive margin response omitted or mismatched snapshot fields.",
      );
    return {
      ...base,
      kind: "margin",
      data: {
        ...selected,
        currency: data.currency as string[],
        subaccount_id: selected.subaccount_id as number,
        subaccount_value: requiredString(
          selected.subaccount_value,
          "subaccount_value",
        ),
        valuation_timestamp: selected.valuation_timestamp,
        positions: data.positions.map((item) => {
          const position = pick(item, POSITION_FIELDS);
          validateExactFields(
            position,
            [
              "amount",
              "average_price",
              "average_price_excl_fees",
              "mark_price",
              "index_price",
              "mark_value",
              "amount_step",
              "cumulative_funding",
              "pending_funding",
              "net_settlements",
              "initial_margin",
              "maintenance_margin",
              "open_orders_margin",
              "realized_pnl",
              "realized_pnl_excl_fees",
              "total_fees",
              "unrealized_pnl",
              "unrealized_pnl_excl_fees",
              "delta",
              "gamma",
              "vega",
              "theta",
            ],
            ["creation_timestamp"],
            ["instrument_type", "instrument_name"],
            [],
            ["leverage", "liquidation_price"],
          );
          return position;
        }),
        collaterals: data.collaterals.map((item) => {
          const collateral = pick(item, COLLATERAL_FIELDS);
          validateExactFields(
            collateral,
            [
              "amount",
              "amount_step",
              "average_price",
              "average_price_excl_fees",
              "cumulative_interest",
              "delta",
              "initial_margin",
              "maintenance_margin",
              "mark_price",
              "mark_value",
              "open_orders_margin",
              "pending_interest",
              "realized_pnl",
              "realized_pnl_excl_fees",
              "total_fees",
              "unrealized_pnl",
              "unrealized_pnl_excl_fees",
            ],
            ["creation_timestamp"],
            ["asset_name", "asset_type", "currency", "delta_currency"],
          );
          return collateral;
        }),
      },
      coverage: {
        status: "snapshot",
        scope:
          "single provider-calculated margin snapshot; values are not cash or graph totals",
        returned: data.positions.length,
        nextPage: null,
      },
    };
  }
  const data = record(value, "trades result");
  const pagination = record(data.pagination, "trade pagination");
  if (!Array.isArray(data.trades))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Derive trade response omitted trades.",
    );
  const numPages = safeInteger(pagination.num_pages, "num_pages");
  const count = safeInteger(pagination.count, "count");
  if (data.trades.length > query.pageSize || data.trades.length > count)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Derive trade page exceeds its declared count or requested page size.",
    );
  if (
    (numPages === 0) !== (count === 0) ||
    (count === 0 && data.trades.length !== 0)
  )
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Derive trade pagination count is inconsistent.",
    );
  if (query.page > (numPages === 0 ? 1 : numPages))
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Derive returned pagination before the requested page.",
    );
  if (count > 0 && data.trades.length === 0)
    throw new ProviderError(
      "INVALID_PROVIDER_DATA",
      "Derive returned no rows for a nonempty trade page.",
    );
  const trades = data.trades.map((item) => {
    const selected = pick(item, TRADE_FIELDS);
    validateExactFields(
      selected,
      ["trade_price", "trade_amount", "trade_fee"],
      ["timestamp", "subaccount_id"],
      ["trade_id", "instrument_name", "direction", "wallet"],
      [],
      [
        "mark_price",
        "index_price",
        "expected_rebate",
        "realized_pnl",
        "realized_pnl_excl_fees",
        "extra_fee",
      ],
      ["quote_id", "rfq_id"],
    );
    if (
      selected.subaccount_id !== query.subaccountId ||
      typeof selected.timestamp !== "number" ||
      selected.timestamp > query.toTimestamp
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive trade row has mismatched identifiers or exceeds the timestamp fence.",
      );
    if (selected.direction !== "buy" && selected.direction !== "sell")
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive returned an invalid trade direction.",
      );
    if (typeof selected.wallet !== "string" || !ADDRESS.test(selected.wallet))
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive returned an invalid trade wallet.",
      );
    for (const key of ["liquidity_role", "tx_hash"] as const) {
      if (selected[key] !== undefined && typeof selected[key] !== "string")
        throw new ProviderError(
          "INVALID_PROVIDER_DATA",
          `Derive returned an invalid ${key}.`,
        );
    }
    if (
      selected.batch_status !== undefined &&
      selected.batch_status !== null &&
      typeof selected.batch_status !== "string"
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        "Derive returned an invalid batch_status.",
      );
    return selected as Trade;
  });
  const terminalPage = query.page >= numPages;
  const nextPage = query.page < numPages ? query.page + 1 : null;
  return {
    ...base,
    kind: "trades",
    data: { trades, pagination: { num_pages: numPages, count } },
    coverage: {
      status:
        query.page === 1 && terminalPage && trades.length === count
          ? "complete"
          : "partial",
      scope:
        "one requested page; prior pages are unobserved unless this is page 1 of 1",
      page: query.page,
      pageSize: query.pageSize,
      toTimestamp: query.toTimestamp,
      terminalPage,
      returned: trades.length,
      nextPage,
      ...(nextPage === null
        ? {}
        : {
            nextQuery: {
              kind: "trades",
              subaccountId: query.subaccountId,
              page: nextPage,
              pageSize: query.pageSize,
              toTimestamp: query.toTimestamp,
            },
          }),
    },
  };
}
let pacingQueue: Promise<void> = Promise.resolve();
function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProviderError(
      "INVALID_ARGUMENT",
      `${name} must be a nonnegative safe integer.`,
    );
  return value;
}
function validateExactFields(
  value: Record<string, unknown>,
  decimalFields: readonly string[],
  integerFields: readonly string[] = [],
  stringFields: readonly string[] = [],
  booleanFields: readonly string[] = [],
  nullableDecimalFields: readonly string[] = [],
  nullableIntegerFields: readonly string[] = [],
): void {
  const decimalPattern = /^-?[0-9]+(?:[.][0-9]+)?$/;
  for (const key of decimalFields) {
    if (
      typeof value[key] !== "string" ||
      !decimalPattern.test(value[key] as string)
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        `Derive returned an invalid decimal field: ${key}.`,
      );
  }
  for (const key of nullableDecimalFields) {
    const field = value[key];
    if (
      field !== undefined &&
      field !== null &&
      (typeof field !== "string" || !decimalPattern.test(field))
    )
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        `Derive returned an invalid nullable decimal field: ${key}.`,
      );
  }
  for (const key of integerFields) safeInteger(value[key], key);
  for (const key of nullableIntegerFields) {
    const field = value[key];
    if (field !== null && field !== undefined) safeInteger(field, key);
  }
  for (const key of stringFields) requiredString(value[key], key);
  for (const key of booleanFields) {
    if (typeof value[key] !== "boolean")
      throw new ProviderError(
        "INVALID_PROVIDER_DATA",
        `Derive returned an invalid boolean field: ${key}.`,
      );
  }
}
