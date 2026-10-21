# Provider behavior and coverage

Verified against official documentation on 21 October 2026. Application code and provider data have separate usage rights. No provider dataset is bundled, and there is no Arkham client or scraping path.

| Provider                          | Access                                                              | Implemented coverage                                                                                                                        | Explicit gaps                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic v1                      | No key, offline                                                     | Fictional Ethereum/Base native and ERC20 transfers, deterministic pages and fixture labels                                                  | Not real transactions, ownership or complete chain history                                                                                   |
| Etherscan V2                      | Existing user-supplied `ETHERSCAN_API_KEY`, server environment only | Ethereum (1), Arbitrum One (42161), native transfers and receipt-confirmed ERC20 logs                                                       | Internal traces, NFTs, fees, balances, historical pricing, bridge linkage, Safe histories, reorg reconciliation and labels                   |
| Fixed public RPC                  | Keyless server-side endpoints; explicit scopes                      | Ethereum (1), Base (8453), Arbitrum One (42161); bounded transaction/receipt/block reads and protocol calls                                 | No wallet index or complete history; method/archive availability and single-provider assertions remain limits                                |
| Safe RPC/service acquisition      | Keyless fixed RPC and bounded Safe service requests                 | Ethereum (1), Arbitrum One (42161); frozen owner/threshold/nonce snapshot, indexed executions and optional limited direct-call EOA recovery | No genesis/configuration-event reconstruction, complete historical quorum, module paths, contract signatures or guaranteed live availability |
| CCTP V1/V2 acquisition            | One supplied transaction via fixed RPC                              | Official source/destination message and native-USDC evidence on Ethereum/Base/Arbitrum                                                      | No wallet/destination search; V2 source nonce placeholder cannot establish a join; independent beneficiary credit remains unverified         |
| Internal `callTracer` acquisition | One supplied transaction via fixed RPC                              | Validated transaction/receipt/block and normalized supported call frames when the provider supplies them                                    | Unsupported capability stays unavailable; returned coverage is partial, never complete wallet history                                        |
| Arkham                            | Disabled                                                            | No live requests or redistributed labels                                                                                                    | Permitted access and data-use rights require separate review                                                                                 |

An indexed live case initially loads one Ethereum page. Request Arbitrum explicitly through the same expansion operation. A live `historyMode: "evidence-only"` case instead begins empty with unsupported indexed-history coverage and makes no provider request; it needs no Etherscan key. Base supports targeted public RPC acquisition but is not enabled for live REST history. BSC and Optimism are also outside this REST adapter. Plan restrictions must not become false “no activity” results. Even on supported chains, an unavailable key/plan returns an explicit error.

## Shared targeted acquisition

CLI `acquire`, HTTP `POST /api/acquire` / `POST /api/investigations/:id/acquire` and MCP `flowlens_acquire` use the same bounded service. Inputs select `safe`, `bridge` or `internal`, a supported chain and an explicit wallet or known transaction. No input accepts an endpoint, credential or arbitrary RPC method. Results preserve errors, warnings, provenance and limited scope. Optional attachment merges observations into an existing live case without changing indexed transfers; demo cases reject external acquisition.

The [RPC transport](rpc-provider.md) defaults to 32 calls, 45 seconds, 2 MB per response and one request per second per chain within one process. It uses fixed endpoints and read methods, rejects redirects and has no automatic retries or alternate-provider fallback. Safe service pagination and signature budgets impose additional bounds. Independent processes do not share account/provider quota controls.

See [acquisition workflows](acquisition.md), [Safe boundaries](safe-provider.md), [known-transaction CCTP](bridge-provider.md) and [internal trace scope](trace-provider.md). The [live verification record](live-verification.md) distinguishes narrow approved public RPC/Safe-service observations from injected fixtures. The public Safe example returned empty bytecode and an HTTP 200 empty indexed history page; successful live Safe configuration/signature acquisition and successful live trace normalization remain unverified. Specific-identifier queries disclose an investigator's selected scope to external services and require authorization; provider access does not grant data redistribution rights.

## Etherscan pagination and evidence

The adapter uses the allowlisted `https://api.etherscan.io/v2/api` endpoint. An initial `eth_blockNumber` request freezes an `endblock` boundary; `txlist` and `tokentx` are read newest-first using separate page counters, fixed page sizes, and the same frozen block range. Opaque cursors retain the chain, address, block anchor, page size and each stream's terminal state. A cursor cannot be used for another wallet/chain/page size. Cursors are validated structural state, not signed credentials.

A page contains at most ten history rows from each stream. The ERC20 history response does not supply a log index, so each distinct token transaction is hydrated with `eth_getTransactionReceipt`. Receipt transaction hash and block must match the requested history evidence; optional log hashes/blocks must agree, and removed logs are rejected. Identity mismatches fail the whole page with retryable `RECEIPT_MISMATCH`, retaining the previous cursor. Only successful receipts and actual ERC20 `Transfer` logs touching the requested wallet are normalized. Their receipt `logIndex` becomes the evidence event index; `statusRep` is token reputation and is never treated as transaction success. Duplicate receipt events across history pages deduplicate by chain/hash/kind/log index/contract. Contract-creation native value uses the created contract address when the ordinary `to` field is empty.

Amounts stay integer strings with per-contract decimals. Token symbols are provider metadata, not identity or independent verification. Different contracts and chains never share a numerical asset total. Explorer links must use the evidence chain.

The provider commits no page until all required requests have succeeded. Missing receipts, network failures and throttling produce a retryable error; the engine retains the prior committed cursor and evidence. Failed transactions are excluded. Malformed rows/logs may be omitted with a permanent coverage warning, so terminal pagination never implies every transaction was ingested. Reaching a terminal stream means only that the provider returned no further rows inside the frozen window. Newer blocks require a new investigation in this version. There is no historical refresh/reorg rollback implementation.

## Budgets and rate limits

The server shares a provider queue paced at one request per second. A first page makes at most 13 requests (block anchor, two history streams, up to ten receipts); later pages make at most 12. An expansion is explicitly bounded to one wallet, at most three pages and 80 total graph nodes. The engine rejects an over-budget page atomically. Receipt parsing is bounded to 2,000 logs per receipt. There are no automatic recursive requests or network retries.

Etherscan documents a free limit of three calls/second, 100,000/day on selected chains. Our pacing is deliberately lower. Account-level quota is external: other clients may consume it. Separate CLI processes have separate pacing queues; do not run concurrent live CLI jobs against the same key. CLI/API writers share a per-file lock for state safety, but that lock is not an account-level rate limiter. Provider throttles and access denials remain explicit. No service or paid tier is purchased automatically.

## Local storage and errors

The HTTP API binds only to `127.0.0.1`. It accepts loopback hosts/origins and JSON mutation bodies, rejects oversized input, and exposes no CORS grant. Server cases are `.local/cases/<id>.json`, stored via an atomic rename with private file modes. The CLI can instead use a user-chosen local path. Both use the same exclusive lock file and engine. A crash may leave `<case>.json.lock`; after verifying no writer is active, remove that exact stale lock before retrying.

A full snapshot PUT includes its original `updatedAt` timestamp. The server checks it against current storage and returns HTTP 409 `CASE_CONFLICT` for stale state; on success use the returned snapshot and new timestamp. Do not manufacture a new timestamp before saving. Expansion operations serialize and reread the latest committed case. A shared-file lock conflict returns HTTP 409 `CASE_BUSY`.

JSON errors use `{ "error": { "code": "...", "message": "...", "retryable": false } }`. Successful expansion responses may still contain `coverage[].status = "error"`, with validated `errorCode` and `retryable` fields; inspect coverage instead of treating HTTP 200 or process exit 0 as proof of full history. A successful retry clears the prior error fields. CLI create/expand exits 2 after saving a case with coverage errors; the JSON result remains on stdout. Validation/unavailable-key failures exit 1 with a JSON error on stderr.

## Official references

- [Normal transaction history and pagination](https://docs.etherscan.io/api-reference/endpoint/txlist)
- [ERC20 history, metadata and token reputation](https://docs.etherscan.io/api-reference/endpoint/tokentx)
- [Block anchor](https://docs.etherscan.io/api-reference/endpoint/ethblocknumber)
- [Transaction receipts](https://docs.etherscan.io/api-reference/endpoint/ethgettransactionreceipt)
- [Rate limits](https://docs.etherscan.io/rate-limits)
- [Supported chains and plan access](https://docs.etherscan.io/supported-chains)

No authenticated live history was fetched during implementation: tests use injected, explicitly synthetic provider responses. The adapter is implemented and boundary-tested, but live account access and end-to-end provider completeness remain unverified.
