# Fixed public RPC transport

`server/rpc.ts` provides a keyless, server-side transport for bounded acquisition. Callers select a supported chain, not an arbitrary URL. The built-in endpoints are fixed:

| Chain        | ID    | Endpoint                                  | Provider reference                                      |
| ------------ | ----- | ----------------------------------------- | ------------------------------------------------------- |
| Ethereum     | 1     | `https://ethereum-rpc.publicnode.com`     | [PublicNode Ethereum](https://ethereum.publicnode.com/) |
| Base         | 8453  | `https://base-rpc.publicnode.com`         | [PublicNode Base](https://base.publicnode.com/)         |
| Arbitrum One | 42161 | `https://arbitrum-one-rpc.publicnode.com` | [PublicNode Arbitrum](https://arbitrum.publicnode.com/) |

Base also has one server-local alternate: setting
`FLOWLENS_BASE_RPC_PROVIDER=blockmachine` selects the fixed keyless
`https://rpc-base.blockmachine.io` endpoint. Empty or `publicnode` keeps the
existing Base route. The enum is read only when the server creates a Base
client; invalid values fail before any request. No URL, API key or provider
choice enters an API/MCP request.

The BlockMachine route is a best-effort historical `debug_traceTransaction`
(`callTracer`) source for an already-known transaction hash. It is not a Base
wallet-history index or enumeration route. Its provenance is `BlockMachine Base
RPC` with [the Base RPC documentation](https://blockmachine.io/docs/base-rpc)
as `sourceUrl`; see the [public RPC endpoint notes](https://blockmachine.io/public-rpc-endpoints)
for provider availability.

The transport reads no credential environment variables, follows no redirects, signs nothing and sends no transactions. It permits only `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getCode`, `eth_call`, `eth_getLogs` and `debug_traceTransaction`. Other method names fail before a request is sent. Supporting a method in the application does not mean the public provider implements it.

Default operation budgets are 32 calls, 45 seconds total, a maximum 12-second timeout per request and 2,000,000 response bytes. Serialized parameters are limited to 1,000,000 characters. The body limit is enforced while reading, including when the server omits or misstates content length. Ordinary requests are paced at one per second through a shared provider queue within one process. BlockMachine `debug_traceTransaction` requests additionally share a minimum 35-second gap for that provider; a provider cooldown is applied only before a later explicit call. Independent processes do not share these limiters. Explicit adapter/test options have validated hard bounds; the application does not expose endpoint or arbitrary-method overrides to case inputs.

Each response must use JSON-RPC 2.0 and match the request ID. A chain-ID response must match the selected chain. HTTP denial, throttling, unsupported methods, RPC reverts, network failures, malformed results and exhausted budgets have distinct coded errors. Provider error text is not returned as trusted evidence. BlockMachine JSON-RPC `-32029` is reported as retryable `RPC_RATE_LIMITED`; an integer `retry_after_ms` from 0 through 120,000 becomes future queue cooldown, never an automatic retry. An absent hint keeps the rate-limit error without adding cooldown; malformed or oversized hints fail that response as non-retryable `RPC_INVALID_RESPONSE` and never poison the shared queue. There are no automatic retries, credential fallbacks or alternate endpoint probes.

This is a transport boundary, not a complete wallet index. Adapters must independently validate transaction, receipt, canonical block and protocol identities, preserve partial coverage and explain omissions. A response from one provider is not independent cryptographic authentication. Historical state, indexing, trace capability and future service availability are separate questions. Querying a wallet or transaction sends its identifier to the provider; public chain data can still disclose an investigator's area of interest.

Etherscan's optional indexed transfer adapter remains separate from this keyless RPC transport. Adapter tests use injected responses; live RPC availability and method support vary by provider. Review provider terms and intended data use independently before deployment or redistribution.
