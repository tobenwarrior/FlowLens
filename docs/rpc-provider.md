# Fixed public RPC transport

`server/rpc.ts` provides a keyless, server-side transport for bounded acquisition. Callers select a supported chain, not an arbitrary URL. The built-in endpoints are fixed:

| Chain        | ID    | Endpoint                                  | Provider reference                                      |
| ------------ | ----- | ----------------------------------------- | ------------------------------------------------------- |
| Ethereum     | 1     | `https://ethereum-rpc.publicnode.com`     | [PublicNode Ethereum](https://ethereum.publicnode.com/) |
| Base         | 8453  | `https://base-rpc.publicnode.com`         | [PublicNode Base](https://base.publicnode.com/)         |
| Arbitrum One | 42161 | `https://arbitrum-one-rpc.publicnode.com` | [PublicNode Arbitrum](https://arbitrum.publicnode.com/) |

The transport reads no credential environment variables, follows no redirects, signs nothing and sends no transactions. It permits only `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getCode`, `eth_call`, `eth_getLogs` and `debug_traceTransaction`. Other method names fail before a request is sent. Supporting a method in the application does not mean the public provider implements it.

Default operation budgets are 32 calls, 45 seconds total, a maximum 12-second timeout per request and 2,000,000 response bytes. Serialized parameters are limited to 1,000,000 characters. The body limit is enforced while reading, including when the server omits or misstates content length. Requests are paced at one per second through a shared per-chain queue within one process. Independent processes do not share this limiter. Explicit adapter/test options have validated hard bounds; the application does not expose endpoint or arbitrary-method overrides to case inputs.

Each response must use JSON-RPC 2.0 and match the request ID. A chain-ID response must match the selected chain. HTTP denial, throttling, unsupported methods, RPC reverts, network failures, malformed results and exhausted budgets have distinct coded errors. Provider error text is not returned as trusted evidence. There are no automatic retries, credential fallbacks or alternate endpoint probes.

This is a transport boundary, not a complete wallet index. Adapters must independently validate transaction, receipt, canonical block and protocol identities, preserve partial coverage and explain omissions. A response from one provider is not independent cryptographic authentication. Historical state, indexing, trace capability and future service availability are separate questions. Querying a wallet or transaction sends its identifier to the provider; public chain data can still disclose an investigator's area of interest.

Etherscan's optional indexed transfer adapter remains separate from this keyless RPC transport. Adapter tests use injected responses; live RPC availability and method support vary by provider. Review provider terms and intended data use independently before deployment or redistribution.
