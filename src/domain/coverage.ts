import type { Coverage } from "./types.ts";

const LOADED_STATUSES = new Set<Coverage["status"]>(["partial", "exhausted"]);

/**
 * A provider error is historical when it committed no page and a newer provider
 * has since loaded the same wallet/chain scope. Keep the row visible so the
 * recovery path remains auditable; callers can label it as an earlier attempt.
 */
export function isEarlierEmptyFailure(
  item: Coverage,
  coverage: readonly Coverage[],
): boolean {
  if (item.status !== "error" || item.pagesLoaded !== 0 || item.cursor !== null)
    return false;
  const itemTime = Date.parse(item.updatedAt);
  const itemIndex = coverage.indexOf(item);
  return coverage.some(
    (candidate, candidateIndex) =>
      candidate !== item &&
      candidate.address === item.address &&
      candidate.chainId === item.chainId &&
      candidate.provider !== item.provider &&
      candidate.pagesLoaded > 0 &&
      LOADED_STATUSES.has(candidate.status) &&
      (Date.parse(candidate.updatedAt) > itemTime ||
        // The engine appends the latest record after removing the prior record
        // for the same provider/scope. Preserve that durable order when both
        // provider updates share one millisecond timestamp.
        (Date.parse(candidate.updatedAt) === itemTime &&
          candidateIndex > itemIndex)),
  );
}

/** Use an explicit fallback rather than guessing a provider name from availability. */
export function coverageProviderLabel(provider: string): string {
  if (provider.startsWith("blockscout-self-hosted-v1"))
    return "Blockscout (self-hosted)";
  switch (provider) {
    case "blockscout-v2":
    case "blockscout-pro-v2":
      return "Blockscout";
    case "etherscan-v2":
      return "Etherscan";
    case "etherscan-mcp-keyless-v1":
      return "Etherscan (keyless)";
    case "alchemy-transfers":
      return "Alchemy";
    case "hypurrtrace-indexed":
      return "HypurrTrace";
    case "evidence-only":
      return "Evidence only";
    default:
      return "Live history";
  }
}
