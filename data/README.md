# Shared wallet labels

`wallet-labels.json` is the tracked, reviewable catalogue that FlowLens may read on
startup and when applying labels to a new trace. It is intentionally empty until a
reviewed public entry is prepared and committed by a human.

Each entry is one exact `chainId` plus full normalized address and reuses the local
`StoredLabel` shape. A catalogue label must have an HTTPS `sourceUrl`, `observedAt`,
`claimType`, `retrievedAt`, and a non-synthetic, non-demo confidence. Verified claims
also need `claimType: "verified-evidence"` and an `evidenceNote`; FlowLens does not
authenticate those claims.

The validator accepts at most 50,000 entries, and the existing bounded JSON reader
limits the catalogue file to 5 MB. These safety limits are not a promise to import a
provider dump.

The required `redistribution` object records the basis and date of a review of
redistribution rights by a person. `status: "reviewed"` is a review record, not a
licence grant or permission to copy a provider's restricted data. Do not add Arkham, Nansen, provider-restricted or
private investigation labels without separately confirming the right to redistribute
the exact source and label.

Prepare one selected label from a local file with:

```sh
node scripts/wallet-labels.ts prepare \
  --file .local/labels.json --chain 1 \
  --address 0x0000000000000000000000000000000000000000 \
  --output .local/wallet-labels.draft.json \
  --redistribution-basis "Human review of the cited public source"
```

Preparation writes a new draft only, refuses to overwrite an existing path, and never
exports the private store broadly. Review the draft, run `validate`, then copy an
approved entry into this tracked catalogue and review the diff before committing or
sharing. If `--redistribution-basis` is omitted, the draft is marked
`pending-review` and `validate` deliberately rejects it until a human records the
review basis. `label_forget` only removes a private label; a shared label can reappear
on a later trace unless the tracked catalogue entry is deliberately removed.
