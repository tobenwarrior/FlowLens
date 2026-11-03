# Image provenance and rights notes

This index covers the tracked assets under `docs/images/`. It documents sources stated in this repository and visible in the screenshots; it is not independent source authentication, a rights grant, or legal certification. Public blockchain data and permission to redistribute provider responses are separate questions. This index does not record approval of image or provider-data redistribution rights; the remaining review below applies before reusing these existing public assets.

## Wallet examples and scope

The case screenshots show one live trace of the Lido DAO treasury (Aragon Agent, `0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c`), loaded on 3 November 2026 from Blockscout's public Ethereum explorer without an API key. The trace holds three pages of the treasury's history and one page for one of its payout Safes (`0x5589…5ad6`), and the graph is filtered to transfers from 16 October to 3 November 2026. Four counterparties are hidden in the app: three that sent only small ETH amounts (under $60 per transfer at spot) and one that sent an unsolicited TENDIE token. Their transfers remain in the case and in the history view. The four entity labels were entered in the app from Lido's [deployed-contracts list](https://docs.lido.fi/deployed-contracts/), recorded as reported provider assertions; every other wallet is unlabelled. USD values are spot prices read from public Uniswap pools on 3 November 2026, not prices at each transfer's time.

These are public organisation wallets, not private investigations or evidence of personal ownership. Payout recipients appear as unlabelled addresses. On-chain history is partial and provider-bounded; labels and proximity do not establish identity, ownership, endorsement, or wrongdoing. No private case data is intended in these assets. The displayed Blockscout resume cursors are pagination state for the public example, not API keys or authentication credentials.

## Tracked assets

| Asset | Depicted content and source context | Date recorded | Remaining review |
| --- | --- | --- | --- |
| `live-desktop.png` | Lido DAO treasury trace: funding graph with Lido fee contracts, the treasury, three Easy Track payout Safes and one Safe's next hop. | Blockscout retrieval and capture: 3 Nov 2026. | Confirm rights to reproduce this provider-derived view and any marks/assets. |
| `how-start.png` | Start screen with public organization-wallet examples; no transaction history is shown. | Capture date/source retrieval: not recorded. | Confirm displayed examples are intended for public use. |
| `how-evidence.png` | Transfer evidence for the treasury's 800,000 USDT Easy Track payout. The visible provenance panel names Blockscout API v2 and shows retrieval on 3 Nov 2026. | Blockscout retrieval and capture: 3 Nov 2026. | Confirm provider-data and screenshot reuse rights. |
| `how-wallet.png` | Wallet inspector for the payout Safe `0x5589…5ad6`, beside the same graph. | Blockscout retrieval and capture: 3 Nov 2026. | Confirm displayed public-wallet example and reuse rights. |
| `how-history.png` | Evidence view for the treasury: assets, cumulative net flow, counterparties and the first page of transfers. | Blockscout retrieval and capture: 3 Nov 2026. | Confirm provider-data and screenshot reuse rights. |
| `how-coverage.png` | Coverage view for the same case, including provider/stream status and resumable pagination cursors. | Blockscout retrieval and capture: 3 Nov 2026. | Cursors are not authentication credentials; confirm the captured page/window is still intended for publication and verify provider-data reuse rights. |
| `how-agents.png` | CLI/MCP example using the ENS DAO endowment address and a generic local case-file path. | Capture date/source retrieval: not recorded per image. | Confirm example remains public and path remains generic; confirm any displayed provider-derived data rights. |
| `flowlens-logo-dark.png`, `flowlens-logo-light.png` | FlowLens logo variants; no wallet/provider data. | Creation date/source: not recorded here. | Confirm logo authorship and permission before release. |

The 0.1.0 section in `CHANGELOG.md` describes the 21 Oct 2026 release-candidate snapshot, when the documentation screenshots were described as synthetic. A later Unreleased entry recorded their replacement with ENS DAO endowment captures retrieved on 23 Oct 2026. On 3 Nov 2026 the lead, evidence, wallet, history and coverage screenshots were recaptured from the Lido trace above; exact capture dates for `how-start.png` and `how-agents.png` are unknown. Keep this chronology explicit; do not describe an older set as the current screenshot set.

## Packaging

`scripts/release.mjs` explicitly allowlists this index, seven screenshots and two logo PNGs in this directory, plus app icons. The source archive's exact-byte checksums establish archive integrity, not provenance, ownership, provider-data rights, or permission to publish.
