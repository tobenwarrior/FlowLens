---
name: render-transaction-map
description: Use when a wallet trace needs a compact transaction-flow graphic, a reusable route map, or a graph-backed report that must preserve complete transfer accounting while separating labels, infrastructure and ownership hypotheses.
---

# Render a transaction map

Use after [trace-wallet](../trace-wallet/SKILL.md) and [audit-trace-evidence](../audit-trace-evidence/SKILL.md). The map is a presentation of a validated ledger. It never replaces the ledger, coverage record or claim review.

Start from the full addresses or a saved case. Acquire, reconcile, select, verify, render and inspect in that order. Deliver the map with its receipt index and a count of acquired, displayed and verified rows. See [the diagonal layout](references/diagonal-layout.md) for a reusable composition and [displayed-transfer verification](references/receipts.md) for the final check.

## 1. Build the ledger before drawing

1. Read the case with `flowlens_inspect`, then page the relevant wallet and chain with `flowlens_wallet` or `flowlens_graph`. Resume every provider stream with `flowlens_expand` until it is terminal, reaches a stated limit, or records an error. Keep each coverage record.
2. Make one ledger row for every retained transfer. Store the full chain ID, hash, kind, event index, token contract, raw amount, decimals, full sender and recipient, block, UTC time, provider, retrieval time and source URL. Count transfer rows and distinct transactions separately.
3. Assign each row one display state: `shown`, `aggregated`, `accounted-but-hidden`, `provider-only`, `unverified`, or `excluded`. An excluded row remains in the ledger with its reason. Never delete a row to make the picture cleaner.
4. Reconcile rows by canonical evidence identity `(chainId, hash, kind, eventIndex, asset.contract)`. Deduplicate only when that identity agrees. Equal amounts, close timestamps, shortened addresses or matching symbols never deduplicate rows.
5. Reconcile gross inflows and outflows separately by chain and token contract. Use integer raw amounts and decimal-aware formatting. Native value, ERC-20 value, internal calls, protocol accounting and USD estimates remain separate quantities.

The map's edge count and amount are derived from ledger row IDs. A grouped edge displays its row count and exact aggregate, and its metadata keeps every member ID and source URL. A single representative receipt never stands in for unlisted grouped rows.

## 2. Classify what the graphic means

Use a small, stable visual vocabulary.

| Graphic element | Meaning | Required treatment |
| --- | --- | --- |
| Solid arrow | Exact transfer relation | Link to all member receipts; show direction, asset, amount and UTC date or range |
| Grouped arrow | Several rows with the same route and asset | Show exact row count and aggregate; retain each row in the ledger |
| Dotted or protocol edge | Bridge, venue or accounting relation without a wallet endpoint | Mark `endpointKind` and `accountingDirection`; never count it as a second wallet transfer |
| Exchange or pooled-service node | Provider label or infrastructure observation | Show the exact source wording and source URL; do not imply customer ownership |
| Neutral wallet node | Address with no supported entity label | Show a truncated address and keep the full address in SVG metadata and the ledger |
| Purple segmented ring with `?` | Suspected entity or service relationship | Mark it as a hypothesis, link its supporting evidence, and keep the node unlabelled unless a source asserts the label |

The purple question marker indicates an unresolved entity or service link. If the suspected company’s logo appears inside the ring, keep the question mark and a visible “Possible [entity] link” beside it. Use an unqualified company logo or entity label only for an exact provider assertion from an allowed source. Labels, funding, shared deposits and coordinated activity occupy separate claim fields.

## 3. Follow routes without losing scope

- Start at the requested root. Follow a candidate dedicated deposit endpoint only within the bounded scope in [cluster-wallets](../cluster-wallets/SKILL.md). Stop at pooled hot wallets, custodians and service infrastructure unless a new address-specific clue supports another bounded check.
- Before selecting routes, rank each investigated wallet’s gross inflows and outflows by exact counterparty on every covered chain and canonical asset contract. Compare all payments to exact shared addresses. If an explorer-only label or exact-address reuse raises a material lead, check the relevant chain’s receipts and any bounded onward sweep. Show the material flows across all covered chains in one map. Reuse a visual node for the same exact EVM address when its role is consistent. Keep chain, token contract, and evidence identity on each transfer. Use chain captions to keep totals distinct on shared arrows.
- Query the material sender and recipient independently for a key route. An endpoint’s capped history can omit older transfers that are still discoverable from the sender. Reconcile the two views by event ID and record both coverage windows.
- Retain independently checked relationships to wallets with a shared deposit, funder, venue or timing pattern. Include them in the main map when they help answer the question. Label each relationship as observed infrastructure or account-use evidence. Do not perform transitive ownership closure.
- Record a deposit’s onward sweep as its own transfer. Draw a separate edge when the sweep matters to the map’s question. Keep the sweep in the supporting ledger or expanded view when the main map stops at the deposit. Preserve its own hash, event index and amount. Do not silently allocate a sweep to one depositor when the endpoint is pooled.
- If two sweep legs occur at different times, retain both legs. A later amount that includes an earlier dust or fee unit must not be presented as the earlier leg plus the later leg unless the ledger proves the arithmetic.
- Give HyperCore and other venue accounting a distinct visual treatment within the same map. Keep positions separate from transfers. A matching Arbitrum leg is supporting evidence for a protocol relation, not an extra HyperCore address or duplicate transfer.

## 4. Reconcile providers and benchmarks

For every provider, record the streams, pages, cursor state, terminal or error state, loaded time range and row count. Compare providers with full identities and raw values.

| Reconciliation result | Meaning |
| --- | --- |
| `exact-match` | Same canonical evidence identity and matching endpoints, asset and raw amount |
| `matched-on-visible-fields` | An explorer row matches one saved event within the declared domain, but the view omits a log index or rounds the amount |
| `duplicate-view` | Same event returned by another provider; retain provenance, count once in canonical totals |
| `provider-only` | One provider returned the row and the other did not search or could not verify it |
| `conflict` | Same apparent event has different endpoints, asset, amount or status; keep both observations and investigate |
| `unresolved` | Matching is impossible within the declared scope or a provider is partial/blocked |

For a supplied benchmark, preserve its filter, cutoff, page count and full denominator. Assign every benchmark row exactly once to a canonical row, an ambiguity bucket or a missing-evidence bucket. A matched benchmark proves only that scoped comparison. It does not prove complete wallet history for a new address.

Before export, run a mechanical check that:

- every displayed edge has at least one ledger row;
- every ledger row has exactly one display state;
- grouped edge amounts equal the integer sum of their member rows;
- totals use one chain, contract, decimal scale and direction each. A shared visual line may show separate asset totals for the same route;
- every full address in nodes and metadata is valid and chain-qualified;
- coverage and reconciliation totals explain all provider-only, conflict and unresolved rows.

Run `node skills/investigation/render-transaction-map/check-ledger.mjs <manifest.json>` to check that every acquired ID has exactly one display state and one route if displayed. Keep the manifest and case files local. Paths are relative to the manifest.

- `cases` lists FlowLens case exports and `hypercore` lists saved HyperCore bundles or their acquisition wrappers.
- `display` points to an array of `{ "id": "...", "state": "shown" }` entries. Use the FlowLens ID for EVM and `hypercore:<account>:<entry ID>` for a HyperCore row. Add `reason` for an exclusion.
- `routes` points to a JSON object from route name to its member ID array. Also verify raw-amount sums and provider coverage separately.

## 5. Render a clean, auditable graphic

Use a white canvas, compact nodes, directional arrows and concise amount/date labels. Remove decorative title cards, notional summaries, long footers and repeated prose when the user asks for a graph-only image. Keep source links in the SVG anchor, tooltip or `data-*` metadata. A PNG is a visual copy; the SVG or private ledger is the auditable artifact.

- When a user selects an existing graphic, use its composition as the baseline for revisions. Keep node placement, visual emphasis and label treatment unless the user asks to change them. Store supporting transaction detail in receipt links and the full ledger when extra routes would obscure the selected view.
- Use direct diagonal arrows and short, separate arcs for reciprocal transfers when they keep the main wallets and settlement route readable. Keep layout experiments as separate previews until the user selects one.
- Make the investigated wallets the visual anchors using larger nodes and stronger labels. Keep counterparties smaller and preserve their exact addresses in the SVG. Use the same generic wallet icon and a clear label for supporting venues when logos could be mistaken for the entity under review.
- Use flat circles and restrained color. Keep text dark. Use teal for funding and bridge transfers, muted red for transfers between investigated wallets and their outbound routes, a distinct secondary color for custody sweeps, and slate for other counterparties. Use a heavier stroke for the route that best supports the investigation’s conclusion and thinner strokes for contextual transfers. When stroke weight expresses emphasis, keep exact amounts in the labels. Reserve segmented violet for affiliation uncertainty.
- Put the label and shortened address under each node. Use mostly straight, continuous arrows. Align the amount with its arrow and give the text clearance from the stroke. Put UTC dates and transfer counts beside the same arrow. Keep text off neighboring arrows and avoid background boxes across them.
- For a deposit-focused overview, place funding sources on the left, investigated wallets in the center, and deposits on the right. Bring each deposit’s incoming arrows in from the left. Arrange the core relationships so that arrows can stay separate, then attach supporting sources and destinations in open space. Use two arrowheads on one line for reciprocal transfers when it removes visual clutter, and retain a distinct receipt and direction for each leg. Give labels and arrowheads space around other routes and node symbols. When a cluster feels crowded, expand the space between its nodes before shrinking the typography.
- Export a clickable SVG and a high-resolution PNG. Inspect the rendered image at its intended display size for clipped text, arrows crossing or touching labels, and ambiguous directions.

Before clearing a map for external sharing, check every displayed member against transaction and receipt evidence. For ERC-20 transfers, match the successful receipt's exact log index, canonical token contract, endpoints and raw amount. For native value, match the transaction's endpoints and value with a successful receipt. Check block times for date and timing claims, recompute each route total, and cite provider labels separately. Report how many rows were checked against raw chain evidence and how many still depend on indexed observations. Share a receipt list for the displayed routes when useful.

Use [the receipt gate](references/receipts.md) on the same route manifest that drives the final export.

```sh
node skills/investigation/render-transaction-map/check-ledger.mjs "$MAP_MANIFEST" --require-receipts
```

If the gate reports unresolved rows, investigate those exact members. Keep unresolved transfers in the full ledger. The verified transfer map uses only passing rows, with amounts and counts recomputed from that selection. Treat traces and venue ledger entries as separate evidence with their own verification check.

Render only facts that the ledger supports. Use full labels from providers verbatim, and include provenance beside the label in the report or metadata. Never put a private wallet case, vault note, API key, restricted provider response or unverified owner name in a public fixture, screenshot or source export.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Drawing only the most interesting transfers | Start from the retained ledger and account for every row before selecting visible edges |
| Treating a shared exchange deposit as an owner | Draw the deposit and sweeps as infrastructure evidence; keep customer ownership unresolved |
| Hiding a failed or partial provider page | Preserve the warning and mark the affected scope unresolved |
| Counting a HyperCore position as an EVM transfer | Keep protocol accounting separate and reconcile only with an exact supported relation |
| Using a solid purple entity node for a guess | Use the segmented purple `?` marker and a hypothesis field |
| Joining by `0x1234…abcd` or amount and time | Join only on full chain-qualified evidence identity |

## Related

- [Tracing method](../trace-wallet/references/tracing-method.md) for acquisition and bounded expansion
- [Evidence audit](../audit-trace-evidence/SKILL.md) for coverage, identity and claim limits
- [Cluster wallet evidence](../cluster-wallets/SKILL.md) for shared deposits and sweep hypotheses
- [Evidence reports](../../reporting/edit-evidence-report/SKILL.md) for the reader-facing conclusion
