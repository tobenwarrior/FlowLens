# Names, venue accounts and attribution

Continue from the [tracing method](tracing-method.md). These steps do not convert payment relationships into ownership.

## 7. Look for names the address chose itself

A name an address registered for itself is a self-disclosure, and one of the stronger leads available:

- ENS reverse records and names it holds, Basenames, and `.hl` names on HyperEVM
- profile aggregators such as web3.bio
- social and identity graphs: Farcaster, Lens, EFP, Ethos
- governance: Snapshot votes, follows and aliases
- attestations and badges: EAS, POAP, Galxe
- portfolio profiles: DeBank, Zerion, OpenSea, Polymarket (an address-derived default name is not a chosen name)
- explorer name tags

Test each lookup with an address you know has a profile. If that positive control also returns nothing, the result is inconclusive, not a negative. A key-gated, challenged or rate-limited lookup is a blocker, not "no profile".

Search social media for the **full** address. A match on a short prefix counts only once the full address and chain match. For X or an equivalent public feed, run three bounded searches separately: exact address in **Top**, exact address in **Latest**, and exact address plus the candidate business name or official handle. Open and expand each relevant original post (for example, **Show more**) before judging confidence; retain the exact full-address/business-name pairing rather than a collapsed preview. Record each query, surface/filter and UTC time, then retain the original post URL, date and author. Note whether the post names the exact address, links the business's official account, or only discusses activity. A third-party address/business-name pairing supports an affiliation lead; a business-controlled post naming the exact address is stronger; activity-only posts do not establish ownership. Search results remain bounded by the accessible scope.

**Stop at a personal-looking handle.** Record it and go no further. This guide is for public businesses and voluntary disclosures, never for identifying private people.

## 8. Venue accounts and trades

Trading venues keep accounts that public chains do not show. Endpoints and access change, so check the current documentation; these notes reflect October 2026.

**Hyperliquid.** Start with the `userRole` query on the public info API. "missing" means the address has no HyperCore account, so it has no vault, sub-account, referral code or agent. For an existing account, read its sub-account names, vault details and equities, referral code and referrer, agent names, and internal-transfer ledger from the start. Hypurrscan shows public aliases.

**Derive.** Derive's public API maps wallets and subaccounts in both directions. Treat a supplied subaccount ID as a hypothesis: check both the reverse and the forward mapping before tracing it, because it may belong to someone else. Current settlement and older Derive Chain (957) history are different places. A wallet's own session keys cannot be listed publicly. Collateral types are visible, and a custodian-specific collateral token can mark that custodian's clients, as a current-state lead only. An approval is permission, not a deposit, and a depositor or session signer is not necessarily the owner.

**In FlowLens:** choose **Derive** as the expansion network, or `--chain 957` and `chainId: 957`, to load a wallet's Derive Chain transfers. Subaccount balances, positions and trades live inside Derive's contracts and are not shown as transfers.

**Matching a trade to a counterparty.** Join the same trade ID, instrument, time, size and price, with opposite sides and both full wallets and subaccounts. One exact pair identifies that pair's counterparties, not the maker of every fill, and not the owner of either account. RFQ, quote, operation and batch identifiers are different things. Close timing across many trades describes an execution pattern, not identity.

**Sizing a trade.** Keep gross underlying notional, cash premium and risk separate, each with its convention and timestamp. Net premium is not maximum loss, and trade size says nothing about ownership.

## Attribution review before a verdict

Before a final verdict, including unresolved ownership, review the root and any distinct verified controller. Search the local case store and run `flowlens_archive_search` for each full address when `FLOWLENS_VAULT_LOG_DIR` is configured. Read matched notes locally and follow explicit continuation links in that same authorized archive. A `complete` scan with no match is scoped negative evidence. `unconfigured`, `unavailable` and `partial` results are unresolved scope. A partial new trace does not replace a historical case. Check the older source dates, coverage and receipts, and refresh mutable labels when accessible. If older funding or material activity lies outside the loaded window, extend that scope within the trace budget or state the gap. An empty local result does not cover exports or project notes outside the configured archive. Record the archive status explicitly.

- Select material counterparties from both directions using the earliest meaningful funding, large or repeated flows, and any documented account or product clues. Start with up to three directly relevant non-pooled peers within a stated chain, time and page budget. Use their exact addresses for local and authorized label checks even when the user has named no candidate firm.
- Classify each peer and verify the deciding hops. For an apparent company link, resolve the product or contract in first-party sources and inspect material receipts in both directions where accessible. Check the immediate source of a material onward payment in a bounded window before connecting it to an older receipt. Keep separate payments separate when there is no reliable join.
- Record product use, payments, technical control and business ownership as separate findings. An entity's contract can serve its customers. A pooled service remains a stopping point unless an account-specific identifier supports the next step.
- Before writing the verdict, record which archive, label and relationship checks were reviewed, unavailable, blocked or outside the stated budget. Treat unchecked material leads as unresolved scope. List the strongest verified relationship even if no firm is identified.

## 9. Testing a named firm

When someone asks "is this firm X?":

1. List the firms the venue or protocol publicly names, such as market makers, investors and partners, with the source and date.
2. Find each firm's publicly labelled wallets.
3. Test address joins with the target: direct transfers, a shared dedicated deposit address, a funding parent, a shared session key, a venue collateral marker.
4. Report each firm as **joined** (with the exact path), **not joined within the stated scope**, or **untestable**.

Treat an operational link as business-discriminating only when its endpoints, timing, product context or account role distinguish the candidate from ordinary OTC/customer payments, exchange or bridge traffic, pooled services and shared infrastructure. Associated peer labels do not become verified joins merely because they are nearby or repeated; predicted labels remain provider assertions until independently supported.

Draw every hop explicitly, for example `firm claim -> labelled wallet A -> verified transfer -> target`. Missing joins stay missing even when every transfer is real. A trade counterparty, a fellow recipient of one distribution, a matching trading style, or a follow on social media is not a join. Never fill a requested shortlist with names the evidence does not support.

## Third-party label platforms (optional)

Arkham, Nansen and explorer name tags can save a lot of time, and FlowLens works without any of them. If you use them:

- Record the exact label wording, the provider, the URL and when you saw it.
- Separate entity labels from predictions, activity tags, first-funder tags and contract names. A holder tag or protocol connection is not an ownership label.
- Treat their graphs as views of indexed transfers, not ownership evidence or complete ledgers, and verify material edges in a primary source.
- A blurred, gated or paywalled field is neither evidence for nor against anything. Do not bypass paywalls, solve challenges or read hidden page content.
- Copied labels and reposts are one claim, not independent corroboration.

**In FlowLens:** save a provider's label as a **provider assertion**, with the provider as its source and the date you saw it. FlowLens never fetches or bundles third-party labels.

## Writing it up

Keep one evidence ledger. A useful row is:

`UTC time | chain | from -> to | exact amount and token contract | transaction link | label and its source | observed fact | interpretation and alternative | confidence`

Give every material lead a state: **verified**, **provider-reported only**, **unreviewed**, **blocked** (with the exact blocker), **terminal service**, or **untested**. "Downloaded" or "row counted" is not "reviewed".

Then report:

1. The strongest conclusion the evidence supports, and the activity actually observed.
2. The exact links behind it, hop by hop.
3. The working hypothesis, clearly labelled as one.
4. What would confirm or change it, and the next input that could.
5. State confidence separately for transfers, exact public platform association, probable business affiliation or common operation, and technical/legal/beneficial ownership. A very confident affiliation finding can coexist with unresolved ownership when exact-address naming and business-discriminating operations converge, material contradictions are reconciled or explicitly outweighed by independent evidence, and alternatives and limits are explicit. Otherwise use disputed or unresolved. Do not use a fixed source count, treat mirrored or predicted labels as independent proof, or invent ownership percentages.

Close the leads you could check, and name the exact blocker for each one you could not. Never claim that every chain, transaction or source has been exhausted. When a later finding overturns an earlier claim, correct it plainly and keep the old version as history.

**In FlowLens:** keep notes on the case, save it, and export it as JSON (`flowlens_export`) so someone else can check the same evidence, coverage and cursors. Exports can contain sensitive research, so share them deliberately.

## Boundaries

- Use public data and voluntary disclosures. Do not identify private individuals, collect personal details or profile people.
- Do not bypass access controls, solve challenges, buy upgrades to see hidden fields, connect wallets or sign anything.
- Respect rate limits and denials: record them and stop, rather than retrying variants.
- A trace is research, not proof of wrongdoing. Present alternatives alongside every inference.

## FlowLens at each step

| Step                          | In the app                            | MCP tool                                       | CLI                  |
| ----------------------------- | ------------------------------------- | ---------------------------------------------- | -------------------- |
| Start a case                  | **Trace wallet**                      | `flowlens_create`                              | `create --mode live` |
| Load more history             | **Expand wallet**                     | `flowlens_expand`                              | `expand`             |
| Check coverage                | **Sources & coverage**                | `flowlens_inspect`                             | `inspect`            |
| Read flows and counterparties | Wallet inspector, **Evidence** view   | `flowlens_wallet`, `flowlens_graph`            | `wallet`, `graph`    |
| Verify one transfer           | Transfer evidence drawer              | `flowlens_evidence`                            | `evidence`           |
| Label a wallet                | **Add entity label**                  | `flowlens_annotate`, `flowlens_label_put`      | `annotate`           |
| Focus the graph               | Pin, hide, checkboxes in wallet flows | `flowlens_visibility`                          | `visibility`         |
| Safe, bridge or call trace    | **Protocol evidence**                 | `flowlens_acquire`                             | `acquire`            |
| Value in USD                  | **Load USD prices**                   | `flowlens_prices`, `flowlens_prices_at_blocks` | n/a                  |
| Keep and share                | **Save case**, **Export JSON**        | `flowlens_export`, `flowlens_import`           | `export`             |

The [MCP guide](../../../../docs/mcp.md) has every tool's arguments, and [wallet controls](../../../../docs/workspace-controls.md) covers labels and visibility in detail.
