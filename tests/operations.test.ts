import test from "node:test";
import assert from "node:assert/strict";
import { startInvestigation } from "../server/operations.ts";
import { demoProvider, DEMO_ROOT } from "../src/domain/demo.ts";
import { parseInvestigation } from "../src/domain/engine.ts";

const providers = {
  demo: demoProvider,
  live: demoProvider,
  liveEnabled: false,
};
test("explicit evidence-only cases need no index key and never imply wallet coverage", async () => {
  const value = await startInvestigation(
    DEMO_ROOT,
    "live",
    "Known evidence",
    providers,
    "evidence-only",
  );
  assert.deepEqual(value.transfers, []);
  assert.equal(value.nodes[0].address, DEMO_ROOT);
  assert.equal(value.coverage[0].status, "unsupported");
  assert.equal(value.coverage[0].provider, "evidence-only");
  assert.deepEqual(value.coverage[0].streams, []);
  assert.match(value.coverage[0].warnings.join(" "), /not enumerated/);
  assert.deepEqual(parseInvestigation(value), value);
});
test("indexed mode still requires a permitted key and evidence-only is explicit", async () => {
  await assert.rejects(
    startInvestigation(DEMO_ROOT, "live", undefined, providers),
    (e: unknown) =>
      !!e && typeof e === "object" && "code" in e && e.code === "KEY_REQUIRED",
  );
  await assert.rejects(
    startInvestigation(
      DEMO_ROOT,
      "demo",
      undefined,
      providers,
      "evidence-only",
    ),
    /only available in live/,
  );
  await assert.rejects(
    startInvestigation(DEMO_ROOT, "live", undefined, providers, "unknown"),
    /History mode/,
  );
});
