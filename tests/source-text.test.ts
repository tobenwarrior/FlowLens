import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tokenSymbol } from "../server/history-provider.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRS = [
  ".github",
  "docs",
  "public",
  "scripts",
  "server",
  "src",
  "tests",
];
const TEXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".toml",
  ".yml",
  ".example",
  ".svg",
]);
/** Text files the release ships whose names carry no extension. */
const TEXT_NAMES = new Set(["LICENSE", ".gitignore", ".gitattributes"]);
/** Directional marks, embeddings, overrides and isolates. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Repository text files, walked from disk so a source archive without Git is covered. */
function sourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) files.push(entry.name);
    else if (entry.isDirectory() && SOURCE_DIRS.includes(entry.name))
      for (const path of readdirSync(join(ROOT, entry.name), {
        recursive: true,
        encoding: "utf8",
      }))
        files.push(join(entry.name, path));
  }
  return files.filter(
    (path) => TEXT.has(extname(path)) || TEXT_NAMES.has(basename(path)),
  );
}

test("source text keeps bidirectional control characters escaped", () => {
  const files = sourceFiles();
  for (const shipped of [
    join("server", "history-provider.ts"),
    join(".github", "workflows", "ci.yml"),
    join("public", "favicon.svg"),
    "LICENSE",
  ])
    assert.ok(files.includes(shipped), shipped);
  const offenders: string[] = [];
  for (const path of files)
    readFileSync(join(ROOT, path), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (BIDI.test(line)) offenders.push(`${path}:${index + 1}`);
      });
  // A raw override can make a line display in an order other than the one it runs in,
  // and GitHub flags the file. Write these characters as escapes, such as \u202e.
  assert.deepEqual(offenders, []);
});

test("untrusted token symbols lose every directional control, marks included", () => {
  const marked = ["\u202e", "\u2066", "\u200e", "\u200f", "\u061c"].join("USD");
  assert.equal(tokenSymbol(marked), "USDUSDUSDUSD");
});
