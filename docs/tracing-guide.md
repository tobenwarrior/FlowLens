# Tracing guide

How to follow money with FlowLens and reach conclusions that hold up. It is written for people and for AI agents driving FlowLens, and it comes from real investigations: what worked, and the mistakes that taught each rule.

The short version: **a transfer proves movement, not ownership.** Most tracing mistakes come from letting one kind of evidence stand in for another. This guide keeps them apart.

## Keep the claims apart

Every conclusion about a wallet is one of these claims, and each needs its own evidence:

| Claim                 | What it says                                                 | Typical evidence                                                                |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Transfer link         | Money moved between A and B                                  | A successful transaction with its transfer log                                  |
| Infrastructure use    | A and B used the same exchange, relayer, deployer or factory | Shared withdrawal batch, deployer or service contract                           |
| Account relationship  | A and B touch the same account or deposit address            | A dedicated deposit address, a venue subaccount mapping                         |
| Technical control     | An address can sign for or configure another                 | Safe owners and threshold at that block, an executed signature                  |
| Identity or ownership | A named business or person controls the wallet               | A first-party disclosure naming the full address, or a sourced chain of control |

Confidence in one claim does not carry over to the next. A verified transfer from an exchange says nothing about who owns the recipient. A Safe owner is a configured signing address, not a beneficial owner.

In FlowLens, record what you learn about a wallet as a label with a **claim type** (provider assertion, hypothesis or verified evidence), a **confidence** (unverified, reported, or verified by supplied evidence), and its source, source URL, observed time and an evidence note. Select the wallet and use **Add entity label**, or call `flowlens_annotate` with the case open. Labels you save are remembered for later traces (`flowlens_label_put`, `flowlens_label_search`).

## Before you start

- Write down the question and the scope: the full address, the chains, and the dates.
- Key everything by **chain ID plus the full 40-hex address**. Never join on a shortened address. The same address on another chain may have a different controller.
- Separate what the wallet did from what it received unasked. Airdropped tokens and dust are not activity.

**In FlowLens:** paste the address and press **Trace wallet**, or call `flowlens_create` with `mode: "live"`. Each case keeps its own evidence, coverage and notes, and can be saved, exported (`flowlens_export`) and resumed later.

## 1. Load history and know your coverage

Inflows and outflows tell different stories, so read them separately, and keep native, token and internal transfers apart. Before you say anything about "all" of a wallet's activity, know the denominator: which chains, dates, transfer types and pages you actually loaded.

- History loads newest first, a page at a time. An empty result means nothing is loaded yet, not that nothing happened. Say "no link found within [scope]", not "no link".
- A provider error, a rate limit or an HTTP 200 with an empty or error payload leaves the fact unknown. It is never zero activity.
- Count transfers and unique transactions separately: one transaction can carry many transfers.

**In FlowLens:** **Sources & coverage** lists every loaded wallet and chain with its provider, streams (native, ERC-20, internal), pages, status and resume cursor. **Expand wallet** (`flowlens_expand`) loads the next page; repeat until the stream reports it has reached the end, or note where you stopped. `flowlens_inspect` returns the same coverage to an agent. Filters for network, asset, direction and date only narrow what is loaded; they never fetch more.

## 2. Find the first meaningful funding

The first wallet to send gas to an address is often the best lead, and often a trap.

- Find the first **meaningful** native funding on each chain. Exclude dust, spam tokens and address poisoning: tiny transfers from lookalike addresses that copy the first and last characters of a real counterparty.
- An explorer's "Funded by" usually names exchange infrastructure, not the owner.
- Record the token sender, the transaction executor, the funder and the deployer separately. They are often different addresses.

**In FlowLens:** open the **Evidence** view, filter the asset to the chain's native token and the direction to inflow, and sort by time. Older history needs more pages, so expand until you reach it. Check the funding transaction in the block explorer from the evidence drawer.

## 3. Classify counterparties before reading meaning into them

Before interpreting a counterparty, decide what kind of thing it is:

- exchange hot or omnibus wallet (many customers)
- exchange deposit address (usually one customer)
- bridge, including CCTP
- mint, burn or redemption contract
- protocol contract, router or solver
- treasury or Safe
- unknown wallet

**Stop at services.** Expanding an exchange hot wallet or a bridge buries you in other people's flows. Continue past a service only when an address-specific identifier (an order, message or deposit address) supports the next hop.

An address with no code is not necessarily a dedicated customer address, and contract code does not by itself mean pooled custody. State the basis for each classification.

**In FlowLens:** select a wallet to see its flows and counterparties, label its class with its source, and **pin** the wallets that matter or **hide** the service wallets that clutter the graph. Hidden wallets keep their evidence and stay in the totals. **Group by type** arranges the graph by category.

## 4. Verify the transfers that matter

Check the largest and the repeated transfers in a primary source: success status, UTC time, sender, recipient, exact amount, token contract and the transfer log.

- Keep the outer executor, the token sender and the ultimate beneficiary apart.
- Match records by chain, transaction hash and log or trace index, never by equal amount or close time.
- Confirm the token contract, not the symbol. Lookalike tokens with familiar symbols are common.
- Keep gross sent, gross received and net separate, per chain and per token contract. A small net can hide large flows both ways. Gross flow is not profit, capital or assets under management.

**In FlowLens:** select a line on the graph, or a row in the transfer list, to open the **transfer evidence** drawer: amount, sender and recipient, network, UTC time, block, event index, exact raw amount, token contract, transaction hash, the provider that supplied it and when, and a link to verify it in the block explorer. `flowlens_evidence` returns the same record. Amounts are exact integers with their decimals, never rounded display values.

## 5. Test linking clues carefully

These techniques generate leads, not an automatic cluster of wallets owned by one person.

**Shared deposit addresses.** First decide whether the endpoint is a dedicated deposit address or a pooled one: check its other senders, its code, and where its sweeps go. A deposit address with many unrelated senders is a service boundary; do not cluster its customers. A plausible dedicated deposit address shared with a labelled wallet supports an account relationship lead, not the same owner. Third-party payments, brokers and reused addresses remain alternatives.

**Funding parents and sweeps.** A shared exchange withdrawal batch, deployer, relayer or public factory shows shared infrastructure, not common control. Regular deposits swept to an exchange hot wallet support "this is exchange infrastructure", not who the customer is.

**Timing and amount matches.** Define the matching rules before looking at examples: chains, assets, time window, amount and fee tolerance. Report matches out of all eligible events, the timing spread, the misses and a baseline. Four hand-picked close matches out of forty unchecked events are not a pattern. Matching legs may simply be one owner moving their own money.

**Bridges.** A bridge transfer is delivered only when the protocol's own message or order identifier joins the source to a successful credit on the destination chain. Matching amounts and times do not establish delivery. **In FlowLens:** **Protocol evidence** checks a known Circle CCTP transaction (`flowlens_acquire` with `kind: "bridge"`).

**Transaction fingerprints.** Transaction type, nonce pattern, function selector and gas settings can suggest automation. Wallet SDKs, relayers and bundlers share defaults, so matching fingerprints can have innocent explanations. A block builder or validator label is never an owner.

## 6. Check Safes and control at the right time

- Read a Safe's owners, threshold, modules and guards **at the block that matters**, on that chain. Current state does not show historical state, and the same address on another chain can be configured differently.
- Decode the setup call and any batched calls before concluding that the owner keys are the only authority.
- Configured signing capacity is not proof that those signers executed a given action, and the account that submitted a Safe transaction need not be an owner.

**In FlowLens:** **Protocol evidence** reads a Safe's configuration and recent history (`flowlens_acquire` with `kind: "safe"`, an optional `blockNumber`, `includeHistory` and `verifySignatures`), and a single transaction's call tree (`kind: "internal"`, where the public RPC supports tracing). These observations stay separate from the graph totals.

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

The [MCP guide](mcp.md) has every tool's arguments, and [wallet controls](workspace-controls.md) covers labels and visibility in detail.
