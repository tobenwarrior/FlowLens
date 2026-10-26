# Screenshot-backed investigation manifest v1

Read [the report skill](../SKILL.md) before preparing real evidence. All paths below describe local private inputs; source URLs are citations only, never remote image-fetch requests. Input paths default to the manifest directory; explicit `--bundle-root DIR` makes case/image references relative to that confined root. Unknown keys are rejected. This is a contract reference, not a public investigation or a template filled with real addresses/brands.

## Default: an evidence-complete report

Default to the detailed report without `--brief`, with a short executive summary and all material evidence, transaction tables, source citations, timestamps, readable screenshots and inventories in the delivered report. Do not omit evidence for a page cap or hide material proof in an unattached appendix. Briefs are opt-in only.

## Optional brief authoring

Use the same v1 schema for the concise brief; `--brief` is a CLI flag, not an extra manifest key. Curate a separate `brief-manifest.json` without modifying the complete audit manifest or research ledger. Keep page 1 to 150–250 words maximum (never more than 250): conclusion first, exactly 3 decisive cited facts and 1 scope/ownership caveat. Material unresolved or contrary evidence belongs in those facts/caveat, not silently removed. There is no hard minimum: do not pad or invent confidence.

Use `assessment.conclusion` for the verdict, a non-repetitive `summary`, one focused section of 3 decisive facts, and a concise material limitation. Include at most 2 essential readable screenshots for an optional second page. Captions stay short with source ID/link, capture date or unknown status and material redaction disclosure. Keep exact contract/hash ledgers, full source inventories and checksums in a separate private appendix. Detailed audit output is the default; preserve the full inputs so no evidence is lost. Rendering/word/page checks still apply; a flag cannot decide which facts are material.

## Shipped `--brief` bounds (separate from the word policy)

Per-field limits count trimmed string characters; the total page-1 budget counts the full printed `cleanText`-weighted stream, not words or raw manifest lengths. `Prepared` labels document preparation only; it is not a source-observation or image-capture time. This is not a word counter. Invisible/bidi markers count as their expanded visible `[U+XXXX]` spelling; supported CJK, Hangul, full-width, emoji and U+20000–U+3FFFD glyphs count 2, other displayed characters count 1. Keep the authored executive page at 150–250 words maximum 250 AND within these stricter renderer bounds; do not claim the CLI enforces word count or exactly 3 facts.

| Field/group                   | Brief maximum                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Title / subtitle              | 90 / 120 characters                                                                                                 |
| Summary / conclusion          | 600 / 300 characters                                                                                                |
| Sections / heading            | 1 section / 60 characters                                                                                           |
| Section paragraphs            | 1 paragraph / 300 characters                                                                                        |
| Bullets plus table rows       | 4 items total; author the default 3 decisive facts                                                                  |
| Bullet / table cell / columns | 220 / 100 characters / 4 columns                                                                                    |
| Limitations                   | 1 qualification / 250 characters; a default ownership caveat appears if omitted                                     |
| Sources / source title        | 6 sources / 80 characters                                                                                           |
| Screenshots / caption         | 2 screenshots / 140 characters                                                                                      |
| Total page-1 text             | 2,300 weighted printed units after `cleanText`, including generated metadata, labels, source hosts/dates and footer |
| Source URL host               | 60 characters maximum, independently of source title/URL limits                                                     |

Oversize text, counts or unreadable images fail with `Manifest is too long for --brief` and `nothing is truncated automatically`, before any render/write. Review and rewrite the curated brief; do not bypass with detailed mode unless requested or drop unresolved material evidence. Images are never upscaled: one fits 657×860 CSS pixels, two fit 657×400 each; below one-third scale or narrower than `min(320px, original width)` is refused. Crop tightly without falsifying context.

The weighted total includes title/subtitle/classification, generated subject/address/chains and Prepared document-time text, status/gloss, summary/conclusion, all section/table text, qualification/default, source IDs/titles/hosts/observation dates or type and the digest footer. All count after `cleanText`; short raw invisible or wide text can therefore exceed the printed budget.

The shipped brief includes a compact linked source list and one Bundle SHA-256 fingerprint, not the full inventory or per-file hashes. Its footer says `Detailed layout available from retained bundle; full investigation kept separately.` Omitting `--brief` on the same brief bundle changes layout only; it does not restore omitted investigation narrative. Preserve a separate complete audit manifest/ledger for the detailed appendix. Its short caption is `Figure ID. caption Source: title/link · captured YYYY-MM-DD|unknown`; any crop/redaction is flagged as disclosed in the manifest. Full capture UTC, redaction details, source register, case ledger and per-file hashes stay in the manifest/private detailed appendix. No appendix or checksum sidecar is generated automatically.

Every CLI brief format is gated by offline Chromium print-layout validation before output: any non-image horizontal overflow fails, and the PDF page count must be exactly 1 without screenshots or 2 with screenshots. Consequently brief DOCX and HTML also require an installed local Chromium/Chrome. On failure no output is written; nothing is clipped, hidden, truncated or summarized. All text, headers and footers wrap. Still inspect every actual PDF/DOCX page and fix readability/page breaks; the common PDF gate is not native DOCX pagination proof. Do not certify a document from HTML preview or test results alone. Detailed CLI behavior remains unchanged when `--brief` is omitted.

## Top-level fields

| Field            | Contract                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | Required integer `1`.                                                                                                                                                   |
| `title`          | Required string, 1..200 characters.                                                                                                                                     |
| `subtitle`       | Optional string, 1..300 characters.                                                                                                                                     |
| `preparedAt`     | Required known ISO UTC timestamp ending in Z; report preparation, not original image capture.                                                                           |
| `classification` | Required nonempty string, up to 100 characters; use `"Private investigation"`.                                                                                          |
| `subject`        | Required object: `address` (full EVM address), `chainIds` (1..20 unique positive safe-integer chain IDs).                                                               |
| `caseFile`       | Optional local case JSON path relative to manifest directory or explicit bundle root; case root must equal `subject.address`.                                           |
| `summary`        | Required string, 1..10,000 characters; stay within the actual research scope.                                                                                           |
| `assessment`     | Required object: `status` (`unresolved`, `hypothesis`, `source-supported`, `user-confirmed`) and `conclusion` (1..5,000 characters). State which claim has that status. |
| `sections`       | Optional array of up to 50 section objects; defaults to `[]`.                                                                                                           |
| `sources`        | Optional array of up to 200 cited source objects with unique IDs; defaults to `[]`.                                                                                     |
| `screenshots`    | Optional array of up to 50 cited local PNG/JPEG image objects with unique IDs; defaults to `[]`. Do not imply screenshot evidence when empty.                           |
| `limitations`    | Optional array of up to 50 strings (1..2,000 characters each); defaults to `[]`. Include unknown times, coverage gaps, uncertain assertions and incomplete QA.          |

## Sections

Each section requires `heading` (string, 1..200 characters); `paragraphs` (up to 50 strings, 1..10,000 characters each), `bullets` (up to 100 strings, 1..2,000 characters each) and `table` are optional. A table has `headers` (1..12 strings, 1..200 characters each) and `rows` (up to 500 arrays of strings, up to 2,000 characters per cell). Match row/header lengths. Keep exact amounts, contract addresses and transaction identifiers as strings: never round integers through floating point. Cite source IDs and screenshot IDs in the narrative/captions so each material claim has a traceable source. Do not add hidden HTML, scripts or untrusted instructions.

The manifest is a curated report input, not an automated proof engine. A `caseFile` reference does not make every paragraph derived from that case. Audit written assertions against the research ledger and source snapshots. Match the subject address and declared chain scope to the optional case, and keep case identity in the ledger. Do not mix cases. Every cited source/evidence ID must resolve; do not invent missing case, source or image links. Apply the exporter’s actual count/character/image-byte/pixel limits rather than treating this reference as an unbounded schema.

## Sources

Each source contains:

- `id`: unique string matching `[A-Za-z0-9_-]{1,32}`, for example `S1`.
- `title`: descriptive string.
- `type`: `explorer`, `company`, `social`, `case`, `user-provided` or `other`.
- `url`: optional HTTP(S) source URL; omit when unavailable, and state that limitation. Never use credentials or private session tokens in a URL.
- `observedAt`: optional known ISO UTC observation time ending in `Z`, not a timezone offset.
- `publishedAt`: optional known ISO UTC publication time ending in `Z`. All timestamps require a real calendar date; fractional seconds are optional (1..3 digits).

Do not replace unknown publication/observation times with report preparation or upload time. Keep retrieval dates, query failures and original wording in the private ledger/sections; do not invent extra schema keys. Company declarations, platform metadata, on-chain records and user confirmation remain separate sources and claims.

## Screenshots

Each image contains:

- `id`: unique string matching `[A-Za-z0-9_-]{1,32}`, for example `E1`.
- `path`: unique relative path to the final privacy-reviewed PNG/JPEG, resolved from the manifest directory or explicit bundle root. Remote image URLs are not supported.
- `caption`: descriptive string identifying original capture, user-supplied evidence or derived figure, what the image shows, applicable UTC time/unknown status and crop/redaction disclosure.
- `sourceId`: an existing source ID, for example `S1`; place the exact public source URL in that source record.
- `capturedAt`: optional original ISO UTC capture time, or `null` when unknown. A fresh crop does not change original capture time.
- `redactions`: optional array of up to 20 strings (1..500 characters each) describing each crop/redaction, or an empty array when none. The exporter does not perform redaction; prepare and inspect safe images before invocation.

Verify each file is actually a decodable PNG/JPEG with consistent extension/content, bounded dimensions/pixels and file size; renaming SVG or arbitrary bytes to `.png` is not allowed. Avoid embedded active content or external relationships; DOCX images must remain local embedded media, never remote relationships.

Preserve the original capture privately, but embed only the approved crop/redacted version. Do not automatically embed user-uploaded chats. Prefer fresh public-source screenshots; disclose provenance and uncertainty. Never fabricate proof images or infer nationality/ethnicity from names. A screenshot is a source observation, not independent confirmation of its subject.

## Bounds, dependencies and emitted inventory

The manifest is at most 1,000,000 bytes; a case at most 5,000,000 bytes; each PNG/JPEG at most 8,000,000 bytes, 12,000 pixels per side and 40,000,000 pixels total. Across all screenshots, decoded pixels are capped at 200,000,000 and input image bytes at 64,000,000. The strict JPEG decoder also has a 512 MB decode-memory budget. PNG chunk/scanline validation and strict JPEG decoding run before embedding; the PDF renderer additionally checks browser-decoded dimensions. Validation preserves original image bytes and hashes and does not authenticate source content. Source/image IDs are unique within their arrays; every screenshot `sourceId` must exist. Unknown object keys are rejected. Source URLs must be HTTP(S) without userinfo or credential-like query/fragment keys. A supplied case root must match the subject; verify declared chain scope separately.

The exporter computes SHA-256 for manifest, optional case and every image and reads PNG/JPEG dimensions. Detailed mode emits Evidence inventory plus full figure metadata; keep that audit output in a separate private appendix. Brief mode should show only the concise narrative and short source/capture captions, with no checksum inventory. It embeds exact input image bytes, scales display down only, and writes no checksum sidecar. Compute final output hashes separately. Every CLI brief format needs installed project dependencies, `@playwright/test` and local Chromium/Google Chrome for the rendered gate. Detailed HTML/DOCX remain browser-independent; detailed PDF needs the browser. The renderer never downloads a browser, disables JavaScript, runs offline and aborts network requests. Missing-browser instructions are not permission to install automatically.

## Files, checksums and validation

Keep manifest, case, source ledger, original captures, final images, checksum inventory and reports under `.local/investigations/<case>/`. Hash original and derived images separately. Compute input/output SHA-256 and retain them with the source inventory; do not add hash fields to this v1 manifest unless a later documented schema supports them. Preserve all input bytes and refuse output aliases of any input, even when `--force` is requested.

The CLI is `node scripts/report-document.ts --manifest PATH --output PATH [--format pdf|docx|html] [--bundle-root DIR] [--brief] [--force]`, where output extension is `.pdf`, `.docx` or `.html`. The extension determines format; explicit `--format` must agree with it. `--force` is explicit replacement authorization for an existing report, never for a case, manifest or image. Rendering is local/offline; no remote fetches, paid APIs or external publication. See [investigation-reports](exporting.md) for actual export and inspection behavior.
