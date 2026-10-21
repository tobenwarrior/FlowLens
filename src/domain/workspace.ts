import {
  nodeKey,
  normalizeAddress,
  parseInvestigation,
  parseLabel,
} from "./engine.ts";
import type { Investigation } from "./types.ts";

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Workspace request must be an object");
  return input as Record<string, unknown>;
}
function revision(value: Investigation): string {
  return new Date(
    Math.max(Date.now(), Date.parse(value.updatedAt) + 1),
  ).toISOString();
}
function targets(value: unknown, name: string, max: number): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== "string" || !v.length || v.length > 300)
  )
    throw new Error(
      `${name} must be an array of at most ${max} nonempty identifiers`,
    );
  return [...new Set(value as string[])];
}

/** User-supplied attribution only. Claim type does not authenticate ownership. */
export function annotateWallet(
  investigation: Investigation,
  input: unknown,
): Investigation {
  const value = parseInvestigation(investigation),
    request = object(input);
  const address = normalizeAddress(request.address as string);
  const key = nodeKey(request.chainId as number, address);
  const index = value.nodes.findIndex(
    (node) => nodeKey(node.chainId, node.address) === key,
  );
  if (index < 0)
    throw new Error("Wallet scope is not a loaded node in this investigation");
  if (request.label === null) {
    delete value.nodes[index].label;
  } else {
    const label = parseLabel(request.label);
    if (!label.text.trim() || !label.source.trim())
      throw new Error("Label text and source must be nonempty");
    if (!label.claimType || !label.observedAt)
      throw new Error("New labels require claimType and observedAt provenance");
    if (
      label.confidence === "verified" &&
      (label.claimType !== "verified-evidence" || !label.evidenceNote?.trim())
    )
      throw new Error(
        "Verified confidence requires a verified-evidence claim and supplied evidence note; FlowLens does not authenticate ownership",
      );
    if (
      value.mode === "live" &&
      (label.confidence === "synthetic" || label.kind === "demo")
    )
      throw new Error(
        "Synthetic or demo labels cannot enter a live investigation",
      );
    value.nodes[index].label = label;
  }
  value.updatedAt = revision(value);
  return value;
}

/** Visibility changes presentation only; it never deletes evidence or changes totals. */
export function setVisibility(
  investigation: Investigation,
  input: unknown,
): Investigation {
  const value = parseInvestigation(investigation),
    request = object(input);
  if (typeof request.visible !== "boolean")
    throw new Error("visible must be a boolean");
  const nodes = targets(request.nodeKeys, "nodeKeys", 2000);
  const transfers = targets(request.transferIds, "transferIds", 20_000);
  if (!nodes.length && !transfers.length)
    throw new Error("Supply at least one loaded visibility target");
  const knownNodes = new Map(
    value.nodes.map((node) => [nodeKey(node.chainId, node.address), node]),
  );
  for (const key of nodes) {
    const node = knownNodes.get(key);
    if (!node) throw new Error("Visibility node scope is not loaded");
    if (!request.visible && node.address === value.root)
      throw new Error("The focus wallet cannot be hidden");
  }
  const knownTransfers = new Set(
    value.transfers.map((transfer) => transfer.id),
  );
  if (transfers.some((id) => !knownTransfers.has(id)))
    throw new Error("Visibility transfer must refer to loaded evidence");
  const hidden = new Set(value.hidden),
    hiddenTransfers = new Set(value.hiddenTransfers ?? []);
  for (const key of nodes) {
    if (request.visible) hidden.delete(key);
    else hidden.add(key);
  }
  for (const id of transfers) {
    if (request.visible) hiddenTransfers.delete(id);
    else hiddenTransfers.add(id);
  }
  value.hidden = [...hidden];
  value.hiddenTransfers = [...hiddenTransfers];
  value.updatedAt = revision(value);
  return value;
}

/** Hydrate shared state without overwriting notes or pins that the local UI has not saved. */
export function refreshWorkspace(
  local: Investigation,
  latest: Investigation,
): Investigation {
  const previous = parseInvestigation(local),
    authoritative = parseInvestigation(latest);
  if (
    previous.id !== authoritative.id ||
    previous.root !== authoritative.root ||
    previous.mode !== authoritative.mode
  )
    throw new Error(
      "Cannot refresh workspace from a different investigation identity",
    );
  return { ...authoritative, notes: previous.notes, pinned: previous.pinned };
}
