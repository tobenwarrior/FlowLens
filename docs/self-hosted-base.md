# Self-hosted Base Blockscout

This packet prepares an API-only Blockscout backend for Base mainnet. It does
not deploy or operate a server. The Compose file contains only db, redis,
backend, and the one-time db-init ownership step. It publishes only
127.0.0.1:4010 to the host; PostgreSQL and Redis have no published ports.

Plan capacity for both the archive node and the Blockscout database; a laptop
with limited free disk space is not a suitable full-archive host. The prepared files are
[deploy/base-blockscout/docker-compose.yml](../deploy/base-blockscout/docker-compose.yml)
and [deploy/base-blockscout/.env.example](../deploy/base-blockscout/.env.example).

## What must exist on the future host

Blockscout is an indexer and API; it does not provide a Base RPC and it does
not index only wallets on demand. A complete Base history therefore needs both
an archive-capable Base node/RPC and a Blockscout indexer that catches up from
genesis. The node must provide:

- archive-capable HTTP JSON-RPC for ETHEREUM_JSONRPC_HTTP_URL;
- transaction tracing through ETHEREUM_JSONRPC_TRACE_URL; and
- WebSocket JSON-RPC through ETHEREUM_JSONRPC_WS_URL.

The HTTP and trace URLs may be the same endpoint only when that endpoint
actually supports the required archive and trace methods. Do not use
https://mainnet.base.org as the full-history trace backend. It is a public,
rate-limited RPC and is not the operator-owned archive required here.

The Blockscout backend also needs an Ethereum mainnet RPC in
INDEXER_OPTIMISM_L1_RPC for Optimism/Base L1 enrichment. Beacon/blob support
is optional and disabled by default: leave the blob/beacon variables empty
unless an operator has configured a compatible blob endpoint and all matching
beacon reference values.

Base's node-operator documentation calls for at least 32 GB RAM (64 GB
recommended), a locally attached NVMe SSD, and storage sized from current
chain size, snapshot size, and buffer. Size the host from the current
[Base snapshots](https://chain.base.org/snapshots) listing. See the [run-a-node](https://docs.base.org/specifications/node-operators/run-a-node),
[snapshot](https://docs.base.org/specifications/node-operators/snapshots), and
[performance](https://docs.base.org/specifications/node-operators/performance-tuning)
guides before choosing the host.

## Pin images and supply local values

On the future host, copy the template and fill it using the operator's
approved secret/configuration mechanism:

```
cd deploy/base-blockscout
cp .env.example .env
```

Supply secrets locally and keep them out of Git. POSTGRES_PASSWORD is used by both
PostgreSQL and the backend connection URL; use a URL-safe password (avoid
@, :, /, ?, #, and spaces) unless the database URL is adjusted with the
correct percent-encoding. SECRET_KEY_BASE must be a stable operator-supplied
secret for the lifetime of this installation.

The three image variables are intentionally blank. Resolve immutable digests
from the official registries and put the full digest reference in .env:

- BLOCKSCOUT_OP_IMAGE: the official
  [Blockscout Optimism package](https://github.com/blockscout/blockscout/pkgs/container/blockscout-optimism);
- POSTGRES_IMAGE: an official PostgreSQL 17 image compatible with Blockscout's database service; and
- REDIS_IMAGE: the official Redis image.

No current tag is guessed here. Verify each digest and its architecture in the
official registry before using it. The backend command follows Blockscout's
official backend Compose service and runs the migration before starting:

```
bin/blockscout eval 'Elixir.Explorer.ReleaseTasks.create_and_migrate()' && bin/blockscout start
```

The Compose file fixes the Base/Optimism settings that are part of this
bounded packet:

| Setting                                       | Value                                      |
| --------------------------------------------- | ------------------------------------------ |
| CHAIN_ID                                      | 8453                                       |
| CHAIN_TYPE                                    | optimism                                   |
| ETHEREUM_JSONRPC_VARIANT                      | geth                                       |
| FIRST_BLOCK / TRACE_FIRST_BLOCK               | 0 / 0                                      |
| BLOCK_RANGES / TRACE_BLOCK_RANGES             | empty / empty                              |
| INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER | false                                      |
| API_V2_ENABLED                                | true                                       |
| DISABLE_INDEXER                               | false                                      |
| INDEXER_OPTIMISM_L1_SYSTEM_CONFIG_CONTRACT    | 0x73a79Fab69143498Ed3712e519A88a918e1f4072 |

The SystemConfig address is taken from Base's reviewed
[mainnet contract configuration](https://raw.githubusercontent.com/base/contract-deployments/main/config/mainnet.env).
The Optimism deployment guide documents the L1 RPC and SystemConfig settings;
the Compose packet leaves the optional blob fallback disabled unless explicitly
configured. To enable it, set INDEXER_DISABLE_BEACON_BLOB_FETCHER=false and
provide the blob URL plus all four beacon reference variables together.

## Validate and start on the future host

With Docker's daemon running and .env filled, inspect the rendered
configuration before any start:

```
docker compose --env-file .env config --quiet
```

Validation prints no configuration or secret values. Review the Compose file's
loopback API binding; PostgreSQL and Redis have no published ports.
Start only after confirming the archive RPC, trace method, L1 RPC, image
digests, storage and backup plan:

```
docker compose --env-file .env up -d
docker compose --env-file .env logs -f backend
```

The backend migration is run by its command. The operator should then check
the chain/readiness endpoints from the host (these checks do not submit wallet
requests):

```
curl -sS -X POST http://127.0.0.1:4010/api/eth-rpc -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
curl -sS http://127.0.0.1:4010/api/v2/main-page/indexing-status
```

## Genesis and readiness limits

FIRST_BLOCK=0, TRACE_FIRST_BLOCK=0, and empty range variables are the
configured intent for genesis coverage. The readiness response can report
finished_indexing, finished_indexing_blocks, and the indexed block/internal
transaction ratios, but it cannot prove that an operator's RPC retained every
archive block or that the indexer actually began at genesis. Manually review
the rendered configuration and the indexer's logs/coverage before treating a
case as complete. FlowLens also keeps this distinction explicit: its local
readiness check requires chain ID 0x2105, both finished flags, and both ratios
at 1.0, while warning that genesis/range coverage is not API-proven.

## Connect FlowLens locally

When Blockscout is on the same host as FlowLens, set the FlowLens process-local
configuration to:

```
FLOWLENS_BASE_BLOCKSCOUT_URL=http://127.0.0.1:4010
```

The FlowLens connector accepts only a loopback origin. If the archive host is
remote, keep Blockscout bound to its remote loopback and use an SSH tunnel from
the FlowLens host:

```
ssh -N -L 4010:127.0.0.1:4010 user@archive-host
```

FlowLens still uses http://127.0.0.1:4010; the tunnel carries the request to
the remote Blockscout API. Do not publish the backend port on an untrusted
interface and do not put credentials or cases in this repository.

## Sources and scope

This packet follows the official
[backend service](https://raw.githubusercontent.com/blockscout/blockscout/master/docker-compose/services/backend.yml),
[database service](https://raw.githubusercontent.com/blockscout/blockscout/master/docker-compose/services/db.yml),
[Redis service](https://raw.githubusercontent.com/blockscout/blockscout/master/docker-compose/services/redis.yml),
and [rollup deployment](https://docs.blockscout.com/setup/deployment/rollup-deployment)
guidance. No deployment, image pull, node sync, live wallet query, credential
generation, or account change has been performed for this repository. Current
server availability and live index coverage remain unverified.
