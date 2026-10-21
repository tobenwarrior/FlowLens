# License decision — AGPL-3.0-only

FlowLens is licensed under the [GNU Affero General Public License, version 3](../LICENSE), SPDX identifier `AGPL-3.0-only`. The owner selected it on 21 October 2026. Copyright © 2026 tobenwarrior.

## Why AGPL rather than a permissive license

FlowLens is meant to be a free, open replacement for paywalled wallet-tracking tools. Under MIT or Apache-2.0, which this document previously compared, anyone could take the code, add a hosted layer and sell a closed version of it. AGPL-3.0 section 13 closes that path: anyone who runs a modified FlowLens and lets people use it over a network must offer those people the corresponding source. Hosted and paid forks have to stay open.

The cost is real and accepted: some companies will not embed or contribute to AGPL code, and FlowLens cannot be folded into proprietary products.

`-only` fixes the terms to version 3. `AGPL-3.0-or-later` would let downstream users adopt any future version the Free Software Foundation publishes. As copyright holder, the owner can still relicense their own code later.

## Dependency compatibility

Checked on 21 October 2026 against `package-lock.json`: all 21 distributed (non-dev) packages are MIT (17), Apache-2.0 (3) or ISC (1). Each can be combined into an AGPL-3.0 work; Apache-2.0 is compatible with version 3 in that direction.

Re-check whenever a production dependency is added. GPL-2.0-only, SSPL, BUSL, non-commercial and proprietary licenses are not compatible. Development-only tooling is not distributed with the application, but bundled builds should be re-audited separately — see [third-party notices](../THIRD_PARTY_NOTICES.md).

## What the code license does not cover

The license covers FlowLens's own code and original synthetic examples. It does not grant rights to provider responses, third-party label sets (including Arkham's), user notes, private investigations, or label packs anyone builds with the tool. Public availability of a blockchain record does not resolve a provider dataset's terms.

## How it is enforced

`scripts/release.mjs` refuses to build a source export unless:

- `package.json` declares exactly `AGPL-3.0-only`;
- `package.json` keeps `private: true` — publishing to npm is a separate decision that has not been made;
- `LICENSE` is byte-identical to the canonical text from <https://www.gnu.org/licenses/agpl-3.0.txt> (SHA-256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`). `.gitattributes` pins it to LF so checkouts on any platform keep that hash.

Tests in `tests/release.test.ts` pin each refusal.
