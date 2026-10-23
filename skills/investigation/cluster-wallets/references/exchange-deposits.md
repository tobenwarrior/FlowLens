# CEX deposit endpoints: continue carefully

A hosted exchange may control a deposit address while crediting a customer account. Therefore **exchange-control infrastructure**, **possible shared account use**, and **ownership of the sending wallets** are different clusters.

## Decision tree

| Endpoint evidence | Next bounded step | Supported claim | Stop condition |
| --- | --- | --- | --- |
| Unknown exchange-labelled endpoint | Verify label time/type, code/delegation, other senders and sweeps | Classification hypothesis | Missing scope or support remains unknown |
| Plausibly dedicated deposit endpoint | Inspect inbound sources within a fixed chain/asset/time/assignment window | Candidate account-use relationship | Pooled use, reassignment or missing required account identifier |
| Hot wallet, omnibus or shared gas station | Record its role and relevant receipt/sweep | Exchange infrastructure use | Do not cluster its customers or traverse arbitrary withdrawals |
| Memo/tag or shared-address credit system | Require the independently supported destination tag/account/order identifier | Identifier-specific relationship | Address alone is not enough |
| Bridge/solver/protocol endpoint | Follow an exact supported message/order ID to successful credit | Protocol delivery within verified scope | Matching amount/time alone is not delivery |

## 1. Establish the deposit-address hypothesis

Record the full chain-scoped address and mutable label provenance. A provider label such as exchange deposit is an assertion, not a customer assignment record. Code-empty does not mean one customer; contract code does not by itself mean pooled custody. Verify code/delegation and control roles at the block being discussed when the available source permits it.

Check actual token sender, transaction executor, gas funder, deployer, beneficiary and sweep destination separately. Providers can conflate these roles. An account-abstraction implementation or public factory is not the account owner.

## 2. Review other depositors without becoming a crawler

- Fix chain, date window, canonical token/native asset, transfer categories and request budget. Reuse retained evidence; refresh mutable labels or uncovered ranges only when authorized.
- Inspect the endpoint's loaded IN and OUT separately. Expand one explicitly selected endpoint at a time; inspect cursor, provider errors, stream warnings and page count after each call. Do not continue automatically just because the graph shows more peers.
- Count distinct observed source addresses, meaningful receipts and unique transactions. State all exclusions and the denominator; graph-node count is not depositor count.
- Dust, zero-value events, fake-symbol tokens and poisoning lookalikes are not evidence of account use. Keep their raw records; exclude them from the specific inference with a documented reason rather than deleting evidence. Never discard a genuine small test deposit solely because it is small.
- Inspect the whole eligible bounded set, not only a labelled peer that seems promising. Record unrelated senders, failed/reversed events and contradictory uses.
- A recurring target/peer pair at the same endpoint is a candidate only after checking whether the assignment windows overlap. Distinct addresses across time can be unrelated customers of a reassigned endpoint.

## 3. Distinguish customer-related evidence from infrastructure

Retain deposits, subsequent sweeps, gas top-ups, fees/balances where observed, time gaps and exceptions. Repeated deposit-to-hot-wallet sweeps can corroborate an exchange-infrastructure cluster. They do not make every depositor part of the exchange or reveal the beneficial customer.

A common gas supplier, shared exchange withdrawal batch, relayer, deployer, bridge, SDK or fee recipient usually explains common infrastructure. Do not treat these as independent corroborating ownership signals just because there are several of them. Related observations from one pipeline are not independent sources.

Do not trace through the hot-wallet pool and associate an arbitrary later withdrawal with a deposit by similar size or timing. Without an account-specific or protocol-specific join, that route is terminal-service.

## 4. Required alternative explanations

Test these as possibilities, not assumptions about a particular exchange:

- **Pooled or omnibus collection:** many customers settle to one endpoint. A large sender set is strong contrary context; a small observed set can simply mean partial history.
- **Memo/destination tags or account IDs:** one address may serve multiple accounts. Join on the supported identifier as well as address/chain; if unavailable, record the gap. Not every asset or exchange uses such identifiers.
- **Rotation and reassignment:** a customer can receive different deposit addresses, and a reused address can have a different assignment later. Neither equal nor unequal addresses alone settle the relationship.
- **Broker/custodian or merchant collection:** clients, invoices, agents and third-party payers may share an endpoint while controlling separate source wallets.
- **Third-party payments or refunds:** another sender may be paying on behalf of someone else, reimbursing a transfer, or returning funds.
- **Stale labels and chain mismatch:** refresh label provenance and verify the exact network. Do not merge the same hex address across chains without separate control evidence.

The memo/tag, rotation/reassignment and merchant examples are general counterexamples, not claims that any specific provider exposes customer assignments or that these checks were available in a previous investigation. Public chain data generally cannot resolve private exchange-account records.

## 5. What would strengthen or falsify the relationship

Look for contemporaneous, public account-specific evidence, repeated independently supported use and relevant control observations. State whether a source supports endpoint assignment, account use, signing capacity or an organization disclosure; none silently fills the others. Never request private customer records, credentials or a signature to manufacture proof.

Falsifiers include a shared-service classification, demonstrated reassignment, incompatible memo/account identifiers, unrelated high-volume depositors, a different verified controller at the relevant block, or canonical receipts contradicting the claimed transfers. If access is denied or historical state is unavailable, the result is unknown rather than refuted.

This EVM workflow does not import UTXO common-input heuristics: multiple call participants are not necessarily jointly controlled inputs.

Use [the hypothesis ledger](hypothesis-ledger.md) to retain evidence, counterevidence and route closures. Return to [cluster-wallets](../SKILL.md) for the CLI/MCP workflow.
