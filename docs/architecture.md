# Engine and investigation boundaries

FlowLens has one evidence engine and four callers: browser, CLI, HTTP API and stdio MCP. Domain code has no provider credentials, filesystem imports or UI dependencies. Transport receives unknown data, validates it, and commits a page only after its evidence and cursor are consistent.

## Data and state

- A transfer is identified by chain, transaction hash, transfer kind, event/trace identity and asset contract. More than one transfer may share a transaction hash. Repeated pages cannot inflate counts.
- Raw amounts are integer strings. `BigInt` accounting separates asset contracts and chains. Gross inflow/outflow both count a self-transfer and its net is zero. No transfer is automatically interpreted as a trade.
- An investigation contains its focus wallet, evidence, nodes, provenance-aware labels, per-provider wallet/chain coverage, cursors, notes and presentation state. Its version is `1`.
- Loaded history and graph traversal are separate. Expansion names one wallet/chain, advances explicit page budgets, and preserves the original focus wallet. No recursive fanout is implicit.
- A coverage stream can exhaust while other chains/transfer kinds remain absent. Provider errors retain the last successful evidence/cursor. Conflicting payloads under an existing evidence ID reject the page.
- Imports reconstruct known fields, canonicalize timestamps to UTC and reject invalid mode/evidence combinations. This validates shape and internal consistency; importing JSON does not authenticate a source's claims.
- Browser persistence is local storage; durable agent/API cases are private JSON files. CLI and API share atomic writes and writer locks. Full-snapshot API saves use the original `updatedAt` for conflict detection.

## Implemented providers

The synthetic provider is deterministic and offline. It describes its entire page stream as fictional. The Etherscan adapter is server-side and opt-in. Its separate native/token cursors share a frozen block fence; ERC20 identities come from successful, matching transaction receipts. Current provider behavior and limits live in [providers.md](providers.md).

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

Before public release, the owner must select a project license and confirm source/data-use rights, review the final archive and choose its destination/visibility. Follow the [release checklist](release-checklist.md). Live provider acceptance is optional and remains distinct from source readiness; [live verification](live-verification.md) records the narrow observations made so far.

Remaining product limits include reorg reconciliation, current-window refresh, account-wide cross-process rate budgeting, richer protocol adapters, arbitrary grouping/manual layout, complete Safe historical authorization, contract/approved-hash signature validation and independently authenticated chain evidence. Public hosting would additionally need authentication and a different network/security model.

## Protocol replay and MCP

`safe.ts`, `bridges.ts` and `internal.ts` strictly parse supplied observations. `protocols.ts` coordinates mode-separated bundles and analyses. The optional investigation `protocolEvidence` field is durable and backward compatible with earlier version-1 snapshots; it never silently augments indexed transfers. The UI shows replay in a progressive drawer rather than mixing it with source coverage.

`server/agent.ts` is the coded operation boundary for MCP and HTTP replay/acquisition. The official SDK owns stdio protocol framing; no custom JSON-RPC transport is implemented. The 12 tools include `flowlens_acquire` and accept bounded JSON and case IDs, not provider URLs, credentials or filesystem paths. Graph cursors pin revision and filters. Case writes share the existing CLI/API file locks. Tool responses are bounded and report uncertain post-mutation overflow explicitly; inspect before retrying.
