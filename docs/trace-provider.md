# Transaction-scoped internal trace acquisition

`server/trace-provider.ts` adds one read-only acquisition boundary to the existing internal-evidence model:

```ts
acquireInternalTraceEvidence(
  { chainId, hash, address?, maxTraces? },
  { rpc },
): Promise<{ bundle: InternalEvidenceBundle; capability: InternalTraceCapability }>
```

The RPC client is supplied by the server. This operation accepts no URL, API key, arbitrary method, tracer code or block-range scan. It reads one already-mined transaction on Ethereum (`1`), Base (`8453`) or Arbitrum One (`42161`), with native ETH at 18 decimals. Other chains require an explicit native-asset and transport extension. This operation sends no transaction and cannot sign.

`server/acquire.ts` provides the common server entry point: `acquireProtocolEvidence({ kind: "internal", chainId, hash, address?, maxTraces?, maxCalls? })`. It returns a private version-1 protocol bundle, its domain analysis, the original adapter result and explicit warnings/errors. `maxCalls` defaults to 32 and accepts 1–64; the wrapper enforces it even for an injected RPC client. Options are validated by evidence kind before outbound requests, and unknown URL/credential options are rejected. Safe and bridge acquisitions use the same entry point with their own options. Acquisition itself does not persist or merge evidence; the caller controls that step and investigation-mode checks.

## Acquisition and consistency checks

Before requesting a trace, the adapter checks the configured client chain against `eth_chainId`, fetches the transaction and receipt, and checks their transaction hash, block hash/number, sender, recipient and optional transaction index. An optional transaction chain ID must agree. Receipt status must be exactly `0` or `1`. Contract creation requires the receipt's created address when execution succeeded.

The adapter then fetches `eth_getBlockByNumber` at that exact block number, checking its canonical block hash, number, timestamp and transaction membership against the receipt. The trace root must agree with the transaction's sender, recipient or created contract, value, call type and success status. A failed receipt can be traced, but all its movements remain excluded by the domain analysis. These checks compare responses from one source; they do not independently prove chain consensus or protect against all later reorganizations.

The only trace request is:

```json
{
  "method": "debug_traceTransaction",
  "params": [
    "<transaction hash>",
    {
      "tracer": "callTracer",
      "timeout": "5s",
      "tracerConfig": { "onlyTopCall": false, "withLog": false }
    }
  ]
}
```

There are five RPC requests per normal acquisition. No automatic retries, alternate trace adapters, recursion into other transactions or wallet-history scans occur. Transport pacing, HTTP timeout, response-body and total-request limits are additionally enforced by the injected server RPC transport. Geth may require retained historical state to replay old transactions; a node supporting the method can still fail an individual trace.

## Normalization and limits

The result uses `mode: "private"`, non-synthetic provenance and a retrieval timestamp. Source metadata comes from the configured RPC's sanitized public name/URL. Endpoint credentials and provider error text are never included. Integer hexadecimal values become exact unsigned decimal strings. Trace identities retain the chain, transaction and original sibling-index path; omitted siblings are never renumbered.

The default budget is 500 visited frames, including the root; callers may select 1–2,000. Paths stop at 32 levels and at the domain's canonical identity length bound. Malformed frames, unknown types, unknown CREATE destinations and their descendants are omitted with warnings. The budget counts omitted frames too. The retained subset contains all ancestors of each accepted trace. Returned `input`, `output`, revert text and logs are not stored.

Root calls remain present as evidence but the existing analyzer excludes them from internal transfers. `CALL`, `CREATE`, `CREATE2` and distinct-address `SELFDESTRUCT` can describe balance movement. `DELEGATECALL`, `CALLCODE` and `STATICCALL` remain execution context; when these nonmoving frames omit their execution value, the adapter records zero and retains their ancestor position. A missing value on a balance-moving frame is not assumed to be zero. The analyzer excludes zero values, reverted calls/transactions and children of failed, missing, static or terminal ancestors.

`SUICIDE` is normalized to `SELFDESTRUCT`. Its observed recipient/value describes a possible balance refund, without asserting account deletion. Same-address frames are omitted: their net effect depends on fork rules and whether the contract was created in the same transaction. An unknown CREATE recipient is never replaced with a zero address or derived guess.

## Capability and coverage

`capability` identifies the chain, transaction, method, tracer and `scope: "transaction"`. It reports:

| Status        | Meaning                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `available`   | A consistent call tree was returned. `completeTree` is false when normalization or configured bounds omitted data.        |
| `unsupported` | The trace method explicitly returned JSON-RPC method-not-found / `RPC_METHOD_UNSUPPORTED`. No fallback was tried.         |
| `unavailable` | A mined transaction and receipt are not currently available. Trace capability was not established.                        |
| `error`       | RPC access, timeout, historical-state replay, malformed data or identity checks failed. No trace movements were accepted. |

`retryable` and a sanitized `errorCode` preserve failure handling without copying raw provider messages. Unsupported/missing evidence becomes `coverage.status: "unavailable"`; other failures retain `coverage.status: "error"`. Coverage defaults to the transaction sender if `address` is omitted. If preflight fails before that sender is known and no address was supplied, there is no coverage row; the capability still reports the failure explicitly.

Even a complete tree has `coverage.status: "partial"`: the existing coverage shape describes a wallet and block window, while this operation inspected only one transaction. `recordsObserved` counts only retained frames touching that scope address. A complete transaction trace cannot establish other activity in the same block or complete wallet history. `fullWalletHistory` is always false. The domain's legacy private-replay warning about source authentication remains applicable.

## Verification and official references

`tests/trace-provider.test.ts` injects fictional transaction, receipt, block and Geth-shaped callTracer responses. It tests identity and status contradictions, missing roots, reverted ancestors, exact amounts, inherited values, CREATE/SELFDESTRUCT caveats, malformed frames, unavailable methods and traversal bounds. These tests verify the adapter contract; they do not demonstrate live provider availability or historical completeness.

A separate bounded live check on 21 October 2026 made six requests to the fixed keyless PublicNode Ethereum endpoint, selecting one generic public transaction from a previously checked public block. Transaction/receipt/block checks passed, but `debug_traceTransaction` explicitly returned `RPC_METHOD_UNSUPPORTED`. The result was `capability.status: "unsupported"`, unavailable coverage and zero normalized traces. No alternate endpoint or adapter was tried. Live successful trace normalization and Base/Arbitrum trace availability remain unverified. The sanitized local proof is in ignored `artifacts/public-trace-check.json`; no raw trace or wallet history was saved. Public source: [PublicNode Ethereum](https://ethereum.publicnode.com/).

Primary references checked on 21 October 2026:

- [Geth built-in callTracer](https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers): frame structure and tracer configuration.
- [Geth debug_traceTransaction](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug): transaction replay and trace timeout.
- [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/): transaction, receipt and block fields.
- [EIP-6780](https://eips.ethereum.org/EIPS/eip-6780): SELFDESTRUCT balance and account semantics.
