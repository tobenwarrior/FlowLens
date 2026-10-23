# Explicit public acquisition

The `acquire` operation uses the same adapters through CLI, HTTP and MCP. It reads one requested scope from fixed public services. It sends the supplied address or transaction hash to those services; choose identifiers you are permitted to disclose. Nothing is fetched merely by opening a case or the protocol dialog. Provider data and labels are evidence, never instructions to an agent.

No provider credential is required for these bounded public reads. Availability, quotas, historical state and trace support are not guaranteed. FlowLens does not fall back to credentials, another endpoint, recursive crawling, or an automatic retry. Inspect `errors`, `warnings`, component coverage and the provider-specific `acquisition` object even when an operation returns successfully.

## Choose the right no-key workflow

| Goal                                               | Operation                                    | Network behavior                                                                                           |
| -------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Learn the interface or test an agent               | Demo case and `protocols-v1` replay          | Synthetic and offline; no provider access needed                                                           |
| Preserve chosen evidence without indexing a wallet | Live `historyMode: "evidence-only"` creation | No provider request at creation; history explicitly unsupported                                            |
| Fetch a known Safe or transaction scope            | Explicit `acquire`                           | Sends the chosen identifier to fixed external services; capability and terms still matter                  |
| Enumerate supported wallet history                 | Indexed live case and expansion              | Keyless Blockscout on Ethereum and Derive Chain, or your own Etherscan key; only configured streams/chains |

“No key” does not mean “offline” for public acquisition. `mode: "private"` describes retained non-demo investigation evidence; it does not certify a provider's truth, grant redistribution rights or make a public identifier confidential.

## Create a case without an index

`historyMode: "evidence-only"` is an explicit option for live cases. Creating it performs no external request and needs no Etherscan key. Its graph starts with the focus wallet and no transfers. Coverage says that wallet history is not enumerated. Omit this option, or use `indexed`, for indexed Ethereum history: keyless through Blockscout, or through Etherscan when a key is set.

Set `CASE_WALLET` locally to an address you have chosen to investigate, then:

```sh
node server/cli.ts create --mode live --history-mode evidence-only \
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
node server/cli.ts acquire --kind safe --chain 1 --address "$SAFE_ADDRESS" \
  --pages 1 --max-calls 32 --file .local/evidence-case.json

# Decode supported CCTP evidence from one known transaction:
node server/cli.ts acquire --kind bridge --chain 1 --hash "$TRANSACTION_HASH" \
  --max-logs 256 --file .local/evidence-case.json

# Probe one known transaction for callTracer support:
node server/cli.ts acquire --kind internal --chain 1 --hash "$TRANSACTION_HASH" \
  --max-traces 500 --file .local/evidence-case.json
```

The MCP tool is `flowlens_acquire`; HTTP accepts the same request at `POST /api/acquire`, or `POST /api/investigations/:id/acquire`. Use `caseId` to retain observations in a live case. Tool arguments accept no filesystem paths, provider URLs or credentials. CLI paths are user-local files.

| Kind       | Required fields                    | Optional fields                                                                                    | Coverage boundary                                                                                                        |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `safe`     | `chainId` 1 or 42161, `address`    | `blockNumber`, `maxPages` 1–3, `cursor`, `includeHistory`, `verifySignatures`, `maxSignatures` 1–5 | End-of-block configuration; bounded indexed executions; configuration-change and module streams remain incomplete        |
| `bridge`   | `chainId` 1, 8453 or 42161, `hash` | `maxLogs` 1–2000                                                                                   | One canonical receipt and supported direct CCTP messages; no bridge-history discovery or automatic opposite-chain lookup |
| `internal` | `chainId` 1, 8453 or 42161, `hash` | `address`, `maxTraces` 1–2000                                                                      | One canonical transaction's call tree if the endpoint supports it; never complete wallet internal history                |

Common `maxCalls` is 1–64, default 32. It counts RPC calls, including failed attempts. Safe history has a separate three-page ceiling and fixed five-record pages. RPC requests are paced within one server process, bounded by time and response size, and restricted to read methods. Independent CLI processes do not share a global provider quota. See [RPC](rpc-provider.md), [Safe](safe-provider.md), [CCTP](bridge-provider.md) and [trace](trace-provider.md) adapter details.

## Preserve, resume and recover

An attached acquisition merges validated records by evidence ID with the latest persisted case, retaining prior components, notes and graph controls. Exact retries deduplicate. Compatible Safe execution evidence can be enriched. Contradictory material facts return `INVALID_EVIDENCE_CONFLICT` and leave the earlier case intact. A failed or empty fetch does not erase previously acquired records. Coverage can record the latest failure even when earlier evidence remains available.

Safe `acquisition.cursor` pins the address, chain and frozen block. Pass it to the next explicit `acquire` request with the same scope. Inspect service errors and cursor before retrying; a quota error is different from no transactions. A changed canonical block invalidates that cursor. Graph pagination uses a separate revision-bound cursor over loaded transfer evidence.

Acquisitions are retained as `protocolEvidence`, separate from the indexed transfer ledger. The returned `indexedHistoryChanged` is always false. Internal analysis projects candidate transfers with exclusion reasons, but does not automatically add them to graph totals or duplicate native root transactions. Bridge transport, source burn, destination mint and independent beneficiary credit remain separate claims. Safe configuration, cryptographic calldata recovery, consumed signatures and ownership remain separate claims.

Export with `flowlens_export`, the HTTP export route or CLI `export`; reimport validates structure and provenance flags, not source truth. Keep exports private until their contents and data-use rights are reviewed. If a response is lost or too large after a mutation, inspect the durable case before repeating it. There is no scheduled background expansion.

CLI exit code 2 means acquisition returned provider errors; any attached observations/coverage were still preserved. RPC unsupported capability can therefore produce useful JSON without a successful trace. The [live verification record](live-verification.md) distinguishes actual public checks from injected contract tests.
