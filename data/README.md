# Shared wallet labels

`wallet-labels.json` is the tracked catalogue that FlowLens reads when applying
shared labels. Everyone who updates their clone receives the published entries.

## Update the catalogue after each trace

1. Check each new or corrected label against the catalogue using its chain ID and
   full address. Confirm the source supports the exact address, chain and claim.
2. Prepare each shareable candidate in an ignored `.local/` draft. Present the
   chain, full address, proposed label, source, dates, confidence and redistribution
   basis for human review.
   Keep private case data, unsupported hypotheses and restricted labels local.
3. After approval, add or update the exact entry in `wallet-labels.json`. Preserve
   unrelated entries and retain the source, dates and confidence. Review conflicting
   evidence before replacing a published label.
4. Run `npm run labels:check`, review the catalogue diff, and commit and push
   only the approved catalogue entries. If review is pending, keep the draft
   local and record its status in the trace handoff.

Follow the same review process for older labels when revisiting them.

Each entry is one exact `chainId` plus full normalized address and reuses the local
`StoredLabel` shape. A catalogue label must have an HTTPS `sourceUrl`, `observedAt`,
`claimType`, `retrievedAt`, and a non-synthetic, non-demo confidence. Verified claims
also need `claimType: "verified-evidence"` and an `evidenceNote`; FlowLens does not
authenticate those claims.

The validator accepts at most 50,000 entries, and the existing bounded JSON reader
limits the catalogue file to 5 MB. These safety limits are not a promise to import a
provider dump.

The required `redistribution` object records the basis and date of a human review.
Confirm the right to redistribute the exact label and source before publishing.
A publicly visible label can still be subject to provider restrictions. Keep
Arkham observations local unless redistribution of the exact entry is authorized
under the applicable [Arkham terms](https://info.arkm.com/terms-of-service).

Prepare one selected label from a local file with:

```sh
node scripts/wallet-labels.ts prepare \
  --file .local/labels.json --chain 1 \
  --address 0x0000000000000000000000000000000000000000 \
  --output .local/wallet-labels.draft.json
```

Preparation selects one entry and writes a new file. The example produces a
`pending-review` draft that the catalogue validator rejects. After human approval,
prepare to a new filename with `--redistribution-basis` set to the approved basis
and use `--reviewed-at` if the review took place earlier. Validate the reviewed draft
with `node scripts/wallet-labels.ts validate --file <reviewed-draft>` before copying
its approved entry into the catalogue.

`label_forget` only removes a private label. To retract a shared label, remove
the exact chain/address entry from the tracked catalogue and publish the correction.
