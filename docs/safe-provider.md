# Read-only Safe acquisition

`server/safe-provider.ts` acquires private-mode Safe observations through an injected read-only `RpcClient` and an optional injected `fetch`. It accepts Ethereum (1) and Arbitrum One (42161). It never connects a wallet, signs, submits a transaction, reads credentials, or accepts an endpoint URL in its input.

```ts
const result = await acquireSafeEvidence(
  {
    address: "0x…",
    chainId: 1,
    includeHistory: true,
    maxPages: 1,
    verifySignatures: false,
  },
  { rpc },
);
```

Inspect `errors`, `history`, the bundle's `coverage`, and individual verification observations even when the operation returns successfully. Validation failures throw `SafeProviderError`; provider failures retain usable observations and explicit gaps. Error messages exclude raw provider responses. Acquired records use `mode: "private"`, `synthetic: false`, a retrieval timestamp and source provenance. RPC source URLs are the transport's public documentation metadata rather than credential-bearing request URLs.

## Snapshot and historical scope

The provider checks the transport's chain and `eth_chainId`, freezes an explicit block or the observed head, then resolves its canonical hash. `eth_getCode` and the three calls to `getOwners`, `getThreshold` and `nonce` use EIP-1898 `{ blockHash, requireCanonical: true }`. An unsupported block parameter, unavailable archive state, malformed interface response or empty bytecode remains an error. There is no silent fallback to `latest` or to a different endpoint.

The result's `snapshot` retains the block/hash and decimal nonce. Its configuration is always `at-block`, including a newly frozen head, so the same evidence identity remains stable on resume. This only establishes interface compatibility; a contract implementing those methods is not thereby authenticated as an official Safe deployment. These are end-of-block owners and threshold. The provider never creates a genesis observation or links this snapshot to earlier or same-block execution authorization.

## Indexed history and cursors

History defaults to enabled. Each request loads five records; `maxPages` defaults to one and is capped at three. Only GET requests to these fixed service roots are used:

- `https://api.safe.global/tx-service/eth/api`
- `https://api.safe.global/tx-service/arb1/api`

The checksummed-address route is `/v2/safes/{address}/multisig-transactions/`, with `executed=true`, `trusted=false`, ascending `nonce,created` ordering, and bounded limit/offset. Records beyond the frozen block are excluded locally because the multisig service filter does not offer a block-number fence. Malformed, wrong-Safe, conflicting or backward-ordered pages are rejected atomically.

Next links must preserve the exact origin, chain, Safe path and filters; only an offset advancing by five is accepted. Links cannot supply credentials, fragments, alternate hosts or new query parameters. The opaque cursor encodes the address, chain, block/hash, offset and last observed nonce. Resume rejects changed scope and a changed canonical fence. Service reindexing, index lag and offset pagination still limit completeness.

RPC preflight failures use separate `preflight-error` coverage identities because no service history request was attempted. Retaining those error observations cannot replace the last successful service coverage or its resume cursor. A later explicit resume can continue that pinned history while preserving the earlier failure observation.

Requests share pacing within this process at one request per 600 ms. HTTP 401/403 and 429 stop immediately. No alternate host, credential lookup, account creation or automatic retry follows a denial. A failed page retains its cursor for a later explicit attempt. Independent processes do not share this limiter, and local budgets cannot establish an external account's remaining monthly quota.

`history.status: "service-exhausted"` means only that the returned indexed query had no next page. Execution coverage remains partial. Module executions, setup/genesis discovery and configuration-change logs are not acquired; configuration-event coverage is explicitly unsupported. An empty service response cannot establish that a Safe never executed or changed configuration.

## Confirmations and optional EOA checks

`materials` preserves each service-reported Safe hash, transaction parameters, packed execution bytes when supplied, and collected confirmations. Confirmations do not populate execution signer observations. Their owners may have confirmed off chain without being included in the executed signature set.

Set `verifySignatures: true` to attempt a separate direct-call proof. It examines at most five indexed transactions, checks two signatures by default, and caps `maxSignatures` at five across the operation. The provider also enforces a 32-call RPC budget. A verified EOA observation requires all of the following:

1. The RPC transaction targets this exact Safe directly, with matching transaction and historical block identities. Transaction and receipt indexes agree, and the canonical block's transaction list contains the exact hash at that index.
2. The successful outer receipt contains one matching Safe `ExecutionSuccess` or `ExecutionFailure` event with the indexed Safe transaction hash and compatible reported execution status.
3. Decoded `execTransaction` parameters agree with the indexed material. Packed signature bytes agree too when the service supplied them.
4. A read-only historical `getTransactionHash` call at that execution block's canonical hash returns the indexed Safe hash.
5. An EOA signature actually present in that calldata recovers successfully. Safe `v=31/32` signatures use the Ethereum signed-message prefix and normalized recovery value; `v=27/28` use the Safe digest directly. A contradictory service owner assertion for the exact same bytes prevents a verified result.

Individual results use `status: "verified-eoa"`, `digestBoundToSafeContract: true` and `participation: "unresolved"`. Recovering an address from an unbound service hash is insufficient. Recovered identities enter the bundle as `source-recovered` EOA observations with `participation: "calldata-only"` and RPC provenance. The separate proof retains its scope and reason.

A Safe may consume only the required prefix of a longer signature byte string. A recoverable trailing signature can therefore be present in direct execution calldata without participating in authorization. This adapter does not reconstruct that consumed prefix. Parsing and replay preserve the `calldata-only` marker, exclude those observations from configured/other quorum signer counts, and warn that participation remains unresolved. When these are the only observations, historical configuration alone cannot turn them into signature-quorum evidence.

This proof relies on the selected RPC's transaction, receipt and historical-state assertions. It does not independently validate block consensus, authenticate a Safe implementation, reconstruct pre-call ownership, establish a threshold quorum, or attribute beneficial ownership. The end-of-block contract hash check may be unavailable or ambiguous after an implementation change. Global replay analysis therefore retains `independentlyVerifiedSignatures: false`; individual proofs are narrower claims.

Contract signatures, approved hashes, unknown signature encodings, module/batch execution paths, signatures beyond the budget and missing historical material remain explicitly unverified. EIP-1271 and approved-hash validation are separate work. There is no current-owner substitution or inference of missing signatures from an execution's success.

## Verification evidence

Focused offline tests exercise frozen reads, chain/address/block validation, archive/interface failures, atomic page rejection, confirmation separation, service denials, cursor scope/reorganization checks, ordering conflicts, canonical transaction membership, and direct-call EOA hash binding. A threshold-one fixture with two recoverable calldata signatures verifies that unresolved participation cannot become quorum evidence. Actual provider outputs also exercise protocol merging across cursor pages and later verification enrichment. The fixture signatures are generated from public synthetic test keys and identify no real investigation.

On 21 October 2026, one explicitly authorized live probe used the exact public example in Safe's API-key documentation after validating its address format. Four keyless PublicNode RPC requests established Ethereum chain identity, a frozen block and its hash, then returned `0x` bytecode for that address at the canonical block. The adapter reported `SAFE_NOT_CONTRACT` and configuration coverage `error`; owners, threshold and nonce calls were therefore skipped. One unauthenticated Safe service request returned HTTP 200 and an empty history page. The adapter retained execution coverage `partial`, zero observations and no resume cursor; it did not infer that the address had never executed or that wallet history was complete.

This verifies narrow live connectivity, canonical block-hash bytecode lookup, service access and the observed error/empty-page boundaries. It does not verify a positive Safe configuration, implementation authenticity, historical executions or signatures. No alternate address, chain, credentials or historical scan was used, and no further retry followed the completed probe. There is no useful continuation cursor or supported configuration recovery from that result within the same frozen scope. A successful configuration acceptance test would need a separately selected, permitted deployed Safe or known historical state; that was outside this probe.

## Primary references

Verified on 21 October 2026:

- [Safe API authentication](https://docs.safe.global/core-api/how-to-use-api-keys): unauthenticated exploration is documented at 2 RPS and 5,000 monthly requests; production usage requires authentication.
- [Safe quotas](https://docs.safe.global/core-api/api-authentication): response quotas and 429 enforcement.
- [Official SDK service roots](https://github.com/safe-global/safe-core-sdk/blob/main/packages/api-kit/src/utils/config.ts) and [v2 history route](https://github.com/safe-global/safe-core-sdk/blob/main/packages/api-kit/src/SafeApiKit.ts).
- [Service filter definitions](https://github.com/safe-global/safe-transaction-service/blob/master/safe_transaction_service/history/filters.py) and [separate confirmation/signature fields](https://github.com/safe-global/safe-transaction-service/blob/master/safe_transaction_service/history/serializers.py).
- [Safe transaction hash](https://docs.safe.global/reference-smart-account/transactions/getTransactionHash) and [signature encodings](https://docs.safe.global/advanced/smart-account-signatures).

The provider is an original bounded adapter. No private investigation or provider dataset is bundled.
