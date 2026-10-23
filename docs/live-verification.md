# Public verification scope — 21 October 2026

This record contains generic capability facts only. It includes no wallet identifiers, transaction hashes, raw provider responses, private cases or local proof-file paths. No real `.env` file or `ETHERSCAN_API_KEY` was configured.

| Check                                      | Observed result                                                                                                                                                                                                         | What it establishes                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved keyless Ethereum metadata request | Chain ID `1` and public block metadata were returned by the fixed PublicNode endpoint.                                                                                                                                  | Basic connectivity and that narrow metadata request worked at the time. It does not verify wallet history or protocol acquisition.                                                           |
| Bounded public transaction trace check     | Transaction, receipt and canonical block checks passed; `debug_traceTransaction` returned `RPC_METHOD_UNSUPPORTED`. The adapter reported unsupported capability, unavailable trace coverage and zero normalized traces. | This public endpoint did not supply the requested trace capability. No alternate endpoint, trace adapter or history scan was attempted.                                                      |
| Approved public Safe example               | Four keyless Ethereum RPC reads returned no contract bytecode at the frozen canonical block; configuration reported `SAFE_NOT_CONTRACT`. One Safe API request returned HTTP 200 with an empty history page.             | Narrow live RPC/service access and honest negative/empty states worked. Positive Safe configuration and execution-signature acquisition remain unverified; execution coverage stays partial. |
| Live CCTP acquisition                      | Not performed against a known live bridge transaction.                                                                                                                                                                  | Receipt/calldata normalization and matching are contract-tested, without a successful live bridge acceptance claim.                                                                          |
| Etherscan indexed history                  | Not performed: no key was configured.                                                                                                                                                                                   | No claim about live indexed-wallet completeness, plan eligibility or successful real-wallet history retrieval.                                                                               |
| Keyless Blockscout indexed history         | See [Blockscout keyless history](#blockscout-keyless-history): four pages of one public Ethereum address loaded through the CLI with no key and no coverage error.                                                      | The adapter works end to end against `eth.blockscout.com` as it answered that day. It does not establish complete history for that or any wallet.                                            |
| Base and Arbitrum acquisition              | Boundary-tested with injected responses; no live acquisition established here.                                                                                                                                          | The supported-chain configuration and mock behavior do not prove endpoint capabilities or historical coverage.                                                                               |

The fixed transport is described in [rpc-provider.md](rpc-provider.md). The trace adapter's checks and capability model are in [trace-provider.md](trace-provider.md), and Safe-specific boundaries are in [safe-provider.md](safe-provider.md). The public endpoint reference is [PublicNode Ethereum](https://ethereum.publicnode.com/).

Synthetic unit tests and browser mocks verify normalization, contradictions, error handling and UI contracts. They are distinct from successful live provider checks.

## Blockscout keyless history

On 21 October 2026 the owner authorized one live run against a public Ethereum address they chose. With `ETHERSCAN_API_KEY` and `FLOWLENS_BLOCKSCOUT` unset, CLI `create --mode live` and one `expand --chain 1 --pages 3` loaded four pages (ten rows per stream) from `eth.blockscout.com` (backend v11.3.3):

- 84 transfers: 22 native, 40 ERC20 and 22 internal. Every internal transfer the explorer listed for the address was matched to its transaction's call trace and kept; none sat under a reverted call.
- Coverage `partial` with `blockscout-v2` as the provider and native, ERC20 and internal streams; no error code, no omitted rows and no throttling. The create took about 15 seconds and the three-page expansion about 33 seconds at the 500 ms pacing.
- Three native and three ERC20 transfers were cross-checked against PublicNode receipts: status, sender, recipient, amount, block and log index all matched.
- The ERC20 stream included unsolicited tokens, one with a lookalike `ETH` symbol. Symbols remain provider metadata.

Host checks the same day: `base.blockscout.com` and `arbitrum.blockscout.com` answered plain server requests with HTTP 403 and a Cloudflare browser check, so neither chain is enabled. `optimism.blockscout.com` redirects to another host; Optimism and Derive Chain are not in FlowLens's chain registry and were not enabled. The keyless v2 limit header read 180 per minute.

Limits: one address, one day, one explorer version. The run stopped at a partial cursor, so older history was not read. Agreement on six sampled transfers is not an audit of the other 78. Explorer v12 changes pagination echoes; the adapter does not depend on them, but no v12 explorer was exercised with a wallet. The private run notes, including the address, stay outside the repository.

## Live public-wallet check — 23 October 2026

With `ETHERSCAN_API_KEY` unset, the web app and CLI traced three public organisation wallets through `eth.blockscout.com`: the ENS DAO endowment (`endowment.ensdao.eth`, `0x4F2083f5fBede34C2714aFfb3105539775f7FE64`), the ENS DAO wallet (`wallet.ensdao.eth`, `0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7`) and the Uniswap governance timelock (`0x1a9C8182C09F50C8318d769245beA52c32BE35BC`, Blockscout contract name `Timelock`).

- Blockscout's `internal-transactions` endpoint did not answer for any of them: adapter requests hit the 15-second timeout and a direct 60-second request got no response, while the transactions and token-transfers endpoints answered in under a second. While it was down, every live trace failed whole and committed nothing. The adapter now keeps a page's native and ERC20 rows when only the internal stream is unavailable, records internal transfers as uncovered with a warning, and leaves the internal cursor in place for the next page. Later that day the endpoint answered again and a CLI `create` plus `expand --pages 1` covered all three streams.
- The ENS DAO endowment's first page held 12 transfers with 8 counterparties (ETHx, WETH, weETH, USDC, syrupUSDC, ETH and one unsolicited token); the expansion brought the case to 23 transfers with no error. The README screenshots show this trace, captured from a production build with an empty label store.
- All three wallets' newest pages included unsolicited airdropped tokens; on the ENS DAO wallet and the Uniswap timelock they were most of the rows.

Limits: three addresses on one day, stopped at partial cursors, so older history was not read. No transfers were cross-checked against receipts in this pass.

## Local release verification

Verified on macOS with Node **26.8.1** and npm **11.19.0**:

- **224/224 tests passed**, including actual MCP-client workflows, HTTP/CLI persistence, Safe provider-to-merge pagination and recovery, bridge replacements, trace capability failures and near-limit case-file roundtrips.
- Typecheck, ESLint, Prettier and production build passed. The actual destination installed from the lockfile with lifecycle hooks disabled.
- Node **24.22.0** / npm **11.19.1** passed local compatibility checks. The current code also passed both Node 24 and Node 26 Linux jobs in the repository's [CI workflow](https://github.com/tobenwarrior/FlowLens/actions/workflows/ci.yml).
- Chrome production QA: **9 scenarios passed** at 1440, 834 and 390 pixels, with no page errors. An additional human/agent usability review passed 15 checks across those sizes, including mobile agent help, precise source coverage, transaction drilldown and no-key evidence-only onboarding. No page errors or external provider requests occurred; provider-specific browser responses were sanitized mocks.
- A fresh extracted source archive installed with `npm ci --offline --ignore-scripts --no-audit --no-fund`; lint, formatting, build and **224/224 tests passed** there too.
- Runtime dependency advisory audit reported **0 vulnerabilities** at verification time. This is an advisory observation, not a guarantee of security.
- Source allowlist/credential audit passed; repeated source packaging produced byte-identical archives and manifests. Checksums accompany the local archive.
- Independent code review found no remaining must-fix issues within its bounded review after the documented fixes.

These local and CI results establish the tested source behavior on the recorded platforms. They do not certify live providers, public hosting, other platform/version combinations or data redistribution rights. Use the [release checklist](release-checklist.md) when preparing a later source snapshot.

Wallet and transaction queries disclose the selected identifiers to external services. Use fixtures until that disclosure is explicitly authorized. A completed request also does not establish provider authenticity, consensus finality, historical completeness, ownership attribution or permission to redistribute the returned data. No private investigation was queried or added to public fixtures.

## Wallet workflow verification

The wallet-flow and local-attribution pass added selected-wallet counterparty/transfer summaries, graph selections, explicit label claims and shared local-case refresh. Final automated checks passed **248/248 tests** with no failures or skips, plus lint, typecheck, formatting, production build and the 92-file sanitized source audit. GitHub CI also passed on Node 24 and 26 for the implementation commit. CLI/API/MCP tests exercise persisted selections and labels, exact totals, mode separation, revision conflicts and stale wallet pages.

The user's Brave browser was checked at 1440, 834 and 390 pixels: no page overflow; counterparty and individual-transfer toggles; select all/none; hidden-wallet recovery; unchanged loaded gross/net totals; refresh persistence; local label source/time and removal; reversed-date recovery; token/direction filters; transaction drilldown; and bounded page expansion. An agent-side local API label edit appeared after browser reload in an evidence-only case using the synthetic example address, with zero history records and no provider query. The preview was returned to the marked synthetic demo.

Reproducible Playwright regression scenarios were added for the new UI workflow; this pass exercised the user's browser directly rather than launching that separate browser harness. The automated test count above refers to the Node regression suite, including CLI/API/MCP end-to-end contracts. These results do not establish indexed live history or positive protocol-provider acceptance. No provider configuration, credentials or Arkham integration changed.
