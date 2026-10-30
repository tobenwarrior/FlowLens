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
- candidate customer-specific exchange deposit address (assignment must be checked)
- bridge, including CCTP
- mint, burn or redemption contract
- protocol contract, router or solver
- treasury or Safe
- unknown wallet

**A CEX label is not automatically a dead end.** A candidate customer-specific deposit endpoint warrants a bounded review of its other depositors, assignment window, gas funding and sweeps; use the [clustering workflow](../../cluster-wallets/SKILL.md). Do not trace indiscriminately through hot/omnibus wallets or link their depositors to arbitrary withdrawals. A pooled service remains a boundary unless an account-specific or protocol message/order identifier supports the next step.

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

## Monitoring venue activity without overcalling a sale

- A receipt-confirmed swap must match the exact transfer and a canonical pool/factory; a router, symbol or pool-shaped log alone is insufficient.
- A direct token transfer to an unrelated contract, without same-receipt swap/fill and consideration or returned asset, does not establish a sale in that transaction.
- Persist only bounded one-hop recipient leads with transaction/log provenance; a lead is a follow-up observation, not ownership attribution.
- Never recurse automatically through leads; pooled CEX endpoints remain terminal without an independent account-specific join.
- Value proceeds using the asset actually returned by the receipt, not the input token's spot quote.
- A current quote is spot-indicative; call USD realized only with a time-scoped historical quote and a verified recipient join.
- Keep remaining balances as chain/contract-scoped snapshots; do not derive them from sale proceeds or historical gross flow.

## Continue by question

- [Names, venue accounts, corporate attribution and reporting](attribution-and-venues.md) continues steps 7–9.
- [Deposit-address clustering](../../cluster-wallets/SKILL.md) distinguishes exchange infrastructure from candidate account relationships.
