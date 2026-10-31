<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/flowlens-logo-dark.png" />
    <img src="docs/images/flowlens-logo-light.png" alt="FlowLens" width="360" />
  </picture>
</p>

<p align="center">
  <strong>Follow the funds. Keep the evidence.</strong><br />
  Open-source EVM wallet tracing, built for people and their agents.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#what-it-can-do-today">Features</a> ·
  <a href="#use-it-from-an-agent">Agents</a> ·
  <a href="#documentation">Documentation</a>
</p>

![FlowLens funding graph showing the ENS DAO endowment, counterparties and per-asset flows](docs/images/live-desktop.png)

_ENS DAO endowment example, loaded from Blockscout without an API key on 23 October 2026. Screenshots use public-wallet examples, not private investigations. [Sources and scope](docs/images/README.md)._

## Why FlowLens

Blockchain data is public. Your investigation should stay under your control.

- **Local-first.** Run on your computer; keep cases, notes and labels local. No telemetry.
- **Evidence you can inspect.** Open a connection to see the transfers, exact amounts, source and transaction links behind it.
- **Coverage you can see.** Missing streams, partial history and provider errors stay visible.
- **Human and agent workflows.** Use the visual workspace, JSON CLI, local HTTP API or stdio MCP server (22 stdio MCP tools).
- **Free and open source.** AGPL-3.0-only. No wallet connection, signing or custody.

## Get started

Requires **Node.js 24.12+** and a modern browser.

```sh
git clone https://github.com/tobenwarrior/FlowLens.git
cd FlowLens
npm ci --ignore-scripts
npm run build
npm start
```

The `start`, `server`, `cli` and `mcp` npm scripts load an optional repository `.env` when present. Direct `node` examples below use `--env-file-if-exists=.env`, so keyless users can omit the file or provide the same variables in their local environment.

Open **http://127.0.0.1:4319**, paste an Ethereum address and select **Trace wallet**. You can also choose a public example from the start screen.

Ethereum (1) and Derive Chain (957) can use the keyless legacy Blockscout routes. Base first uses an operator-run Blockscout instance when `FLOWLENS_BASE_BLOCKSCOUT_URL` is configured; otherwise it can use the optional Alchemy Transfers route when `ALCHEMY_API_KEY` is present, followed by unified hosted Blockscout with `BLOCKSCOUT_API_KEY`. Robinhood Chain (4663) is available only through the user-local keyed unified Blockscout route when explicitly expanded. Hosted account plans can restrict chain access. On 31 October 2026, a request from one free-tier account returned HTTP 402 and the response requested Builder, Business or Pro access; this records that account response, not tested paid-tier eligibility. The server listens on your computer only; do not expose the unauthenticated API to an untrusted network.

## What it can do today

| Capability        | What you get                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Funding graph     | Follow incoming and outgoing transfers; expand one wallet at a time, filter, group, pin or hide nodes.              |
| Wallet analysis   | Per-asset gross inflow, outflow and net; ranked counterparties, transfer history and cumulative net-flow charts.    |
| Evidence          | Exact raw amounts, transaction hashes, blocks, UTC timestamps, token contracts and provider provenance.             |
| Labels and cases  | Save investigations, add sourced labels and notes, and export or reopen case JSON.                                  |
| USD prices        | Optional current values from Uniswap V3 over public RPC; historical prices with your Etherscan key.                 |
| Protocol evidence | Bounded Safe reads, Circle CCTP bridge transactions and single-transaction call traces, separate from graph totals. |
| Reports           | Agent workflows for source-cited PDF, Word and HTML reports with reviewed screenshots.                              |

### Supported history sources

| Network      | Chain ID | Default history source                                                                                  | API key                                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Ethereum     | 1        | Legacy Blockscout: native, ERC-20 and internal transfers; Etherscan can be selected                    | None for legacy Blockscout; optional `ETHERSCAN_API_KEY` selects the legacy two-stream route |
| Derive Chain | 957      | Legacy Blockscout: native, ERC-20 and internal transfers                                                | None; `FLOWLENS_BLOCKSCOUT=off` disables this route                                     |
| Base         | 8453     | Self-hosted Blockscout when configured; otherwise Alchemy Transfers, then unified hosted Blockscout: native, ERC-20 and internal transfers | Optional loopback `FLOWLENS_BASE_BLOCKSCOUT_URL` (no API key); otherwise `ALCHEMY_API_KEY` or `BLOCKSCOUT_API_KEY`; hosted plan controls access |
| Arbitrum One | 42161    | Unified Blockscout API when configured; Etherscan legacy route remains available                        | `BLOCKSCOUT_API_KEY` or optional `ETHERSCAN_API_KEY`; configured capability is not a complete-history guarantee |
| HyperEVM     | 999      | Keyless HypurrTrace indexed history                                                                     | None; `FLOWLENS_HYPURRTRACE=off` disables this route                                    |
| Robinhood Chain | 4663   | Unified hosted Blockscout only when explicitly expanded: native, ERC-20 and internal transfers        | `BLOCKSCOUT_API_KEY` only; no keyless FlowLens history route; `FLOWLENS_BLOCKSCOUT=off` disables it |

An Etherscan key selects the legacy Etherscan route for Ethereum or Arbitrum. It reads native and ERC-20 streams only; it does not provide internal transfers, and it does not cover Base or Robinhood Chain. On Base, a configured self-hosted endpoint takes precedence, then `ALCHEMY_API_KEY`, then keyed hosted Blockscout. Robinhood Chain stays on keyed unified Blockscout and is reached only by explicitly expanding chain 4663. No self-hosted or Alchemy key is bundled, and offline adapter tests do not establish live index readiness, plan eligibility, quotas or complete coverage. Derive stays on legacy Blockscout. Provider selection, self-hosting, plan restrictions and coverage limits are described in [Provider coverage and limits](docs/providers.md).

HyperEVM history is indexed by HypurrTrace (`hypurrtrace-indexed`), with a default page size of 10 and a maximum of 100. It includes native transfers whose transaction status is successful, indexed ERC-20 transfer logs, and internal value transfers checked against the provider's full call trees. It does not include NFTs, gas fees or labels. A frozen index fence and a 10,000-provider-row bound keep coverage explicit; reaching the bound is partial coverage, not complete history.

Derive subaccount collateral, positions and trades are not wallet transfers; a wallet trace does not reconstruct those balances or trading activity. The standalone Derive inspector can read one public account association, margin snapshot or bounded trade page.

> **A trace is evidence of movement, not proof of ownership.** Gross flow is not profit. Loaded history is partial, and labels or shared counterparties do not establish who controls a wallet.

## How it works

1. **Start with a wallet.** Load the newest Ethereum history page, then use **Expand wallet** to query a supported network explicitly. FlowLens does not automatically discover every chain where an address has activity.
2. **Inspect the evidence.** Select a connection or wallet to examine individual transfers and per-asset flows. Filter by network, asset, direction or date; filters never fetch more history.
3. **Check coverage and save.** Review **Sources & coverage** for loaded streams, missing data and resume cursors. Add notes or labels, then save or export your case.

For a new investigation, check each relevant network in the source table and continue its saved pagination until its provider stream is exhausted or a limit is reported. `collect` below can load a bounded batch of pages; repeat it to continue after `budget-reached`. An error needs review before another attempt. An exhausted stream describes what that provider returned within its saved window; it does not certify all-chain completeness. HyperCore has its own ledger operation and coverage.

<details>
<summary><strong>Explore the workspace</strong> — screenshots</summary>

### Start a trace

![Address entry and public organization-wallet examples](docs/images/how-start.png)

### Inspect a connection

![Transfer evidence with exact amounts, transaction identity and provider provenance](docs/images/how-evidence.png)

### Follow a wallet

![Wallet inspector with per-asset flows and expansion controls](docs/images/how-wallet.png)

### Review history

![Asset flows, counterparties and filterable transfer history](docs/images/how-history.png)

### Understand coverage

![Loaded provider streams, partial coverage and resumable cursors](docs/images/how-coverage.png)

### Connect an agent

![CLI and MCP interfaces for creating, expanding and inspecting cases](docs/images/how-agents.png)

</details>

## Use it from an agent

The CLI, local HTTP API and stdio MCP server share the same evidence engine and case store.

### CLI

Each command returns JSON. When invoking Node directly, include `--env-file-if-exists=.env` so an optional user-local key or switch is loaded:

```sh
node --env-file-if-exists=.env server/cli.ts create --mode live --title "ENS DAO endowment" \
  --address 0x4F2083f5fBede34C2714aFfb3105539775f7FE64 --file .local/endowment.json
node --env-file-if-exists=.env server/cli.ts expand --file .local/endowment.json \
  --address 0x4F2083f5fBede34C2714aFfb3105539775f7FE64 --chain 1 --pages 1
node --env-file-if-exists=.env server/cli.ts inspect --file .local/endowment.json
```

Use `--chain 957` to expand on Derive. `create` will not overwrite a case; resume it with `expand` or `inspect`. Exit code `2` means a provider failed; retained evidence and coverage explain what was loaded.

For an explicit bounded collection, use `collect` against one existing case file and one wallet/chain:

```sh
node --env-file-if-exists=.env server/cli.ts collect --file .local/endowment.json \
  --address 0x4F2083f5fBede34C2714aFfb3105539775f7FE64 --chain 1 --pages 10 --page-size 10
```

It saves each committed page, stops at provider errors, quota, access or evidence budgets, and does not retry, fall back or fan out to counterparties. The case retains up to 2,000 nodes and 20,000 transfers within the existing 5 MB snapshot bound; the human graph is a projection of the focus wallet plus at most 80 counterparties.

Reuse the command with the appropriate `--chain` from the source table for each network you want to check. `inspect` reports saved coverage and cursors. After loading transfers, add a label with its source, observation date and confidence; a counterparty relationship alone does not identify an owner. The [label guide](docs/workspace-controls.md#attach-or-edit-a-label) covers annotations, and the [shared catalogue guide](data/README.md) covers reviewing selected labels for publication.

### MCP

Launch `node --env-file-if-exists=.env server/mcp.ts` from your MCP host and start with `flowlens_status`. The [MCP guide](docs/mcp.md) covers setup and all 22 tool contracts.

`flowlens_hypercore` and `POST /api/hypercore` read one bounded HyperCore non-funding ledger page. Without a case ID they are explicit caller-scoped reads; with a live case ID they persist `protocolEvidence.hypercore` and resume its frozen provider window without changing EVM transfers or totals. See [Provider coverage and limits](docs/providers.md) for the separate retention boundary.

Cases live in `.local/cases`; labels in `.local/labels.json`. For an MCP host that launches outside the repository, set absolute `FLOWLENS_DATA_DIR` and `FLOWLENS_LABEL_FILE` paths. The standard HTTP server uses `.local/cases` relative to the repository; `FLOWLENS_DATA_DIR` does not relocate its storage. Run `npm start` from the repository root.

### Investigation skills

| Workflow                                                             | Purpose                                                                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Trace a wallet](skills/investigation/trace-wallet/SKILL.md)         | Follow funding, classify counterparties and build an attribution case with explicit uncertainty.                                                     |
| [Review a cluster](skills/investigation/cluster-wallets/SKILL.md)    | Examine dedicated deposit-address leads; stop indiscriminate expansion through pooled exchanges. Bounded review, not automatic ownership clustering. |
| [Audit evidence](skills/investigation/audit-trace-evidence/SKILL.md) | Check event identity, provenance, coverage gaps and what a conclusion actually establishes.                                                          |
| [Create a report](skills/reporting/report-investigation/SKILL.md)    | Turn reviewed evidence and screenshots into cited PDF, Word or HTML documents.                                                                       |

Start at the [skill index](skills/README.md), or read the [tracing method](skills/investigation/trace-wallet/references/tracing-method.md).

## Privacy

**Local-first does not mean offline.** Requested identifiers go to the services needed to answer your query:

- **Wallet history:** legacy Blockscout on Ethereum and Derive; an operator-run loopback Blockscout, optional Alchemy Transfers or keyed unified Blockscout on Base; keyed unified Blockscout on Arbitrum and Robinhood Chain; Etherscan remains an optional legacy Ethereum/Arbitrum route. HypurrTrace provides keyless HyperEVM history.
- **USD prices:** public Ethereum RPC and, for historical prices, Etherscan. Lookups run when you select **Load USD prices**.
- **Protocol reads:** fixed public RPC and protocol services, only when requested.
- **Derive inspection:** the public Derive API receives the submitted wallet address or subaccount ID.

Cases and browser storage are **not encrypted**. Exports can contain sensitive research; review them before sharing. Set `FLOWLENS_BLOCKSCOUT=off` to disable all Blockscout history routes, including the self-hosted Base route and keyed unified Base/Arbitrum/Robinhood routes; Derive history is then unavailable. This switch does not disable an independently configured Alchemy Base route. `FLOWLENS_BASE_BLOCKSCOUT_URL`, `BLOCKSCOUT_API_KEY` and `ALCHEMY_API_KEY` stay in the user-local server environment and are never accepted from API/MCP callers or written to cases, reports or logs. See [SECURITY.md](SECURITY.md).

### Optional Etherscan key

Copy `.env.example` to `.env`, add your Etherscan V2 key, then start the server with:

```sh
node --env-file-if-exists=.env server/index.ts
```

The key stays server-side and is never sent to the browser. Keys and private case files do not belong in Git.

### Optional Blockscout key

Set `BLOCKSCOUT_API_KEY` in the same user-local `.env` file to enable the unified Blockscout API for Base, Arbitrum and explicitly expanded Robinhood Chain (4663). A key is required even for the free tier, and account plans can restrict individual chains; FlowLens does not create keys, upgrade plans or promise hosted coverage. See Blockscout's [first-call setup](https://docs.blockscout.com/make-your-first-call) and [official setup documentation](https://docs.blockscout.com/setup).

### Optional Alchemy Base key

Set `ALCHEMY_API_KEY` in the same user-local `.env` file to select the bounded Alchemy Transfers adapter for Base (8453) when no self-hosted Base endpoint is configured. A free account may be usable, but Alchemy controls quotas and plan access; no live key is bundled or verified by this repository. See the official [Alchemy Transfers API reference](https://www.alchemy.com/docs/reference/alchemy-getassettransfers).

### Optional self-hosted Base Blockscout

Set `FLOWLENS_BASE_BLOCKSCOUT_URL` in the server's user-local `.env` to a loopback HTTP(S) origin such as `http://127.0.0.1:4010`. The value may use `127.0.0.1` or `[::1]` only, with no path, query, fragment or credentials. A remote indexer can stay on its own loopback and be reached through an SSH tunnel; FlowLens still uses the local loopback URL. This route needs no API key, and no URL input is exposed through HTTP or MCP. It is selected for Base before Alchemy and hosted keyed Blockscout when `FLOWLENS_BLOCKSCOUT` is not `off`. Readiness checks run before every history page, but the API cannot prove genesis range configuration or archive completeness. See the [self-hosted Base deployment guide](docs/self-hosted-base.md) and [provider contract](docs/providers.md#self-hosting-blockscout).

### Optional keyless Base transaction traces

Set `FLOWLENS_BASE_RPC_PROVIDER=blockmachine` in the user-local server environment to use Blockmachine's fixed public Base RPC for targeted protocol acquisition. The default remains PublicNode. This option needs no key and can recover internal ETH movements for a **known transaction hash** when the public service retains its historical trace. Heavy trace requests are paced, rate limits remain visible, and nothing retries or changes providers automatically. Public archive access is best effort. This option does not enumerate an unknown wallet's complete Base history; that still needs an accessible history index such as the self-hosted deployment above. See [RPC coverage](docs/rpc-provider.md).

### Tracing after a third-party trial

Wallet-history discovery, known-transaction verification and saved-case review are separate capabilities. A saved transaction can remain reviewable after a trial ends while a new wallet still needs an accessible index. Check the per-chain provider and stream coverage before following a lead. Provider exhaustion, a matching benchmark or a larger transfer count does not establish complete history. Native transfers, ERC-20 logs, internal calls, NFTs, failed transactions, fees and protocol accounting have different scopes; current omissions are documented in [provider coverage](docs/providers.md). FlowLens retains small loaded transfers without a USD filter, but it cannot recover a transfer that its source never returned.

## Documentation

- [Provider coverage](docs/providers.md) — networks, streams, pagination and limits.
- [Self-hosted Base deployment](docs/self-hosted-base.md) — preparation packet for an operator-run Blockscout backend.
- [MCP guide](docs/mcp.md) — agent setup and tool contracts.
- [Workspace controls](docs/workspace-controls.md) — labels, notes and wallet visibility.
- [Protocol acquisition](docs/acquisition.md) — bounded Safe, CCTP and call-trace workflows.
- [Investigation reports](docs/investigation-reports.md) — report bundles, screenshots and document exports.
- [Architecture](docs/architecture.md) — the shared engine and evidence boundaries.

## Roadmap

- Broader EVM history coverage, through explorers and providers that support it.
- Better tracing and attribution methods as we learn, with evidence and uncertainty kept explicit.

Missing a network or tracing workflow? [Open an issue](https://github.com/tobenwarrior/FlowLens/issues).

## Shared wallet labels

Clones receive the reviewed, tracked catalogue in
[`data/wallet-labels.json`](data/wallet-labels.json); its format, rights-review policy
and preparation workflow are documented in [`data/README.md`](data/README.md). The
catalogue is currently empty, bounded to 50,000 entries and 5 MB, and read-only at
runtime. Private `.local` labels and
investigation cases stay local, override a shared label when present, and are never
published by tagging or annotation.

## Develop and contribute

Keep `npm start` running for the API, then run `npm run dev` in a second terminal and open **http://127.0.0.1:4318**.

```sh
npm run lint
npm run typecheck
npm run format:check
npm run skills:check
npm run labels:check
npm test
npm run build
npm run release:check
```

`npm test` always runs offline synthetic smoke checks. A local ignored `tests/` suite runs when present; tests do not certify live-provider availability or complete history.
`npm run labels:check` strictly validates the tracked shared wallet-label catalogue;
`npm run build` runs that check before compiling the application.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing evidence behavior or preparing a release.

## License

**AGPL-3.0-only** · Copyright © 2026 tobenwarrior. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

Modified versions offered over a network must provide corresponding source under AGPL section 13. The code license does not grant rights to provider data, third-party labels or private investigations.
