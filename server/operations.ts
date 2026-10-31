import {
  createInvestigation,
  expandInvestigation,
  MAX_RETAINED_NODES,
  normalizeAddress,
} from "../src/domain/engine.ts";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";
import type { Investigation, TraceProvider } from "../src/domain/types.ts";
import {
  BLOCKSCOUT_CHAINS,
  BLOCKSCOUT_PRO_CHAINS,
  createBlockscoutProvider,
} from "./blockscout.ts";
import {
  createEtherscanProvider,
  ETHERSCAN_CHAINS,
  ProviderError,
} from "./etherscan.ts";
import { operationSchema } from "./schema.ts";
import { createHypurrtraceProvider } from "./hypurrtrace.ts";
import { createAlchemyProvider } from "./alchemy.ts";
import { createSelfHostedBlockscoutProvider } from "./self-hosted-blockscout.ts";

export interface Providers {
  demo: TraceProvider;
  /** Live history provider for each chain it serves; a chain without one has no live history. */
  live: ReadonlyMap<number, TraceProvider>;
}
export function providersFromEnvironment(): Providers {
  const switchValue = process.env.FLOWLENS_BLOCKSCOUT ?? "";
  if (!["", "on", "off"].includes(switchValue))
    throw new Error("FLOWLENS_BLOCKSCOUT must be empty, on or off");
  const etherscan = process.env.ETHERSCAN_API_KEY
    ? createEtherscanProvider()
    : undefined;
  const blockscout =
    switchValue === "off" ? undefined : createBlockscoutProvider();
  const blockscoutPro =
    switchValue !== "off" && process.env.BLOCKSCOUT_API_KEY
      ? createBlockscoutProvider({ apiKey: process.env.BLOCKSCOUT_API_KEY })
      : undefined;
  const selfHostedBase =
    switchValue !== "off" && process.env.FLOWLENS_BASE_BLOCKSCOUT_URL
      ? createSelfHostedBlockscoutProvider({
          origin: process.env.FLOWLENS_BASE_BLOCKSCOUT_URL,
        })
      : undefined;
  const hypurrSwitch = process.env.FLOWLENS_HYPURRTRACE ?? "";
  if (!["", "on", "off"].includes(hypurrSwitch))
    throw new Error("FLOWLENS_HYPURRTRACE must be empty, on or off");
  const hypurrtrace =
    hypurrSwitch === "off" ? undefined : createHypurrtraceProvider();
  const alchemy = process.env.ALCHEMY_API_KEY
    ? createAlchemyProvider({ apiKey: process.env.ALCHEMY_API_KEY })
    : undefined;
  const live = new Map<number, TraceProvider>();
  for (const chainId of operationSchema.limits.liveChains) {
    // Provider selection is configuration, never a silent retry/fallback after a failure.
    // A user-owned Alchemy key selects Base before the hosted Blockscout route.
    const provider =
      (ETHERSCAN_CHAINS.includes(chainId) ? etherscan : undefined) ??
      (BLOCKSCOUT_CHAINS.includes(chainId) ? blockscout : undefined) ??
      (chainId === 8453 ? selfHostedBase : undefined) ??
      (chainId === 8453 ? alchemy : undefined) ??
      (BLOCKSCOUT_PRO_CHAINS.includes(chainId) ? blockscoutPro : undefined) ??
      (chainId === 999 ? hypurrtrace : undefined);
    if (provider) live.set(chainId, provider);
  }
  return { demo: demoProvider, live };
}
function liveProvider(providers: Providers, chainId: number): TraceProvider {
  const provider = providers.live.get(chainId);
  if (provider) return provider;
  if (chainId === 999)
    throw new ProviderError(
      "PROVIDER_DISABLED",
      "HyperEVM history is disabled by FLOWLENS_HYPURRTRACE=off",
    );
  if (chainId === 8453)
    throw new ProviderError(
      "KEY_REQUIRED",
      "Base history needs FLOWLENS_BASE_BLOCKSCOUT_URL for a ready local Base Blockscout, ALCHEMY_API_KEY, or a BLOCKSCOUT_API_KEY with Base plan access in the local server environment. No complete hosted keyless Base history source is configured.",
    );
  if (chainId === 42161)
    throw new ProviderError(
      "KEY_REQUIRED",
      `History for chain ${chainId} needs a permitted BLOCKSCOUT_API_KEY in the local server environment; its free tier also requires a key. Arbitrum can alternatively use ETHERSCAN_API_KEY. No keyless access is configured.`,
    );
  if (chainId === 4663)
    throw new ProviderError(
      "KEY_REQUIRED",
      "Robinhood Chain history (4663) needs a permitted BLOCKSCOUT_API_KEY in the local server environment; the public explorer is not a configured keyless history route and account-plan access may restrict the chain. No retry or fallback is attempted.",
    );
  if (!ETHERSCAN_CHAINS.includes(chainId))
    throw new ProviderError(
      "PROVIDER_DISABLED",
      `Live history for chain ${chainId} comes only from keyless Blockscout, which FLOWLENS_BLOCKSCOUT=off turns off; an Etherscan key does not cover it.`,
    );
  throw new ProviderError(
    "KEY_REQUIRED",
    providers.live.size
      ? `Live history for chain ${chainId} needs ETHERSCAN_API_KEY in the local server environment; keyless Blockscout history does not cover it.`
      : "Live tracing is unavailable. Set ETHERSCAN_API_KEY in the local server environment, or leave FLOWLENS_BLOCKSCOUT unset for keyless Ethereum history.",
  );
}
export { operationSchema };
export async function startInvestigation(
  rootValue: unknown,
  modeValue: unknown,
  title: unknown,
  providers: Providers,
  historyMode: unknown = "indexed",
): Promise<Investigation> {
  if (modeValue !== "demo" && modeValue !== "live")
    throw new Error("Mode must be demo or live");
  if (historyMode !== "indexed" && historyMode !== "evidence-only")
    throw new Error("History mode must be indexed or evidence-only");
  if (modeValue === "demo" && historyMode !== "indexed")
    throw new Error(
      "Evidence-only history mode is only available in live investigations",
    );
  const root = normalizeAddress(rootValue as string);
  if (title !== undefined && (typeof title !== "string" || title.length > 200))
    throw new Error("Title must be a string of at most 200 characters");
  if (modeValue === "demo") {
    if (root !== DEMO_ROOT)
      throw new Error(
        "Demo mode uses only the clearly marked synthetic demo address. Select live mode to investigate another wallet.",
      );
    const value = await createDemoInvestigation();
    return title ? { ...value, title: title as string } : value;
  }
  if (historyMode === "evidence-only") {
    const value = createInvestigation(
      root,
      "live",
      title as string | undefined,
    );
    value.nodes = [{ address: root, chainId: 1 }];
    value.coverage = [
      {
        key: `evidence-only:1:${root}`,
        address: root,
        chainId: 1,
        provider: "evidence-only",
        status: "unsupported",
        pagesLoaded: 0,
        cursor: null,
        streams: [],
        updatedAt: value.updatedAt,
        warnings: [
          "Wallet history is not enumerated. This case preserves explicitly acquired or imported protocol evidence only. No complete native, token or internal-transfer history is implied.",
        ],
      },
    ];
    return value;
  }
  const provider = liveProvider(providers, 1);
  const value = createInvestigation(root, "live", title as string | undefined);
  return expandInvestigation(
    value,
    provider,
    { address: root, chainId: 1, pageSize: 10 },
    { maxPages: 1, maxNodes: MAX_RETAINED_NODES },
  );
}
export async function expandCase(
  value: Investigation,
  input: unknown,
  providers: Providers,
): Promise<Investigation> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expansion must be an object");
  const query = input as Record<string, unknown>;
  const address = normalizeAddress(query.address as string);
  const chains =
    value.mode === "live"
      ? operationSchema.limits.liveChains
      : operationSchema.limits.demoChains;
  if (typeof query.chainId !== "number" || !chains.includes(query.chainId))
    throw new Error(
      value.mode === "live"
        ? "Live chain ID must be 1 (Ethereum), 957 (Derive Chain), 8453 (Base), 42161 (Arbitrum One), 999 (HyperEVM) or 4663 (Robinhood Chain). Check provider status for configured access."
        : "Demo chain ID must be 1 or 8453",
    );
  const pages = query.maxPages ?? 1;
  if (
    typeof pages !== "number" ||
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 3
  )
    throw new Error("Page budget must be an integer from 1 to 3");
  const size = query.pageSize ?? (value.mode === "live" ? 10 : 12);
  const provider =
    value.mode === "live"
      ? liveProvider(providers, query.chainId)
      : providers.demo;
  const maxSize =
    value.mode === "live" && provider.id !== "hypurrtrace-indexed" ? 10 : 100;
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > maxSize
  )
    throw new Error(
      `Page size must be an integer from 1 to ${maxSize} for this provider`,
    );
  return expandInvestigation(
    value,
    provider,
    { address, chainId: query.chainId, pageSize: size },
    { maxPages: pages, maxNodes: MAX_RETAINED_NODES },
  );
}
