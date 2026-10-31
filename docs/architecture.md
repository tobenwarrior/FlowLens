# Engine and investigation boundaries

FlowLens has one evidence engine and four callers: browser, CLI, HTTP API and stdio MCP. Domain code has no provider credentials, filesystem imports or UI dependencies. Transport receives unknown data, validates it, and commits a page only after its evidence and cursor are consistent.

## Data and state

- A transfer is identified by chain, transaction hash, transfer kind, event/trace identity and asset contract. More than one transfer may share a transaction hash. Repeated pages cannot inflate counts.
- Raw amounts are integer strings. `BigInt` accounting separates asset contracts and chains. Gross inflow/outflow both count a self-transfer and its net is zero. No transfer is automatically interpreted as a trade.
- An investigation contains its focus wallet, evidence, nodes, provenance-aware labels, per-provider wallet/chain coverage, cursors, notes and presentation state. Its version is `1`.
- Loaded history and graph traversal are separate. Expansion names one wallet/chain, advances explicit page budgets, and preserves the original focus wallet. No recursive fanout is implicit.
- A coverage stream can exhaust while other chains/transfer kinds remain absent. Provider errors retain the last successful evidence/cursor. Conflicting payloads under an existing evidence ID reject the page.
- The parsed case snapshot is bounded to 5 MB, 20,000 transfers and 2,000 retained nodes. The human graph is a readable projection of the focus wallet plus at most 80 counterparties; it does not discard retained history or addresses.
- Imports reconstruct known fields, canonicalize timestamps to UTC and reject invalid mode/evidence combinations. This validates shape and internal consistency; importing JSON does not authenticate a source's claims.
- Browser persistence is local storage; durable agent/API cases are private JSON files. CLI and API share atomic writes and writer locks. Full-snapshot API saves use the original `updatedAt` for conflict detection.

## Implemented providers

The synthetic provider is deterministic and offline. It describes its entire page stream as fictional. The Etherscan adapter is server-side and opt-in: its separate native/token cursors share a frozen block fence, ERC-20 identities come from successful matching receipts, and it has no internal stream. Without a key, the legacy keyless Blockscout adapter serves Ethereum and Derive Chain from fixed explorer hosts. On Base, a configured loopback self-hosted Blockscout endpoint selects first, then a user-supplied `ALCHEMY_API_KEY` selects the bounded `alchemy-transfers` adapter, then `BLOCKSCOUT_API_KEY` adds the unified hosted route. The same Blockscout key adds unified Arbitrum access and the explicitly expanded Robinhood Chain (4663) route; Etherscan retains precedence on Arbitrum when configured, but does not cover Robinhood. Account-plan restrictions, self-hosted readiness and provider/case coverage remain explicit and are not fallback triggers. Blockscout per-stream cursors wrap `next_page_params`; self-hosted provider IDs use the `blockscout-self-hosted-v1-` prefix and bind cursors to a hashed endpoint identity; Alchemy cursors re-query frozen block-boundary identities instead of retaining short-lived page keys; and internal transfers are checked against each provider's call trace. HypurrTrace adds keyless HyperEVM (999) indexed native, ERC-20 and internal history under provider ID `hypurrtrace-indexed`, with a frozen index fence and explicit 10,000-row partial bound. Current provider behavior and limits live in [providers.md](providers.md).

HyperCore is a separate, standalone operation over Hyperliquid's public non-funding ledger. It reads one account/time-window page of up to 500 entries, retains an inclusive cursor and declares provider retention undocumented. With a live case it persists `protocolEvidence.hypercore`; it never changes EVM chain-999 transfers, graph nodes or gross/net totals, and exhaustion never sets `fullHistory` true.

`server/acquire.ts` coordinates bounded Safe, CCTP and internal-trace adapters through a fixed public RPC transport. The CLI, HTTP API, MCP and browser use this shared service. It returns private-mode protocol bundles with analysis, warnings, errors and per-adapter scope. Optional attachment merges retained observations into a live case without adding indexed transfers. A live `historyMode: "evidence-only"` case begins empty, marks wallet history unsupported and requires no key or provider request at creation.

Safe acquisition supports Ethereum/Arbitrum snapshots and bounded service history, with optional EOA recovery over matched direct execution calldata and historical contract-bound digests. Those proofs remain narrower than signer participation, historical quorum or ownership attribution. CCTP V1/V2 acquisition accepts known transactions on Ethereum/Base/Arbitrum; exact emitters, routes and message identities govern normalization. Internal acquisition uses `debug_traceTransaction`/`callTracer` after transaction, receipt and canonical-block checks and reports unavailable/unsupported capability explicitly. Its coverage remains partial and transaction scoped. See [acquisition workflows](acquisition.md), [Safe](safe-provider.md), [bridge](bridge-provider.md) and [trace](trace-provider.md) boundaries.

The browser can run the demo engine directly. Live operations pass through the local HTTP server. Both return the same investigation contract. JSON exports can be inspected and expanded by the CLI without a GUI.

## Deliberate scope limits

This slice is a wallet-history and transfer-evidence tool. It does not claim complete economic funding, asset balances, ownership, legal attribution, trade reconstruction or protocol credit matching. A label can be sourced without being true; an API response can be internally consistent without being independently verified.

Supplied replay and targeted acquisition retain separate observations for these claims, with deliberately limited verification:

1. Safe genesis/current configuration, historical changes, confirmations and direct execution signature material. Acquisition does not reconstruct genesis or every configuration change; a configured quorum is not evidence of who actually participated in an execution.
2. Exact protocol-indexed bridge joins, source burns/escrows, destination receipts/credits and fees. Matching amounts or timing alone is insufficient; pooled-service customer joins may remain missing.
3. Protocol operations, trade legs, lifecycle rows, premium, notional and settlement transactions. The correct settlement chain is part of identity. An issuer entitlement does not establish corporate ownership.
4. Independent public attribution, provider reports, predictions, user assertions and historical labels. A repeated label is not independent corroboration.

An extension should introduce explicit claim/evidence relations for these domains, with scoped coverage and source rights. It should not overload a transfer row or derive unsupported ownership from graph proximity. No private investigation archive or proprietary provider output belongs in a public fixture.

## Release work still required

FlowLens is licensed [AGPL-3.0-only](../LICENSE). Release checks and source/data-use review are covered in [contributing](../CONTRIBUTING.md). Fixture tests do not establish live provider availability or complete coverage.

Remaining product limits include reorg reconciliation, current-window refresh, account-wide cross-process rate budgeting, richer protocol adapters, arbitrary grouping/manual layout, complete Safe historical authorization, contract/approved-hash signature validation and independently authenticated chain evidence. Public hosting would additionally need authentication and a different network/security model.

## Protocol replay and MCP

`safe.ts`, `bridges.ts` and `internal.ts` strictly parse supplied observations. `protocols.ts` coordinates mode-separated bundles and analyses. The optional investigation `protocolEvidence` field is durable and backward compatible with earlier version-1 snapshots; it never silently augments indexed transfers. The UI shows replay in a progressive drawer rather than mixing it with source coverage.

`server/agent.ts` is the coded operation boundary for MCP and HTTP replay/acquisition. The official SDK owns stdio protocol framing; no custom JSON-RPC transport is implemented. The 22 tools include `flowlens_acquire`, `flowlens_derive` and `flowlens_hypercore`, and accept bounded JSON and case IDs, not provider URLs, credentials or filesystem paths. The self-hosted Base origin is server-environment configuration only; no HTTP or MCP operation accepts it. Graph cursors pin revision and filters. Case writes share the existing CLI/API file locks. Tool responses are bounded and report uncertain post-mutation overflow explicitly; inspect before retrying.

The standalone `derive` operation inspects public venue associations, one margin snapshot or one time-bounded trade page through the same CLI, HTTP and MCP service. These are provider-reported venue records, not indexed transfers, chain ownership proofs or beneficial-owner labels.

The `collect` CLI command is an explicit sequential loop over one wallet and chain. It accepts 1–200 pages, saves each committed page, and stops on provider quota/access errors or evidence budgets. It does not retry, use a fallback provider or expand counterparties; the same engine and case locks enforce the retention bounds above.
