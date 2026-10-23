---
name: report-investigation
description: Produce an offline PDF or DOCX investigation report with cited, privacy-reviewed screenshots from a FlowLens research ledger and local manifest. Use when asked for a shareable evidence report, PDF, DOCX or screenshot-backed investigation document; preserve claim limits, sources, timestamps and checksums.
---

# Report an investigation

Use [trace-wallet](../../investigation/trace-wallet/SKILL.md) for research and [audit-trace-evidence](../../investigation/audit-trace-evidence/SKILL.md) before drafting. This skill packages existing authorized evidence; it does not fetch providers, infer identities, sign, post or purchase access. Follow [AGENTS.md](../../../AGENTS.md) and the [report guide](references/exporting.md). Keep real cases, manifests, original captures, redacted images, inventories and output under `.local/investigations/<case>/`, never public source or fixtures.

## 1. Verify the research ledger and claims

- Record full addresses, numeric chain IDs, exact transaction hashes/event or trace indices, raw integer amounts/decimals, token contracts, block and UTC event times, source URLs and observation/retrieval times. Keep gross inflow/outflow/net separate; transfers are not balances, trades, profit or ownership. Preserve provider/chain/stream/page/cursor errors and date gaps.
- Separate company-profile matching, wallet-ownership/control claims and user confirmation. A user-confirmed candidate is a user statement, not upgraded on-chain ownership proof or independent corroboration. State exactly which claim was confirmed and which remains unresolved; do not reproduce private chat as proof.
- Never infer nationality or ethnicity from names or pseudonyms. Company country can come only from explicit public business metadata with source/date and scope, not a private person’s identity, residence or location. Platform-reported account country is weak context, not proof of company headquarters or wallet control.
- Classify each material claim as observed, calculated, source assertion, hypothesis or user-provided confirmation. Use `assessment.status` only for the conclusion actually written: `unresolved`, `hypothesis`, `source-supported` or `user-confirmed`. Do not turn a platform label, service funder, screenshot or matching brand into ownership proof. No invented percentages, aggregate assertions or forced verdict.
- For a cluster, preserve its kind, chain-scoped candidate members/roles, exact per-hop evidence, population and exclusions, alternatives, missing assignment/control join and route outcomes. Follow the [cluster ledger](../../investigation/cluster-wallets/references/hypothesis-ledger.md); use existing manifest sections/tables rather than an unsupported `clusters` field.

## 2. Acquire only authorized visible images

- Capture only authorized visible web content. Prefer a fresh, cropped public-source capture with exact source URL and capture UTC time. Use only already authorized accounts/access; no bot-check bypass, hidden fields, private scraping or paid tools/APIs. Do not send cases or private screenshots to hosted renderers.
- User-uploaded chat screenshots must not be included automatically. Prefer a fresh public-source crop. If a user-provided image is necessary and explicitly approved for inclusion, label it user-supplied, keep original capture time unknown when unknown, and review it for third-party privacy. A filename, upload time, report preparation time or EXIF guess is not the original capture timestamp. Use `capturedAt: null` or omit it when unknown.
- Distinguish original capture, user-supplied evidence and derived figures in each caption/ledger. A crop or redaction is a derived image: disclose the transformation and preserve the original privately. A diagram or synthetic fixture is not a screenshot of an external source. Never fabricate proof images, alter source wording/numbers or silently reconstruct missing UI.
- Before embedding, crop/redact private chat names, personal aliases, logged-in account sidebars, contact details, session/account identifiers, secrets and unrelated content. Use irreversible masks/flattened image exports, not removable layers or translucent blur. Inspect the final embedded image, including margins, metadata, filename and caption. Retain enough source context to prevent a misleading crop.
- For each included PNG/JPEG record an evidence ID, local path, descriptive caption, source ID, exact source URL, known/unknown capture UTC and redaction/crop disclosure. A screenshot is a source observation, not independent truth or a second source corroborating the page it depicts. A missing screenshot remains missing; do not substitute an invented one.

## 3. Prepare the local manifest and inventory

Follow the exact [manifest contract](references/manifest.md). Use version 1, a clear title, known UTC `preparedAt`, `classification: "Private investigation"`, full subject address and chain IDs, bounded summary/conclusion, sections, sources, screenshots and limitations. Keep the source ledger alongside it; do not add undocumented manifest keys. Source and evidence IDs must resolve. Use exact source URLs without credentials, access tokens or private session parameters.

- Resolve `caseFile` and image paths relative to the manifest directory by default, never the shell working directory. If `--bundle-root DIR` is explicit, those paths are relative to that confined root instead. Include only the intended local case and reviewed PNG/JPEG files, not arbitrary paths, remote URLs, browser caches or private chats. Source URLs are citations, not fetch instructions.
- Calculate SHA-256 hashes of the original manifest, optional case and every original/derived image before exporting; retain the inventory privately. Preserve original capture timestamps separately from file-modification/report times. After export compare input hashes byte-for-byte and hash the final outputs. A checksum proves byte identity, not authenticity or claim truth.
- The exporter computes manifest/case/image SHA-256 and image dimensions, records them in Evidence inventory and figure captions with bundle-relative paths, and writes no checksum sidecar. It embeds the exact reviewed image bytes and only scales display down, never up; it performs no image redaction. Retain your private pre/post input and output inventory separately.
- Pick new output paths that cannot alias any input through a symlink, hardlink or shared canonical path. Preserve inputs even with `--force`; overwriting a report is different from overwriting evidence. Never delete originals or silently overwrite existing outputs.

## 4. Export only the requested formats, offline

Run from the project root, with the project-supported Node version and already reviewed local dependencies. Replace `CASE` with a private local case directory. The manifest supplies text and local image inputs; the exporter makes no remote fetching or provider/price/label calls.

```sh
node scripts/report-document.ts --manifest .local/investigations/CASE/report-manifest.json --output .local/investigations/CASE/report.pdf
node scripts/report-document.ts --manifest .local/investigations/CASE/report-manifest.json --output .local/investigations/CASE/report.docx
node scripts/report-document.ts --manifest .local/investigations/CASE/report-manifest.json --output .local/investigations/CASE/report.html
```

Optional `--format pdf|docx|html` must agree with the output extension; it cannot override a mismatched extension. Optional `--bundle-root DIR` changes the confined local input root, not the output format. DOCX/HTML use installed project dependencies; PDF additionally needs `@playwright/test` and an already installed local Chromium or Google Chrome. The exporter never downloads a browser, disables JavaScript, uses an offline context and aborts network requests. If a browser is missing, disclose the limitation; do not install one without separate authorization.

Choose PDF OR DOCX according to the request; run both only when both are requested. HTML is a local preview, not a substitute for inspecting the delivered format. Existing output is refused without explicit `--force`; use it only when replacement is authorized. Do not automatically append it after an error. A missing dependency or renderer is a reported limitation, not permission to install paid software, call hosted conversion APIs or change global configuration.

## 5. Render every page and inspect the delivered format

- Render ALL pages of each final PDF and DOCX with an available local renderer, then inspect every rendered page. DOCX requires a local viewer/converter capable of pagination; a ZIP/XML check is not visual QA. HTML preview alone does not certify PDF or DOCX layout. If no suitable renderer is available, report visual QA incomplete and do not claim the document passed.
- Check readability at normal viewing size, page breaks, clipped text, table wrapping, orphan headings, full addresses/hashes, screenshot resolution/crop, captions, citation/source IDs and visible link text. Confirm source links point to the intended public URL without silently opening/fetching them. Confirm unknown capture dates remain unknown and all redactions are disclosed.
- Reopen the final output after layout fixes and inspect ALL pages again; each format paginates differently. Never claim one format is validated because the other looks correct. Verify no image, caption, metadata or source inventory leaks private aliases, chat names or account UI.
- Compare final input hashes with the pre-export inventory; retain file sizes, output SHA-256, source/image inventory, page counts, reviewed formats and any rendering limitations. Preserve manifest, case and images unchanged; keep any normalization/derived image distinct and disclosed.

## 6. Deliver a bounded report

Return requested file paths and their SHA-256 values, with a concise conclusion, claim-specific status, scope/coverage limits and any incomplete visual QA. Include cited screenshots only if authorized and reviewed. Do not post, upload or share externally without separate authorization. Do not attach raw chats or unredacted originals by default.

[Manifest reference](references/manifest.md) defines fields; [report guide](references/exporting.md) explains the CLI and limits. Contract tests are local: `node --test tests/report-investigation-skill.test.mjs`. Synthetic tests are not evidence about any real company or wallet.
