# Contributing

This is a local project prepared for a possible open-source release. Publication and a project license remain owner decisions. See [LICENSE-DECISION.md](LICENSE-DECISION.md) before distributing or accepting external contributions.

Read the README setup instructions, [architecture](docs/architecture.md) and [release checklist](docs/release-checklist.md) first. Keep the CLI, API and human interface on the same engine contract. Add a focused test for evidence normalization, pagination or accounting changes; run the documented checks before proposing a change. UI changes need browser verification at desktop and narrow widths.

Use synthetic fixtures. Never commit real case exports, provider credentials, proprietary labels, private source or another tool's assets. Document the source and license of any third-party material. A publicly accessible blockchain response does not automatically grant redistribution rights for a provider's enrichment dataset.

Adapters must state supported chains and streams, pagination semantics, historical limits, rate controls, provenance and failure behavior. Preserve explicit incomplete coverage; a failed request is not an empty result. Avoid automatic recursive expansion. Keep budget limits visible to agents.

New attribution features must distinguish observations from hypotheses. Do not rename transfers to trades or infer ownership from common funding. Arkham access requires permission covering the intended integration; scraping and paywall circumvention are out of scope.
