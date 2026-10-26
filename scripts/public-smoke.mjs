import assert from "node:assert/strict";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";

const investigation = await createDemoInvestigation();
assert.equal(investigation.mode, "demo");
assert.equal(investigation.root, DEMO_ROOT);
assert.ok(investigation.transfers.length > 0);
assert.ok(investigation.transfers.every((transfer) => transfer.synthetic));
assert.ok(
  investigation.nodes.every((node) => node.label?.confidence === "synthetic"),
);

const firstPage = await demoProvider.fetchPage({
  address: DEMO_ROOT,
  chainId: 1,
  pageSize: 5,
});
assert.equal(firstPage.transfers.length, 5);
assert.ok(firstPage.cursor);
assert.ok(firstPage.transfers.every((transfer) => transfer.synthetic));

const secondPage = await demoProvider.fetchPage({
  address: DEMO_ROOT,
  chainId: 1,
  pageSize: 5,
  cursor: firstPage.cursor,
});
assert.equal(secondPage.transfers.length, 5);
assert.notEqual(secondPage.cursor, firstPage.cursor);
assert.ok(
  secondPage.transfers.every(
    (transfer) =>
      !firstPage.transfers.some((first) => first.id === transfer.id),
  ),
);
console.log(
  "Public synthetic smoke checks passed (offline demo and pagination).",
);
