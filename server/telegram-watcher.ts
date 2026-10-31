import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Address,
  TraceProvider,
  Transfer,
  TransferKind,
  TransferPage,
} from "../src/domain/types.ts";
import { createBlockscoutProvider } from "./blockscout.ts";
import {
  decimalProduct,
  fetchTokenBalance,
  fetchTokenQuote,
  fetchWalletValuation,
  priceForAsset,
  type WalletValuationSnapshot,
} from "./telegram-valuation.ts";

const ETHEREUM_CHAIN_ID = 1;
const PAGE_SIZE = 10;
const MAX_PAGES = 2;
const MAX_SEEN = 10_000;
const MAX_RECENT_OUTGOING_HASHES = 2_000;
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const DEFAULT_PROVIDER_INTERVAL_MS = 500;
const MIN_PROVIDER_INTERVAL_MS = 500;
const MAX_PROVIDER_INTERVAL_MS = 10_000;
const DEFAULT_MAX_ALERT_AGE_MS = 120_000;
const MAX_MAX_ALERT_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_INFLOW_USD = "1000";
const MAX_MIN_INFLOW_USD_LENGTH = 64;
const DEFAULT_ALERT_KINDS: TransferKind[] = ["native", "erc20", "internal"];
const HEALTH_RETRY_MS = 5 * 60_000;
const MAX_PRICE_LENGTH = 128;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface WalletWatchState {
  seen: string[];
  recentOutgoingHashes: string[];
  bootstrapped: boolean;
  // These anchors stay small and survive seen-set pruning. They let a pending
  // cursor prove that each active stream reached a row already observed.
  anchors: Partial<Record<TransferKind, string>>;
  pendingCursor?: string;
  pendingKinds: TransferKind[];
  activeHealthFingerprint?: string;
  notifiedHealthFingerprint?: string;
  lastHealthAttemptAt?: string;
}

export interface WatchState {
  version: 1;
  wallets: Record<string, WalletWatchState>;
}

export interface WatchConfig {
  addresses: Address[];
  chainId: number;
  maxAlertAgeMs?: number;
  minInflowUsd?: string;
  alertKinds?: TransferKind[];
}

export interface PollResult {
  state: WatchState;
  alerts: string[];
  outflows: Outflow[];
  flows: FlowEvent[];
  warnings: string[];
  errors: string[];
  health: HealthEvent[];
}

export interface Outflow {
  wallet: Address;
  transfer: Transfer;
  direction: "outflow";
}

export interface FlowEvent {
  wallet: Address;
  transfer: Transfer;
  direction: "inflow" | "outflow" | "self";
}

export interface AlertValuation {
  approxUsd: string | null;
  remainingAmount: string | null;
  remainingSymbol: string | null;
  remainingUsd?: string | null;
  trackedEthereumTotal?: {
    status: "complete" | "partial" | "unavailable";
    amount: string | null;
    symbol: string;
    usd: string | null;
  };
  totalPricedUsd: string;
  pricedAssets: number;
  unpricedAssets: number;
}

export interface HealthEvent {
  wallet: Address;
  impaired: boolean;
  fingerprint?: string;
  detail?: string;
}

export interface HealthNotification {
  wallet: Address;
  kind: "impaired" | "recovered";
  fingerprint?: string;
  text: string;
}

export function createInitialState(addresses: Address[]): WatchState {
  const wallets: Record<string, WalletWatchState> = {};
  for (const wallet of addresses)
    wallets[wallet.toLowerCase()] = {
      seen: [],
      recentOutgoingHashes: [],
      bootstrapped: false,
      anchors: {},
      pendingKinds: [],
    };
  return { version: 1, wallets };
}

function canonicalAddress(value: string): Address {
  if (!ADDRESS.test(value)) throw new Error(`Invalid EVM address: ${value}`);
  return value.toLowerCase() as Address;
}

function parseAddresses(value: string): Address[] {
  const addresses = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(canonicalAddress);
  if (!addresses.length)
    throw new Error(
      "FLOWLENS_WATCH_ADDRESSES must contain at least one address",
    );
  return [...new Set(addresses)];
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`Expected a non-negative integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Integer is out of range: ${value}`);
  return parsed;
}

function parseDecimalConfig(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  if (value === undefined || value === "") return fallback;
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    value.length > MAX_MIN_INFLOW_USD_LENGTH
  )
    throw new Error(`${name} must be a non-negative decimal`);
  return canonicalDecimal(value);
}

function parseAlertKinds(value: string | undefined): TransferKind[] {
  if (value === undefined || value.trim() === "")
    return [...DEFAULT_ALERT_KINDS];
  const kinds = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (kinds.length === 1 && kinds[0] === "none") return [];
  const allowed = new Set<TransferKind>(DEFAULT_ALERT_KINDS);
  if (!kinds.length || kinds.some((kind) => !allowed.has(kind as TransferKind)))
    throw new Error(
      "FLOWLENS_WATCH_ALERT_KINDS must contain only native, erc20, internal, or none",
    );
  return [...new Set(kinds)] as TransferKind[];
}

export interface EnvironmentConfig extends WatchConfig {
  token: string;
  chatId: string;
  stateFile: string;
  intervalMs: number;
  providerIntervalMs: number;
  maxAlertAgeMs: number;
  minInflowUsd: string;
  alertKinds: TransferKind[];
}

export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentConfig {
  const addressText =
    env.FLOWLENS_WATCH_ADDRESSES ?? env.FLOWLENS_WATCH_ADDRESS;
  if (!addressText) throw new Error("FLOWLENS_WATCH_ADDRESSES is required");
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is required");
  const chainId = parseInteger(env.FLOWLENS_WATCH_CHAIN_ID, ETHEREUM_CHAIN_ID);
  if (chainId !== ETHEREUM_CHAIN_ID)
    throw new Error(
      "The Telegram watcher currently supports Ethereum (chain 1) only",
    );
  const intervalMs = parseInteger(
    env.FLOWLENS_WATCH_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)
    throw new Error(
      `FLOWLENS_WATCH_INTERVAL_MS must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
    );
  const providerIntervalMs = parseInteger(
    env.FLOWLENS_WATCH_PROVIDER_INTERVAL_MS,
    DEFAULT_PROVIDER_INTERVAL_MS,
  );
  if (
    providerIntervalMs < MIN_PROVIDER_INTERVAL_MS ||
    providerIntervalMs > MAX_PROVIDER_INTERVAL_MS
  )
    throw new Error(
      `FLOWLENS_WATCH_PROVIDER_INTERVAL_MS must be between ${MIN_PROVIDER_INTERVAL_MS} and ${MAX_PROVIDER_INTERVAL_MS}`,
    );
  const maxAlertAgeMs = parseInteger(
    env.FLOWLENS_WATCH_MAX_ALERT_AGE_MS,
    DEFAULT_MAX_ALERT_AGE_MS,
  );
  if (maxAlertAgeMs > MAX_MAX_ALERT_AGE_MS)
    throw new Error(
      `FLOWLENS_WATCH_MAX_ALERT_AGE_MS must be between 0 and ${MAX_MAX_ALERT_AGE_MS}`,
    );
  const minInflowUsd = parseDecimalConfig(
    env.FLOWLENS_WATCH_MIN_INFLOW_USD,
    DEFAULT_MIN_INFLOW_USD,
    "FLOWLENS_WATCH_MIN_INFLOW_USD",
  );
  const alertKinds = parseAlertKinds(env.FLOWLENS_WATCH_ALERT_KINDS);
  return {
    addresses: parseAddresses(addressText),
    chainId,
    token,
    chatId,
    stateFile: resolve(
      env.FLOWLENS_WATCH_STATE_FILE ?? ".local/telegram-watcher.json",
    ),
    intervalMs,
    providerIntervalMs,
    maxAlertAgeMs,
    minInflowUsd,
    alertKinds,
  };
}

function normalizeState(value: unknown, addresses: Address[]): WatchState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Watcher state must be an object");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !raw.wallets ||
    typeof raw.wallets !== "object" ||
    Array.isArray(raw.wallets)
  )
    throw new Error("Unsupported watcher state version");
  const source = raw.wallets as Record<string, unknown>;
  const state = createInitialState(addresses);
  for (const address of addresses) {
    const item = source[address.toLowerCase()];
    if (item === undefined) continue;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Malformed watcher wallet state");
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.bootstrapped !== "boolean" ||
      !Array.isArray(candidate.seen)
    )
      throw new Error("Malformed watcher wallet state");
    if (candidate.seen.some((id) => typeof id !== "string" || id.length > 300))
      throw new Error("Malformed watcher event identity");
    const rawAnchors = candidate.anchors;
    if (
      rawAnchors !== undefined &&
      (!rawAnchors ||
        typeof rawAnchors !== "object" ||
        Array.isArray(rawAnchors))
    )
      throw new Error("Malformed watcher stream anchors");
    const anchors: Partial<Record<TransferKind, string>> = {};
    for (const kind of ["native", "erc20", "internal"] as const) {
      const anchor = (rawAnchors as Record<string, unknown> | undefined)?.[
        kind
      ];
      if (anchor !== undefined) {
        if (typeof anchor !== "string" || anchor.length > 300)
          throw new Error("Malformed watcher stream anchor");
        anchors[kind] = anchor;
      }
    }
    const pendingKinds = candidate.pendingKinds ?? [];
    if (
      !Array.isArray(pendingKinds) ||
      pendingKinds.some(
        (kind) => !["native", "erc20", "internal"].includes(kind as string),
      )
    )
      throw new Error("Malformed watcher pending streams");
    const pendingCursor = candidate.pendingCursor;
    if (
      pendingCursor !== undefined &&
      (typeof pendingCursor !== "string" || pendingCursor.length > 4096)
    )
      throw new Error("Malformed watcher pending cursor");
    const recentOutgoingHashes = candidate.recentOutgoingHashes ?? [];
    if (
      !Array.isArray(recentOutgoingHashes) ||
      recentOutgoingHashes.some(
        (hash) => typeof hash !== "string" || !HASH.test(hash),
      )
    )
      throw new Error("Malformed recent outgoing hashes");
    state.wallets[address.toLowerCase()] = {
      bootstrapped: candidate.bootstrapped,
      seen: [...new Set(candidate.seen)].slice(-MAX_SEEN),
      recentOutgoingHashes: [
        ...new Set(recentOutgoingHashes.map((hash) => hash.toLowerCase())),
      ].slice(-MAX_RECENT_OUTGOING_HASHES),
      anchors,
      pendingKinds: [...new Set(pendingKinds)] as TransferKind[],
      ...(pendingCursor ? { pendingCursor } : {}),
      ...(typeof candidate.activeHealthFingerprint === "string"
        ? {
            activeHealthFingerprint: candidate.activeHealthFingerprint.slice(
              0,
              1000,
            ),
          }
        : {}),
      ...(typeof candidate.notifiedHealthFingerprint === "string"
        ? {
            notifiedHealthFingerprint:
              candidate.notifiedHealthFingerprint.slice(0, 1000),
          }
        : {}),
      ...(typeof candidate.lastHealthAttemptAt === "string"
        ? { lastHealthAttemptAt: candidate.lastHealthAttemptAt }
        : {}),
    };
  }
  return state;
}

export async function loadState(
  path: string,
  addresses: Address[],
): Promise<WatchState> {
  try {
    return normalizeState(JSON.parse(await readFile(path, "utf8")), addresses);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return createInitialState(addresses);
    throw error;
  }
}

export async function saveState(
  path: string,
  state: WatchState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function formatUnits(raw: string, decimals: number): string {
  if (
    !/^\d+$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    return raw;
  const value = raw.replace(/^0+(?=\d)/, "");
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

function groupedWhole(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Round a provider decimal for a compact message without using floating point. */
function roundedDecimal(value: string, maxFractionDigits: number): string {
  if (!DECIMAL.test(value)) return value;
  let [whole, fraction = ""] = value.split(".");
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  if (fraction.length > maxFractionDigits) {
    const kept = fraction
      .slice(0, maxFractionDigits)
      .padEnd(maxFractionDigits, "0");
    if (fraction[maxFractionDigits] >= "5") {
      const scaled = BigInt(`${whole}${kept}`) + 1n;
      const text = scaled.toString().padStart(maxFractionDigits + 1, "0");
      whole = text.slice(0, -maxFractionDigits) || "0";
      fraction = text.slice(-maxFractionDigits);
    } else {
      fraction = kept;
    }
  }
  fraction = fraction.replace(/0+$/, "");
  return fraction ? `${groupedWhole(whole)}.${fraction}` : groupedWhole(whole);
}

interface DisplayAmount {
  text: string;
  approximate: boolean;
}

function decimalToRaw(value: string, decimals: number): string | null {
  if (!DECIMAL.test(value) || !Number.isInteger(decimals) || decimals < 0)
    return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  const scaled = `${whole}${fraction.padEnd(decimals, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  return scaled || "0";
}

function canonicalDecimal(value: string): string {
  const [whole, fraction = ""] = value.replace(/,/g, "").split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function decimalAtLeast(value: string, threshold: string): boolean {
  if (!DECIMAL.test(value) || !DECIMAL.test(threshold)) return false;
  const [valueWhole, valueFraction = ""] = canonicalDecimal(value).split(".");
  const [thresholdWhole, thresholdFraction = ""] =
    canonicalDecimal(threshold).split(".");
  if (valueWhole.length !== thresholdWhole.length)
    return valueWhole.length > thresholdWhole.length;
  if (valueWhole !== thresholdWhole) return valueWhole > thresholdWhole;
  const scale = Math.max(valueFraction.length, thresholdFraction.length);
  return (
    valueFraction.padEnd(scale, "0") >= thresholdFraction.padEnd(scale, "0")
  );
}

export function shouldDeliverFlowAlert(
  direction: FlowEvent["direction"],
  approxUsd: string | null,
  minInflowUsd = DEFAULT_MIN_INFLOW_USD,
): boolean {
  if (direction !== "inflow") return true;
  return approxUsd !== null && decimalAtLeast(approxUsd, minInflowUsd);
}

export function filterAlertFlows(
  flows: FlowEvent[],
  alertKinds?: readonly TransferKind[],
): FlowEvent[] {
  if (alertKinds === undefined) return flows;
  const allowed = new Set(alertKinds);
  return flows.filter((flow) => allowed.has(flow.transfer.kind));
}

function fixedDecimal(value: string, fractionDigits: number): string {
  const rounded = roundedDecimal(value, fractionDigits);
  if (rounded.includes(".")) {
    const [whole, fraction = ""] = rounded.split(".");
    return `${whole}.${fraction.padEnd(fractionDigits, "0")}`;
  }
  return `${rounded}.${"0".repeat(fractionDigits)}`;
}

function displayAmount(value: string): DisplayAmount {
  if (!DECIMAL.test(value)) return { text: value, approximate: false };
  const numeric = Number(value);
  if (numeric > 0 && numeric < 0.01)
    return { text: "<0.01", approximate: true };
  const rounded = fixedDecimal(value, 2);
  return {
    text: rounded,
    approximate: canonicalDecimal(value) !== canonicalDecimal(rounded),
  };
}

function displayUsd(value: string | null): string {
  if (value === null || !DECIMAL.test(value)) return "unavailable";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `≈$${fixedDecimal(value, 2)}`;
  if (numeric > 0 && numeric < 0.01) return "≈<$0.01";
  const suffix =
    numeric >= 1e9 ? "B" : numeric >= 1e6 ? "M" : numeric >= 1e3 ? "K" : "";
  const divisor =
    suffix === "B" ? 1e9 : suffix === "M" ? 1e6 : suffix === "K" ? 1e3 : 1;
  if (!suffix) return `≈$${fixedDecimal(value, 2)}`;
  const compact = fixedDecimal((numeric / divisor).toString(), 2);
  return `≈$${compact}${suffix}`;
}

function displayTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  const parts = new Intl.DateTimeFormat("en-SG", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")} · ${part("hour")}:${part("minute")}:${part("second")} UTC`;
}

export function formatTransferAlert(
  transfer: Transfer,
  _wallet: Address,
  valuation?: AlertValuation,
  direction: FlowEvent["direction"] = "outflow",
): string {
  const amount = displayAmount(
    formatUnits(transfer.rawAmount, transfer.asset.decimals),
  );
  const symbol =
    transfer.asset.symbol || (transfer.kind === "native" ? "ETH" : "token");
  const heading =
    direction === "inflow"
      ? `💰 ${symbol} INFLOW`
      : direction === "self"
        ? `🔄 ${symbol} SELF-TRANSFER`
        : `🚨 ${symbol} OUTFLOW`;
  const valueSuffix = valuation
    ? valuation.approxUsd === null
      ? " · USD unavailable"
      : ` · ${displayUsd(valuation.approxUsd)}`
    : "";
  const lines = [
    heading,
    "",
    `Amount: ${amount.approximate ? "≈" : ""}${amount.text} ${symbol}${valueSuffix}`,
  ];
  if (valuation) {
    const total = valuation.trackedEthereumTotal;
    const remaining =
      total?.status === "complete" && total.amount !== null
        ? displayAmount(total.amount)
        : null;
    const remainingValue =
      total?.status !== "complete" || total.amount === null
        ? ""
        : total.usd === null || total.usd === undefined
          ? " · USD unavailable"
          : ` · ${displayUsd(total.usd)}`;
    lines.push(
      remaining === null
        ? "Remaining: unavailable"
        : `Remaining: ${remaining.approximate ? "≈" : ""}${remaining.text} ${total?.symbol ?? symbol}${remainingValue}`,
    );
  } else lines.push("Remaining: unavailable");
  lines.push("", `🕒 ${displayTime(transfer.timestamp)}`);
  return lines.join("\n");
}

function operationalWarning(warning: string): boolean {
  const value = warning.toLowerCase();
  return /possible gap|incomplete|did not answer|still being indexed|trace[^.]{0,40}omitted|no cursor|rate limit|access denied|provider error|network error/.test(
    value,
  );
}

function healthFingerprint(detail: string[]): string {
  return detail.join(" | ").slice(0, 1000);
}

function publicHealthDetail(value: string): string {
  return value
    .replace(/0x[0-9a-fA-F]{40}/g, "[wallet]")
    .replace(/\bflowlens\b/gi, "tracker")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function isStaleTransfer(
  transfer: Transfer,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!Number.isFinite(maxAgeMs)) return false;
  const timestamp = Date.parse(transfer.timestamp);
  return Number.isFinite(timestamp) && now - timestamp > maxAgeMs;
}

export function isFlowStaleForDelivery(
  flow: FlowEvent,
  now: number,
  maxAgeMs: number,
): boolean {
  return isStaleTransfer(flow.transfer, now, maxAgeMs);
}

export function buildHealthNotifications(
  state: WatchState,
  events: HealthEvent[],
  now = Date.now(),
): HealthNotification[] {
  const notifications: HealthNotification[] = [];
  for (const event of events) {
    const walletState = state.wallets[event.wallet.toLowerCase()];
    if (!walletState) continue;
    const lastAttempt = walletState.lastHealthAttemptAt
      ? Date.parse(walletState.lastHealthAttemptAt)
      : NaN;
    if (Number.isFinite(lastAttempt) && now - lastAttempt < HEALTH_RETRY_MS)
      continue;
    if (event.impaired && event.fingerprint) {
      if (walletState.notifiedHealthFingerprint === event.fingerprint) continue;
      walletState.lastHealthAttemptAt = new Date(now).toISOString();
      const detail = publicHealthDetail(event.detail ?? event.fingerprint);
      notifications.push({
        wallet: event.wallet,
        kind: "impaired",
        fingerprint: event.fingerprint,
        text: [
          "⚠️ Tracker delayed",
          "Some transfers may be delayed while the tracker catches up.",
          ...(detail ? [`Detail: ${detail}`] : []),
        ].join("\n"),
      });
    } else if (!event.impaired && walletState.notifiedHealthFingerprint) {
      walletState.lastHealthAttemptAt = new Date(now).toISOString();
      notifications.push({
        wallet: event.wallet,
        kind: "recovered",
        text: [
          "✅ Tracker recovered",
          "Coverage is current again; live transfer alerts resumed.",
        ].join("\n"),
      });
    }
  }
  return notifications;
}

export function markHealthNotificationDelivered(
  state: WatchState,
  notification: HealthNotification,
): void {
  const walletState = state.wallets[notification.wallet.toLowerCase()];
  if (!walletState) return;
  if (notification.kind === "impaired")
    walletState.notifiedHealthFingerprint = notification.fingerprint;
  else walletState.notifiedHealthFingerprint = undefined;
}

export async function pollOnce(
  config: WatchConfig,
  provider: TraceProvider,
  previous: WatchState,
  now = Date.now(),
): Promise<PollResult> {
  const state = normalizeState(previous, config.addresses);
  const alerts: string[] = [];
  const outflows: Outflow[] = [];
  const flows: FlowEvent[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const health: HealthEvent[] = [];
  const trackedWallets = new Set(
    config.addresses.map((address) => address.toLowerCase()),
  );
  for (const wallet of config.addresses) {
    const key = wallet.toLowerCase();
    const walletState = state.wallets[key];
    try {
      const dedupeSeen = new Set(walletState.seen);
      const baseline = walletState.pendingCursor
        ? new Set<string>()
        : new Set(walletState.seen);
      for (const anchor of Object.values(walletState.anchors))
        if (anchor) baseline.add(anchor);
      const pages: TransferPage[] = [];
      const first = await provider.fetchPage({
        address: wallet,
        chainId: config.chainId,
        pageSize: PAGE_SIZE,
      });
      pages.push(first);
      const walletWarnings = pages.flatMap((page) => page.warnings);
      warnings.push(
        ...walletWarnings.map((warning) => `${wallet}: ${warning}`),
      );
      const operational = walletWarnings.filter(operationalWarning);
      const transfers = () => pages.flatMap((page) => page.transfers);

      if (!walletState.bootstrapped) {
        // Startup establishes the observation boundary. Older rows are never
        // replayed as alerts, and no historical pagination is needed.
        const initialOutgoingHashes = first.transfers
          .filter((transfer) => transfer.from.toLowerCase() === key)
          .map((transfer) => transfer.hash.toLowerCase())
          .filter((hash) => HASH.test(hash));
        for (const transfer of first.transfers)
          walletState.anchors[transfer.kind] = transfer.id;
        walletState.seen = [
          ...new Set(first.transfers.map((transfer) => transfer.id)),
        ].slice(-MAX_SEEN);
        walletState.recentOutgoingHashes = [
          ...new Set(initialOutgoingHashes),
        ].slice(-MAX_RECENT_OUTGOING_HASHES);
        walletState.bootstrapped = true;
        walletState.pendingCursor = undefined;
        walletState.pendingKinds = [];
        walletState.activeHealthFingerprint = operational.length
          ? healthFingerprint(operational)
          : undefined;
        health.push(
          operational.length
            ? {
                wallet,
                impaired: true,
                fingerprint: walletState.activeHealthFingerprint,
                detail: walletState.activeHealthFingerprint,
              }
            : { wallet, impaired: false },
        );
        continue;
      }

      const needed = new Set<TransferKind>(walletState.pendingKinds);
      const newBoundaryKinds = new Set<TransferKind>();
      for (const transfer of first.transfers) {
        const hadAnchor = Boolean(walletState.anchors[transfer.kind]);
        if (!hadAnchor) {
          walletState.anchors[transfer.kind] = transfer.id;
          newBoundaryKinds.add(transfer.kind);
          needed.delete(transfer.kind);
          continue;
        }
        if (newBoundaryKinds.has(transfer.kind)) continue;
        if (!baseline.has(transfer.id)) needed.add(transfer.kind);
      }
      let cursor =
        walletState.pendingCursor ?? (needed.size ? first.cursor : null);
      let fetched = 1;
      if (needed.size && !cursor && !first.exhausted) {
        const issue = `provider returned no cursor while reporting non-exhausted ${[...needed].join(", ")} stream(s)`;
        warnings.push(`${wallet}: ${issue}`);
        operational.push(issue);
      }
      while (cursor && fetched < MAX_PAGES && needed.size) {
        const response = await provider.fetchPage({
          address: wallet,
          chainId: config.chainId,
          cursor,
          pageSize: PAGE_SIZE,
        });
        pages.push(response);
        fetched += 1;
        warnings.push(
          ...response.warnings.map((warning) => `${wallet}: ${warning}`),
        );
        operational.push(...response.warnings.filter(operationalWarning));
        const pageOverlaps = new Set<TransferKind>();
        for (const transfer of response.transfers)
          if (baseline.has(transfer.id)) pageOverlaps.add(transfer.kind);
        for (const kind of [...needed]) {
          if (pageOverlaps.has(kind) || response.exhausted) needed.delete(kind);
        }
        if (!response.exhausted && !response.cursor) {
          const issue = `provider returned no cursor while reporting non-exhausted ${[...needed].join(", ")} stream(s)`;
          warnings.push(`${wallet}: ${issue}`);
          operational.push(issue);
          break;
        }
        cursor = response.exhausted || !needed.size ? null : response.cursor;
      }
      if (first.exhausted) needed.clear();
      const gap =
        needed.size && cursor
          ? `possible gap on ${[...needed].join(", ")} stream(s); bounded pagination is continuing from a saved cursor`
          : undefined;
      if (gap) {
        warnings.push(`${wallet}: ${gap}`);
        operational.push(gap);
      }
      walletState.pendingCursor = cursor ?? undefined;
      walletState.pendingKinds = [...needed];
      const newIds = new Set(
        [
          ...new Map(
            transfers().map((transfer) => [transfer.id, transfer]),
          ).values(),
        ]
          .map((transfer) => transfer.id)
          .filter((id) => !dedupeSeen.has(id)),
      );
      const observedTransfers = [
        ...new Map(
          transfers().map((transfer) => [transfer.id, transfer]),
        ).values(),
      ];
      const staleTransfers = observedTransfers.filter(
        (transfer) =>
          newIds.has(transfer.id) &&
          isStaleTransfer(
            transfer,
            now,
            config.maxAlertAgeMs ?? Number.POSITIVE_INFINITY,
          ),
      );
      if (staleTransfers.length) {
        warnings.push(
          `${wallet}: stale transfer data suppressed (${staleTransfers.length} event${staleTransfers.length === 1 ? "" : "s"})`,
        );
        operational.push("stale transfer data suppressed");
      }
      const currentOutgoingHashes = observedTransfers
        .filter((transfer) => transfer.from.toLowerCase() === key)
        .map((transfer) => transfer.hash.toLowerCase())
        .filter((hash) => HASH.test(hash));
      const knownOutgoingHashes = new Set([
        ...walletState.recentOutgoingHashes,
        ...currentOutgoingHashes,
      ]);
      walletState.recentOutgoingHashes = [...knownOutgoingHashes].slice(
        -MAX_RECENT_OUTGOING_HASHES,
      );
      walletState.seen = [...new Set([...walletState.seen, ...newIds])].slice(
        -MAX_SEEN,
      );
      if (operational.length) {
        const detail = operational.join(" | ").slice(0, 1000);
        const fingerprint = healthFingerprint(operational);
        walletState.activeHealthFingerprint = fingerprint;
        health.push({ wallet, impaired: true, fingerprint, detail });
      } else {
        walletState.activeHealthFingerprint = undefined;
        health.push({ wallet, impaired: false });
      }
      for (const transfer of observedTransfers) {
        if (!newIds.has(transfer.id)) continue;
        if (
          isStaleTransfer(
            transfer,
            now,
            config.maxAlertAgeMs ?? Number.POSITIVE_INFINITY,
          )
        )
          continue;
        const fromWallet = transfer.from.toLowerCase() === key;
        const toWallet = transfer.to.toLowerCase() === key;
        if (!fromWallet && !toWallet) continue;
        // A transfer between two configured wallets is internal movement, not
        // a dump or an inflow. It is already marked seen above, and outgoing
        // hashes are retained so same-transaction swap context still works.
        if (
          trackedWallets.has(transfer.from.toLowerCase()) &&
          trackedWallets.has(transfer.to.toLowerCase())
        )
          continue;
        const direction: FlowEvent["direction"] =
          fromWallet && toWallet ? "self" : fromWallet ? "outflow" : "inflow";
        if (
          direction === "inflow" &&
          knownOutgoingHashes.has(transfer.hash.toLowerCase())
        )
          continue;
        const flow = { wallet, transfer, direction };
        flows.push(flow);
        if (direction === "outflow")
          outflows.push({ wallet, transfer, direction });
        alerts.push(
          formatTransferAlert(transfer, wallet, undefined, direction),
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown provider failure";
      errors.push(`${wallet}: ${message}`);
      const fingerprint = healthFingerprint([`provider error: ${message}`]);
      walletState.activeHealthFingerprint = fingerprint;
      health.push({
        wallet,
        impaired: true,
        fingerprint,
        detail: message.slice(0, 1000),
      });
    }
  }
  return {
    state,
    alerts,
    outflows,
    flows,
    warnings: [...new Set(warnings)],
    errors,
    health,
  };
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Telegram send failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    ok?: boolean;
    description?: string;
  };
  if (!body.ok)
    throw new Error(
      `Telegram rejected message: ${body.description ?? "unknown error"}`,
    );
}

function valuationForTransfer(
  snapshot: WalletValuationSnapshot,
  transfer: Transfer,
  quoteOverride?: string | null,
  remainingOverride?: string | null,
  remainingSymbolOverride?: string | null,
  remainingUsdOverride?: string | null,
): AlertValuation {
  const quote =
    quoteOverride === undefined
      ? priceForAsset(snapshot, transfer.asset)
      : quoteOverride;
  const safeQuote = quote && quote.length <= MAX_PRICE_LENGTH ? quote : null;
  const balance =
    transfer.asset.contract === null
      ? snapshot.native
      : snapshot.tokens.find(
          (item) =>
            item.contract?.toLowerCase() ===
            transfer.asset.contract?.toLowerCase(),
        );
  const remainingAmount =
    remainingOverride !== undefined
      ? remainingOverride
      : balance && balance.amount.length <= MAX_PRICE_LENGTH
        ? balance.amount
        : null;
  const remainingSymbol =
    remainingSymbolOverride !== undefined
      ? remainingSymbolOverride
      : (balance?.symbol ?? null);
  const remainingUsd =
    remainingUsdOverride !== undefined
      ? remainingUsdOverride
      : balance?.valueUsd && balance.valueUsd.length <= MAX_PRICE_LENGTH
        ? balance.valueUsd
        : null;
  return {
    approxUsd:
      safeQuote === null
        ? null
        : decimalProduct(
            transfer.rawAmount,
            transfer.asset.decimals,
            safeQuote,
          ),
    remainingAmount,
    remainingSymbol,
    remainingUsd,
    totalPricedUsd:
      snapshot.totalPricedUsd.length <= MAX_PRICE_LENGTH
        ? snapshot.totalPricedUsd
        : "unavailable",
    pricedAssets: snapshot.pricedAssets,
    unpricedAssets: snapshot.unpricedAssets,
  };
}

function formatAlertWithValuation(
  flow: FlowEvent,
  valuation: AlertValuation,
  minInflowUsd: string,
): string | null {
  if (
    !shouldDeliverFlowAlert(flow.direction, valuation.approxUsd, minInflowUsd)
  )
    return null;
  return formatTransferAlert(
    flow.transfer,
    flow.wallet,
    valuation,
    flow.direction,
  );
}

async function formatValuedAlert(
  outflow: FlowEvent,
  snapshots: Map<string, Promise<WalletValuationSnapshot | null>>,
  quotes: Map<string, Promise<string | null>>,
  balances: Map<string, Promise<string | null>>,
  minInflowUsd = DEFAULT_MIN_INFLOW_USD,
): Promise<string | null> {
  const key = outflow.wallet.toLowerCase();
  let snapshotPromise = snapshots.get(key);
  if (!snapshotPromise) {
    snapshotPromise = fetchWalletValuation(outflow.wallet).catch(() => null);
    snapshots.set(key, snapshotPromise);
  }
  const snapshot = await snapshotPromise;
  try {
    let quoteOverride: string | null | undefined;
    let remainingOverride: string | null | undefined;
    let remainingSymbolOverride: string | null | undefined;
    let remainingUsdOverride: string | null | undefined;
    if (outflow.transfer.asset.contract !== null) {
      const contract = outflow.transfer.asset.contract.toLowerCase();
      const snapshotQuote = snapshot
        ? priceForAsset(snapshot, outflow.transfer.asset)
        : null;
      if (snapshotQuote !== null) quoteOverride = snapshotQuote;
      else {
        let quotePromise = quotes.get(contract);
        if (!quotePromise) {
          quotePromise = fetchTokenQuote(outflow.transfer.asset.contract)
            .then((quote) => quote.usd)
            .catch(() => null);
          quotes.set(contract, quotePromise);
        }
        quoteOverride = await quotePromise;
      }
      const snapshotBalance = snapshot?.tokens.find(
        (item) => item.contract?.toLowerCase() === contract,
      );
      if (snapshotBalance) {
        remainingOverride = snapshotBalance.amount;
        remainingSymbolOverride = snapshotBalance.symbol;
        remainingUsdOverride = snapshotBalance.valueUsd;
      } else {
        const balanceKey = `${outflow.wallet.toLowerCase()}:${contract}`;
        let balancePromise = balances.get(balanceKey);
        if (!balancePromise) {
          balancePromise = fetchTokenBalance(
            outflow.wallet,
            outflow.transfer.asset,
          );
          balances.set(balanceKey, balancePromise);
        }
        remainingOverride = await balancePromise;
        remainingSymbolOverride = outflow.transfer.asset.symbol || null;
        if (
          remainingOverride !== null &&
          quoteOverride !== null &&
          quoteOverride !== undefined
        ) {
          const rawRemaining = decimalToRaw(
            remainingOverride,
            outflow.transfer.asset.decimals,
          );
          remainingUsdOverride =
            rawRemaining === null
              ? null
              : decimalProduct(
                  rawRemaining,
                  outflow.transfer.asset.decimals,
                  quoteOverride,
                );
        }
      }
    }
    if (!snapshot)
      return formatAlertWithValuation(
        outflow,
        {
          approxUsd:
            quoteOverride === null || quoteOverride === undefined
              ? null
              : decimalProduct(
                  outflow.transfer.rawAmount,
                  outflow.transfer.asset.decimals,
                  quoteOverride,
                ),
          remainingAmount: remainingOverride ?? null,
          remainingSymbol: remainingSymbolOverride ?? null,
          remainingUsd: remainingUsdOverride ?? null,
          totalPricedUsd: "unavailable",
          pricedAssets: 0,
          unpricedAssets: 0,
        },
        minInflowUsd,
      );
    return formatAlertWithValuation(
      outflow,
      valuationForTransfer(
        snapshot,
        outflow.transfer,
        quoteOverride,
        remainingOverride,
        remainingSymbolOverride,
        remainingUsdOverride,
      ),
      minInflowUsd,
    );
  } catch {
    if (outflow.direction === "inflow") return null;
    return formatTransferAlert(
      outflow.transfer,
      outflow.wallet,
      {
        approxUsd: null,
        remainingAmount: null,
        remainingSymbol: null,
        totalPricedUsd: "unavailable",
        pricedAssets: 0,
        unpricedAssets: 0,
      },
      outflow.direction,
    );
  }
}

export async function runWatcher(config: EnvironmentConfig): Promise<never> {
  const provider = createBlockscoutProvider({
    intervalMs: config.providerIntervalMs,
  });
  let state = await loadState(config.stateFile, config.addresses);
  for (;;) {
    const result = await pollOnce(config, provider, state);
    for (const warning of result.warnings)
      process.stderr.write(`watcher warning: ${warning}\n`);
    for (const error of result.errors)
      process.stderr.write(`watcher error: ${error}\n`);
    // Save after delivery so a failed Telegram call causes the event to be
    // retried on the next poll instead of silently losing the alert.
    try {
      const snapshots = new Map<
        string,
        Promise<WalletValuationSnapshot | null>
      >();
      const quotes = new Map<string, Promise<string | null>>();
      const balances = new Map<string, Promise<string | null>>();
      const lateStale = new Set<string>();
      const alertFlows = filterAlertFlows(result.flows, config.alertKinds);
      if (alertFlows.length) {
        const alertTexts = await Promise.all(
          alertFlows.map((flow) =>
            formatValuedAlert(
              flow,
              snapshots,
              quotes,
              balances,
              config.minInflowUsd,
            ),
          ),
        );
        for (let index = 0; index < alertFlows.length; index += 1) {
          const flow = alertFlows[index];
          // A slow valuation batch can age an event after pollOnce accepted it.
          // Re-check immediately before the network send, not only at capture.
          if (isFlowStaleForDelivery(flow, Date.now(), config.maxAlertAgeMs)) {
            lateStale.add(`${flow.wallet.toLowerCase()}:${flow.transfer.id}`);
            continue;
          }
          const alert = alertTexts[index];
          if (alert !== null)
            await sendTelegramMessage(config.token, config.chatId, alert);
        }
      } else if (!result.flows.length) {
        for (const alert of result.alerts)
          await sendTelegramMessage(config.token, config.chatId, alert);
      }
      if (lateStale.size)
        process.stderr.write(
          `watcher warning: stale transfer data suppressed before delivery (${lateStale.size} event${lateStale.size === 1 ? "" : "s"})\n`,
        );
      // Coverage/recovery and startup notices stay in logs only; Telegram is
      // reserved for transfer alerts.
      state = result.state;
      await saveState(config.stateFile, state);
    } catch (error) {
      process.stderr.write(
        `watcher delivery error: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, config.intervalMs),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runWatcher(configFromEnvironment()).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
