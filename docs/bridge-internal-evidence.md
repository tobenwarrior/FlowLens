# Bridge and internal-transfer replay

These are local evidence models and deterministic analyses, not new live provider integrations. They fetch no explorer, RPC or proprietary label data. Public fixtures are fictional. Private replay accepts user-supplied observations only and does not independently authenticate them.

## Bridge evidence

`src/domain/bridges.ts` exports:

```ts
parseBridgeEvidence(input: unknown, mode: 'synthetic' | 'private'): BridgeEvidenceBundle
matchBridgeEvidence(bundle: BridgeEvidenceBundle): BridgeAnalysis
createSyntheticBridgeEvidence(): BridgeEvidenceBundle
```

A version-1 bundle contains `mode`, `observations`, `assetMappings` and `coverage`. Each observation retains its ID, role (`source`, `destination`, `fee`), chain, transaction hash, log index, block, UTC time, exact raw amount/asset identity, declared route, protocol message identity and provenance. Duplicate event identities or conflicting transaction facts are rejected. Unknown fields are stripped.

Supported identity schemes:

- CCTP: source/destination domains plus versioned nonce, or an exact message hash. Version 1 uses an unsigned 64-bit decimal nonce; version 2 uses a 32-byte nonce. Explicit domain claims are compared even when no nonce is supplied. Conflicting hashes, domains/nonces or versions stay conflicting.
- LayerZero: an exact 32-byte GUID.
- Other indexed protocols: a namespace plus exact protocol-indexed message ID.

Route chains must agree with each observation's role. Multiple destination/source observations sharing an identity remain ambiguous. Conflicting routes do not silently form a pair. Matching never uses equal amounts, token symbols, nearby timestamps or wallet labels.

CCTP routes additionally use a narrow mainnet domain registry: Ethereum chain `1` → domain `0`, Base `8453` → `6`, and Arbitrum One `42161` → `3`. Circle's named-blockchain domain table was checked on 21 October 2026; protocol domains are distinct from EVM chain IDs. The analysis retains the registry source/date and the observed/expected domain values in `cctpRouteValidation`. Source: [Circle supported blockchains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains).

Known domain/chain contradictions make the match `conflicting`. An unregistered chain or absent domain claims produce an explicit `unresolved` route check. An otherwise unique endpoint pair then remains `ambiguous`, with amount reconciliation unavailable; a genuinely unmatched endpoint retains its unmatched status. Neither a shared message hash nor a balanced amount silently validates an unknown route. Other domain mappings require a separately verified registry extension.

Every result preserves observation IDs and reports `matched`, `unmatched-source`, `unmatched-destination`, `ambiguous` or `conflicting`. Here `unmatched-source` means a source observation has no matched destination; `unmatched-destination` is the inverse. A fee without an endpoint is an explicit conflict. The top-level `completeHistory` is always `false`; supplied coverage can describe only declared block scopes.

Exact amount reconciliation is separate from the transport join. It requires one supplied mapping between exact source/destination chain, contract and decimals, with a raw-unit ratio. It does not assume that equal symbols or decimals imply asset equivalence. Source-asset fees and destination-asset fees are handled separately with integer arithmetic:

```text
(sourceRaw - sourceFeeRaw) × destinationUnits
  - (destinationRaw + destinationFeeRaw) × sourceUnits
```

A zero numerator is balanced under that supplied mapping. A nonzero numerator remains a visible difference; it does not erase a valid protocol identity match. Missing/ambiguous mappings or unmapped fee assets keep reconciliation unavailable.

Independent customer credit is another evidence claim. A matched burn/message/receipt does not prove a pooled service credited a particular customer. Without separate observations it remains `unverified`. A supplied credit observation needs a beneficiary and separate provenance, and is reported as `observed-in-supplied-evidence`, not independently verified. Neither transport matching nor credit establishes ownership.

## Internal traces

`src/domain/internal.ts` exports:

```ts
parseInternalEvidence(input: unknown, mode: 'synthetic' | 'private'): InternalEvidenceBundle
analyzeInternalEvidence(bundle: InternalEvidenceBundle): InternalAnalysis
createSyntheticInternalEvidence(): InternalEvidenceBundle
```

Traces preserve chain, hash, block, UTC time, numeric trace path, call type, sender/recipient, exact native value, transaction/trace success and provenance. The canonical trace identity includes chain, transaction and trace path. Transaction block/status/native-asset contradictions and duplicate trace identities are rejected.

Successful value-bearing `CALL`, `CREATE`, `CREATE2` and `SELFDESTRUCT` observations can produce normalized `kind: 'internal'` transfer evidence. Root transaction traces are excluded to avoid counting a native transaction twice. `DELEGATECALL`, `CALLCODE` and `STATICCALL` execution values do not become funding transfers. Failed transactions/traces, descendants of failed or static ancestors, missing intervening ancestors and zero-value observations are excluded with explicit reasons. A descendant of terminal `SELFDESTRUCT` is excluded as `terminal-ancestor`, even if its supplied success flag is true: that execution frame halts. A successful child call beneath a delegate context is still considered on its own evidence; the inherited delegate value is not counted again. Source: [EIP-6780](https://eips.ethereum.org/EIPS/eip-6780).

Coverage requires an actual supplied trace-source declaration, a bounded block scope, a terminal cursor and consistent observed row count before it can be described as `supplied-scope-exhausted`. Missing ancestors or inconsistent static/terminal execution observations downgrade that scope. No trace provider means `unavailable`; exhausted pagination alone is insufficient. Every scope retains `fullWalletHistory: false`. No current live adapter claims internal coverage.

## Mode, provenance and limits

Synthetic mode requires every provenance record to be explicitly synthetic. Private mode requires explicitly non-synthetic records. Neither mode silently relabels evidence or mixes data. All timestamps normalize to UTC; provenance URLs, if present, must use HTTPS without embedded credentials. No URL is followed by these modules. Parsing is validation of supplied structure, not a guarantee that its claim is true.

Bridge replay caps a bundle at 5 MB, 10,000 observations, 500 asset mappings and 2,000 coverage records. Internal replay caps a bundle at 2 MB, 5,000 traces and 200 coverage scopes. Bound values and IDs are validated. Private exports may contain sensitive research and inherit any source-data restrictions; keep them outside source control.

The synthetic replay helpers are deterministic examples for automated workflows. They intentionally include unresolved bridge credit and excluded inherited/failed internal values so agents can distinguish supported observations from missing coverage.
