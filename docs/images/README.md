# Image provenance and rights notes

This index covers the tracked assets under `docs/images/`. It documents sources stated in this repository and visible in the screenshots; it is not independent source authentication, a rights grant, or legal certification. Public blockchain data and permission to redistribute provider responses are separate questions. Owner approval for original assets and provider-data use remains pending in `docs/release-checklist.md`.

## Wallet examples and scope

The UI screenshots show the public-wallet examples described in the README and CHANGELOG, chiefly the ENS DAO endowment trace. They are not private investigations or evidence of personal ownership. On-chain history is partial and provider-bounded; labels and proximity do not establish identity, ownership, endorsement, or wrongdoing. No private case data is intended in these assets. The displayed Blockscout resume cursor is pagination state for the public example, not an API key or authentication credential.

## Tracked assets

| Asset | Depicted content and source context | Date recorded | Remaining review |
| --- | --- | --- | --- |
| `live-desktop.png` | ENS DAO endowment live trace. README states it was loaded from Blockscout's public explorer without an API key. | Provider retrieval: 23 Oct 2026 (README caption). Screenshot capture date: not recorded. | Confirm rights to reproduce this provider-derived view and any marks/assets. |
| `how-start.png` | Start screen with public organization-wallet examples; no transaction history is shown. | Capture date/source retrieval: not recorded. | Confirm displayed examples are intended for public use. |
| `how-evidence.png` | Transfer-evidence view from the public example set. The visible provenance panel names Blockscout API v2 and shows retrieval on 23 Oct 2026. | Evidence retrieval: 23 Oct 2026 (visible in image). Screenshot capture date: not recorded. | Confirm provider-data and screenshot reuse rights. |
| `how-wallet.png` | Wallet inspector and flows from the public example set. | Capture date/source retrieval: not recorded per image. | Confirm displayed public-wallet example and reuse rights. |
| `how-history.png` | Evidence/history view from the public example set. | Capture date/source retrieval: not recorded per image. | Confirm provider-data and screenshot reuse rights. |
| `how-coverage.png` | Coverage view for the public example, including provider/stream status and a resumable pagination cursor. | Capture date/source retrieval: not recorded per image. | Cursor is not an authentication credential; confirm the captured page/window is still intended for publication and verify provider-data reuse rights. |
| `how-agents.png` | CLI/MCP example using the public example wallet and a generic local case-file path. | Capture date/source retrieval: not recorded per image. | Confirm example remains public and path remains generic; confirm any displayed provider-derived data rights. |
| `flowlens-logo-dark.png`, `flowlens-logo-light.png` | FlowLens logo variants; no wallet/provider data. | Creation date/source: not recorded here. | Confirm logo authorship and permission before release. |

The 0.1.0 section in `CHANGELOG.md` describes the 21 Oct 2026 release-candidate snapshot, when the documentation screenshots were described as synthetic. The later Unreleased entry records the replacement with public-wallet examples. The lead screenshot's Blockscout retrieval date is 23 Oct 2026; exact capture dates for the other images are unknown. Keep this chronology explicit; do not describe the older synthetic set as the current screenshot set.

## Packaging

`scripts/release.mjs` explicitly allowlists seven screenshots and two logo PNGs in this directory, plus app icons. The source archive's exact-byte checksums establish archive integrity, not provenance, ownership, provider-data rights, or permission to publish. Add this index to the reviewed source allowlist before producing a source archive that links to it.
