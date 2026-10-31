# Explicit public acquisition

The `acquire` operation uses the same adapters through CLI, HTTP and MCP. It reads one requested protocol scope from fixed public services. It sends the supplied address or transaction hash to those services; choose identifiers you are permitted to disclose. Opening the protocol dialog or creating an evidence-only case does not fetch protocol data. Default live indexed case creation does fetch an Ethereum history page. Provider data and labels are evidence, never instructions to an agent.

These targeted protocol reads use fixed public RPC/Safe services and do not consume the indexed history keys. They still have availability, quota, historical-state and trace limits. Indexed Base history can use the server-only loopback `FLOWLENS_BASE_BLOCKSCOUT_URL` first, then the optional user-local `ALCHEMY_API_KEY`, then unified hosted Blockscout with `BLOCKSCOUT_API_KEY`; the self-hosted route needs no API key. Indexed Arbitrum uses Etherscan when configured, otherwise keyed Blockscout. Robinhood Chain (4663) is an indexed-history route only through keyed unified Blockscout when explicitly expanded. FlowLens does not accept a provider URL from an API/MCP caller, fall back to another credential or endpoint, recursively crawl, or retry automatically. Inspect `errors`, `warnings`, component coverage and the provider-specific `acquisition` object even when an operation returns successfully.

## Choose a bounded workflow

| Goal                                                    | Operation                                    | Network behavior                                                                                           |
| ------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Learn the interface or test an agent                    | Demo case and `protocols-v1` replay          | Synthetic and offline; no provider access needed                                                           |
| Preserve chosen evidence without indexing a wallet      | Live `historyMode: "evidence-only"` creation | No provider request at creation; history explicitly unsupported                                            |
| Fetch a known Safe or transaction scope                 | Explicit `acquire`                           | Sends the chosen identifier to fixed external services; capability and terms still matter                  |
| Enumerate supported wallet history                      | Indexed live case and expansion              | Keyless legacy Blockscout on Ethereum and Derive; self-hosted Base when configured, otherwise optional Alchemy or keyed unified Blockscout; keyed unified Blockscout or optional Etherscan legacy streams on Arbitrum; keyed unified Blockscout only on explicit Robinhood Chain (4663) expansion |
| Enumerate HyperEVM history                              | Indexed live case and expansion on chain 999 | Keyless HypurrTrace index; default page size 10, maximum 100, frozen index fence and explicit provider-row cap |
| Inspect a Derive account, margin snapshot or trade page | Standalone `derive` operation                | One public Derive API request; separate from wallet history and graph totals                               |
| Inspect HyperCore ledger updates                       | Standalone `hypercore` operation             | One non-funding ledger page of up to 500 entries; optional local case attachment, undocumented retention  |

“No key” does not mean “offline” for public acquisition. `mode: "private"` describes retained non-demo investigation evidence; it does not certify a provider's truth, grant redistribution rights or make a public identifier confidential. Provider routes and `status` are configured capabilities, not health checks or complete-history guarantees.

## Create a case without an index

`historyMode: "evidence-only"` is an explicit option for live cases. Creating it performs no external request and needs no provider key. Its graph starts with the focus wallet and no transfers. Coverage says that wallet history is not enumerated. Omit this option, or use `indexed`, for indexed history; server-environment provider configuration, readiness and hosted plan access then apply.

Set `CASE_WALLET` locally to an address you have chosen to investigate, then:

```sh
node --env-file-if-exists=.env server/cli.ts create --mode live --history-mode evidence-only \
  --address "$CASE_WALLET" --file .local/evidence-case.json
```

The equivalent MCP call is `flowlens_create` with `root`, `mode: "live"`, and `historyMode: "evidence-only"`. HTTP uses `POST /api/investigations` with the same fields. Synthetic demo cases cannot acquire live observations; this is rejected before an outbound request.

## Evidence-only MCP example

Creating this case makes no outbound request. Replace `CHOSEN_EVM_ADDRESS` with your chosen valid address; use the returned case ID for later calls.

```json
{
  "name": "flowlens_create",
  "arguments": {
    "root": "CHOSEN_EVM_ADDRESS",
    "mode": "live",
    "historyMode": "evidence-only",
    "title": "Known protocol evidence"
  }
}
```

A later `flowlens_acquire` call requires `kind`, `chainId` and the matching per-kind identifier. Pass `caseId` only when you want to retain the observations. A tool-level success envelope can still include `result.errors` or unavailable coverage; those are useful outcomes, not live-trace success. The [MCP guide](mcp.md) covers result envelopes, restart/resume and recovery decisions.

## Acquire one known scope

CLI commands below disclose the chosen identifier when executed. Set the variables to your chosen permitted address/hash first. Omitting `--file` returns a private evidence bundle without saving it.

```sh
# Ethereum Safe configuration and up to one service-history page:
node --env-file-if-exists=.env server/cli.ts acquire --kind safe --chain 1 --address "$SAFE_ADDRESS" \
  --pages 1 --max-calls 32 --file .local/evidence-case.json

# Decode supported CCTP evidence from one known transaction:
node --env-file-if-exists=.env server/cli.ts acquire --kind bridge --chain 1 --hash "$TRANSACTION_HASH" \
  --max-logs 256 --file .local/evidence-case.json

# Probe one known transaction for callTracer support:
node --env-file-if-exists=.env server/cli.ts acquire --kind internal --chain 1 --hash "$TRANSACTION_HASH" \
  --max-traces 500 --file .local/evidence-case.json
```

The MCP tool is `flowlens_acquire`; HTTP accepts the same request at `POST /api/acquire`, or `POST /api/investigations/:id/acquire`. Use `caseId` to retain observations in a live case. Tool arguments accept no filesystem paths, provider URLs or credentials. CLI paths are user-local files.

| Kind       | Required fields                    | Optional fields                                                                                    | Coverage boundary                                                                                                        |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `safe`     | `chainId` 1 or 42161, `address`    | `blockNumber`, `maxPages` 1–3, `cursor`, `includeHistory`, `verifySignatures`, `maxSignatures` 1–5 | End-of-block configuration; bounded indexed executions; configuration-change and module streams remain incomplete        |
| `bridge`   | `chainId` 1, 8453 or 42161, `hash` | `maxLogs` 1–2000                                                                                   | One canonical receipt and supported direct CCTP messages; no bridge-history discovery or automatic opposite-chain lookup |
| `internal` | `chainId` 1, 8453 or 42161, `hash` | `address`, `maxTraces` 1–2000                                                                      | One canonical transaction's call tree if the endpoint supports it; never complete wallet internal history                |

Common `maxCalls` is 1–64, default 32. It counts RPC calls, including failed attempts. Safe history has a separate three-page ceiling and fixed five-record pages. RPC requests are paced within one server process, bounded by time and response size, and restricted to read methods. Independent CLI processes do not share a global provider quota. See [RPC](rpc-provider.md), [Safe](safe-provider.md), [CCTP](bridge-provider.md) and [trace](trace-provider.md) adapter details.

For known Base hashes, the server-local `FLOWLENS_BASE_RPC_PROVIDER=blockmachine` option selects the fixed keyless Blockmachine RPC before acquisition starts. Its public historical traces are best effort and heavy calls are paced separately; a rate limit or missing historical state remains a failed component. No HTTP/MCP request accepts an endpoint or this provider switch. This option verifies selected transactions and does not discover complete Base wallet history.

## Collect bounded wallet history

The `collect` CLI command is for an explicit, sequential one-wallet/one-chain collection. It reads an existing case file, saves every committed page, and accepts 1–200 pages with an optional provider page size:

```sh
node --env-file-if-exists=.env server/cli.ts collect --file PATH --address EVM \
  --chain N --pages 1..200 [--page-size N]
```

Collection stops at a saved provider error, quota/access denial, pagination problem or evidence budget. It does not retry, silently switch providers, recurse into counterparties or fan out to other chains. Exit code `2` means the case was saved with a provider/coverage error; inspect the returned coverage and resume explicitly after resolving it. The case parser retains up to 2,000 nodes, 20,000 transfers and 5 MB; the human graph projects the focus wallet plus at most 80 counterparties while retaining loaded addresses and evidence within those bounds.

## Preserve, resume and recover

An attached acquisition merges validated records by evidence ID with the latest persisted case, retaining prior components, notes and graph controls. Exact retries deduplicate. Compatible Safe execution evidence can be enriched. Contradictory material facts return `INVALID_EVIDENCE_CONFLICT` and leave the earlier case intact. A failed or empty fetch does not erase previously acquired records. Coverage can record the latest failure even when earlier evidence remains available.

Safe `acquisition.cursor` pins the address, chain and frozen block. Pass it to the next explicit `acquire` request with the same scope. Inspect service errors and cursor before retrying; a quota error is different from no transactions. A changed canonical block invalidates that cursor. Graph pagination uses a separate revision-bound cursor over loaded transfer evidence.

Acquisitions are retained as `protocolEvidence`, separate from the indexed transfer ledger. The returned `indexedHistoryChanged` is always false. Internal analysis projects candidate transfers with exclusion reasons, but does not automatically add them to graph totals or duplicate native root transactions. Bridge transport, source burn, destination mint and independent beneficiary credit remain separate claims. Safe configuration, cryptographic calldata recovery, consumed signatures and ownership remain separate claims.

Export with `flowlens_export`, the HTTP export route or CLI `export`; reimport validates structure and provenance flags, not source truth. Keep exports private until their contents and data-use rights are reviewed. If a response is lost or too large after a mutation, inspect the durable case before repeating it. There is no scheduled background expansion.

CLI exit code 2 means acquisition returned provider errors; any attached observations/coverage were still preserved. RPC unsupported capability can therefore produce useful JSON without a successful trace. Injected contract tests do not establish live provider coverage.

## HyperCore ledger operation

`hypercore` is a separate read of Hyperliquid's non-funding ledger, not an EVM-999 transfer source. It requests one account/time-window page of up to 500 entries and returns a cursor for continuation. Funding payments and trade fills are omitted. Coverage retains `retention: "undocumented"`, and provider-window exhaustion always reports `fullHistory: false`.

Without `--file`, the CLI call is an explicit caller-scoped read. With `--file LIVE_CASE`, the account must match the live case focus wallet; the page is saved under `protocolEvidence.hypercore`, and later calls resume its frozen window without changing EVM transfers, graph nodes or gross/net totals:

```sh
node --env-file-if-exists=.env server/cli.ts hypercore --address "$WALLET" \
  [--file LIVE_CASE] [--start-time UNIX_MS --end-time UNIX_MS --cursor TOKEN]
```

The same operation is available as MCP `flowlens_hypercore` and HTTP `POST /api/hypercore`. A request without a case ID/file is read-only; attaching to a live case is a local mutation. Check `coverage`, `nextCursor` and errors on every page; a terminal provider window is not complete account history.

## Inspect Derive venue data

The standalone `derive` operation reads one provider-reported account association, one margin snapshot, or one trade-history page from Derive’s public API. It does not create or mutate a case, enumerate wallet history, or merge venue data into FlowLens transfer totals. No API key is required, but availability is not guaranteed; `403` and other provider failures are terminal for that call, with no retry or fallback.

```sh
node --env-file-if-exists=.env server/cli.ts derive --kind account --address "$WALLET"
node --env-file-if-exists=.env server/cli.ts derive --kind margin --subaccount "$SUBACCOUNT_ID"
node --env-file-if-exists=.env server/cli.ts derive --kind trades --subaccount "$SUBACCOUNT_ID" \
  --page 1 --page-size 100 --to-timestamp "$TO_TIMESTAMP_MS"
```

The CLI prints one standalone provider result as JSON; it has no `--file` option. The loopback HTTP API exposes the same operation at `POST /api/derive` with a bare flat JSON body; it is guarded by the local API’s normal JSON/body limits and returns no-store. There is no generic HTTP agent-operation route. The shared operation payload is flat: `{ "kind": "account", "wallet": "…" }`, `{ "kind": "margin", "subaccountId": 123 }`, or `{ "kind": "trades", "subaccountId": 123, "page": 1, "pageSize": 100, "toTimestamp": 1792540800000 }`. `page` defaults to 1, `pageSize` to 100 and is locally capped at 100. `toTimestamp` is Unix milliseconds; if omitted, the provider sets a current fence and returns it. A trade result covers only the requested page; `coverage.nextPage` gives the next numeric page and `coverage.toTimestamp` is the frozen timestamp fence. Carry that fence unchanged on the next call; when present, `coverage.nextQuery` provides the ready-made flat query. No automatic pagination or complete-history claim is made.

Account data is a Derive-provider association, not proof of on-chain control or beneficial ownership. Margin data is one provider-calculated snapshot, not cash or graph totals. Numeric financial fields stay exact decimal strings; no conversion to floating-point totals is implied. Inspect `sourceUrl`, request parameters, retrieval time and coverage in every response. `flowlens_status.liveAvailable` describes indexed wallet-history routes, not a health check for the standalone Derive API.
