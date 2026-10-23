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

Search social media for the **full** address. A match on a short prefix counts only once the full address and chain match. Keep the original post URL and date, and attribute a third party's claim to its author as unverified.

**Stop at a personal-looking handle.** Record it and go no further. This guide is for public businesses and voluntary disclosures, never for identifying private people.

## 8. Venue accounts and trades

Trading venues keep accounts that public chains do not show. Endpoints and access change, so check the current documentation; these notes reflect October 2026.

**Hyperliquid.** Start with the `userRole` query on the public info API. "missing" means the address has no HyperCore account, so it has no vault, sub-account, referral code or agent. For an existing account, read its sub-account names, vault details and equities, referral code and referrer, agent names, and internal-transfer ledger from the start. Hypurrscan shows public aliases.

**Derive.** Derive's public API maps wallets and subaccounts in both directions. Treat a supplied subaccount ID as a hypothesis: check both the reverse and the forward mapping before tracing it, because it may belong to someone else. Current settlement and older Derive Chain (957) history are different places. A wallet's own session keys cannot be listed publicly. Collateral types are visible, and a custodian-specific collateral token can mark that custodian's clients, as a current-state lead only. An approval is permission, not a deposit, and a depositor or session signer is not necessarily the owner.

**In FlowLens:** choose **Derive** as the expansion network, or `--chain 957` and `chainId: 957`, to load a wallet's Derive Chain transfers. Subaccount balances, positions and trades live inside Derive's contracts and are not shown as transfers.

**Matching a trade to a counterparty.** Join the same trade ID, instrument, time, size and price, with opposite sides and both full wallets and subaccounts. One exact pair identifies that pair's counterparties, not the maker of every fill, and not the owner of either account. RFQ, quote, operation and batch identifiers are different things. Close timing across many trades describes an execution pattern, not identity.

**Sizing a trade.** Keep gross underlying notional, cash premium and risk separate, each with its convention and timestamp. Net premium is not maximum loss, and trade size says nothing about ownership.

## 9. Testing a named firm

When someone asks "is this firm X?":

1. List the firms the venue or protocol publicly names, such as market makers, investors and partners, with the source and date.
2. Find each firm's publicly labelled wallets.
3. Test address joins with the target: direct transfers, a shared dedicated deposit address, a funding parent, a shared session key, a venue collateral marker.
4. Report each firm as **joined** (with the exact path), **not joined within the stated scope**, or **untestable**.

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
5. Confidence stated separately for transfers, provider labels, possible common operation and ownership. Do not invent ownership percentages.

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
