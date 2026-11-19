import type { Asset } from "../domain/types.ts";
import { assetKey } from "../domain/engine.ts";

/**
 * Build the visible labels and preserve the exact assetKey used by filtering.
 * The input is already unique by assetKey (aggregateFlows' contract), so a
 * symbol/chain count is enough to detect every visible-label collision.
 */
export function assetOptionLabels(
  assets: readonly Asset[],
  networkLabel: (chainId: number) => string,
): Array<{ key: string; label: string }> {
  const collisions = new Map<string, number>();
  for (const asset of assets) {
    const groupKey = `${asset.chainId}:${asset.symbol.toLowerCase()}`;
    collisions.set(groupKey, (collisions.get(groupKey) ?? 0) + 1);
  }

  return assets.map((asset) => {
    const groupKey = `${asset.chainId}:${asset.symbol.toLowerCase()}`;
    const label = `${asset.symbol} · ${networkLabel(asset.chainId)}`;
    return {
      key: assetKey(asset),
      label:
        collisions.get(groupKey)! > 1
          ? `${label} · ${asset.contract ?? "native"}`
          : label,
    };
  });
}
