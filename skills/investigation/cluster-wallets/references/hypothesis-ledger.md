# Cluster hypothesis ledger and reporting

Keep this review separate from the saved transfer graph. There is no automatic ownership-cluster field or operation in FlowLens. Use a private Markdown/JSON sidecar under `.local/investigations/<case>/`; do not inject undocumented fields into case or report manifests.

## Cluster kinds

| Kind | Meaning | Must not be restated as |
| --- | --- | --- |
| Infrastructure | Observed exchange/service deposit, sweep or gas-management relationships | Every customer is controlled by that service |
| Account-use candidate | Wallets may interact with the same dedicated account endpoint in a stated assignment window | Same customer, same controller or same beneficial owner |
| Technical-control observation | A configured signer/owner/delegation/permission is observed at a specific chain/block | Historical execution or economic ownership |
| Corporate attribution hypothesis | A separately sourced organization/profile/control chain is proposed | Ownership inferred from a cluster score, a transfer or business similarity |

## Required record

```text
cluster_id; cluster_kind; question; target chain_id + full_address
candidate members: chain_id + full_address + role + inclusion basis
endpoint class and basis; label wording/provider/type/URL/as-of UTC
assignment window or account/memo/order identifier, with source or gap
scope: chains; canonical assets/decimals; categories; date/block window
coverage: provider; streams; pages; cursor/revision; errors; explicit budget
eligible deposits and distinct sources; unique transactions; exclusions
matching rules fixed in advance; matches, misses, reversals and baseline
per-hop evidence: source URL; transaction hash; log/trace index; event UTC
exact raw amounts and decimals; gross IN/OUT/net per contract; fees separate
claim slot: transfer | infrastructure | account relation | control | identity
observed fact; inference; alternatives; counterevidence; missing join
qualitative confidence per claim; falsifier; next bounded useful check
route outcome; last query/method/target/time; exact blocker or stop reason
```

Use full addresses in the record. Short labels in diagrams are display aliases only and must map to that full chain/address table. Every edge needs its own source and claim type; a valid path does not establish common control of all nodes.

## Route outcomes

| Outcome | Interpretation |
| --- | --- |
| verified-observation | The stated receipt/control fact was checked, within source limits; not universal ownership verification |
| provider-only | A sourced label/API assertion was retained but not independently established |
| untested | A concrete route has not been attempted; not a dead end |
| input-dependent | A required address, account identifier, block or authorization is missing |
| access-denied | The observed method/target returned an access denial; no bypass |
| rate-limited | The observed source refused the current rate; no silent retry loop |
| connection-failed | No usable response; do not invent an HTTP status or no-activity conclusion |
| terminal-service | A classified pool/service has no supported account-specific continuation |

Scope failures to the exact provider, method, target, time and requested range. A successful lookup elsewhere does not erase a gap; one failed target does not prove the entire chain unavailable. Unknown, contradicted and never checked are different states.

## Report the evidence, not an owner score

1. State the cluster kind and the strongest supported claim, with its scope.
2. Show candidate members and roles, then exact per-hop receipts/control records.
3. Report eligible populations and exclusions, gross flows per canonical asset, and the match/miss baseline. Never sum unlike assets or present recirculated gross volume as capital/profit.
4. Show competing explanations and what would falsify the proposed join. Separate exchange infrastructure from source-wallet ownership; never perform transitive ownership closure.
5. State source and access limitations, including account-assignment/memo gaps and unresolved customer/controller identity.
6. State the next useful bounded check, or the justified service boundary.

For PDF/DOCX, use existing `sections`, `table`, `sources`, `screenshots` and `limitations` in the [report manifest](../../../reporting/report-investigation/references/manifest.md). Use `assessment.status: "hypothesis"` when the conclusion is a candidate relationship. There is no `clusters` manifest key. Each diagram or table is an analyst-derived view, not a provider screenshot or independent source.

A user-confirmed explanation stays a user assertion. Do not persist inferred labels with `flowlens_annotate` or `flowlens_label_put` without approval. Existing provider labels retain their original source and scope. Private-person identity/location/contact inference and private exchange-account access are outside this workflow.

Review with [audit-trace-evidence](../../audit-trace-evidence/SKILL.md) before [report-investigation](../../../reporting/report-investigation/SKILL.md).
