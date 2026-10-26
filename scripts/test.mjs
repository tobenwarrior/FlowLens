import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDirectory = join(root, "tests");
const tests =
  process.argv.length > 2
    ? process.argv.slice(2)
    : existsSync(testDirectory)
      ? readdirSync(testDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
          .map((entry) => join("tests", entry.name))
      : [];

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (tests.length > 0) run(["--test", ...tests]);
run(["scripts/public-smoke.mjs"]);
