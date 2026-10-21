import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeSafeEvidence,
  createSyntheticSafeEvidence,
  parseSafeEvidence,
} from "../src/domain/safe.ts";

const copy = () => structuredClone(createSyntheticSafeEvidence());
const address = (digit: string) => `0x${digit.repeat(40)}`;

test("Safe replay keeps configured quorum separate from actual observed signers", () => {
  const bundle = parseSafeEvidence(copy(), "synthetic");
  const report = analyzeSafeEvidence(bundle);
  assert.equal(bundle.executions.length, 11);
  assert.equal(report.executionCount, 11);
  assert.equal(report.independentlyVerifiedSignatures, false);
  assert.equal(report.executions[0].configuredThreshold, 3);
  assert.equal(report.executions[0].configuredOwners.length, 5);
  assert.equal(report.executions[0].uniqueObservedSigners.length, 1);
  assert.equal(report.executions[0].observedConfiguredSigners.length, 1);
  assert.equal(
    report.executions[0].thresholdObservation,
    "below-threshold-in-supplied-observations",
  );
  assert.equal(report.executions[0].executionStatus, "success");
  assert.ok(
    report.warnings.some((w) => w.includes("does not establish ownership")),
  );
});

test("current configuration never supplies historical execution owners implicitly", () => {
  const bundle = copy();
  delete bundle.executions[0].configurationEvidenceId;
  const result = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(result.executions[0].configuredThreshold, null);
  assert.deepEqual(result.executions[0].configuredOwners, []);
  assert.equal(
    result.executions[0].thresholdObservation,
    "configuration-unavailable",
  );
  assert.ok(
    result.executions[0].warnings.some((w) => w.includes("current snapshot")),
  );
});

test("explicit current, future and wrong-chain configuration links are rejected", () => {
  const current = copy();
  current.executions[0].configurationEvidenceId = "config-current";
  assert.throws(
    () => parseSafeEvidence(current, "synthetic"),
    /current snapshot/i,
  );
  const future = copy();
  future.configurations[0].blockNumber = future.executions[0].blockNumber + 1;
  assert.throws(
    () => parseSafeEvidence(future, "synthetic"),
    /after the execution/i,
  );
  const wrongChain = copy();
  wrongChain.configurations[0].chainId = 42161;
  assert.throws(
    () => parseSafeEvidence(wrongChain, "synthetic"),
    /same Safe and chain/i,
  );
});

test("same-block ordering ambiguity remains an explicit gap", () => {
  const bundle = copy();
  bundle.configurations[0].blockNumber = bundle.executions[0].blockNumber;
  delete bundle.configurations[0].transactionIndex;
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(
    report.executions[0].thresholdObservation,
    "configuration-order-ambiguous",
  );
  assert.equal(report.executions[0].configuredThreshold, null);
});

test("duplicate signer observations cannot inflate a configured threshold", () => {
  const bundle = copy();
  const first = bundle.executions[0].signatures[0];
  bundle.executions[0].signatures.push(
    { ...first, id: "duplicate-observation-a" },
    { ...first, id: "duplicate-observation-b" },
  );
  const result = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(result.executions[0].signatureObservationCount, 3);
  assert.equal(result.executions[0].uniqueObservedSigners.length, 1);
  assert.equal(result.executions[0].observedConfiguredSigners.length, 1);
  assert.equal(
    result.executions[0].thresholdObservation,
    "below-threshold-in-supplied-observations",
  );
});

test("unknown signature observations and source-reported completeness do not become verification", () => {
  const bundle = copy();
  bundle.executions[0].signatures.push({
    id: "unknown-signature",
    type: "unknown",
    observation: "supplied",
    provenance: bundle.executions[0].provenance,
  });
  bundle.executions[0].signatureCoverage = "reported-complete";
  const result = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(result.executions[0].unknownSignatureCount, 1);
  assert.equal(result.executions[0].signatureCoverage, "reported-complete");
  assert.equal(result.independentlyVerifiedSignatures, false);
  assert.ok(
    result.executions[0].warnings.some((w) =>
      w.includes("not independently verified"),
    ),
  );
});

test("observed configured owner count can meet the threshold without claiming cryptographic verification", () => {
  const bundle = copy();
  const execution = bundle.executions[0];
  execution.signatures = bundle.configurations[0].owners
    .slice(0, 3)
    .map((signer, index) => ({
      id: `observed-${index}`,
      type: "eoa" as const,
      observation: "source-recovered" as const,
      signer,
      provenance: execution.provenance,
    }));
  const result = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(
    result.executions[0].thresholdObservation,
    "observed-count-meets-threshold",
  );
  assert.equal(result.independentlyVerifiedSignatures, false);
});

test("unconfigured observed signers remain visible rather than silently promoted to owners", () => {
  const bundle = copy();
  bundle.executions[0].signatures[0].signer = address("f") as `0x${string}`;
  const result = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.deepEqual(result.executions[0].observedOtherSigners, [address("f")]);
  assert.deepEqual(result.executions[0].observedConfiguredSigners, []);
});

test("no-change observation is bounded to supplied exhausted configuration-event coverage", () => {
  const report = analyzeSafeEvidence(parseSafeEvidence(copy(), "synthetic"));
  assert.equal(
    report.configurationChanges[0].observation,
    "no changes observed in supplied scope",
  );
  assert.equal(report.configurationChanges[0].fromBlock, 100);
  assert.equal(report.configurationChanges[0].toBlock, 300);
  const partial = copy();
  partial.coverage[0].status = "partial";
  partial.coverage[0].cursor = "page-2";
  const partialResult = analyzeSafeEvidence(
    parseSafeEvidence(partial, "synthetic"),
  );
  assert.equal(
    partialResult.configurationChanges[0].observation,
    "configuration-change coverage incomplete",
  );
  const absent = copy();
  absent.coverage = [];
  const absentResult = analyzeSafeEvidence(
    parseSafeEvidence(absent, "synthetic"),
  );
  assert.equal(
    absentResult.configurationChanges[0].observation,
    "configuration-change coverage unavailable",
  );
});

test("configuration changes retain exact event evidence and are scoped by chain and range", () => {
  const bundle = copy();
  bundle.configurationEvents.push({
    id: "change-1",
    safeAddress: bundle.executions[0].safeAddress,
    chainId: 1,
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 180,
    transactionIndex: 2,
    logIndex: 5,
    type: "threshold-changed",
    threshold: 2,
    provenance: bundle.executions[0].provenance,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(
    report.configurationChanges[0].observation,
    "configuration changes observed in supplied scope",
  );
  assert.deepEqual(report.configurationChanges[0].eventIds, ["change-1"]);
});

test("parser separates private and synthetic modes and strips unknown properties", () => {
  const input = { ...copy(), apiKey: "do-not-retain" };
  assert.throws(() => parseSafeEvidence(input, "private"), /mode/i);
  const parsed = parseSafeEvidence(input, "synthetic");
  assert.equal("apiKey" in parsed, false);
  const mixed = copy();
  mixed.executions[0].provenance.synthetic = false;
  assert.throws(() => parseSafeEvidence(mixed, "synthetic"), /synthetic/i);
  const privateBundle = JSON.parse(
    JSON.stringify(copy()).replaceAll('"synthetic":true', '"synthetic":false'),
  );
  privateBundle.mode = "private";
  privateBundle.labels = [];
  assert.equal(parseSafeEvidence(privateBundle, "private").mode, "private");
  const mixedLabel = structuredClone(privateBundle);
  mixedLabel.labels = [
    {
      ...copy().labels[0],
      provenance: { ...copy().labels[0].provenance, synthetic: false },
    },
  ];
  assert.throws(
    () => parseSafeEvidence(mixedLabel, "private"),
    /synthetic label/i,
  );
});

test("parser normalizes addresses and UTC offsets while retaining label provenance", () => {
  const input = copy();
  input.configurations[0].owners[0] = address("A") as `0x${string}`;
  input.executions[0].provenance.retrievedAt = "2026-10-20T08:00:00+09:00";
  const result = parseSafeEvidence(input, "synthetic");
  assert.equal(result.configurations[0].owners[0], address("a"));
  assert.equal(
    result.executions[0].provenance.retrievedAt,
    "2026-10-19T23:00:00.000Z",
  );
  assert.equal(result.labels[0].kind, "demo");
  assert.equal(result.labels[0].confidence, "synthetic");
});

test("parser rejects impossible thresholds, duplicate owners and malformed execution evidence", () => {
  for (const threshold of [0, 6, 1.5]) {
    const bundle = copy();
    bundle.configurations[0].threshold = threshold;
    assert.throws(() => parseSafeEvidence(bundle, "synthetic"), /threshold/i);
  }
  const duplicate = copy();
  duplicate.configurations[0].owners[1] = duplicate.configurations[0].owners[0];
  assert.throws(
    () => parseSafeEvidence(duplicate, "synthetic"),
    /duplicate owner/i,
  );
  const wrongHash = copy();
  wrongHash.executions[0].transactionHash = "0x123";
  assert.throws(() => parseSafeEvidence(wrongHash, "synthetic"), /hash/i);
  const impossibleDate = copy();
  impossibleDate.executions[0].provenance.retrievedAt = "2026-02-30T01:00:00Z";
  assert.throws(
    () => parseSafeEvidence(impossibleDate, "synthetic"),
    /timestamp/i,
  );
});

test("duplicate identities, dangling links and contradictory signature coverage reject rather than inflate reports", () => {
  const duplicate = copy();
  duplicate.executions.push({
    ...duplicate.executions[0],
    id: "second-id",
    signatures: duplicate.executions[0].signatures.map((s) => ({
      ...s,
      id: `duplicate-${s.id}`,
    })),
  });
  assert.throws(
    () => parseSafeEvidence(duplicate, "synthetic"),
    /duplicate execution/i,
  );
  const dangling = copy();
  dangling.executions[0].configurationEvidenceId = "missing";
  assert.throws(
    () => parseSafeEvidence(dangling, "synthetic"),
    /configuration evidence/i,
  );
  const impossible = copy();
  impossible.executions[0].signatureCoverage = "unavailable";
  assert.throws(
    () => parseSafeEvidence(impossible, "synthetic"),
    /unavailable signature/i,
  );
  const reusedId = copy();
  reusedId.executions[0].id = reusedId.configurations[0].id;
  assert.throws(
    () => parseSafeEvidence(reusedId, "synthetic"),
    /duplicate evidence ID/i,
  );
});

test("parser enforces input budgets before analysis", () => {
  const huge = copy();
  huge.executions = Array.from({ length: 1001 }, () => huge.executions[0]);
  assert.throws(() => parseSafeEvidence(huge, "synthetic"), /at most 1000/i);
  assert.throws(
    () => parseSafeEvidence({ notes: "x".repeat(2_000_001) }, "synthetic"),
    /2 MB/i,
  );
});

test("unknown signature types with supplied addresses never count toward a configured threshold", () => {
  const bundle = copy(),
    execution = bundle.executions[0];
  execution.signatures.push(
    ...bundle.configurations[0].owners.slice(1, 3).map((signer, index) => ({
      id: `unknown-address-${index}`,
      signer,
      type: "unknown" as const,
      observation: "supplied" as const,
      provenance: execution.provenance,
    })),
  );
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(report.executions[0].uniqueObservedSigners.length, 3);
  assert.equal(report.executions[0].observedConfiguredSigners.length, 1);
  assert.equal(
    report.executions[0].thresholdObservation,
    "below-threshold-in-supplied-observations",
  );
});

test("module and unspecified authorization paths are not owner-quorum tests", () => {
  const bundle = copy();
  bundle.executions[0].authorizationPath = "module";
  assert.equal(
    analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic")).executions[0]
      .thresholdObservation,
    "module-authorization-not-owner-quorum",
  );
  const unknown = copy() as unknown as {
    executions: Record<string, unknown>[];
  };
  delete unknown.executions[0].authorizationPath;
  assert.equal(
    analyzeSafeEvidence(parseSafeEvidence(unknown, "synthetic")).executions[0]
      .thresholdObservation,
    "authorization-path-unresolved",
  );
});

test("an observed owner/threshold change invalidates a stale linked execution snapshot", () => {
  const bundle = copy();
  bundle.configurationEvents.push({
    id: "intervening-owner-change",
    chainId: 1,
    safeAddress: bundle.executions[0].safeAddress,
    blockNumber: 150,
    transactionIndex: 1,
    logIndex: 4,
    transactionHash: `0x${"a".repeat(64)}`,
    type: "owner-added",
    owner: address("7") as `0x${string}`,
    provenance: bundle.executions[0].provenance,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(report.executions[0].configuredThreshold, null);
  assert.equal(
    report.executions[0].thresholdObservation,
    "configuration-link-crosses-observed-change",
  );
});

test("conflicting snapshots and out-of-window events never become a global no-change conclusion", () => {
  const inconsistent = copy();
  inconsistent.configurations[1].threshold = 2;
  assert.equal(
    analyzeSafeEvidence(parseSafeEvidence(inconsistent, "synthetic"))
      .configurationChanges[0].observation,
    "configuration snapshots differ without matching change evidence",
  );
  const outside = copy();
  outside.configurationEvents.push({
    id: "outside-observed-change",
    chainId: 1,
    safeAddress: outside.executions[0].safeAddress,
    blockNumber: 400,
    transactionIndex: 1,
    logIndex: 4,
    transactionHash: `0x${"c".repeat(64)}`,
    type: "owner-added",
    owner: address("7") as `0x${string}`,
    provenance: outside.executions[0].provenance,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(outside, "synthetic"));
  assert.equal(
    report.configurationChanges[0].observation,
    "no changes observed in supplied scope",
  );
  assert.equal(report.configurationChanges[1].coverageStatus, "unavailable");
  assert.deepEqual(report.configurationChanges[1].eventIds, [
    "outside-observed-change",
  ]);
});

test("same-transaction configuration changes keep execution configuration unresolved without per-call ordering", () => {
  const bundle = copy(),
    execution = bundle.executions[0];
  bundle.configurationEvents.push({
    id: "same-tx-threshold",
    chainId: execution.chainId,
    safeAddress: execution.safeAddress,
    transactionHash: execution.transactionHash,
    blockNumber: execution.blockNumber,
    transactionIndex: execution.transactionIndex!,
    logIndex: 0,
    type: "threshold-changed",
    threshold: 1,
    provenance: execution.provenance,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(report.executions[0].configuredThreshold, null);
  assert.equal(
    report.executions[0].thresholdObservation,
    "configuration-order-ambiguous",
  );
  assert.ok(
    report.executions[0].warnings.some((w) =>
      w.includes("same outer transaction"),
    ),
  );
});

test("intervening contradictory snapshots invalidate the explicitly linked old configuration", () => {
  const bundle = copy(),
    old = bundle.configurations[0];
  bundle.configurations.push({
    ...old,
    id: "new-historical-config",
    kind: "at-block",
    blockNumber: 150,
    owners: [old.owners[4]],
    threshold: 1,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(report.executions[0].configuredThreshold, null);
  assert.equal(
    report.executions[0].thresholdObservation,
    "configuration-link-conflicts-with-snapshot",
  );
  assert.deepEqual(report.executions[0].observedConfiguredSigners, []);
});

test("duplicate configuration snapshot identities reject even under distinct evidence IDs", () => {
  const bundle = copy();
  bundle.configurations.push({
    ...bundle.configurations[0],
    id: "duplicate-snapshot",
    threshold: 1,
  });
  assert.throws(
    () => parseSafeEvidence(bundle, "synthetic"),
    /duplicate configuration snapshot/i,
  );
});

test("a boundary-block event without transaction order is ambiguous rather than definitely intervening", () => {
  const bundle = copy(),
    execution = bundle.executions[0];
  delete execution.transactionIndex;
  bundle.configurationEvents.push({
    id: "boundary-change",
    chainId: 1,
    safeAddress: execution.safeAddress,
    transactionHash: `0x${"d".repeat(64)}`,
    blockNumber: execution.blockNumber,
    transactionIndex: 5,
    logIndex: 3,
    type: "threshold-changed",
    threshold: 1,
    provenance: execution.provenance,
  });
  const report = analyzeSafeEvidence(parseSafeEvidence(bundle, "synthetic"));
  assert.equal(report.executions[0].configuredThreshold, null);
  assert.equal(
    report.executions[0].thresholdObservation,
    "configuration-order-ambiguous",
  );
});

test("provenance URLs reject credentials without retaining or echoing them", () => {
  const bundle = copy();
  bundle.configurations[0].provenance.sourceUrl =
    "https://user:secret@example.com/evidence";
  assert.throws(
    () => parseSafeEvidence(bundle, "synthetic"),
    (error) =>
      error instanceof Error &&
      /credentials/i.test(error.message) &&
      !error.message.includes("secret"),
  );
});

test("calldata-only signatures survive parsing and cannot count toward an observed quorum", () => {
  const source = copy();
  source.configurations[0].threshold = 1;
  const first = source.executions[0];
  const candidate = {
    ...source,
    executions: [
      {
        ...first,
        signatures: [
          { ...first.signatures[0], participation: "calldata-only" },
          {
            ...first.signatures[0],
            id: "extra-calldata-signature",
            signer: source.configurations[0].owners[1],
            participation: "calldata-only",
          },
        ],
      },
    ],
  };
  const parsed = parseSafeEvidence(candidate, "synthetic");
  assert.equal(
    parsed.executions[0].signatures[0].participation,
    "calldata-only",
  );
  const report = analyzeSafeEvidence(parsed).executions[0];
  assert.equal(report.uniqueObservedSigners.length, 2);
  assert.deepEqual(report.observedConfiguredSigners, []);
  assert.equal(report.thresholdObservation, "signature-evidence-unavailable");
  assert.ok(report.warnings.some((w) => /participation/i.test(w)));
  const invalid = structuredClone(candidate);
  invalid.executions[0].signatures[0].participation = "assumed-consumed";
  assert.throws(
    () => parseSafeEvidence(invalid, "synthetic"),
    /participation/i,
  );
});
