# Receipt verification for displayed transfers

## Acquire evidence for the selected routes

1. Resolve each displayed member through its FlowLens evidence ID. Deduplicate receipt requests by chain and transaction hash. Retain each transfer's event index even when several rows share a receipt.
2. Use an authorized public source for the transaction, execution receipt and block. Confirm the source chain ID, fetch the block with its list of transaction hashes and record the retrieval time. Preserve the successful receipt's logs in full. Validate canonical ERC-20 contract and decimals before formatting human amounts.
3. Record archive access or receipt-decoding errors against the affected transaction. When a second source is authorized, send only unresolved hashes. Join its receipts to the original chain transaction and block records. A successful receipt on a different chain or block cannot resolve the row.
4. Keep all acquired rows in the accounting ledger. Move failed or unsupported rows outside the verified transfer selection. Record internal transfers with the relevant complete call tree, and HyperCore with the corresponding venue ledger records. Preserve those evidence types separately from receipt-verified native and ERC-20 arrows.

## Run the offline check on the final selection

Add a `proofs` file path, relative to the operator-reviewed map manifest. The file contains an array with one object per chain and transaction hash:

| Field | Value |
| --- | --- |
| `chainId` | Positive integer returned by the selected chain |
| `transaction` | JSON-RPC transaction result |
| `receipt` | JSON-RPC transaction receipt result |
| `block` | JSON-RPC block result with transaction hashes |
| `sources` | Object with `transaction`, `receipt` and `block` HTTPS source URLs, with no credentials, query strings or fragments |

```sh
node skills/investigation/render-transaction-map/check-ledger.mjs "$MAP_MANIFEST" --require-receipts
```

The command uses local files. It checks block membership, block timestamp, endpoints, successful execution and the exact native value or ERC-20 log. It reports `receiptVerified` and the full `unresolved` list. An unresolved row exits nonzero. A pass requires `receiptVerified` to equal `onMap` with an empty `unresolved` list. Run the command after changing route membership. The checker matches supplied records and cannot authenticate where they came from, confirm chain finality on its own or audit labels. Retain provider provenance and any finality limit.

Build the actual export from the passing selection. Reconcile the visible arrows, their amounts in human units, directions, chains and member counts against that same manifest. Keep the exact full addresses, asset contract, raw values, block, UTC and correct-chain explorer link in the receipt companion. Report the acquired and displayed counts separately from the number of displayed rows successfully verified.
