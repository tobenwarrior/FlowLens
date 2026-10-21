# Changelog

## 0.1.0 — local release candidate, 21 October 2026

This source has not been published. No project license has been selected.

### Implemented

- Local graph and evidence workspace backed by the same typed engine as the HTTP API, JSON CLI and stdio MCP server.
- Synthetic investigation with exact integer flows, scoped filtering, bounded wallet expansion, provenance, explicit coverage gaps and validated import/export.
- Durable local case storage with writer locks, stale-save protection and immutable investigation identity.
- Supplied Safe, bridge and internal-trace evidence replay, including ambiguity/conflict states and clear separation from independent verification.
- Optional Etherscan V2 native/ERC20 history with receipt validation, bounded pagination and coded provider errors.

- Shared targeted acquisition through CLI, HTTP API, browser and the twelfth MCP tool, `flowlens_acquire`; private observations merge into live cases without changing indexed transfer totals.
- Explicit evidence-only live cases that need no Etherscan key or indexed-history request at creation.
- Fixed keyless RPC transport for Ethereum, Base and Arbitrum with bounded calls, duration, response bytes and pacing.
- Safe snapshot/history acquisition on Ethereum/Arbitrum and optional limited direct-call EOA recovery; confirmations, calldata proof and historical quorum remain separate claims.
- Known-transaction CCTP V1/V2 acquisition with exact official identities, conservative V2 joins and unverified independent credit.
- Transaction-scoped internal `callTracer` acquisition with explicit unsupported/unavailable capability and partial coverage.

### Release preparation

- Meaningful ESLint checks, a Node 24/26 CI workflow, deterministic source archive and sorted SHA-256 manifest.
- Explicit archive allowlist, redacted credential scan, empty environment-template check and symlink rejection.
- Release checklist, nonbinding license comparison and preserved selected dependency notices.

Final integration test totals and clean-room build results must be recorded from the completed source snapshot. This changelog does not substitute historical baseline counts for current verification. The [public live verification record](docs/live-verification.md) documents observed provider capability separately from fixture tests.

### Release limitations

License/copyright ownership and data-use rights remain owner decisions. The source archive contains no private case exports, local screenshots, credentials or installed dependencies. A successful build does not establish provider completeness, source authenticity, ownership attribution or redistribution permission for imported data.
