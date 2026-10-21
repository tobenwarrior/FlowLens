import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Reviewed release metadata, deliberately independent of shell environment and file mtimes.
const timestamp = "2026-10-21T00:00:00.000Z";
const epoch = Date.parse(timestamp) / 1000;
const screenshots = new Set([
  "docs/images/demo-desktop.png",
  "docs/images/demo-mobile.png",
]);
const required = new Set([
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE-DECISION.md",
]);
// Adding a distributable file is an explicit review decision. Do not replace this with a glob.
const allowlist = [
  ".env.example",
  "AGENTS.md",
  ".gitattributes",
  ".gitignore",
  ".repo-audit.toml",
  ".github/workflows/ci.yml",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE-DECISION.md",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "eslint.config.js",
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "public/favicon.svg",
  "scripts/release.mjs",
  ...screenshots,
  "docs/architecture.md",
  "docs/bridge-internal-evidence.md",
  "docs/mcp.md",
  "docs/providers.md",
  "docs/research-notes.md",
  "docs/safe-evidence.md",
  "docs/release-checklist.md",
  "docs/license-options.md",
  "docs/rpc-provider.md",
  "docs/live-verification.md",
  "docs/safe-provider.md",
  "docs/trace-provider.md",
  "docs/bridge-provider.md",
  "docs/acquisition.md",
  "server/agent.ts",
  "server/api.ts",
  "server/cli.ts",
  "server/etherscan.ts",
  "server/index.ts",
  "server/mcp.ts",
  "server/operations.ts",
  "server/schema.ts",
  "server/store.ts",
  "server/rpc.ts",
  "server/bridge-provider.ts",
  "server/acquire.ts",
  "server/safe-provider.ts",
  "server/trace-provider.ts",
  "src/App.tsx",
  "src/main.tsx",
  "src/protocol.css",
  "src/styles.css",
  "src/components/Evidence.tsx",
  "src/components/Graph.tsx",
  "src/components/ProtocolEvidence.tsx",
  "src/components/Sidebar.tsx",
  "src/components/WorkspaceDialogs.tsx",
  "src/domain/bridges.ts",
  "src/domain/demo.ts",
  "src/domain/engine.ts",
  "src/domain/internal.ts",
  "src/domain/protocols.ts",
  "src/domain/safe.ts",
  "src/domain/types.ts",
  "tests/agent.test.ts",
  "tests/bridges.test.ts",
  "tests/browser.mjs",
  "tests/engine.test.ts",
  "tests/internal.test.ts",
  "tests/mcp.test.ts",
  "tests/safe.test.ts",
  "tests/server.test.ts",
  "tests/release.test.ts",
  "tests/rpc.test.ts",
  "tests/bridge-provider.test.ts",
  "tests/acquire.test.ts",
  "tests/safe-provider.test.ts",
  "tests/trace-provider.test.ts",
  "tests/store.test.ts",
  "tests/operations.test.ts",
  "tests/protocols.test.ts",
  "tests/acquisition-workflow.test.ts",
].sort();

function options(args) {
  const result = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    output: undefined,
    check: false,
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") result.check = true;
    else if (
      ["--root", "--output"].includes(args[index]) &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    ) {
      result[args[index].slice(2)] = resolve(args[++index]);
    } else
      throw new Error(
        "unknown argument; use --check, --root PATH or --output PATH",
      );
  }
  result.output ??= join(result.root, ".local/releases");
  return result;
}

async function sourceFile(root, path) {
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && !required.has(path)) return undefined;
      throw new Error(`${path}: missing or unreadable release file`, {
        cause: error,
      });
    }
    if (stat.isSymbolicLink())
      throw new Error(`${path}: symbolic link rejected`);
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error(`${path}: parent is not a directory`);
    if (index === parts.length - 1 && (!stat.isFile() || stat.size > 2_000_000))
      throw new Error(`${path}: expected a regular reviewed file below 2 MB`);
  }
  return readFile(current);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Only explicitly reviewed browser screenshots are distributable binary assets.
// Restrict them to image chunks; text, EXIF, profiles and trailing payloads stay out.
function auditScreenshot(path, data) {
  const reject = () => [
    `${path}:1: PNG screenshot invalid or contains metadata`,
  ];
  if (
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return reject();
  let offset = 8,
    header = false,
    pixels = false,
    ended = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > data.length) return reject();
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const payload = data.subarray(offset + 8, end - 4);
    if (!["IHDR", "IDAT", "IEND"].includes(type)) return reject();
    if (
      crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      return reject();
    if (type === "IHDR") {
      if (header || offset !== 8 || length !== 13) return reject();
      const width = payload.readUInt32BE(0),
        height = payload.readUInt32BE(4);
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 8192 ||
        width * height > 16777216 ||
        payload[8] !== 8 ||
        ![2, 6].includes(payload[9]) ||
        payload[10] ||
        payload[11] ||
        payload[12]
      )
        return reject();
      header = true;
    } else if (type === "IDAT") {
      if (!header || !length || ended) return reject();
      pixels = true;
    } else {
      if (!header || !pixels || length || end !== data.length) return reject();
      ended = true;
    }
    offset = end;
  }
  return ended && offset === data.length ? [] : reject();
}

function audit(path, data) {
  if (screenshots.has(path)) return auditScreenshot(path, data);
  const text = data.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text).equals(data))
    return [`${path}:1: binary or invalid UTF-8 content`];
  const findings = [];
  const rules = [
    [
      "credential token",
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{32,255})\b/,
    ],
    [
      "private key material",
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    ],
    ["personal local path", /\/(?:Users|home)\/[a-zA-Z0-9._-]+\//],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9_.=+/-]{24,}/],
  ];
  const isPlaceholder = (value) =>
    /^(?:(?:test|dummy|example|fake|placeholder)(?:[-_ ](?:key|token|secret|credential|value|\d+))*|your[-_ ](?:existing[-_ ])?(?:key|token)|\$\{[A-Za-z0-9_.]+\})$/i.test(
      value,
    ) ||
    (path.startsWith("tests/") &&
      [
        "do-not-retain",
        "do-not-preserve",
        "do-not-leak",
        "private-key",
        "secret",
        "pass",
        "key",
        "k",
        "user",
        "hide",
      ].includes(value));
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const location = `${path}:${index + 1}`;
    if (
      path === ".env.example" &&
      line.trim() &&
      !line.trim().startsWith("#") &&
      !/^[A-Z][A-Z0-9_]*=\s*$/.test(line)
    )
      findings.push(`${location}: nonempty environment template`);
    for (const [rule, pattern] of rules)
      if (pattern.test(line)) findings.push(`${location}: ${rule}`);
    // Short, explicit test doubles are safe; realistic credentials are rejected even in tests.
    for (const assigned of line.matchAll(
      /["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([A-Za-z0-9_./+=$:{}-]+))/g,
    )) {
      const label = assigned[1].replace(/[-_]/g, "").toLowerCase();
      const sensitive =
        /(?:apikey|accesstoken|clientsecret|password|privatekey|secretaccesskey|authorization)$/.test(
          label,
        ) || label === "secret";
      const value = assigned[2] ?? assigned[3] ?? assigned[4] ?? assigned[5];
      // Unquoted JS expressions are references, while upper-case environment assignments are literal examples.
      const literal =
        assigned[5] === undefined || /^[A-Z][A-Z0-9_]*$/.test(assigned[1]);
      if (sensitive && literal && value.length >= 12 && !isPlaceholder(value))
        findings.push(`${location}: assigned credential`);
    }
    for (const match of line.matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)) {
      let url;
      try {
        url = new URL(match[0]);
      } catch {
        continue;
      }
      if (url.username || url.password) {
        const dummyUserinfo =
          path.startsWith("tests/") &&
          /(?:^|\.)example(?:\.com)?$|\.test$/.test(url.hostname) &&
          isPlaceholder(decodeURIComponent(url.username)) &&
          isPlaceholder(decodeURIComponent(url.password));
        if (!dummyUserinfo)
          findings.push(`${location}: URL userinfo credential`);
      }
      for (const [key, value] of url.searchParams) {
        if (
          /^(?:api[-_]?key|key|access[-_]?token|token|password|client[-_]?secret)$/i.test(
            key,
          ) &&
          value &&
          !isPlaceholder(value)
        )
          findings.push(`${location}: URL query credential`);
      }
      const authenticatedPath =
        (/(?:^|\.)(?:g\.)?alchemy(?:api)?\.(?:com|io)$/.test(url.hostname) &&
          /^\/v2\//.test(url.pathname)) ||
        (/(?:^|\.)infura\.io$/.test(url.hostname) &&
          /^\/v3\//.test(url.pathname));
      if (authenticatedPath) {
        const credential = decodeURIComponent(url.pathname.split("/")[2] ?? "");
        if (credential && !isPlaceholder(credential))
          findings.push(`${location}: provider URL path credential`);
      }
    }
  }
  return findings;
}

const hash = (data) => createHash("sha256").update(data).digest("hex");

function tarEntry(path, data) {
  const header = Buffer.alloc(512);
  const field = (value, start, length) =>
    header.write(value, start, length, "ascii");
  if (Buffer.byteLength(path) > 100)
    throw new Error("release path exceeds portable tar name limit");
  field(path, 0, 100);
  field("0000644\0", 100, 8);
  field("0000000\0", 108, 8);
  field("0000000\0", 116, 8);
  field(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  field(`${epoch.toString(8).padStart(11, "0")}\0`, 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
    8,
  );
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

async function main() {
  const config = options(process.argv.slice(2));
  const files = [];
  const findings = [];
  for (const path of allowlist) {
    const data = await sourceFile(config.root, path);
    if (data === undefined) continue;
    findings.push(...audit(path, data));
    files.push({ path, data });
  }
  if (findings.length)
    throw new Error(
      `release audit failed (values redacted):\n${findings.join("\n")}`,
    );
  const readme = files
    .find((file) => file.path === "README.md")
    .data.toString("utf8");
  for (const path of screenshots)
    if (readme.includes(path) && !files.some((file) => file.path === path))
      throw new Error(`${path}: referenced screenshot missing`);
  let pkg;
  try {
    pkg = JSON.parse(files.find((file) => file.path === "package.json").data);
  } catch {
    throw new Error("package.json: invalid package metadata");
  }
  if (
    pkg.name !== "flowlens" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)
  )
    throw new Error(
      "package.json: expected flowlens and a safe semantic version",
    );
  if (pkg.license || pkg.private !== true)
    throw new Error(
      "package.json: pending license requires private:true and no license selection",
    );
  const base = `flowlens-${pkg.version}-source`;
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        format: "flowlens-source-v1",
        name: pkg.name,
        version: pkg.version,
        timestamp,
        projectLicense: "UNSELECTED",
        archive: `${base}.tar.gz`,
        files: files.map(({ path, data }) => ({
          path,
          bytes: data.length,
          sha256: hash(data),
        })),
      },
      null,
      2,
    )}\n`,
  );
  if (config.check) {
    console.log(
      JSON.stringify({
        audit: "passed",
        files: files.length,
        timestamp,
        projectLicense: "UNSELECTED",
      }),
    );
    return;
  }
  const content = [
    ...files,
    { path: "SOURCE_MANIFEST.json", data: manifest },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archive = gzipSync(
    Buffer.concat([
      ...content.map(({ path, data }) => tarEntry(`${base}/${path}`, data)),
      Buffer.alloc(1024),
    ]),
    { level: 9 },
  );
  archive.fill(0, 4, 8);
  archive[9] = 255;
  await mkdir(config.output, { recursive: true });
  const paths = {
    archive: join(config.output, `${base}.tar.gz`),
    manifest: join(config.output, `${base}.manifest.json`),
    checksums: join(config.output, `${base}.sha256`),
  };
  await writeFile(paths.archive, archive);
  await writeFile(paths.manifest, manifest);
  await writeFile(
    paths.checksums,
    `${hash(archive)}  ${base}.tar.gz\n${hash(manifest)}  ${base}.manifest.json\n`,
  );
  console.log(
    JSON.stringify({
      ...paths,
      files: files.length,
      audit: "passed",
      projectLicense: "UNSELECTED",
    }),
  );
}

main().catch((error) => {
  // Do not echo raw fs/system errors or input snippets, which can contain private values.
  console.error(
    error instanceof Error && !error.code
      ? error.message
      : "release failed: filesystem operation unavailable",
  );
  process.exitCode = 1;
});
