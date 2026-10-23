# Contributing to FlowLens

FlowLens is an agent-first wallet tracing workspace with a human interface over the same engine. A contribution should make the evidence easier to obtain, resume or assess without weakening its meaning.

FlowLens is licensed under [AGPL-3.0-only](LICENSE). Contributions are accepted under the same license: by submitting one, you agree it is licensed under AGPL-3.0-only. Any production dependency you add must be AGPL-compatible — MIT, Apache-2.0, ISC and BSD are; GPL-2.0-only, SSPL, BUSL, non-commercial and proprietary licenses are not. The [license decision](docs/license-options.md) explains why.

## Run and check a change

Read [README.md](README.md), [architecture](docs/architecture.md) and the relevant provider contract first. Run a live trace of a public wallet to see the product as people use it. The test suite is kept outside this repository; the checks below run from a clone.

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm run format:check
npm run build
npm run release:check
```

For a UI change, run the local production server and check a desktop and a narrow viewport, keyboard access, loading/error states and the evidence drawer. Use public wallets or synthetic data in screenshots, never a private investigation.

Changes to normalization, accounting, identity, pagination, persistence or a boundary that can lose evidence need focused tests in the maintainer's suite. Describe the behavior a change should keep in the pull request, so it can be tested through the shared engine or caller with bounded synthetic provider responses.

## Preserve the contract

Keep browser, CLI, API and MCP on the same domain contract. A new agent operation needs typed input/output, bounded work, coded errors, explicit coverage, provenance, resumability and a clear persistence rule. Document what happens if it is repeated or interrupted. Avoid automatic recursive graph expansion.

An adapter must state its chains and streams, pagination/frozen-window semantics, historical limits, request/rate/byte budgets, attribution source and failure behavior. Unsupported or failed coverage is not zero activity. An exhausted provider stream is not proof of complete wallet history. Live acceptance claims must name exactly what was verified.

Keep gross inflow and gross outflow separate from net. Distinguish chains and asset contracts, preserve exact raw units and stable evidence IDs, and never turn a transfer into a trade or common funding into ownership. Configuration, observed signature material, consumed authorization, bridge transport and independent beneficiary credit are distinct claims.

## Keep research and secrets private

Never commit real investigations, case exports, provider credentials, raw response captures, private research, proprietary labels, another tool's private source or copied assets. Use invented addresses/hashes/amounts and explicit synthetic provenance for public fixtures. Document the source and license of third-party material.

A public blockchain response does not automatically grant redistribution rights to provider enrichment. Arkham integration remains deferred pending suitable rights; scraping and paywall circumvention are outside scope. See [SECURITY.md](SECURITY.md) for local storage, untrusted input and private reporting boundaries.

## Prepare a reviewable contribution

Describe the concrete problem, resulting behavior, validation and remaining limits. Identify any contract, data format or dependency change. Preserve the repository's existing license decisions and user work; do not add credentials, telemetry, paid services, global agent configuration or hosted exposure as a side effect.

Use the [release checklist](docs/release-checklist.md) before proposing a public release. Source packaging uses an explicit allowlist: include new public source/test/documentation files deliberately, then inspect the archive and checksums. Keep private data and generated test artifacts excluded. Dependency notices must match the final lockfile.
