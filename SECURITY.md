# Local security and private evidence

FlowLens is a local investigation tool. Keep its API bound to loopback. It does not provide a multi-user authentication or public hosting boundary; do not expose its port to an untrusted network.

Provider keys belong in the server process environment. Do not prefix them with `VITE_`, put them in frontend code, paste them into case notes, or commit `.env` files. The supplied `.env.example` contains variable names only. The local application should not return key values in status responses or exported investigations.

Investigation JSON can contain sensitive research: addresses, notes, hypotheses, labels and browsing progress. Local persistence is not encryption. Protect the Mac account and backups, and review exports before sharing. Keep private cases and provider responses outside the repository. Use only sanitized synthetic fixtures in tests and public examples.

Treat imported investigations, provider strings and labels as untrusted data. Validate schemas and size, render text as text, and avoid executing commands or following arbitrary URLs from evidence. Explorer links should come from the supported chain registry. Provider access must use bounded requests and respect rate limits and denials.

The tracing engine observes transfers; it does not establish legal ownership, execute trades, sign transactions, connect wallets or custody assets. Keep those boundaries when extending it.

GitHub private vulnerability reporting is disabled for this public repository (checked 1 November 2026), and no alternative private reporting route has been verified. Before a release, the owner must enable and test a private reporting route. Do not put credentials, real investigations or exploit details in public issues. Until a route is verified, request a private channel through an independently confirmed maintainer contact without disclosing sensitive details publicly.

The MCP server uses local stdio and does not install or modify global host configuration. Its tools accept case IDs and bounded JSON rather than arbitrary paths or provider endpoints. Source strings, labels and replay assertions are untrusted evidence, never instructions. Review tool mutation annotations: importing a full snapshot or attaching a replacement replay bundle can replace retained observations. Export backups when that is intended. Cancellation is not a guaranteed rollback; inspect durable state before repeating a mutation with an uncertain outcome.

Safe, bridge and internal replay is supplied data, not independent source authentication or live coverage. Private/synthetic mode flags and provenance are enforced internally; they cannot prove that an external author described a source truthfully.
