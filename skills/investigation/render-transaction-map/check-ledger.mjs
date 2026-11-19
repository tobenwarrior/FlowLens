import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const displayStates = new Set([
  "shown",
  "aggregated",
  "accounted-but-hidden",
  "provider-only",
  "unverified",
  "excluded",
]);
const onMap = new Set(["shown", "aggregated"]);

function claimEvent(events, id, signature) {
  if (typeof id !== "string" || !id)
    throw new Error("Acquired event has no ID");
  if (events.has(id) && events.get(id) !== signature) {
    throw new Error(`Conflicting evidence for ${id}`);
  }
  events.set(id, signature);
}

async function check(manifestPath) {
  const folder = dirname(resolve(manifestPath));
  const read = async (path) =>
    JSON.parse(await readFile(resolve(folder, path), "utf8"));
  const {
    cases = [],
    hypercore = [],
    display,
    routes,
  } = await read(resolve(manifestPath));
  if (
    !Array.isArray(cases) ||
    !Array.isArray(hypercore) ||
    !(cases.length || hypercore.length)
  ) {
    throw new Error(
      "Manifest must include at least one case or HyperCore bundle",
    );
  }
  const events = new Map();
  for (const path of cases) {
    for (const row of (await read(path)).transfers) {
      claimEvent(
        events,
        row.id,
        JSON.stringify([
          row.chainId,
          row.hash,
          row.kind,
          row.eventIndex,
          row.asset.contract,
          row.asset.decimals,
          row.from,
          row.to,
          row.rawAmount,
          row.status,
        ]),
      );
    }
  }

  for (const path of hypercore) {
    const file = await read(path);
    for (const row of (file.bundle ?? file).entries) {
      if (!row.account || !row.id)
        throw new Error("HyperCore entry is missing account or ID");
      const id = `hypercore:${row.account}:${row.id}`;
      claimEvent(events, id, JSON.stringify([row.hash, row.time, row.delta]));
    }
  }

  const states = new Map();
  for (const { id, state, reason } of await read(display)) {
    if (!events.has(id)) throw new Error(`Display entry has unknown ID ${id}`);
    if (states.has(id)) throw new Error(`Duplicate display state for ${id}`);
    if (!displayStates.has(state))
      throw new Error(`Invalid display state for ${id}: ${state}`);
    if (state === "excluded" && !reason?.trim())
      throw new Error(`Excluded event has no reason: ${id}`);
    states.set(id, state);
  }
  for (const id of events.keys()) {
    if (!states.has(id))
      throw new Error(`Acquired event has no display state: ${id}`);
  }

  const drawn = new Set();
  const routeEntries = Object.entries(await read(routes));
  for (const [route, ids] of routeEntries) {
    if (!Array.isArray(ids) || !ids.length)
      throw new Error(`Route has no member IDs: ${route}`);
    for (const id of ids) {
      if (!onMap.has(states.get(id)))
        throw new Error(`Route ${route} includes a non-displayed ID: ${id}`);
      if (drawn.has(id))
        throw new Error(`Event occurs on multiple routes: ${id}`);
      drawn.add(id);
    }
  }
  for (const [id, state] of states) {
    if (onMap.has(state) && !drawn.has(id))
      throw new Error(`Displayed event has no route: ${id}`);
  }
  console.log(
    JSON.stringify({
      acquired: events.size,
      onMap: drawn.size,
      offMap: events.size - drawn.size,
      routes: routeEntries.length,
    }),
  );
}

try {
  if (process.argv.length !== 3)
    throw new Error("Usage: node check-ledger.mjs <manifest.json>");
  await check(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
