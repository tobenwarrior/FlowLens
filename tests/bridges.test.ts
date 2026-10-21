import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBridgeEvidence,
  matchBridgeEvidence,
  createSyntheticBridgeEvidence,
} from "../src/domain/bridges.ts";

const sourceAsset = {
  chainId: 1,
  symbol: "DEMO",
  decimals: 6,
  contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const destinationAsset = {
  chainId: 8453,
  symbol: "DEMO",
  decimals: 6,
  contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const provenance = {
  source: "Synthetic bridge replay test",
  retrievedAt: "2026-10-21T10:00:00.000Z",
  synthetic: true,
};
function observation(
  id: string,
  role: "source" | "destination" | "fee",
  changes: Record<string, unknown> = {},
) {
  return {
    id,
    role,
    chainId: role === "source" ? 1 : 8453,
    txHash: `0x${(role === "source" ? "1" : id === "destination" ? "2" : "3").repeat(64)}`,
    logIndex: 0,
    blockNumber: 100,
    timestamp: "2026-10-20T10:00:00.000Z",
    rawAmount:
      role === "source"
        ? "1000000000000"
        : role === "destination"
          ? "999999987020"
          : "12980",
    asset: role === "source" ? sourceAsset : destinationAsset,
    route: { sourceChainId: 1, destinationChainId: 8453 },
    message: {
      protocol: "cctp",
      version: 1,
      sourceDomain: 0,
      destinationDomain: 6,
      nonce: "9001",
    },
    provenance,
    ...changes,
  };
}
function bundle(changes: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "synthetic",
    observations: [
      observation("source", "source"),
      observation("destination", "destination"),
      observation("fee", "fee", { feeSide: "destination" }),
    ],
    assetMappings: [
      {
        id: "demo-mapping",
        sourceAsset,
        destinationAsset,
        sourceUnits: "1",
        destinationUnits: "1",
        provenance,
      },
    ],
    coverage: [],
    ...changes,
  };
}

test("an exact CCTP domain/nonce join preserves observations and exact fee reconciliation", () => {
  const parsed = parseBridgeEvidence(bundle(), "synthetic");
  const result = matchBridgeEvidence(parsed);
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match.status, "matched");
  assert.deepEqual(match.observationIds, ["source", "destination", "fee"]);
  assert.equal(match.amountReconciliation.status, "balanced");
  assert.equal(match.amountReconciliation.differenceNumerator, "0");
  assert.equal(match.independentCredit.status, "unverified");
  assert.ok(match.warnings.some((x) => /credit/i.test(x)));
});
test("equal amounts and nearby times never join different protocol-indexed messages", () => {
  const source = observation("source", "source", { rawAmount: "100" });
  const destination = observation("destination", "destination", {
    rawAmount: "100",
    message: {
      protocol: "cctp",
      version: 1,
      sourceDomain: 0,
      destinationDomain: 6,
      nonce: "9002",
    },
  });
  const analysis = matchBridgeEvidence(
    parseBridgeEvidence(
      bundle({ observations: [source, destination] }),
      "synthetic",
    ),
  );
  assert.deepEqual(
    analysis.matches.map((x) => x.status),
    ["unmatched-source", "unmatched-destination"],
  );
});
test("a message hash can join a CCTP observation with no nonce without guessing a nonce", () => {
  const hash = `0x${"a".repeat(64)}`;
  const input = bundle({
    observations: [
      observation("source", "source", {
        message: {
          protocol: "cctp",
          version: 1,
          sourceDomain: 0,
          destinationDomain: 6,
          nonce: "9001",
          messageHash: hash,
        },
      }),
      observation("destination", "destination", {
        message: { protocol: "cctp", version: 1, messageHash: hash },
      }),
    ],
  });
  assert.equal(
    matchBridgeEvidence(parseBridgeEvidence(input, "synthetic")).matches[0]
      .status,
    "matched",
  );
});
test("LayerZero GUID joins require matching route chains and do not join an indexed lookalike", () => {
  const guid = `0x${"b".repeat(64)}`;
  const input = bundle({
    observations: [
      observation("source", "source", {
        message: { protocol: "layerzero", guid },
      }),
      observation("destination", "destination", {
        message: { protocol: "layerzero", guid },
      }),
      observation("unrelated", "destination", {
        txHash: `0x${"9".repeat(64)}`,
        message: {
          protocol: "indexed",
          namespace: "layerzero-copy",
          messageId: guid,
        },
      }),
    ],
  });
  const matches = matchBridgeEvidence(
    parseBridgeEvidence(input, "synthetic"),
  ).matches;
  assert.equal(matches.length, 2);
  assert.equal(matches[0].status, "matched");
  assert.equal(matches[1].status, "unmatched-destination");
});
test("same protocol message on conflicting routes stays conflicting rather than silently pairing", () => {
  const input = bundle({
    observations: [
      observation("source", "source"),
      observation("destination", "destination", {
        route: { sourceChainId: 42161, destinationChainId: 8453 },
      }),
    ],
  });
  const match = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(match.status, "conflicting");
  assert.ok(match.conflicts.includes("route-mismatch"));
});
test("repeated endpoints are ambiguous and no preferred destination is selected", () => {
  const input = bundle({
    observations: [
      observation("source", "source"),
      observation("destination", "destination"),
      observation("second", "destination", { txHash: `0x${"4".repeat(64)}` }),
    ],
  });
  const match = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(match.status, "ambiguous");
  assert.equal(match.amountReconciliation.status, "unavailable");
});
test("a shared nonce with incompatible message hashes is explicitly conflicting", () => {
  const input = bundle({
    observations: [
      observation("source", "source", {
        message: {
          protocol: "cctp",
          version: 1,
          sourceDomain: 0,
          destinationDomain: 6,
          nonce: "9001",
          messageHash: `0x${"a".repeat(64)}`,
        },
      }),
      observation("destination", "destination", {
        message: {
          protocol: "cctp",
          version: 1,
          sourceDomain: 0,
          destinationDomain: 6,
          nonce: "9001",
          messageHash: `0x${"b".repeat(64)}`,
        },
      }),
    ],
  });
  const match = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(match.status, "conflicting");
  assert.ok(match.conflicts.includes("message-hash-mismatch"));
});
test("hash-only CCTP identities cannot hide contradictory explicitly supplied domains", () => {
  const messageHash = `0x${"d".repeat(64)}`;
  const input = bundle({
    observations: [
      observation("source", "source", {
        message: {
          protocol: "cctp",
          version: 1,
          messageHash,
          sourceDomain: 0,
          destinationDomain: 6,
        },
      }),
      observation("destination", "destination", {
        message: {
          protocol: "cctp",
          version: 1,
          messageHash,
          sourceDomain: 0,
          destinationDomain: 7,
        },
      }),
    ],
  });
  const match = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(match.status, "conflicting");
  assert.ok(match.conflicts.includes("message-domain-mismatch"));
  assert.deepEqual(match.observationIds, ["source", "destination"]);
  assert.equal(match.amountReconciliation.status, "unavailable");
});
test("known CCTP domains must agree with Ethereum, Base and Arbitrum mainnet routes", () => {
  const input = createSyntheticBridgeEvidence();
  for (const observation of input.observations) {
    if (observation.message.protocol === "cctp") {
      observation.message.sourceDomain = 6;
      observation.message.destinationDomain = 0;
    }
  }
  const conflict = matchBridgeEvidence(input).matches.find((m) =>
    m.sourceIds.includes("source"),
  )!;
  assert.equal(conflict.status, "conflicting");
  assert.ok(conflict.conflicts.includes("cctp-source-domain-chain-mismatch"));
  assert.ok(
    conflict.conflicts.includes("cctp-destination-domain-chain-mismatch"),
  );
  assert.equal(conflict.cctpRouteValidation?.status, "conflicting");
  assert.equal(conflict.amountReconciliation.status, "unavailable");

  const valid = createSyntheticBridgeEvidence();
  valid.observations = valid.observations
    .filter((o) => o.message.protocol === "cctp")
    .map((o) =>
      o.role === "source"
        ? o
        : { ...o, chainId: 42161, asset: { ...o.asset, chainId: 42161 } },
    );
  for (const o of valid.observations) {
    o.route.destinationChainId = 42161;
    if (o.message.protocol === "cctp") o.message.destinationDomain = 3;
  }
  valid.assetMappings = valid.assetMappings.map((m) => ({
    ...m,
    destinationAsset: { ...m.destinationAsset, chainId: 42161 },
  }));
  const matched = matchBridgeEvidence(valid).matches[0];
  assert.equal(matched.status, "matched");
  assert.equal(matched.cctpRouteValidation?.status, "known-mapping-consistent");
  assert.equal(
    matched.cctpRouteValidation?.sourceUrl,
    "https://developers.circle.com/cctp/concepts/supported-chains-and-domains",
  );
});
test("unknown CCTP chain mappings and absent domain claims remain unresolved without losing unmatched states", () => {
  const input = createSyntheticBridgeEvidence();
  input.observations = input.observations
    .filter((o) => o.message.protocol === "cctp")
    .map((o) =>
      o.role === "source"
        ? o
        : { ...o, chainId: 999999, asset: { ...o.asset, chainId: 999999 } },
    );
  for (const o of input.observations) {
    o.route.destinationChainId = 999999;
    if (o.message.protocol === "cctp") o.message.destinationDomain = 99;
  }
  input.assetMappings = [];
  const result = matchBridgeEvidence(input).matches[0];
  assert.equal(result.status, "ambiguous");
  assert.equal(result.cctpRouteValidation?.status, "unresolved");
  assert.ok(result.warnings.some((w) => /unresolved/i.test(w)));
  const sourceOnly = matchBridgeEvidence({
    ...input,
    observations: input.observations.filter((o) => o.role === "source"),
  }).matches[0];
  assert.equal(sourceOnly.status, "unmatched-source");
  assert.equal(sourceOnly.cctpRouteValidation?.status, "unresolved");
  const messageHash = `0x${"e".repeat(64)}`;
  const hashOnly = matchBridgeEvidence(
    parseBridgeEvidence(
      bundle({
        observations: [
          observation("source", "source", {
            message: { protocol: "cctp", version: 1, messageHash },
          }),
          observation("destination", "destination", {
            message: { protocol: "cctp", version: 1, messageHash },
          }),
        ],
      }),
      "synthetic",
    ),
  ).matches[0];
  assert.equal(hashOnly.status, "ambiguous");
  assert.equal(hashOnly.cctpRouteValidation?.status, "unresolved");
});
test("matching symbols do not reconcile amounts without an explicit per-contract mapping", () => {
  const input = bundle({ assetMappings: [] });
  const result = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(result.status, "matched");
  assert.equal(result.amountReconciliation.status, "unavailable");
});
test("explicit raw-unit conversion is exact across differing token decimals", () => {
  const dest = { ...destinationAsset, decimals: 18 };
  const input = bundle({
    observations: [
      observation("source", "source", { rawAmount: "1200000" }),
      observation("destination", "destination", {
        rawAmount: "1200000000000000000",
        asset: dest,
      }),
    ],
    assetMappings: [
      {
        id: "scaled",
        sourceAsset,
        destinationAsset: dest,
        sourceUnits: "1",
        destinationUnits: "1000000000000",
        provenance,
      },
    ],
  });
  assert.equal(
    matchBridgeEvidence(parseBridgeEvidence(input, "synthetic")).matches[0]
      .amountReconciliation.status,
    "balanced",
  );
});
test("a known mapping with an unexplained amount difference preserves the discrepancy", () => {
  const input = bundle({
    observations: [
      observation("source", "source"),
      observation("destination", "destination", { rawAmount: "3" }),
    ],
  });
  const result = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(result.status, "matched");
  assert.equal(result.amountReconciliation.status, "difference");
  assert.equal(result.amountReconciliation.differenceNumerator, "999999999997");
});
test("a matched pooled transport does not turn into independently observed customer credit", () => {
  const input = bundle({
    observations: [
      observation("source", "source"),
      observation("destination", "destination", {
        recipientScope: "pooled-service",
      }),
    ],
  });
  const result = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(result.status, "matched");
  assert.equal(result.independentCredit.status, "unverified");
  assert.ok(result.warnings.some((x) => /pooled/i.test(x)));
});
test("an independent credit observation retains separate source evidence without ownership inference", () => {
  const input = bundle({
    observations: [
      observation("source", "source"),
      observation("destination", "destination", {
        recipientScope: "pooled-service",
        independentCredit: {
          status: "observed",
          beneficiary: "0xcccccccccccccccccccccccccccccccccccccccc",
          evidence: [provenance],
        },
      }),
    ],
  });
  const result = matchBridgeEvidence(parseBridgeEvidence(input, "synthetic"))
    .matches[0];
  assert.equal(
    result.independentCredit.status,
    "observed-in-supplied-evidence",
  );
  assert.ok(result.warnings.some((x) => /ownership/i.test(x)));
});
test("mode separation, duplicate identities, invalid hashes, and unbounded closure claims are rejected", () => {
  assert.throws(() => parseBridgeEvidence(bundle(), "private"), /mode/i);
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({
          observations: [
            observation("one", "source"),
            observation("one", "destination"),
          ],
        }),
        "synthetic",
      ),
    /duplicate/i,
  );
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({
          observations: [
            observation("one", "source"),
            observation("two", "source"),
          ],
        }),
        "synthetic",
      ),
    /event/i,
  );
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({
          observations: [observation("source", "source", { txHash: "0x1" })],
        }),
        "synthetic",
      ),
    /hash/i,
  );
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({
          coverage: [
            {
              id: "coverage",
              chainId: 1,
              protocol: "cctp",
              stream: "source",
              status: "supplied-scope-exhausted",
              blockFrom: null,
              blockTo: null,
              warnings: [],
              provenance,
            },
          ],
        }),
        "synthetic",
      ),
    /bound/i,
  );
});
test("private replay is accepted only with explicitly non-synthetic evidence and drops unknown fields", () => {
  const input = bundle();
  input.mode = "private";
  const source = JSON.parse(
    JSON.stringify(input).replaceAll('"synthetic":true', '"synthetic":false'),
  );
  source.secret = "do-not-retain";
  source.observations[0].provenance.apiKey = "do-not-retain";
  const parsed = parseBridgeEvidence(source, "private");
  assert.ok(!JSON.stringify(parsed).includes("do-not-retain"));
  assert.equal(matchBridgeEvidence(parsed).mode, "private");
});
test("observations cannot attach contradictory block facts to one chain transaction", () => {
  const first = observation("source", "source");
  const second = observation("second", "source", {
    logIndex: 1,
    blockNumber: 101,
  });
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({ observations: [first, second] }),
        "synthetic",
      ),
    /transaction facts/i,
  );
  const offset = observation("second", "source", {
    logIndex: 1,
    timestamp: "2026-10-20T11:00:00.000Z",
  });
  assert.throws(
    () =>
      parseBridgeEvidence(
        bundle({ observations: [first, offset] }),
        "synthetic",
      ),
    /transaction facts/i,
  );
});
test("synthetic replay is deterministic and remains partial about independent credit coverage", () => {
  const a = createSyntheticBridgeEvidence(),
    b = createSyntheticBridgeEvidence();
  assert.deepEqual(a, b);
  assert.equal(a.mode, "synthetic");
  const result = matchBridgeEvidence(a);
  assert.ok(result.matches.some((x) => x.status === "matched"));
  assert.ok(result.matches.some((x) => x.status === "unmatched-source"));
  assert.ok(result.warnings.some((x) => /complete|coverage|supplied/i.test(x)));
});
