---
name: cluster-wallets
description: Review bounded EVM shared-deposit, funding, sweep and signing-control evidence. Use when a trace reaches a CEX deposit address or when testing related-wallet hypotheses; keep exchange infrastructure, customer-account relationships and ownership separate.
---

# Cluster wallet evidence

A CEX label is not automatically a dead end. A plausible customer-specific deposit address can lead to other relevant depositors. A pooled hot wallet is not a route through which customer ownership can be inferred.

This is a research workflow using existing FlowLens operations, **not an automatic clustering algorithm or ownership tool**. `Group by type` only changes graph presentation. Start with [trace-wallet](../trace-wallet/SKILL.md); apply [audit-trace-evidence](../audit-trace-evidence/SKILL.md) before reporting.

## 1. Choose the claim and scope

- Record the exact chain ID plus full address for the target, endpoint and each candidate. Do not join shortened addresses or assume cross-chain control.
- Choose the claim: exchange infrastructure, possible shared account use, technical control, or a separately supported public corporate attribution. A finding in one slot does not fill the others.
- Fix the time window, canonical asset contracts, transfer categories, eligible population, page/node/call budget and exclusion rules before looking for matches. Retain source URLs, retrieval UTC, event/block time and provider limits.
- Start with one endpoint. Review up to three pages per explicit expansion, subject to `flowlens_status` limits; inspect coverage after every expansion. Select a peer deliberately from evidence before another bounded request. Never recurse automatically into all counterparties or retry an access denial.

## 2. Classify the endpoint before continuing

Read [exchange deposits](references/exchange-deposits.md) for the decision tree and false joins.

1. Preserve the provider label, category, source URL and as-of time; verify the exact chain/address. An exchange name does not distinguish customer deposit, omnibus, hot wallet or gas station.
2. Check code/delegation at the relevant block where available, actual token sender versus outer executor, other depositors, gas funding and sweep recipients. Missing contract code is not proof of dedicated assignment.
3. For a candidate dedicated deposit endpoint, inspect its bounded inbound history and sweeps. Compare the target with other independently supported, meaningful depositors; preserve all raw evidence and explain analysis exclusions.
4. For a hot/omnibus wallet, exchange gas station, pooled broker, router or payment service, stop customer clustering at that boundary. Do not match arbitrary exchange withdrawals to earlier deposits.
5. If a memo/tag, order or customer-specific account identifier is required but unavailable, record the missing identifier. The shared address alone cannot distinguish accounts.

## 3. Test the candidate, not just supporting examples

- Repeated deposits to the same plausibly dedicated endpoint within an overlapping assignment window support an **account-use hypothesis**, not proof that the source wallets share a customer, controller or owner.
- Check pooled use, third-party payments, broker/custodian settlement, merchant collection, address rotation/reassignment, refunds and stale labels. Many unrelated senders argue against a customer-specific join; a small sender count alone does not prove one.
- Separate infrastructure sweeps and gas top-ups from customer behavior. Shared exchange withdrawal batches, wallet gas services, deployers, SDKs, factories or relayers are not ownership links.
- Define timing/amount tolerances and eligible events in advance; count matches, nonmatches, reversed events and alternate pairings against a baseline. No cherry-picked match rate or invented ownership percentage.
- Where supported and authorized, retain independently checked owner/Safe/session-key observations at the relevant block. Configured roles, delegation and current permissions do not prove historical execution or beneficial ownership.
- Do not perform transitive closure on ownership: a relationship between A and B plus one between B and C does not establish common ownership of A, B and C.

## 4. Use the real FlowLens interface

Set variables from an actual case, its evidence and [the documented CLI](../../../docs/mcp.md); placeholders are not instructions to query an arbitrary wallet.

```sh
node server/cli.ts status
node server/cli.ts inspect --file "$CASE_FILE"
node server/cli.ts wallet --file "$CASE_FILE" --address "$DEPOSIT_ADDRESS" --chain "$CHAIN_ID" --direction in --from "$FROM" --to "$TO" --page-size 100
node server/cli.ts expand --file "$CASE_FILE" --address "$DEPOSIT_ADDRESS" --chain "$CHAIN_ID" --pages 1
node server/cli.ts evidence --file "$CASE_FILE" --id "$EVIDENCE_ID"
```

- `wallet` reads loaded evidence only. Its totals and counterparties do not imply complete endpoint history. Later transfer pages use `--offset` plus the preceding `--expected-revision`; restart after a stale revision instead of mixing snapshots.
- `expand` is the explicit network step. The address is sent to the configured provider. Confirm task authorization and provider support before executing it; no credential discovery or silent fallback.
- MCP equivalents are `flowlens_status`, `flowlens_inspect`, `flowlens_wallet`, `flowlens_expand` and `flowlens_evidence`. `maxPages` is bounded by the current status/schema. There is no `flowlens_cluster` operation.
- Every significant relationship needs an exact transaction/log or trace ID, canonical asset, raw amount/decimals, status and UTC time. Distinguish unique transactions from transfer rows and source addresses from graph nodes.

## 5. Preserve a hypothesis ledger and a reversible conclusion

Use [the ledger and reporting contract](references/hypothesis-ledger.md). Store it under `.local/investigations/<case>/`, alongside the case; do not add undocumented cluster fields to investigation JSON. Keep candidate members separate from the evidence graph.

Report the kind of cluster, scope and denominator, supported members and roles, per-hop evidence, counterexamples, missing assignment/control proof and a falsifying next check. Mark each route as tested, provider-only, untested, access-denied, rate-limited, connection-failed, input-dependent or terminal-service. A route not attempted is not a demonstrated dead end.

Do not persist an inferred ownership label with `flowlens_annotate` or `flowlens_label_put` without user approval. Do not merge or delete evidence to make a cluster appear coherent. Keep infrastructure nodes visible as a separate category, or hide them only as a presentation choice.

## Boundaries

Use public evidence and existing authorized access. No private-person identity, nationality, location or contact inference; no private exchange-account access, signing, trading, wallet connections or outbound messages. Names and counterparties do not identify a customer. Respect provider limits and do not bypass gated or blurred data.

These generic procedures incorporate evidence-review lessons, not private case details. Files follow the [skill size rule](../../README.md).
