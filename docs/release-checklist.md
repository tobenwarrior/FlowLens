# Release checklist

This prepares a source handoff for the owner. It does not create a remote, commit, push, publish, deploy, configure global clients or choose a project license.

## Local checks

Use Node 24 or newer and the checked-in lockfile:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run format:check
npm run build
npm run release:check
npm run release:source
```

The CI file checks the same source on Node 24 and 26 after the owner pushes to GitHub. It grants read-only repository contents permission and does not upload or publish artifacts. The workflow has been authored locally; that does not mean a GitHub Actions run has occurred. The configuration follows the official [setup-node guidance](https://github.com/actions/setup-node) and [TypeScript ESLint quickstart](https://typescript-eslint.io/getting-started/).

Run the browser suite separately with the local production server listening at port 4319:

```sh
npm run server
# In another terminal:
FLOWLENS_URL=http://127.0.0.1:4319 npm run test:browser
```

Review desktop, tablet and phone output locally. Browser artifacts remain ignored. Provider acquisition needs separately documented checks: injected boundary tests are not live verification, and a successful public RPC request does not establish historical completeness or provider data-use rights.

Prepared and locally checked: the source allowlist/archive implementation, nine packaging regression tests, redacted credential diagnostics, owned-file lint/format checks, dependency notice texts and public documentation links. The repository hygiene audit has no blocking findings. These preparation checks do not claim that the final combined application or a hosted CI run has passed; record the full source-snapshot checks and clean-room result after concurrent implementation work ends.

Final local release checks recorded in [live-verification.md](live-verification.md):

- [x] 213/213 application tests, typecheck, lint, formatting and production build.
- [x] Production Chrome QA at desktop, tablet and phone sizes, plus acquisition UI contract checks.
- [x] Independent code review and regression fixes; runtime dependency advisory audit with zero reported vulnerabilities.
- [x] Sanitized source archive, checksums and byte-identical repeated packaging.
- [x] Fresh offline archive installation, build, lint, formatting and 213/213 tests.

Hosted CI and Node 24 remain unexecuted here. Provider acceptance is separately bounded below.

## Review the source archive

`npm run release:source` writes these files under ignored `.local/releases/`:

- `flowlens-0.1.0-source.tar.gz`: source tree plus `SOURCE_MANIFEST.json`.
- `flowlens-0.1.0-source.manifest.json`: identical manifest for review without extraction.
- `flowlens-0.1.0-source.sha256`: SHA-256 checksums of the archive and manifest.

```sh
cd .local/releases
shasum -a 256 -c flowlens-0.1.0-source.sha256
tar -tzf flowlens-0.1.0-source.tar.gz
```

The script is dependency-free. It uses an explicit reviewed file allowlist rather than Git state or directory globs. File order, file mode, ownership, tar timestamp and gzip header are normalized; the release timestamp is fixed at `2026-10-21T00:00:00.000Z`, independent of environment variables and local file dates. Identical included bytes with the same Node/zlib implementation produce identical archive bytes. The manifest hashes every original included file; it excludes its own hash to avoid recursion. The sidecar checksums cover the manifest and archive.

The archive excludes `node_modules`, `dist`, `.git`, real `.env` files, `.local` cases, artifacts/screenshots, browser output, local verification records and internal working plans. Unknown future files are excluded until explicitly reviewed and added to `scripts/release.mjs`; update the allowlist whenever a public source, test or documentation file is added. The public research summary contains links and boundaries, not private research source or cases.

The scan fails on recognized credential formats, private-key blocks, configured environment templates, suspicious quoted or environment-style credential assignments, authenticated URL query/userinfo/provider-path fields, and personal local paths. Diagnostics report only path, line and rule, never the matched value. Short explicit test doubles are permitted; realistic tokens remain rejected in tests. Symlinks, invalid UTF-8 and oversized files are rejected. This bounded scan complements human review; it cannot prove the absence of every possible secret or identify rights in data.

Extract the archive into a fresh temporary directory and run `npm ci`, the verification commands and the production build there. Compare manifests from repeated archive generation. Record the exact Node/npm versions and final test result. Do this after concurrent source work stops so the result represents one source snapshot. Archive generation itself does not run installs, invoke a shell, read credentials or contact a service.

## Owner decisions before public release

- [ ] Select the project license and copyright holder; apply its exact text and package metadata. The current archive intentionally preserves `LICENSE-DECISION.md` and [license options](license-options.md), and remains **unlicensed**.
- [ ] Confirm rights to original code, fixtures, docs, name and assets; review external contribution terms if contributions will be accepted.
- [ ] Review [third-party notices](../THIRD_PARTY_NOTICES.md) against the final lockfile. Source-only packaging excludes installed dependencies. Re-audit bundled distributions and tools separately.
- [ ] Verify that source, test fixtures, docs and history contain no private cases, credentials, proprietary labels, provider datasets or copied private source.
- [ ] Review provider terms/data rights for the intended use and clearly state which live behaviors were actually verified, with no private addresses or responses in public artifacts.
- [x] Record final source-snapshot tests, browser checks, archive checksums and clean-room install/build results; repeat for later code changes.
- [ ] Inspect the manifest and extracted tree, verify clean-room installation/build, and decide the repository destination and visibility.
- [ ] Have the owner perform the authorized GitHub push. Publication and deployment remain separate owner actions.

No npm publication is configured: `private: true` remains in `package.json`. An `.npmignore` is unnecessary for this source-only handoff and would not replace that guard or the explicit archive allowlist.

## Optional live acceptance

Source preparation does not require a configured Etherscan key, a successful Safe probe or a trace-capable public RPC. Those are separate optional acceptance checks. No Etherscan key was configured; indexed live wallet history remains unverified. The approved public Safe example probe completed with empty contract bytecode and an HTTP 200 empty history page; positive configuration and signature acceptance remain unverified. The observed public Ethereum trace method was unsupported, which establishes an explicit capability gap rather than successful live trace normalization. See [live verification](live-verification.md).

The approved public-example probe is complete. No further retry or alternate wallet, chain or endpoint is part of that acceptance check; use fixtures for additional scenarios unless their scope is separately authorized. Optional provider availability does not block generating/reviewing the unlicensed source archive; selecting the project license, confirming rights and performing the owner's eventual manual push remain separate decisions.
