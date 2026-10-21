import {
  createInvestigation,
  expandInvestigation,
  normalizeAddress,
} from "../src/domain/engine.ts";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";
import type { Investigation, TraceProvider } from "../src/domain/types.ts";
import { BLOCKSCOUT_CHAINS, createBlockscoutProvider } from "./blockscout.ts";
import { createEtherscanProvider, ProviderError } from "./etherscan.ts";
import { operationSchema } from "./schema.ts";

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
  const live = new Map<number, TraceProvider>();
  for (const chainId of operationSchema.limits.liveChains) {
    // A configured key keeps Etherscan the default; keyless Blockscout serves only chains it is confirmed for.
    const provider =
      etherscan ??
      (BLOCKSCOUT_CHAINS.includes(chainId) ? blockscout : undefined);
    if (provider) live.set(chainId, provider);
  }
  return { demo: demoProvider, live };
}
function liveProvider(providers: Providers, chainId: number): TraceProvider {
  const provider = providers.live.get(chainId);
  if (provider) return provider;
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
    { maxPages: 1, maxNodes: 80 },
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
  const chains = value.mode === "live" ? [1, 42161] : [1, 8453];
  if (typeof query.chainId !== "number" || !chains.includes(query.chainId))
    throw new Error(
      value.mode === "live"
        ? "Live chain ID must be 1 (Ethereum) or 42161 (Arbitrum One). Base, BSC and Optimism are not enabled; provider history may require a paid plan."
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
  if (
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > (value.mode === "live" ? 10 : 100)
  )
    throw new Error(
      `Page size must be an integer from 1 to ${value.mode === "live" ? 10 : 100}`,
    );
  return expandInvestigation(
    value,
    value.mode === "live"
      ? liveProvider(providers, query.chainId)
      : providers.demo,
    { address, chainId: query.chainId, pageSize: size },
    { maxPages: pages, maxNodes: 80 },
  );
}
