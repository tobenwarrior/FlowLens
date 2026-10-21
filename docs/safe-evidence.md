# Safe configuration and execution replay

`src/domain/safe.ts` validates and analyzes supplied Safe observations. It does not fetch a Safe, recover a signature, validate an EIP-1271 contract signature, check an approved hash, or authenticate a source. A successful execution, current owner set, or configured threshold is never substituted for evidence of the signers on a particular execution.

## Entry points

```ts
parseSafeEvidence(input: unknown, mode: "synthetic" | "private"): SafeEvidenceBundle
analyzeSafeEvidence(bundle: SafeEvidenceBundle): SafeAnalysis
createSyntheticSafeEvidence(): SafeEvidenceBundle
```

The parser reconstructs known fields, applies a 2 MB input budget, normalizes addresses and UTC timestamps, validates record bounds, rejects conflicting/duplicate event identities and requires provenance on every record. Invalid data throws `SafeEvidenceError` with code `INVALID_SAFE_EVIDENCE` and `retryable: false`.

The version-1 bundle contains `mode`, `configurations`, `executions`, `configurationEvents`, `coverage`, and optional `labels` (returned as an array). Every record has an evidence ID, chain identity and provenance: `{source, retrievedAt, synthetic, sourceUrl?}`. Source URLs must use HTTPS and cannot contain username/password credentials. Synthetic and private modes cannot mix provenance flags; a synthetic label is also excluded from private replay. Parsing does not establish whether a source's private claim is true.

### Configuration

Snapshots are explicitly `genesis`, `current`, or `at-block`, with Safe address, chain, block, optional transaction index, owners and threshold. Owner sets must be unique; threshold is an integer from one through the owner count.

An execution can name `configurationEvidenceId` to compare against a supplied historical snapshot. A missing link remains unavailable; the analyzer never borrows a current snapshot. A link to another Safe/chain, a future snapshot, or a current snapshot is rejected. Same-block ordering without both transaction indexes remains ambiguous. A configuration change in the same outer transaction also remains ambiguous because transaction identity and event indexes alone do not establish per-call authorization order. An observed owner/threshold change between a snapshot and execution invalidates that snapshot's applicability rather than silently reconstructing a new configuration. A contradictory intervening historical snapshot similarly makes the linked older configuration unavailable. Duplicate snapshot identities reject even when supplied under different record IDs.

### Executions and signatures

Each execution retains its outer transaction hash, execution/event index, block, optional transaction index, Safe transaction hash/nonce when supplied, source-reported status, and `authorizationPath`: `owner-signatures`, `module`, or `unknown`. Module authorization is explicitly separate from an owner-signature quorum. Missing authorization path becomes unknown.

Signature observations retain an ID, optional signer, type (`eoa`, `contract`, `approved-hash`, `unknown`), observation method (`supplied` or `source-recovered`), and provenance. A known type requires an observed address. `signatureCoverage` is `partial`, `reported-complete`, or `unavailable`; the last cannot contain observations. Reported completeness remains a source assertion.

Reports show the unique observed addresses, typed observed configured signers, typed observed other signers, unknown observations, configured threshold, and the comparison result. Duplicate observations of one signer never inflate a threshold count. Unknown signature types never count toward the configured threshold, even when a source supplied an address. “Observed count meets threshold” describes supplied identities only; `independentlyVerifiedSignatures` remains `false`.

### Configuration-event coverage

Coverage rows name one Safe, chain, stream and inclusive block window, with status and cursor. An exhausted `configuration-events` window containing no change events may yield **“no changes observed in supplied scope.”** It never means complete history or proof that no configuration ever changed. Setup events are retained separately from subsequent owner/threshold changes. Partial, unsupported, error, absent or contradictory coverage remains explicit. Events outside a supplied coverage window remain visible in a separate uncovered observation.

The synthetic replay includes a fictional 3-of-5 configuration, eleven source-reported successful executions with only one or two observed configured signers, and a bounded event window with no observed changes. It illustrates missing signature coverage; it makes no claim about a real Safe, wallet owner or corporate entity.

## Verification and future work

Focused tests cover quorum/signature separation, duplicate and unknown observations, module execution, temporal ambiguity, stale links, bounded negative observations, malformed/oversized input, mode separation, labels, exact evidence identity and timestamp normalization. Live Safe indexing, historical state verification, signature recovery, module capability analysis and cryptographic validation require separate adapters and coverage contracts.

The signature types and the need for actual signature validation are documented by the primary sources: [Safe signature encoding](https://docs.safe.global/advanced/smart-account-signatures), [checkSignatures](https://docs.safe.global/reference-smart-account/signatures/checkSignatures). This implementation imports no Safe contract source or private case data.
