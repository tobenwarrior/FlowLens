import assert from "node:assert/strict";
import {
  createDemoInvestigation,
  DEMO_ROOT,
  demoProvider,
} from "../src/domain/demo.ts";
import { inspectDerive } from "../server/derive-provider.ts";

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

let deriveRequests = 0;
const deriveResult = await inspectDerive(
  { kind: "account", wallet: DEMO_ROOT },
  {
    fetch: async (url, init) => {
      deriveRequests++;
      assert.equal(url, "https://api.derive.xyz/v3/public/get_subaccounts");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { wallet: DEMO_ROOT });
      return new globalThis.Response(
        JSON.stringify({
          result: { wallet: DEMO_ROOT, subaccount_ids: [123] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  },
);
assert.equal(deriveRequests, 1);
assert.equal(deriveResult.kind, "account");
assert.deepEqual(deriveResult.data.subaccount_ids, [123]);
assert.equal(deriveResult.coverage.status, "complete");

console.log("Public synthetic smoke checks passed (demo and injected Derive).");
