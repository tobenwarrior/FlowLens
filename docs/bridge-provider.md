# Known-transaction CCTP acquisition

`server/bridge-provider.ts` adds read-only acquisition for one supplied Ethereum, Base or Arbitrum One mainnet transaction. It returns a private replay bundle that the existing bridge matcher can analyze. It does not search a wallet, scan a destination chain, call Circle Iris, or infer a transfer from equal amounts or nearby times.

```ts
acquireBridgeEvidence(
  { chainId, hash, maxLogs: 256 },
  { rpc: RpcClient },
): Promise<BridgeAcquisitionResult>
```

The result contains `bundle`, `scope: 'transaction'`, `warnings`, sanitized error codes in `errors`, typed `issues: { code, retryable }[]`, and `events`. Retryability preserves the RPC classification; transaction-not-yet-available gaps are retryable and identity failures are permanent. `events` preserves decoded official event identities even when a complete asset/amount observation cannot be normalized; `normalized: false` is explicit. It is acquisition metadata, not a substitute for the validated replay bundle. Evidence provenance has `synthetic: false`; the replay mode is `private`.

`maxLogs` defaults to 256 and accepts 1–2,000. The provider reads only the receipt's bounded prefix. It performs four RPC calls: chain identity, transaction, receipt, and canonical block by number. The shared public transport additionally enforces response bytes, duration, pacing and request budgets. No automatic retries or credential fallback occur.

Before examining logs, the provider checks chain identity, the requested transaction hash, mined transaction/receipt block identity, receipt status, sender/recipient/index agreement, and the transaction hash at its canonical block index. It rejects removed logs, duplicate or unordered indices, and transaction/block identity mismatches throughout the inspected prefix. A reverted receipt yields no movements. A missing or pending transaction remains unavailable. These checks compare observations from one RPC; they do not independently authenticate the chain or exclude later reorganizations.

## Supported contracts and assets

Only Circle's documented contract emitters and their exact ABI topics are accepted. The registry was checked on 21 October 2026. Its scope is deliberately limited to the following mainnets:

| Chain        | Chain ID | CCTP domain | Native USDC                                  |
| ------------ | -------- | ----------- | -------------------------------------------- |
| Ethereum     | 1        | 0           | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` |
| Base         | 8453     | 6           | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| Arbitrum One | 42161    | 3           | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` |

Sources: [Circle domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains), [native USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses). Contract identities, not ticker symbols, determine the asset. Explicit replay mappings identify these native-USDC pairs with a 1:1 raw-unit ratio; all use six decimals.

Legacy messenger/transmitter addresses are taken from [Circle's legacy mainnet registry](https://developers.circle.com/cctp/v1/evm-smart-contracts). V2 uses TokenMessenger `0x28b5a0e9c621a5badaa536219b3a228c8168cf5d` and MessageTransmitter `0x81d40f21f12a8f0e3252bccb954d722d4c464b64` on all three chains, from [Circle's current registry](https://developers.circle.com/cctp/references/contract-addresses). The newer TokenMessengerWithFees contract is outside this implementation's allowlist.

## Event and message validation

Legacy CCTP uses wire/header and burn-body version 0; the replay model calls this protocol version 1. CCTP V2 uses wire/body version 1 and replay protocol version 2. The implementation checks both versions rather than interpreting the wire value as the replay version. It decodes the 116-byte legacy or 148-byte V2 header, and the 132-byte legacy or minimum 228-byte V2 USDC burn body. Unknown domains, non-EVM addresses, mismatched messenger endpoints, unknown burn-token identities, malformed data and inconsistent amounts remain unnormalized. See [legacy format](https://developers.circle.com/cctp/v1/message-format) and [current technical guide](https://developers.circle.com/cctp/references/technical-guide).

Source normalization requires one `MessageSent(bytes)` from an official transmitter, one corresponding official `DepositForBurn` event, and a directly called official `depositForBurn` transaction (`depositForBurnWithCaller` for legacy and `depositForBurnWithHook` for V2 are also supported). The transaction sender must equal the message's depositor. Calldata, deposit event and message must agree on amount, source USDC contract, recipient, domains, destination messenger and caller; legacy nonce and V2 fee/finality/hook fields are also checked. The emitted message precedes its deposit event. An inspected prefix can retain that complete direct deposit even when later receipt logs are omitted; coverage stays partial.

Legacy `replaceDepositForBurn` emits both `MessageSent` and `DepositForBurn` without burning again. These logs alone cannot prove a new source movement. Replacement calls, wrappers, missing deposit events, conflicting fields or ambiguous events retain message metadata and an explicit unavailable source amount. Direct official deposit-call semantics establish that the burn succeeded under the canonical successful receipt. See [Circle's legacy implementation](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMessenger.sol#L214-L281). A normalized source observation retains integer raw amount, message sender, mint recipient, domains, applicable nonce and emitted-message hash.

**V2 source identity is incomplete onchain.** The emitted message contains a zero nonce placeholder; Circle assigns the nonce offchain, and attestation changes additional header/body fields. The provider omits that placeholder as a matching nonce. It preserves the emitted raw message hash and warns that this hash cannot join the attested destination message. It never converts the shared zero placeholder into a cross-chain identity. See Circle's [V2 message serializer](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/MessageV2.sol).

Destination normalization requires one directly called `receiveMessage(bytes,bytes)` transaction, one official `MessageReceived` event and one official `MintAndWithdraw` event in the complete inspected receipt. Calldata message domains, nonce, sender, body and applicable executed finality must agree exactly with the received event. The message must target the official local TokenMessenger. Its earlier mint event must name the registered local USDC contract and expected recipient, and the logged mint amount and fee must agree with the message body. This establishes attribution before comparing amounts. Multiple, malformed or capped events, wrappers, and missing calldata/mint evidence retain decoded event metadata with an explicit unavailable destination amount. No preferred candidate is selected.

The ABI declarations follow Circle's Solidity: [legacy transmitter](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/MessageTransmitter.sol), [V2 transmitter](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol), [legacy messenger](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMessenger.sol), and [V2 base messenger](https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseTokenMessenger.sol). In particular, `sourceDomain` is not indexed; V2's nonce is `bytes32` and its executed-finality field is indexed.

The destination observation uses the received-event index. A nonzero V2 destination fee uses the mint-event index and exact logged `feeCollected`, avoiding duplicate replay event identities. Fee recipient identity is not inferred. A mint or exact transport join does not prove a customer was credited: independent credit remains `unverified`, and its coverage remains `unavailable`.

All successful receipt coverage is partial and transaction scoped. No stream is labeled full history or supplied-scope-exhausted. Unsupported chains make no RPC requests. The matcher may retain unmatched source/destination records, conflicting routes, unresolved identities, or amount differences; acquisition does not override these states.

## Verification

`node --test tests/bridge-provider.test.ts` uses injected RPC responses to exercise legacy/V2 source and destination decoding, actual asset identity, exact nonce checks, direct source-call binding and replacement rejection, V2 placeholder handling and fees, malformed additional events, canonical membership, reverted/pending transactions, transport errors and retryability, fake emitters, unsupported domains/chains and log budgets. The tests make no live network requests. A live success claim requires a separately documented public transaction and successful bounded acquisition; unit fixtures are not presented as live observations.
