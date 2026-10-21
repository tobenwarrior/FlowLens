# Flowlens

**Follow the flow. Keep the evidence.**

A local EVM tracing workspace for agents and investigators. A typed evidence engine powers both a JSON CLI/API and an original interactive graph. No account, wallet connection, paid service, or key is needed to explore the synthetic demo.

This is a first vertical slice, prepared for source review. **No project license has been chosen and nothing has been published.** See [the release decision](LICENSE-DECISION.md) before redistribution.

## Run locally

Requires Node.js **24+**, npm, and a modern browser. Developed and verified on macOS with Node 26.8.1.

```sh
npm ci
npm run build
npm run server
```

Open **http://127.0.0.1:4319**. The server binds to loopback only. It serves the built app and the local API; no public deployment is needed.

For development, keep `npm run server` running and start `npm run dev` in a second terminal. Open **http://127.0.0.1:4318**. Vite proxies `/api` to port 4319. Demo mode also works without the API, with browser persistence and JSON export.

The initial Northstar case is **entirely synthetic**: invented addresses, hashes, amounts, labels and timestamps. Ethereum and Base are illustrative fixture networks. Synthetic transactions have no explorer links and cannot enter live cases.

## What works

- Directional funding paths, wallet selection, counterparty expansion, zoom/pan, pin/hide/restore, and category arrangement.
- Network, contract-specific asset, UTC time and focus-wallet direction filters; accessible evidence list for narrow screens.
- Gross inflow, gross outflow and net in exact integer units, separated by chain and asset contract. The summary explicitly identifies the selected asset scope; it is never a combined USD valuation.
- Evidence drawer with raw amounts, transaction/event identity, UTC timestamp, block, provider, retrieval time, and chain-correct live explorer links.
- Provenance-aware label records: source, kind, qualitative confidence and retrieval time. Shared funders, labels and transfers never prove ownership or a trade.
- Explicit incomplete coverage and source errors, one-wallet expansion budgets, frozen live windows, cursor resume and duplicate-event protection.
- Saved browser cases/notes, validated JSON import/export, durable API/CLI files, atomic page commits, writer locks and stale-save protection.

Grouping currently arranges wallets by service category; arbitrary named clusters and free node dragging are future work. Pinning prioritizes a node's position. Filters affect loaded evidence; they do not silently fetch a missing date range. Direction filters refer to the investigation's focus wallet.

## Agent quick start

The CLI works directly against the same engine, without a browser or running HTTP server. It prints JSON to stdout; operational errors go to stderr. Use `node` directly, or `npm run --silent cli -- …`, when parsing output.

```sh
node server/cli.ts status
node server/cli.ts schema
node server/cli.ts create --mode demo --file .local/demo.json
node server/cli.ts inspect --file .local/demo.json
node server/cli.ts expand --file .local/demo.json \
  --address 0x1111111111111111111111111111111111111111 --chain 1 --pages 1
node server/cli.ts graph --file .local/demo.json --chain 1 --direction in
node server/cli.ts export --file .local/demo.json
```

`evidence --file PATH --id EVIDENCE_ID` returns one canonical transfer. `graph` accepts `--asset CHAIN:CONTRACT` (or `CHAIN:native`), `--from YYYY-MM-DD`, and `--to YYYY-MM-DD`. Amounts in machine outputs are raw integer strings plus asset decimals. See `help` for flags.

Exit codes: `0` operation succeeded (coverage may still be partial), `1` invalid/unavailable operation, `2` create/expand saved a case containing a coverage error. Always inspect `coverage`, including with HTTP 200. Retry only after resolving the cause; the last committed cursor is retained.

## MCP and protocol replay

Run `node server/mcp.ts` (or `npm run --silent mcp`) from an MCP client. stdout is protocol-only. There are 12 typed tools for availability/schema, case discovery, create/inspect/expand, evidence lookup, graph pages, import/export, replay and bounded acquisition through `flowlens_acquire`. Set `FLOWLENS_DATA_DIR` to the API's `.local/cases` directory to share investigations. [docs/mcp.md](docs/mcp.md) contains a client configuration example; installing it into global settings is an owner choice and has not been performed.

Safe, bridge and internal-trace **supplied-evidence replay** needs no account or key:

```sh
# Inspect a sanitized synthetic replay without modifying a case:
node server/cli.ts replay --fixture protocols-v1
# Keep it with the existing synthetic case:
node server/cli.ts replay --fixture protocols-v1 --file .local/demo.json
# Explicitly supplied private JSON; never copied to public fixtures:
node server/cli.ts replay --protocol-file /PRIVATE/PATH/protocol-evidence.json
```

The UI's **Protocol evidence** drawer can import the same bundle, inspect provenance, and keep it with a case. Optional `protocolEvidence` survives case JSON export/import. Demo accepts synthetic replay; live/private cases accept private replay. Indexed transfer counts/graph totals remain unchanged; replay is a separate projection.

- [Safe evidence](docs/safe-evidence.md) separates genesis/current/historical configured owners and threshold from observed signature material, module authorization and explicitly limited verification claims. Ambiguous ordering or contradictory configuration remains unresolved.
- [Bridge/internal evidence](docs/bridge-internal-evidence.md) matches exact protocol IDs and routes, preserves unmatched/ambiguous/conflicting states, reconciles amounts only with explicit asset mappings, and separates transport from independent beneficiary credit. Internal projections exclude failed, inherited, root-duplicate and impossible trace values; missing trace-provider coverage remains unavailable.

MCP `flowlens_replay` accepts exactly one `fixture: "protocols-v1"` or validated `bundle`, plus optional `caseId` to retain it. `POST /api/replay`, `POST /api/investigations/:id/replay` and `GET /api/investigations/:id/protocols` expose the same replay path over HTTP. Existing case identity (root and mode) is immutable. Imports validate claims' structure, not their truth.

## Targeted protocol acquisition

The shared acquisition service is available through CLI `acquire`, HTTP `POST /api/acquire` and MCP `flowlens_acquire`. It returns private-mode protocol evidence and can merge it into an existing live case without changing indexed transfer counts or graph totals. Demo cases reject live acquisition. See [acquisition workflows](docs/acquisition.md) for arguments and examples.

Create an empty live case with `historyMode: "evidence-only"` (CLI `--history-mode evidence-only`) when no indexed history is wanted. This creates the case without an Etherscan key or provider request and marks wallet-history coverage unsupported. A later acquisition sends only the explicitly supplied wallet or transaction identifier to fixed public services.

- Safe acquisition on Ethereum and Arbitrum One reads a frozen configuration snapshot and bounded indexed history. Optional EOA recovery checks matching direct-call calldata against a historical contract-bound digest. This narrow proof does not establish pre-execution ownership, consumed-signature participation or a configured quorum; confirmations remain separate.
- CCTP V1/V2 acquisition on Ethereum, Base and Arbitrum One inspects one known transaction, official emitter identities and exact message/asset evidence. V2 placeholder identities, unmatched routes and unverified beneficiary credit stay explicit.
- Internal acquisition requests `debug_traceTransaction` with `callTracer` for one known transaction after transaction/receipt/canonical-block checks. Unsupported capability remains unavailable. Coverage is partial and transaction scoped, including when a trace is returned.

The [fixed RPC transport](docs/rpc-provider.md) has request, time, byte and pacing limits with no automatic retry or alternate-endpoint fallback. These adapters do not enumerate complete wallet history. Live Safe availability and successful live trace normalization remain unverified; the [public verification record](docs/live-verification.md) distinguishes observed capability from injected test responses.

## Local HTTP API

```sh
curl http://127.0.0.1:4319/api/status
curl http://127.0.0.1:4319/api/schema
curl -H 'Content-Type: application/json' \
  -d '{"root":"0x1111111111111111111111111111111111111111","mode":"demo"}' \
  http://127.0.0.1:4319/api/investigations
```

| Operation                 | Method and path                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| List/get cases            | `GET /api/investigations` / `GET /api/investigations/:id`                                      |
| Expand one scope          | `POST /api/investigations/:id/expand` with `{ "address": "0x…", "chainId": 1, "maxPages": 1 }` |
| Evidence lookup           | `GET /api/investigations/:id/evidence/:encodedEvidenceId`                                      |
| Graph and flows           | `GET /api/investigations/:id/graph?chainId=1&direction=in`                                     |
| Save snapshot             | `PUT /api/investigations/:id` with validated investigation JSON and its original `updatedAt`   |
| Export                    | `GET /api/investigations/:id/export`                                                           |
| Acquire protocol evidence | `POST /api/acquire`, optionally with `caseId`, or `POST /api/investigations/:id/acquire`       |

HTTP cases live in `.local/cases`. The CLI can operate on those exact files, using the same writer locks. Browser-only demo cases live in that origin's local storage; import/export JSON moves a case between interfaces. Live UI expansion operates on the server case. Save browser notes/pins before another client needs them. The stdio MCP interface uses the same case store and engine; see [MCP setup and tool contracts](docs/mcp.md). No global client configuration is changed by this project.

## Optional live history

Use only your own existing permitted Etherscan V2 access. No credential is generated. Copy `.env.example` to an ignored `.env`, supply the key privately, then launch:

```sh
node --env-file=.env server/index.ts
```

Alternatively provide `ETHERSCAN_API_KEY` in the process environment. Never use a `VITE_` prefix. The browser receives availability only. A key in a shell command may be retained by shell history; an ignored local environment file avoids that.

An indexed live case initially loads one Ethereum page. Expand Arbitrum explicitly from the focus-wallet inspector or CLI with `--chain 42161`. This Etherscan adapter covers **native transfers and receipt-confirmed ERC20 logs**. It excludes internal calls, NFTs, fees, balances, bridge joins, Safe history, pricing, ownership and labels; targeted protocol acquisition is a separate service. Base supports the synthetic demo and targeted public RPC acquisition, but is not enabled for indexed REST history. Provider plan/access failures are explicit, not “no activity.”

Requests are paced at one per second per provider instance, with no automatic retries. A first live page can require up to 13 requests and take appreciably longer than a demo. Expansions cap at three pages and 80 graph nodes. Independent CLI processes do not share an account-wide rate limiter. History is pinned to a block window; current refresh and reorg rollback are not implemented. See [provider behavior](docs/providers.md) for cursors, errors and remaining completeness limits.

**Live account access has not been verified:** no key was configured and no real-wallet history was fetched during this build. Provider tests use injected synthetic responses. API access also does not establish commercial use or redistribution rights; full Etherscan terms could not be verified by the companion research.

Arkham enrichment is deferred. Published API terms require separate review of automation, competing-product and redistribution rights; supplying a key alone does not settle permission. The generic label model is available for permitted, provenance-preserving evidence. No scraping or proprietary dataset is included. [Research notes](docs/research-notes.md) record the sources and boundaries.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run format:check
```

With the local server/preview running and Google Chrome installed:

```sh
npm run test:browser
# Or test the built app directly:
FLOWLENS_URL=http://127.0.0.1:4319 npm run test:browser
```

Browser QA covers 1440px desktop, 834px tablet, 390px phone, filters, evidence, expansion, pin/hide, persistence, export, keyboard behavior, recoverable errors and a mocked live UI contract. Screenshots and the JSON report are written to ignored `artifacts/`. These are local QA artifacts, not a live-provider certification.

The public [live verification record](docs/live-verification.md) separates observed provider behavior from synthetic tests. Follow the [release checklist](docs/release-checklist.md) to create and inspect the sanitized source archive; local screenshots, logs and internal working records are excluded. The engine's boundaries are described in [architecture.md](docs/architecture.md).

## Structure and release boundaries

`src/domain` owns the evidence contract, exact accounting, page commits and synthetic replay. `server` owns transport, server-side credentials, allowlisted provider requests, persistence, API, CLI and MCP. `src/components` owns graph/evidence presentation. The UI never performs provider-authenticated requests.

All implementation is original; no private STS/WalletWatch source, registry, labels or real-wallet investigation is copied. Generalized research lessons informed the design. No retired service is imported, started or modified. No repository is published or pushed.

Local cases are unencrypted and may contain sensitive research. Exported evidence inherits any provider/data restrictions. Review [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [LICENSE-DECISION.md](LICENSE-DECISION.md) before extension or release.
