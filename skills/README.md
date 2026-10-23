# FlowLens skills

Read the entry for the question in hand, then only its relevant references.
Agent procedures live here; architecture, provider specifications and API/data contracts stay in `docs/`.

| Task | Entry |
| --- | --- |
| Gather transfers, funding and attribution evidence | [Trace a wallet](investigation/trace-wallet/SKILL.md) |
| Follow a CEX deposit-address or shared-control lead | [Cluster wallet evidence](investigation/cluster-wallets/SKILL.md) |
| Challenge completeness, claims and false joins | [Audit trace evidence](investigation/audit-trace-evidence/SKILL.md) |
| Prepare a cited PDF, Word, HTML or Markdown report | [Report an investigation](reporting/report-investigation/SKILL.md) |

## Structure and maintenance

- [Investigation](investigation/README.md): acquisition, relationship hypotheses and evidence review.
- [Reporting](reporting/README.md): reviewed claims, screenshots, provenance and exports.
- Every skill text file, including references, indexes, examples and helpers, is limited to **200 logical lines and 25 KiB**. Split by topic and link the continuation before reaching either cap.
- Do not minify prose, glue words or remove useful spacing to fit. A short entry routes to focused reference files rather than copying a complete manual.
- Run `npm run skills:check` after edits. `npm run release:check` enforces the same guard, and its explicit allowlist must include new public methodology files.
- Keep real cases, private vault notes, labels, screenshots and generated reports under `.local/`, not in these files or fixtures.
- Generic methods may be learned from authorized research notes; do not copy private case identifiers, counterparties or financial figures into public skills.

Clustering here is an evidence-review workflow, not an automatic ownership engine. Graph category grouping is presentation only. A candidate account relationship is not a verified common controller or owner.
