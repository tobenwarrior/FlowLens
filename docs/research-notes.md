# Research and data boundaries

Reviewed 21 October 2026. Provider capabilities and terms can change; check the linked sources before enabling a new deployment or dataset. These notes describe design constraints, not an assurance that a provider account grants redistribution rights.

## What this first slice proves

The public demo contains synthetic addresses, amounts, transaction hashes and fictional service labels. It exercises the same engine contract used by local agents and the visual workspace. It is not a live trace. Real investigations and exports belong in private local storage, outside source control.

Independent requirements research inspected existing local wallet tools as references. This project uses original implementation rather than copied private source. Reusing a design lesson does not establish the right to redistribute the underlying implementation, internal labels or case evidence.

## Transfer history

Etherscan V2 exposes address transaction and ERC-20 transfer endpoints with chain IDs, block bounds, page numbers, page sizes and sort order. A response status of zero can mean either no records or a provider error; adapters must distinguish them. The token reputation field is not transaction success. Sources: [normal transactions](https://docs.etherscan.io/api-reference/endpoint/txlist), [ERC-20 transfers](https://docs.etherscan.io/api-reference/endpoint/tokentx).

The published free plan allows three calls per second and 100,000 calls per day on selected chains. An API-supported chain is not necessarily included in a user's plan. Do not infer Base, BSC or OP history availability from Ethereum success; preserve explicit plan errors. Sources: [rate limits](https://docs.etherscan.io/rate-limits), [chain availability](https://docs.etherscan.io/supported-chains).

Blockscout's current documentation deprecates per-instance API support in favor of a keyed Universal API and identifies breaking changes during its October 2026 rollout. Old keyless instance routes are therefore not a dependable universal fallback. No new provider key was generated for this project. Source: [Blockscout APIs](https://docs.blockscout.com/devs/apis).

General RPC access alone is insufficient for efficient, complete address history. Contract transfers, internal calls, token logs, fees, NFT events and bridge messages have different evidence and indexing requirements. An exhausted page for one stream must never become a claim of complete wallet history. The current adapter's precise limitations are documented in [providers.md](providers.md).

## Attribution and Arkham

Arkham integration remains disabled. Its published API agreement restricts automated users, competing-product use, scraping and third-party redistribution. Merely supplying a key or seeing a UI label does not settle permission for an agent-oriented tracer. Any future connector needs a permission basis covering the intended use and export behavior. Source: [Arkham API agreement](https://arkm.com/api-terms-of-service).

Never scrape gated fields or bundle an Arkham label dataset. If enrichment is permitted, preserve exact wording, source, retrieval time and attribution type. Separate a reported entity label from a prediction, service classification, user note and verified public self-disclosure. An enrichment label is evidence about a source's claim; it is not proof of control.

## Investigation lessons carried into the model

- Keep gross inflows, gross outflows and net separate for each chain and asset contract. Volume is neither profit nor unique funding.
- Deduplicate event identities rather than transaction hashes; one transaction may contain several transfers.
- Treat exchange deposits, bridges, protocol contracts, issuance and burns as distinct relationships. Bound graph expansion at service hubs.
- Shared funders, similar timing and equal values do not prove common ownership. Store alternatives and unresolved joins.
- Preserve corrections and withdrawn hypotheses; an older label must not silently override newer evidence.
- The release pass adds bounded Safe configuration/history and calldata recovery, CCTP receipt acquisition, and transaction-specific trace capability checks. These preserve configuration, signature participation, bridge transport and independent credit as distinct claims. Venue trade settlement remains outside scope. See [live verification](live-verification.md) for the difference between contract tests and observed provider availability.
- Keep transaction links chain-correct, with exact raw units and source timestamps. Transfer observations must not be described as buys or sells.

No private addresses, desk labels, source credentials or historical case conclusions are included here.
