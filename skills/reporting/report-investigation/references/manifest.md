# Screenshot-backed investigation manifest v1

Read [the report skill](../SKILL.md) before preparing real evidence. All paths below describe local private inputs; source URLs are citations only, never remote image-fetch requests. Input paths default to the manifest directory; explicit `--bundle-root DIR` makes case/image references relative to that confined root. Unknown keys are rejected. This is a contract reference, not a public investigation or a template filled with real addresses/brands.

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

The exporter computes SHA-256 for manifest, optional case and every image, reads PNG/JPEG dimensions, and emits Evidence inventory plus figure captions with bundle-relative paths, capture time/unknown status and redaction disclosure. It embeds exact input image bytes, scales display down only, and writes no checksum sidecar. Compute final output hashes separately. HTML/DOCX need installed project dependencies; PDF also needs `@playwright/test` and an installed local Chromium or Google Chrome. The renderer never downloads a browser, disables JavaScript, runs offline and aborts network requests. Missing-browser instructions are not permission to install automatically.

## Files, checksums and validation

Keep manifest, case, source ledger, original captures, final images, checksum inventory and reports under `.local/investigations/<case>/`. Hash original and derived images separately. Compute input/output SHA-256 and retain them with the source inventory; do not add hash fields to this v1 manifest unless a later documented schema supports them. Preserve all input bytes and refuse output aliases of any input, even when `--force` is requested.

The CLI is `node scripts/report-document.ts --manifest PATH --output PATH [--format pdf|docx|html] [--bundle-root DIR] [--force]`, where output extension is `.pdf`, `.docx` or `.html`. The extension determines format; explicit `--format` must agree with it. `--force` is explicit replacement authorization for an existing report, never for a case, manifest or image. Rendering is local/offline; no remote fetches, paid APIs or external publication. See [investigation-reports](exporting.md) for actual export and inspection behavior.
