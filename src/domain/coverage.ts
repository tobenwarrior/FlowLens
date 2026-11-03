import type { Coverage } from "./types.ts";

const LOADED_STATUSES = new Set<Coverage["status"]>(["partial", "exhausted"]);

/**
 * Return the newest durable coverage attempt for one exact wallet/chain scope.
 * Coverage keeps historical provider attempts side-by-side for auditability;
 * callers showing the active cursor must therefore select by timestamp and use
 * array order as the tie-breaker used by the engine's append-on-update behavior.
 */
export function latestCoverageForScope(
  coverage: readonly Coverage[],
  address: string,
  chainId: number,
): Coverage | undefined {
  const normalized = address.toLowerCase();
  let latest: Coverage | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestIndex = -1;
  coverage.forEach((candidate, index) => {
    if (
      candidate.address.toLowerCase() !== normalized ||
      candidate.chainId !== chainId
    )
      return;
    const candidateTime = Date.parse(candidate.updatedAt);
    const time = Number.isFinite(candidateTime)
      ? candidateTime
      : Number.NEGATIVE_INFINITY;
    if (
      latest === undefined ||
      time > latestTime ||
      (time === latestTime && index > latestIndex)
    ) {
      latest = candidate;
      latestTime = time;
      latestIndex = index;
    }
  });
  return latest;
}

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
    case "etherscan-mcp-keyless-v2":
      return "Etherscan (keyless + traces)";
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

/** Hide page-local omission notes once their stream is represented cumulatively. */
export function coverageWarningsForDisplay(item: Coverage): string[] {
  const cumulativeOmissions = new Set(
    item.streams.map(
      (stream) => `${stream} transfers are not covered by this provider page.`,
    ),
  );
  return item.warnings.filter((warning) => !cumulativeOmissions.has(warning));
}
