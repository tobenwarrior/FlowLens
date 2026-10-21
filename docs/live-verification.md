# Public verification scope — 21 October 2026

This record contains generic capability facts only. It includes no wallet identifiers, transaction hashes, raw provider responses, private cases or local proof-file paths. No real `.env` file or `ETHERSCAN_API_KEY` was configured.

| Check                                      | Observed result                                                                                                                                                                                                         | What it establishes                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved keyless Ethereum metadata request | Chain ID `1` and public block metadata were returned by the fixed PublicNode endpoint.                                                                                                                                  | Basic connectivity and that narrow metadata request worked at the time. It does not verify wallet history or protocol acquisition.                                                           |
| Bounded public transaction trace check     | Transaction, receipt and canonical block checks passed; `debug_traceTransaction` returned `RPC_METHOD_UNSUPPORTED`. The adapter reported unsupported capability, unavailable trace coverage and zero normalized traces. | This public endpoint did not supply the requested trace capability. No alternate endpoint, trace adapter or history scan was attempted.                                                      |
| Approved public Safe example               | Four keyless Ethereum RPC reads returned no contract bytecode at the frozen canonical block; configuration reported `SAFE_NOT_CONTRACT`. One Safe API request returned HTTP 200 with an empty history page.             | Narrow live RPC/service access and honest negative/empty states worked. Positive Safe configuration and execution-signature acquisition remain unverified; execution coverage stays partial. |
| Live CCTP acquisition                      | Not performed against a known live bridge transaction.                                                                                                                                                                  | Receipt/calldata normalization and matching are contract-tested, without a successful live bridge acceptance claim.                                                                          |
| Etherscan indexed history                  | Not performed: no key was configured.                                                                                                                                                                                   | No claim about live indexed-wallet completeness, plan eligibility or successful real-wallet history retrieval.                                                                               |
| Base and Arbitrum acquisition              | Boundary-tested with injected responses; no live acquisition established here.                                                                                                                                          | The supported-chain configuration and mock behavior do not prove endpoint capabilities or historical coverage.                                                                               |

The fixed transport is described in [rpc-provider.md](rpc-provider.md). The trace adapter's checks and capability model are in [trace-provider.md](trace-provider.md), and Safe-specific boundaries are in [safe-provider.md](safe-provider.md). The public endpoint reference is [PublicNode Ethereum](https://ethereum.publicnode.com/).

Synthetic unit tests and browser mocks verify normalization, contradictions, error handling and UI contracts. They are distinct from successful live provider checks.

## Local release verification

Verified on macOS with Node **26.8.1** and npm **11.19.0**:

- **213/213 tests passed**, including actual MCP-client workflows, HTTP/CLI persistence, Safe provider-to-merge pagination and recovery, bridge replacements, trace capability failures and near-limit case-file roundtrips.
- Typecheck, ESLint, Prettier and production build passed.
- Chrome production QA: **9 scenarios passed** at 1440, 834 and 390 pixels, with no page errors. Additional acquisition-form contract QA covered 7 scenarios at the same three sizes, with no overflow or console errors. All browser provider responses were sanitized mocks.
- A fresh extracted source archive installed with `npm ci --offline --no-audit --no-fund`; lint, formatting, build and **213/213 tests passed** there too.
- Runtime dependency advisory audit reported **0 vulnerabilities** at verification time. This is an advisory observation, not a guarantee of security.
- Source allowlist/credential audit passed; repeated source packaging produced byte-identical archives and manifests. Checksums accompany the local archive.
- Independent code review found no remaining must-fix issues within its bounded review after the documented fixes.

These local results establish the tested release behavior. They do not certify live providers, public hosting, a hosted CI run, Node 24 execution or data redistribution rights. Use the [release checklist](release-checklist.md) when preparing a later source snapshot.

Wallet and transaction queries disclose the selected identifiers to external services. Use fixtures until that disclosure is explicitly authorized. A completed request also does not establish provider authenticity, consensus finality, historical completeness, ownership attribution or permission to redistribute the returned data. No private investigation was queried or added to public fixtures.
