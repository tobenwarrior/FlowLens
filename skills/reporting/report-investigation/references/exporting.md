# Investigation reports

## Default: a concise human-facing brief

Agents use document `--brief` by default. Page 1: conclusion first, exactly 3 decisive cited facts and 1 scope/ownership caveat, target 150–250 words and never more than 250. No hard minimum; prefer a shorter complete brief to padding. Add an optional page 2 with at most 2 essential, readable screenshots and short source-link/capture-date captions. Do not repeat disclaimers or dump full source ledgers, transaction tables or checksums into the brief. Keep those in a separate private appendix, not attached unless requested.

Material unresolved or contradictory evidence must remain visible in the concise conclusion/facts/caveat; do not manufacture confidence or omit facts merely to fit. Preserve full inputs and author a curated brief manifest. Inspect rendered page count and readability; a two-page target is not permission to clip content. Detailed mode remains explicitly available only on request: render the retained complete audit manifest without `--brief` into a separate appendix. The brief bundle alone cannot restore omitted narrative. The CLI full printed `cleanText`-weighted budget is 2,300 units, not a word counter: wide glyphs count 2, and generated metadata/labels/source hosts/dates/footer count too. Hosts are capped at 60 characters; see [brief bounds](manifest.md). Oversized input errors before writing; nothing is truncated automatically. The shipped brief retains a short source list, one compact Bundle SHA-256 fingerprint and the pointer `Detailed layout available from retained bundle; full investigation kept separately.`; full per-file hashes/ledgers are private detailed output. Short captions show source link and capture date/unknown, with crop/redaction disclosure in the manifest. Every CLI brief format first passes the same offline PDF render gate: no horizontal overflow and exactly 1 page without images or 2 with images; failure writes nothing. Inspect every actual delivered page too.

`scripts/report-investigation.ts` turns one saved FlowLens case into a Markdown report. It is offline: it reads the case file and nothing else. It makes no provider, price, balance or label request, does not expand any wallet and does not modify the case.

```sh
node scripts/report-investigation.ts --file .local/investigations/CASE/case.json --output .local/investigations/CASE/report.md
```

| Flag            | Meaning                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `--file PATH`   | Saved case JSON. Read through the same bounded parser as the CLI and API. |
| `--output PATH` | Report path. Must differ from the case file.                              |
| `--force`       | Replace an existing report. Without it an existing file is refused.       |
| `--top N`       | Strongest transfers listed per asset contract, 1 to 50 (default 3).       |

Keep cases and reports from real investigations under `.local/`. They are private working material and never belong in fixtures, docs or the public release.

## What the report contains

- The full root address, case ID, mode, creation and snapshot (`updatedAt`) times, the range of evidence retrieval and coverage update times, the case file name and a SHA-256 of the normalized snapshot so a reader can confirm which snapshot was reported.
- Coverage per wallet and chain: provider, status, streams, pages loaded, whether a cursor (more history) remains, update time and warnings or error codes. Root chains with transfers but no root coverage record are listed as gaps.
- Root inflow, outflow and net per asset contract, as exact decimal amounts from raw integers and recorded decimals, with transfer counts split into in, out and self. Native assets show contract `native`; every token shows its full contract.
- The largest non-self root transfers within each asset contract, with time, full counterparty address, recorded label, full transaction hash, explorer link and evidence ID. Amounts are never compared across assets, because the report has no prices.
- The first observed inbound transfer per chain. It is described as the earliest indexed inbound only when every root coverage record on that chain is exhausted with no cursor, and then only for the listed streams; the report counts any coverage warnings beside it. Exhausted indexed history is still not earliest-ever funding, because indexes and trace streams can omit or reclassify transfers. Otherwise it is marked as first observed, not earliest funding. Neither reading identifies a funding source.
- Recorded labels with kind, confidence, claim type, source, retrieval and observation times and evidence note.
- Transfer counts per recorded evidence source, and the case notes.

## Reading limits

Detailed audit reports include these limits; a brief combines applicable material scope/ownership limits into 1 concise caveat rather than repeating the full list:

- Net flow is loaded inflow minus loaded outflow. It is not a holding, balance, profit, loss, buy or sell.
- Self-transfers count as both inflow and outflow. Failed transactions are excluded by provider validation, yet a successful frame inside a larger transaction can still mislead.
- Dust, spam, same-symbol tokens from noncanonical contracts and Unicode lookalike symbols are reported per contract and never merged by symbol. The report flags a symbol shared by more than one contract on a chain, a non-ASCII symbol, and a token named like a native asset.
- Labels, counterparties, timing and amounts do not prove ownership or attribution. A recorded source is provenance, not authentication.
- Partial, errored, unsupported or missing coverage means gaps in chains or streams.

## Untrusted text

Labels, token symbols, titles, notes, provider names and warnings come from providers, imports or people and are treated as data. The report escapes Markdown punctuation and HTML characters, collapses line breaks, and shows invisible or bidirectional control characters as `[U+XXXX]`. Links are emitted only for HTTPS label sources and fixed explorer origins. The output contains no executable HTML.

## Auditing a report

Before relying on a report, audit the case it came from with the [audit-trace-evidence skill](../../../investigation/audit-trace-evidence/SKILL.md): coverage, cursors, budgets and the evidence behind each claim. The full tracing method is in [tracing-guide.md](../../../investigation/trace-wallet/references/tracing-method.md).

## Tests

`tests/report-investigation.test.ts` uses synthetic addresses only. It covers exact per-contract sums, same-symbol and lookalike flags, escaping, the first-inbound wording, determinism, overwrite refusal, `--force` and that the case file is left byte-identical. Like the rest of `tests/`, it stays out of the public repository.

## PDF, DOCX and HTML with cited screenshots

Use the [report-investigation skill](../SKILL.md) for a reusable research-ledger → verified claims → privacy-reviewed screenshots → local manifest → document → all-page review workflow. The [manifest v1 reference](manifest.md) lists the shared fields and citation rules. This path curates an evidence report; it does not automatically establish that its written assertions follow from a case.

```sh
node scripts/report-document.ts --manifest .local/investigations/CASE/brief-manifest.json --output .local/investigations/CASE/brief.pdf --brief
node scripts/report-document.ts --manifest .local/investigations/CASE/brief-manifest.json --output .local/investigations/CASE/brief.docx --brief
node scripts/report-document.ts --manifest .local/investigations/CASE/brief-manifest.json --output .local/investigations/CASE/brief.html --brief
```

Generate PDF OR DOCX as requested; generate both only when requested. HTML is a local preview. The exporter reads the local manifest, optional case and local PNG/JPEG inputs without remote fetching; source URLs are citations, not permission to retrieve images or pages. An existing output requires explicit `--force`, never an automatic retry. Outputs must not alias any case, manifest or image input, including symlink/hardlink aliases. Preserve input bytes and retain pre/post SHA-256 inventories.

Use `--brief` for the default concise document; omit it only for explicitly requested detailed audit output. Optional `--format pdf|docx|html` must agree with the output extension. Case and image paths resolve from the manifest directory by default; `--bundle-root DIR` changes that confined input root. Unknown manifest keys are rejected. Section paragraphs/bullets/table are optional; sections/sources/screenshots/limitations default to empty arrays. A supplied case root must match the manifest subject.

The exporter computes manifest/case/image SHA-256 and image dimensions. Detailed mode prints Evidence inventory and full figure metadata with bundle-relative paths and writes no checksum sidecar; keep it separate from the brief. Brief captions retain the cited source and capture date/unknown status without repeated metadata. It embeds exact local image bytes; redactions are disclosure text, not image edits. Image display scales down only. Limits: manifest 1,000,000 bytes, case 5,000,000 bytes, each PNG/JPEG 8,000,000 bytes, 12,000 pixels per side and 40,000,000 total pixels. Aggregate image caps are 64,000,000 bytes and 200,000,000 decoded pixels per report; JPEG decoding has a 512 MB memory budget. Images undergo PNG scanline/chunk validation or strict JPEG decoding without rewriting source bytes. See the manifest reference for section/source/image-count bounds.

All CLI `--brief` outputs, including DOCX and HTML, need `@playwright/test` and installed local Chromium/Google Chrome for print-layout validation before writing. Detailed DOCX/HTML use installed project dependencies without a browser; detailed PDF needs the browser. The exporter never downloads a browser; PDF rendering disables JavaScript, runs offline and aborts every network request. If no browser exists, report the limitation instead of silently downloading one or using a hosted converter.

Each included screenshot needs an evidence ID, descriptive caption, resolvable source ID/URL, original capture UTC (or `null`/omitted when unknown) and crop/redaction disclosure. Keep original capture, user-supplied evidence and derived figures distinct. Cropping now does not establish when an older screenshot was captured. Screenshots observe a source; they are not independent proof of its claims.

Prefer fresh authorized visible public-source crops. Never automatically include user-uploaded chats. Before embedding, remove private chat names, personal aliases, contacts, secrets and logged-in account UI using irreversible redaction, then inspect the final image and metadata. Preserve originals privately; do not fabricate proof images or copy real case images/brands into public examples. Do not infer nationality/ethnicity from names or pseudonyms; published company country must have explicit public business evidence and context.

Keep company-profile matching, wallet-ownership/control and user confirmation separate. A `user-confirmed` assessment records the user’s confirmation of the stated candidate/claim, not stronger on-chain ownership proof. Report exact amounts/contracts/hashes with claim-specific citations and coverage limits; no source label, screenshot, payment or matching name authenticates beneficial ownership.

Render ALL pages of the delivered PDF and DOCX locally and inspect readability, page breaks, tables, images, captions, source links and privacy. A DOCX ZIP/XML check or HTML preview is not a substitute for rendered-page inspection. If a suitable local renderer is unavailable, disclose incomplete visual QA rather than certify the output. No hosted converters, paid APIs or posting are authorized by this workflow.

`tests/report-investigation-skill.test.mjs` checks the skill/docs/manifest contract and public-source links using no private investigation data. It remains in ignored `tests/`; it does not certify real-source truth or completed visual QA.
