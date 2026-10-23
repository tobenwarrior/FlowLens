import { DEMO_ROOT } from "./demo.ts";
import { normalizeAddress } from "./engine.ts";
import type { Address } from "./types.ts";

export interface SearchIntentInput {
  address: string;
  requestedMode: "demo" | "live";
  historyMode: "indexed" | "evidence-only";
  liveAvailable: boolean;
}
export type SearchIntent =
  | { kind: "demo"; root: Address }
  | { kind: "setup"; root: Address; reason: "KEY_REQUIRED" }
  | {
      kind: "live";
      root: Address;
      historyMode: "indexed" | "evidence-only";
    };

/** Render/request intent only. This does not fetch evidence or certify provider health. */
export function resolveSearchIntent(input: SearchIntentInput): SearchIntent {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Search intent must be an object");
  const root = normalizeAddress(input.address);
  if (input.requestedMode !== "demo" && input.requestedMode !== "live")
    throw new Error("Requested mode must be demo or live");
  if (input.historyMode !== "indexed" && input.historyMode !== "evidence-only")
    throw new Error("History mode must be indexed or evidence-only");
  if (typeof input.liveAvailable !== "boolean")
    throw new Error("Provider readiness must be an explicit boolean");

  // A stale Demo selector must never replace the wallet entered by the investigator.
  if (input.requestedMode === "demo" && root === DEMO_ROOT)
    return { kind: "demo", root };
  if (input.historyMode === "indexed" && !input.liveAvailable)
    return { kind: "setup", root, reason: "KEY_REQUIRED" };
  return { kind: "live", root, historyMode: input.historyMode };
}
