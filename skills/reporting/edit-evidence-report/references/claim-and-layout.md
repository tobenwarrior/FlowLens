# Claim and layout checks

## Claim ledger before prose

Keep a private ledger linking each material statement to evidence. Use only fields the available records support:

| Field | Purpose |
| --- | --- |
| Evidence ID and type | Stable reference; fact, calculation, assertion or inference |
| Observation | Exact direction, amount, asset, chain and UTC; avoid inferred intent |
| Retained proof | Source URL/file and retrieval time; full transaction/event identity |
| Attribution source | Exact label wording, who supplied it and prediction status |
| Source family | Which reports depend on the same original assertion |
| Relevance | Why this observation changes the comparison |
| Limit | The specific missing join, contrary fact or coverage gap |

An exact transfer receipt and a company label are separate evidence. The receipt can verify the payment while the label remains uncertain. A corporate ownership conclusion requires its own join.

## Reader layout

Use a short conclusion followed by the material evidence and countercase. If both are weak, lead with the unresolved finding. Put the most useful comparison or timeline before the address register.

A useful evidence row answers: **what happened, how it is known, why it matters**. Prefer a few wide columns. Give a short transaction reference in the main text; put full identifiers and raw values in a technical ledger with room to wrap. Markdown can link the short reference directly; use the source register for formats whose renderer does not support inline links.

State a general qualification once. At a later evidence item, include only its distinct limitation: a predicted label, reversed chronology, reused source family, missing customer assignment or unverified bridge credit. Repeating "transfers do not prove ownership" after every row adds no new evidence.

Synthetic example: a provider-labelled company wallet pays a funder in June, but the funder paid the target in May. The two receipts establish a network relationship. The chronology prevents treating those payments as a same-funds route. One timeline and one explicit inference cover this; extra pages restating the limitation do not strengthen it.

## Bind to the existing manifest

- `assessment.conclusion` supplies the reader's finding. `summary` supplies its short rationale and scope. The exporter already prints both: begin authored `sections` with the deciding evidence, rather than adding another Finding or Executive Summary section.
- `sections`: comparison, critical chronology, open questions and technical appendix as needed. Use short evidence handles in the reader section and map them to full record identities in the ledger. The v1 schema has no custom evidence-card, cluster or layout fields.
- V1 section strings are plain text, not Markdown markup. Inline Markdown links print literally; use evidence IDs that resolve to the linked `sources` register.
- `sources`: sources actually cited by this edition, grouped honestly by provenance. Retain the full research source register in the audit package.
- `screenshots`: retain complementary proof images in reader editions. Cover relevant source assertions, label wording, transfer direction/amount/status/time and contrary evidence. Shorter prose does not imply fewer screenshots or a fixed figure/page cap. Keep source/capture/crop disclosures accurate; each figure observes its underlying source rather than adding independent corroboration.
- `limitations`: distinct material gaps. Account for boilerplate the exporter already adds.
- `caseFile`: the actual attached case. If using a filtered derivative, give it a separate identity and describe exclusions; retain and deliver the full research case too. A snapshot's loaded totals are not the investigation's total coverage.

Default detailed export can have a short reader section and a full technical appendix. The existing `--brief` format has separate strict limits and remains an explicitly requested option; an editorial cleanup does not require it.

## Final reader test

Ask an independent reader to identify the finding, strongest contrary evidence and unresolved ownership/control question from the opening section. Then ask them to reproduce one decisive amount and chronology from the attached ledger. Revise the part that fails; do not add general warnings to compensate for a missing source.
