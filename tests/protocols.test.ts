import test from "node:test";
import assert from "node:assert/strict";
import * as protocols from "../src/domain/protocols.ts";
import type { ProtocolEvidenceBundle } from "../src/domain/protocols.ts";

function merge(
  previous: ProtocolEvidenceBundle | undefined,
  incoming: ProtocolEvidenceBundle,
): ProtocolEvidenceBundle {
  assert.equal(
    typeof protocols.mergeProtocolEvidence,
    "function",
    "Protocol acquisition needs a validated, non-destructive evidence merge",
  );
  return protocols.mergeProtocolEvidence(previous, incoming);
}
const clone = <T>(value: T): T => structuredClone(value);
const fixture = () => protocols.createSyntheticProtocolEvidence();
function conflict(run: () => unknown) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_EVIDENCE_CONFLICT",
  );
}

test("first acquisition validates and copies evidence without sharing mutable state", () => {
  const incoming = fixture();
  const value = merge(undefined, incoming);
  assert.deepEqual(value, incoming);
  assert.notEqual(value, incoming);
  value.safe!.configurations[0].owners.reverse();
  assert.notDeepEqual(value.safe, incoming.safe);
});

test("partial acquisitions preserve prior components and deduplicate stable evidence IDs", () => {
  const initial = fixture();
  const sourceOnly = clone(initial.bridges!);
  sourceOnly.observations = sourceOnly.observations.filter(
    (row) => row.role === "source",
  );
  const destinationOnly = clone(initial.bridges!);
  destinationOnly.observations = destinationOnly.observations.filter(
    (row) => row.role !== "source",
  );
  const first = merge(undefined, {
    version: 1,
    mode: "synthetic",
    safe: initial.safe,
    bridges: sourceOnly,
  });
  const second = merge(first, {
    version: 1,
    mode: "synthetic",
    bridges: destinationOnly,
    internal: initial.internal,
  });
  const repeated = merge(second, initial);
  assert.deepEqual(repeated.safe, initial.safe);
  assert.deepEqual(
    repeated.bridges!.observations.map((row) => row.id),
    ["source", "unresolved-source", "destination", "fee"],
  );
  assert.deepEqual(
    [...repeated.bridges!.observations].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    [...initial.bridges!.observations].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(repeated.bridges!.coverage, initial.bridges!.coverage);
  assert.deepEqual(
    repeated.bridges!.assetMappings,
    initial.bridges!.assetMappings,
  );
  assert.deepEqual(repeated.internal, initial.internal);
  assert.equal(
    protocols.analyzeProtocolEvidence(repeated).bridges!.matches.length,
    2,
  );
});

test("an empty or failed acquisition keeps prior observations and updates scoped coverage", () => {
  const initial = fixture();
  const next = clone(initial.internal!);
  next.traces = [];
  next.coverage[0].status = "error";
  next.coverage[0].warnings = ["Temporary read failure"];
  next.coverage[0].provenance.retrievedAt = "2026-10-21T12:00:00.000Z";
  const merged = merge(initial, {
    version: 1,
    mode: "synthetic",
    internal: next,
  });
  assert.deepEqual(merged.internal!.traces, initial.internal!.traces);
  assert.equal(merged.internal!.coverage[0].status, "error");
  assert.deepEqual(merged.safe, initial.safe);
});

test("later retrieval refreshes provenance while out-of-order pages cannot rewind coverage", () => {
  const initial = fixture();
  const next = clone(initial.safe!);
  next.configurations[0].provenance.retrievedAt = "2026-10-21T12:00:00.000Z";
  next.configurations[0].owners.reverse();
  next.coverage[1].status = "partial";
  next.coverage[1].cursor = "next-page";
  next.coverage[1].provenance.retrievedAt = "2026-10-21T12:00:00.000Z";
  const refreshed = merge(initial, {
    version: 1,
    mode: "synthetic",
    safe: next,
  });
  assert.equal(
    refreshed.safe!.configurations[0].provenance.retrievedAt,
    "2026-10-21T12:00:00.000Z",
  );
  assert.equal(refreshed.safe!.coverage[1].cursor, "next-page");
  const stale = merge(refreshed, initial);
  assert.equal(stale.safe!.coverage[1].cursor, "next-page");
});

test("separate beneficiary-credit provenance can refresh without changing its source or claim", () => {
  const initial = fixture();
  const destination = initial.bridges!.observations.find(
    (row) => row.role === "destination",
  )!;
  destination.independentCredit = {
    status: "observed",
    beneficiary: "0x7777777777777777777777777777777777777777",
    evidence: [
      {
        ...clone(destination.provenance),
        source: "Synthetic independent credit evidence",
      },
    ],
  };
  const updated = clone(initial);
  const refreshed = updated.bridges!.observations.find(
    (row) => row.id === destination.id,
  )!;
  refreshed.provenance.retrievedAt = "2026-10-22T12:00:00.000Z";
  refreshed.independentCredit!.evidence[0].retrievedAt =
    "2026-10-22T12:00:00.000Z";
  const merged = merge(initial, updated);
  assert.deepEqual(
    merged.bridges!.observations.find((row) => row.id === destination.id)!
      .independentCredit,
    refreshed.independentCredit,
  );
  const changed = clone(updated);
  changed.bridges!.observations.find(
    (row) => row.id === destination.id,
  )!.independentCredit!.evidence[0].source = "Different source";
  conflict(() => merge(merged, changed));
});

test("verification can enrich an execution and preserve earlier signer observations", () => {
  const initial = fixture();
  const next = clone(initial.safe!);
  const previousExecution = initial.safe!.executions[0];
  previousExecution.signatures = [];
  previousExecution.signatureCoverage = "unavailable";
  previousExecution.authorizationPath = "unknown";
  delete previousExecution.nonce;
  delete previousExecution.transactionIndex;
  const enriched = merge(initial, {
    version: 1,
    mode: "synthetic",
    safe: next,
  });
  assert.deepEqual(enriched.safe!.executions[0], next.executions[0]);
  const repeated = merge(enriched, initial);
  assert.deepEqual(repeated.safe!.executions[0], next.executions[0]);
  assert.equal(
    repeated.safe!.executions.length,
    initial.safe!.executions.length,
  );
});

test("paginated Safe coverage retains attribution while advancing its exact source page", () => {
  const initial = fixture(),
    next = clone(initial);
  const first = initial.safe!.coverage[0],
    second = next.safe!.coverage[0];
  first.provenance.sourceUrl =
    "https://api.example.test/history?limit=5&offset=0";
  second.provenance.sourceUrl =
    "https://api.example.test/history?limit=5&offset=5";
  second.provenance.retrievedAt = "2026-10-22T12:00:00.000Z";
  second.status = "partial";
  second.cursor = "page-2";
  const merged = merge(initial, next);
  assert.equal(
    merged.safe!.coverage[0].provenance.sourceUrl,
    second.provenance.sourceUrl,
  );
  assert.equal(merged.safe!.coverage[0].cursor, "page-2");
  const changed = clone(next);
  changed.safe!.coverage[0].provenance.sourceUrl =
    "https://unrelated.example.test/history?limit=5&offset=5";
  conflict(() => merge(merged, changed));
});

test("verification unions distinct signature IDs without accepting contradictory execution claims", () => {
  const initial = fixture();
  const next = clone(initial.safe!);
  const first = next.executions[0];
  first.signatures = [
    {
      ...clone(first.signatures[0]),
      id: "additional-signature",
      signer: "0x3333333333333333333333333333333333333333",
    },
  ];
  first.signatureCoverage = "reported-complete";
  const enriched = merge(initial, {
    version: 1,
    mode: "synthetic",
    safe: next,
  });
  assert.deepEqual(
    enriched.safe!.executions[0].signatures.map((row) => row.id),
    ["signature-0-0", "additional-signature"],
  );
  assert.equal(
    enriched.safe!.executions[0].signatureCoverage,
    "reported-complete",
  );
  for (const change of [
    { authorizationPath: "module" as const },
    { nonce: "999" },
    { status: "failure" as const },
  ]) {
    const contradictory = clone(initial);
    Object.assign(contradictory.safe!.executions[0], change);
    conflict(() => merge(enriched, contradictory));
  }
});

test("material contradictions under a stable evidence ID never replace earlier facts", () => {
  const initial = fixture();
  const configuration = clone(initial);
  configuration.safe!.configurations[0].threshold = 2;
  conflict(() => merge(initial, configuration));
  const bridge = clone(initial);
  bridge.bridges!.observations[0].rawAmount = "999";
  conflict(() => merge(initial, bridge));
  const trace = clone(initial);
  trace.internal!.traces[0].rawValue = "999";
  conflict(() => merge(initial, trace));
  const signature = clone(initial);
  signature.safe!.executions[0].signatures[0].signer =
    "0x9999999999999999999999999999999999999999";
  conflict(() => merge(initial, signature));
  assert.equal(initial.safe!.configurations[0].threshold, 3);
});

test("merging cannot relabel provenance or switch evidence modes", () => {
  const initial = fixture();
  const relabeled = clone(initial);
  relabeled.safe!.labels[0].provenance.source = "Unrelated attribution source";
  conflict(() => merge(initial, relabeled));
  assert.throws(() => merge(initial, { ...initial, mode: "private" }), /mode/i);
});

test("the combined result must still satisfy component record budgets", () => {
  const initial = fixture();
  const first = clone(initial.safe!);
  first.executions = [];
  first.labels = [];
  first.coverage = [];
  first.configurationEvents = [];
  first.configurations = Array.from({ length: 101 }, (_, i) => ({
    ...clone(initial.safe!.configurations[0]),
    id: `first-${i}`,
    blockNumber: i,
  }));
  const second = clone(first);
  second.configurations = second.configurations.map((row, i) => ({
    ...row,
    id: `second-${i}`,
    blockNumber: i + 101,
  }));
  assert.throws(
    () =>
      merge(
        { version: 1, mode: "synthetic", safe: first },
        { version: 1, mode: "synthetic", safe: second },
      ),
    /at most 200|configurations/i,
  );
});

test("separately valid pages cannot exceed the combined serialized-size budget", () => {
  const initial = fixture().internal!;
  const page = (offset: number) => ({
    ...clone(initial),
    coverage: [],
    traces: Array.from({ length: 1800 }, (_, i) => {
      const trace = clone(initial.traces[0]);
      trace.hash = `0x${(i + offset + 1).toString(16).padStart(64, "0")}`;
      trace.id = `${trace.chainId}:${trace.hash}:trace:root`;
      return trace;
    }),
  });
  const first: ProtocolEvidenceBundle = {
    version: 1,
    mode: "synthetic",
    internal: page(0),
  };
  const second: ProtocolEvidenceBundle = {
    version: 1,
    mode: "synthetic",
    internal: page(1800),
  };
  assert.ok(protocols.parseProtocolEvidence(first));
  assert.ok(protocols.parseProtocolEvidence(second));
  assert.throws(() => merge(first, second), /2 MB limit/);
});
