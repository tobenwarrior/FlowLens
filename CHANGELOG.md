# Changelog

## 0.1.0 — local release candidate, 21 October 2026

Unreleased publicly. Development commits are in the private repository; no project license has been selected.

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

### Readiness hardening

- Consistent FlowLens branding, separate human/agent quickstarts, mobile agent help and two reviewed synthetic screenshots.
- Hook-free lockfile installation, `npm start`, a Node 24.12+ requirement and immutable CI action references.
- A 2 MB Etherscan response cap, atomic rejection of conflicting event identities and bounded regular-file JSON imports.
- Configuration-only Safe reads can add and resume history while preserving earlier evidence and provenance.

### Release preparation

- Meaningful ESLint checks, a Node 24/26 CI workflow, deterministic source archive and sorted SHA-256 manifest.
- Explicit archive allowlist, redacted credential scan, empty environment-template check and symlink rejection.
- Release checklist, nonbinding license comparison and preserved selected dependency notices.

The destination and fresh source-archive install passed 224/224 tests, lint, typecheck, formatting and build. Both Node 24 and Node 26 CI jobs passed. Chrome QA passed 9 regression scenarios plus 15 human/agent usability checks across desktop, tablet and phone. The [public live verification record](docs/live-verification.md) documents observed provider capability separately from fixture tests.

### Release limitations

License/copyright ownership and data-use rights remain owner decisions. The source archive contains no private case exports, private/temporary QA artifacts, credentials or installed dependencies; the two reviewed synthetic documentation screenshots are included. A successful build does not establish provider completeness, source authenticity, ownership attribution or redistribution permission for imported data.

## Wallet flows and local attribution

- Added chain/address-scoped wallet counterparties, exact per-asset gross/net totals, selected transfer pages and graph visibility controls. Hiding paths preserves evidence and accounting.
- Added local label editing and shared CLI/API/MCP annotation and visibility operations. Claims retain source, observation time, confidence and evidence notes; ownership is not inferred.
- Added revision checks for agent wallet paging and local mutation conflicts. Live indexed history still requires an existing permitted Etherscan key and remains unverified on this instance.
