import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const releaseScript = resolve("scripts/release.mjs");

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "flowlens-release-"));
  try {
    for (const [path, text] of Object.entries({
      "package.json": JSON.stringify({
        name: "flowlens",
        version: "0.1.0",
        private: true,
      }),
      "package-lock.json": JSON.stringify({
        name: "flowlens",
        version: "0.1.0",
        lockfileVersion: 3,
      }),
      "README.md": "# Synthetic release fixture\n",
      "LICENSE-DECISION.md": "No project license selected.\n",
      "src/main.tsx": 'export const demo = "synthetic";\n',
      "server/index.ts": 'export const host = "127.0.0.1";\n',
      "tests/engine.test.ts": 'const key = "dummy-key";\n',
      ".env.example": "ETHERSCAN_API_KEY=\n",
    })) {
      await put(root, path, text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(root: string, path: string, value: string | Uint8Array) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

function release(root: string, output = join(root, ".local/releases")) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [releaseScript, "--root", root, "--output", output],
      { encoding: "utf8" },
    ),
  ) as {
    archive: string;
    manifest: string;
    checksums: string;
  };
}

function entries(archive: Buffer) {
  const tar = gunzipSync(archive);
  const result: {
    name: string;
    mode: string;
    uid: string;
    gid: string;
    mtime: number;
    data: Buffer;
  }[] = [];
  for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, end: number) =>
      header.subarray(start, end).toString().replace(/\0.*$/s, "");
    const size = parseInt(field(124, 136), 8);
    result.push({
      name: field(0, 100),
      mode: field(100, 108),
      uid: field(108, 116),
      gid: field(116, 124),
      mtime: parseInt(field(136, 148), 8),
      data: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

test("source archives have stable bytes, sorted checksums and normalized tar metadata", () =>
  fixture(async (root) => {
    const first = release(root, join(root, ".local/first"));
    await utimes(join(root, "src/main.tsx"), new Date(), new Date());
    const second = release(root, join(root, ".local/second"));
    const bytes = await readFile(first.archive);
    assert.deepEqual(bytes, await readFile(second.archive));
    const files = entries(bytes);
    assert.deepEqual(
      files.map((entry) => entry.name),
      [...files.map((entry) => entry.name)].sort(),
    );
    for (const file of files) {
      assert.equal(file.mode, "0000644");
      assert.equal(file.uid, "0000000");
      assert.equal(file.gid, "0000000");
      assert.equal(file.mtime, 1792540800);
    }
    const manifest = JSON.parse(await readFile(first.manifest, "utf8"));
    assert.equal(manifest.projectLicense, "UNSELECTED");
    assert.deepEqual(
      manifest.files.map((file: { path: string }) => file.path),
      [...manifest.files.map((file: { path: string }) => file.path)].sort(),
    );
    for (const file of manifest.files) {
      assert.equal(
        file.sha256,
        createHash("sha256")
          .update(await readFile(join(root, file.path)))
          .digest("hex"),
      );
    }
    const embedded = files.find((file) =>
      file.name.endsWith("/SOURCE_MANIFEST.json"),
    );
    assert.equal(
      embedded?.data.toString(),
      await readFile(first.manifest, "utf8"),
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.ok(
      (await readFile(first.checksums, "utf8")).startsWith(
        `${digest}  flowlens-0.1.0-source.tar.gz\n`,
      ),
    );
  }));

test("new private files and generated outputs never enter the explicit source allowlist", () =>
  fixture(async (root) => {
    for (const path of [
      ".env",
      ".local/cases/private.json",
      "node_modules/a/index.js",
      "dist/app.js",
      "artifacts/screenshot.png",
      "test-results/case.json",
      ".git/config",
      "src/private-investigation.ts",
      "docs/new-private-research.md",
      "docs/verification.md",
      "docs/superpowers/plans/private.md",
      "public/private-export.json",
    ]) {
      await put(root, path, "must remain private\n");
    }
    const output = release(root);
    const names = entries(await readFile(output.archive)).map(
      (entry) => entry.name,
    );
    assert.ok(names.some((name) => name.endsWith("/src/main.tsx")));
    assert.ok(names.some((name) => name.endsWith("/.env.example")));
    assert.ok(
      names.every(
        (name) =>
          !/private|node_modules|dist\/|artifacts|test-results|\.git\/|verification\.md|superpowers/.test(
            name,
          ),
      ),
    );
  }));

test("credential-shaped values fail closed with redacted path/rule diagnostics", () =>
  fixture(async (root) => {
    const secret = ["ghp", "A".repeat(36)].join("_");
    await put(root, "src/main.tsx", `export const accidental = "${secret}";\n`);
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/main\.tsx:1.*credential token/);
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stdout.includes(secret));
    await assert.rejects(
      readFile(join(root, ".local/releases/flowlens-0.1.0-source.tar.gz")),
    );
  }));

test("template environment files permit blanks and reject configured credentials", () =>
  fixture(async (root) => {
    const secret = ["not", "a", "placeholder", "actual", "credential"].join(
      "-",
    );
    await put(root, ".env.example", `ETHERSCAN_API_KEY=${secret}\n`);
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\.env\.example:1.*nonempty environment template/,
    );
    assert.ok(!result.stderr.includes(secret));
  }));

test("dummy test credentials remain valid but high-entropy assigned secrets are rejected", () =>
  fixture(async (root) => {
    const good = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(good.status, 0, good.stderr);
    const value = ["Q9w8E7r6T5y4", "U3i2O1p0A9s8"].join("");
    await put(root, "tests/engine.test.ts", `const apiKey = "${value}";\n`);
    const bad = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /assigned credential/);
    assert.ok(!bad.stderr.includes(value));
  }));

test("source symlinks cannot pull files or directories from outside the release root", () =>
  fixture(async (root) => {
    await rm(join(root, "src/main.tsx"));
    await symlink(join(root, "README.md"), join(root, "src/main.tsx"));
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/main\.tsx.*symbolic link/);
  }));

test("credential URLs and later assignments on the same line are audited with redacted output", () =>
  fixture(async (root) => {
    const value = ["R9t8Y7u6I5o4", "P3a2S1d0F9g8"].join("");
    for (const text of [
      `const apiKey = "dummy-key"; const password = "${value}";`,
      `export const source = "https://rpc.example?api_key=${value}";`,
      `export const source = "https://user:${value}@rpc.example";`,
    ]) {
      await put(root, "src/main.tsx", text);
      const result = spawnSync(
        process.execPath,
        [releaseScript, "--root", root, "--check"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /src\/main\.tsx:1.*credential/);
      assert.ok(!result.stderr.includes(value));
    }
  }));

test("environment key labels and authenticated provider paths fail closed", () =>
  fixture(async (root) => {
    const value = ["M9n8B7v6C5x4", "Z3l2K1j0H9g8"].join("");
    for (const text of [
      `ETHERSCAN_API_KEY=${value}`,
      `AWS_SECRET_ACCESS_KEY="${value}"`,
      `https://eth-mainnet.g.alchemy.com/v2/${value}`,
      `https://mainnet.infura.io/v3/${value}`,
    ]) {
      await put(root, "README.md", text);
      const result = spawnSync(
        process.execPath,
        [releaseScript, "--root", root, "--check"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /README\.md:1.*credential/);
      assert.ok(!result.stderr.includes(value));
    }
  }));

test("check mode is read-only and unsupported arguments fail clearly", () =>
  fixture(async (root) => {
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).timestamp,
      "2026-10-21T00:00:00.000Z",
    );
    await assert.rejects(
      readFile(join(root, ".local/releases/flowlens-0.1.0-source.tar.gz")),
    );
    const invalid = spawnSync(process.execPath, [releaseScript, "--publish"], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /unknown argument/);
  }));

// A generated white 1x1 RGB PNG, with only IHDR/IDAT/IEND chunks.
const screenshotPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  "base64",
);

test("reviewed synthetic screenshots are included as exact PNG bytes with manifest checksums", () =>
  fixture(async (root) => {
    await put(
      root,
      "README.md",
      "![Synthetic desktop](docs/images/demo-desktop.png)\n![Synthetic phone](docs/images/demo-mobile.png)\n",
    );
    for (const path of [
      "docs/images/demo-desktop.png",
      "docs/images/demo-mobile.png",
    ])
      await put(root, path, screenshotPng);
    await put(root, "docs/images/unreviewed.png", screenshotPng);
    const result = release(root);
    const files = entries(await readFile(result.archive));
    const included = files.filter((f) => f.name.endsWith(".png"));
    assert.equal(included.length, 2);
    for (const file of included) assert.deepEqual(file.data, screenshotPng);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    assert.equal(
      manifest.files.filter((f: { path: string }) => f.path.endsWith(".png"))
        .length,
      2,
    );
  }));

test("screenshot metadata, appended bytes and checksum corruption are refused", () =>
  fixture(async (root) => {
    const metadata = Buffer.concat([
      screenshotPng.subarray(0, -12),
      Buffer.from([0, 0, 0, 0, 116, 69, 88, 116, 0, 0, 0, 0]),
      screenshotPng.subarray(-12),
    ]);
    const corrupt = Buffer.from(screenshotPng);
    corrupt[32] ^= 1;
    for (const png of [
      metadata,
      Buffer.concat([screenshotPng, Buffer.from("private notes")]),
      corrupt,
    ]) {
      await put(root, "docs/images/demo-desktop.png", png);
      const result = spawnSync(
        process.execPath,
        [releaseScript, "--root", root, "--check"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /docs\/images\/demo-desktop\.png.*PNG/);
      assert.ok(!result.stderr.includes("private notes"));
    }
  }));

test("a public screenshot referenced by README must be present in the source export", () =>
  fixture(async (root) => {
    await put(
      root,
      "README.md",
      "![Synthetic demo](docs/images/demo-desktop.png)\n",
    );
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /demo-desktop\.png.*referenced screenshot missing/,
    );
  }));

test("HTML screenshot references must also exist in the exported source", () =>
  fixture(async (root) => {
    await put(
      root,
      "README.md",
      '<img src="docs/images/demo-mobile.png" alt="Synthetic phone">\n',
    );
    const result = spawnSync(
      process.execPath,
      [releaseScript, "--root", root, "--check"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /demo-mobile\.png.*referenced screenshot missing/,
    );
  }));
