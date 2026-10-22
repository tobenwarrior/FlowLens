import { chromium, expect } from "@playwright/test";
import { createDemoInvestigation } from "../src/domain/demo.ts";
import { writeFile, mkdir } from "node:fs/promises";

const base = process.env.FLOWLENS_URL || "http://127.0.0.1:4318";
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await expect(page.getByTestId("funding-graph")).toBeVisible();
  await expect(
    page.getByText("31,300", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  await page.getByLabel("Filter network").selectOption("8453");
  await expect(page.locator(".scope-note strong")).toHaveText("USDC · Base");
  await expect(page.locator(".record-count")).toHaveText("8 transfers");
  await page.getByLabel("Filter direction").selectOption("in");
  await expect(page.locator(".record-count")).toHaveText("3 transfers");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  results.push("Desktop chain/direction filters and scoped gross totals");
  await page.getByRole("button", { name: "Wallet flows", exact: true }).click();
  const walletPanel = page.getByLabel("Selected wallet flows");
  await expect(walletPanel).toContainText("8 / 8 enabled for graph");
  const northstarSelection = page.getByLabel(
    "Show counterparty 1:0x2222222222222222222222222222222222222222",
    { exact: true },
  );
  await northstarSelection.uncheck();
  await expect(walletPanel).toContainText("6 / 8 enabled for graph");
  await expect(page.locator(".flow-summary")).toContainText("31,300");
  await page
    .locator(".counterparty-inspect")
    .filter({ hasText: "Northstar Exchange" })
    .click();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(walletPanel).toContainText("2 / 2 enabled for graph");
  await expect(
    page
      .locator(".wallet-card.counterparty")
      .filter({ hasText: "Northstar Exchange" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Wallet flows", exact: true }).click();
  await page.getByRole("button", { name: "Select none", exact: true }).click();
  await expect(walletPanel).toContainText("0 / 8 enabled for graph");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("button", { name: "Transfers 8", exact: true }).click();
  await page
    .getByLabel(/^Show transfer /)
    .first()
    .uncheck();
  await expect(walletPanel).toContainText("7 / 8 enabled for graph");
  await page.reload();
  await page.getByRole("button", { name: "Wallet flows", exact: true }).click();
  await page.getByRole("button", { name: "Transfers 8", exact: true }).click();
  await expect(
    page.locator(".wallet-transfer-row input:not(:checked)"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(walletPanel).toContainText("8 / 8 enabled for graph");
  await page
    .getByRole("button", { name: "Edit entity label", exact: true })
    .click();
  await page
    .getByLabel("Entity label", { exact: true })
    .fill("Synthetic analyst hypothesis");
  await page.getByLabel("Label claim type").selectOption("hypothesis");
  await page.getByLabel("Label confidence").selectOption("unverified");
  await page
    .getByLabel("Label source", { exact: true })
    .fill("Synthetic QA analyst");
  await page
    .getByLabel("Label source URL")
    .fill("https://example.invalid/synthetic-evidence");
  await page
    .getByLabel("Label evidence note")
    .fill("Synthetic UI replay only; no ownership assertion.");
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "Synthetic QA analyst",
  );
  await page.reload();
  await page.getByRole("button", { name: "Wallet flows", exact: true }).click();
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "Synthetic analyst hypothesis",
  );
  await expect(
    page.getByRole("link", { name: "View label source" }),
  ).toHaveAttribute("href", "https://example.invalid/synthetic-evidence");
  await page
    .getByRole("button", { name: "Edit entity label", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove label", exact: true }).click();
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "Ownership is unknown",
  );
  await page.getByLabel("Close evidence").click();
  results.push(
    "Wallet counterparty/transfer selections, hidden-wallet recovery, unchanged gross totals, refresh persistence, scoped label provenance and removal",
  );

  await page.getByRole("button", { name: "Wallet flows", exact: true }).click();
  await page.getByRole("button", { name: "All time", exact: true }).click();
  await page.getByLabel("To date").fill("2026-10-10");
  await page.getByLabel("From date").fill("2026-10-19");
  await expect(page.getByRole("alert")).toContainText(
    "From date must be on or before",
  );
  await expect(page.getByTestId("funding-graph")).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByLabel("Selected wallet flows")).toBeVisible();
  await page.getByLabel("Close evidence").click();
  results.push(
    "Reversed dates with open wallet inspector stay recoverable without a rendering crash",
  );
  await page.getByRole("button", { name: /^FOCUS WALLET/ }).click();
  await page.getByLabel("Expansion network").selectOption("8453");
  await page
    .getByRole("button", { name: "Load next page", exact: true })
    .click();
  await expect(page.locator(".rail-case p")).toContainText(
    "22 evidence records",
  );
  await page.getByLabel("Close evidence").click();
  const cedar = page.getByRole("button", { name: /Cedar wallet.*Ethereum/ });
  await cedar.click();
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "LABEL PROVENANCE",
  );
  await page.getByLabel("Pin wallet").click();
  await expect(page.getByLabel("Pin wallet")).toHaveClass(/active/);
  await page
    .getByRole("button", { name: "Expand wallet", exact: true })
    .click();
  await expect(page.getByLabel("Evidence drawer")).toContainText("page loaded");
  await page.getByLabel("Hide wallet").click();
  await expect(
    page.getByRole("button", { name: "Restore 1 hidden" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore 1 hidden" }).click();
  results.push(
    "Root other-chain cursor resume, counterparty expansion, pin/hide/restore",
  );
  await page.getByLabel("List view").click();
  await page.locator(".transfers-table tbody tr").first().click();
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "EXACT RAW AMOUNT",
  );
  await expect(page.getByLabel("Evidence drawer")).toContainText(
    "Synthetic evidence has no explorer record",
  );
  await expect(page.getByLabel("Evidence drawer").locator("a")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/evidence.png", fullPage: true });
  await page.getByLabel("Close evidence").click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await dl;
  await download.saveAs("artifacts/demo-export.json");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("funding-graph")).toBeVisible();
  await page.getByRole("button", { name: /Investigations/ }).click();
  await page
    .getByLabel("Investigation notes")
    .fill("Synthetic QA: shared funders do not establish ownership.");
  await page.getByRole("button", { name: "Save current case" }).click();
  await page.getByLabel("Close dialog").click();
  await page.reload();
  await page.getByRole("button", { name: /Investigations/ }).click();
  await expect(page.getByLabel("Investigation notes")).toHaveValue(
    "Synthetic QA: shared funders do not establish ownership.",
  );
  // Browser saves and the shared agent case store are listed as separate groups, so a
  // case created by an MCP agent or the local API is reachable from here.
  const casesDialog = page.getByRole("dialog");
  await expect(casesDialog).toContainText("On this browser");
  await expect(casesDialog).toContainText("Agent workspace");
  await expect(casesDialog).toContainText("shared with MCP and the API");
  await page.getByLabel("Close dialog").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByLabel("Wallet address")).toBeFocused();
  await page.getByLabel("Wallet address").fill("invalid");
  await page.getByRole("button", { name: "Trace wallet" }).click();
  await expect(page.getByRole("alert")).toContainText("valid EVM address");
  results.push(
    "Evidence precision/provenance, synthetic explorer suppression, JSON export, saved notes/reload, keyboard shortcut, invalid-address error",
  );
  await page
    .getByLabel("Import investigation JSON")
    .setInputFiles("artifacts/demo-export.json");
  await expect(page.locator(".rail-case p")).toContainText(
    "26 evidence records",
  );
  await page.getByLabel("Import investigation JSON").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":999}'),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Unsupported investigation version",
  );
  await expect(page.getByTestId("funding-graph")).toBeVisible();
  results.push(
    "JSON export/import roundtrip preserves evidence and cursors; invalid snapshots leave the current case intact",
  );
  await page
    .getByRole("button", { name: "Protocol evidence", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Protocol evidence replay" }),
  ).toContainText("No live Safe, bridge or internal-trace provider");
  await page.getByRole("button", { name: "Load synthetic replay" }).click();
  await expect(
    page.getByRole("dialog", { name: "Protocol evidence replay" }),
  ).toContainText("Indexed graph totals remain unchanged");
  await expect(
    page.getByRole("dialog", { name: "Protocol evidence replay" }),
  ).toContainText("Signatures have not been independently verified");
  await page.screenshot({
    path: "artifacts/protocol-evidence.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Keep with case", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Kept with case", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close protocol evidence" }).click();
  await expect(page.locator(".rail-case p")).toContainText(
    "26 evidence records",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Protocol evidence", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Protocol evidence replay" }),
  ).toContainText("Safe execution evidence");
  await page.getByRole("button", { name: "Close protocol evidence" }).click();
  results.push(
    "Protocol replay UI preserves separate Safe/bridge/internal claims, persists with case, and never changes indexed totals",
  );
  await context.close();
  for (const viewport of [
    { width: 834, height: 1112 },
    { width: 390, height: 844 },
  ]) {
    const ctx = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await expect(p.getByTestId("funding-graph")).toBeVisible();
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await expect(p.locator(".summary-scope-mobile")).toContainText(
      "USDC · Ethereum",
    );
    await p.screenshot({
      path: `artifacts/${viewport.width === 390 ? "mobile" : "tablet"}.png`,
      fullPage: true,
    });
    await p.getByLabel("List view").click();
    await p.locator(".transfers-table tbody tr").first().click();
    await expect(p.getByLabel("Evidence drawer")).toContainText(
      "UTC TIMESTAMP",
    );
    await p.screenshot({
      path: `artifacts/${viewport.width === 390 ? "mobile" : "tablet"}-evidence.png`,
      fullPage: true,
    });
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await p.getByLabel("Close evidence").click();
    await p.getByRole("button", { name: "View coverage" }).click();
    await expect(p.getByRole("dialog")).toContainText(
      "Arkham labels · disabled",
    );
    const close = p.getByLabel("Close dialog");
    await expect(close).toBeFocused();
    await p.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    await p.keyboard.press("Escape");
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await p
      .getByRole("button", { name: "Protocol evidence", exact: true })
      .click();
    await p.getByRole("button", { name: "Load synthetic replay" }).click();
    await expect(
      p.getByRole("dialog", { name: "Protocol evidence replay" }),
    ).toContainText("Safe execution evidence");
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await p.screenshot({
      path: `artifacts/${viewport.width === 390 ? "mobile" : "tablet"}-protocol-evidence.png`,
      fullPage: true,
    });
    await p.getByRole("button", { name: "Close protocol evidence" }).click();
    results.push(
      `${viewport.width}px layout: no page overflow, visible metric chain scope, evidence drawer, modal keyboard trap`,
    );
    await ctx.close();
  }
  const liveCtx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const live = await liveCtx.newPage();
  live.on("pageerror", (e) => errors.push(e.message));
  let fixture = await createDemoInvestigation();
  fixture = {
    ...fixture,
    mode: "live",
    nodes: fixture.nodes.map(({ label, ...node }) => node),
    transfers: fixture.transfers.map(({ synthetic, ...t }) => t),
  };
  await live.route("**/api/status", (route) =>
    route.fulfill({ json: { liveAvailable: true } }),
  );
  await live.route("**/api/investigations", (route) =>
    route.fulfill({
      json:
        route.request().method() === "GET"
          ? [
              {
                id: fixture.id,
                title: fixture.title,
                root: fixture.root,
                mode: fixture.mode,
                updatedAt: fixture.updatedAt,
                transferCount: fixture.transfers.length,
              },
            ]
          : fixture,
    }),
  );
  let expansionBody;
  await live.route(`**/api/investigations/${fixture.id}/expand`, (route) => {
    expansionBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...fixture,
        notes: "",
        pinned: [],
        hidden: [],
        updatedAt: new Date().toISOString(),
      },
    });
  });
  await live.goto(base);
  await expect(live.getByTestId("funding-graph")).toBeVisible();
  await live.getByLabel("Data mode").selectOption("live");
  await live.getByRole("button", { name: "Trace wallet" }).click();
  await expect(live.locator(".case-badge").first()).toHaveText("LOCAL");
  await live.getByRole("button", { name: /Investigations/ }).click();
  await live
    .getByLabel("Investigation notes")
    .fill("Retain unsaved local notes");
  await live.getByLabel("Close dialog").click();
  await live.getByRole("button", { name: /^FOCUS WALLET/ }).click();
  await live.getByLabel("Expansion network").selectOption("42161");
  await live
    .getByRole("button", { name: "Expand wallet", exact: true })
    .click();
  await expect.poll(() => expansionBody?.pageSize).toBe(10);
  expect(expansionBody.chainId).toBe(42161);
  await live.getByLabel("Close evidence").click();
  await live.getByRole("button", { name: /Investigations/ }).click();
  await expect(live.getByLabel("Investigation notes")).toHaveValue(
    "Retain unsaved local notes",
  );
  await live.getByLabel("Close dialog").click();
  let revision = fixture.updatedAt;
  let refusal = "conflict";
  let savedBody;
  await live.route(`**/api/investigations/${fixture.id}`, (route) => {
    if (route.request().method() === "GET") {
      revision = new Date(Date.now() + 1000).toISOString();
      return route.fulfill({ json: { ...fixture, updatedAt: revision } });
    }
    savedBody = route.request().postDataJSON();
    if (refusal === "conflict")
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "CASE_CONFLICT",
            message: "Investigation changed. Refresh the latest case.",
          },
        },
      });
    if (refusal === "invalid")
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: "INVALID_ARGUMENT",
            message: "Investigation failed validation.",
          },
        },
      });
    return route.fulfill({
      json: {
        ...savedBody,
        updatedAt: new Date(Date.now() + 2000).toISOString(),
      },
    });
  });
  const saveCase = live.getByRole("button", { name: "Save case", exact: true });
  const reloadAndSave = live.getByRole("button", {
    name: "Reload latest & save",
    exact: true,
  });
  await saveCase.click();
  await expect(live.getByRole("alert")).toContainText("Investigation changed");
  // A refused save offers to take the newer case and carry local notes and pins onto
  // it, while reloading without saving stays available as the conservative answer.
  await expect(reloadAndSave).toBeVisible();
  // The offer belongs to that refusal: once dismissed, a later refusal does not bring it
  // back, even an import of the same case refused with the same conflict message.
  await live.getByRole("button", { name: "Dismiss error" }).click();
  await live.getByLabel("Import investigation JSON").setInputFiles({
    name: "stale-case.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await expect(live.getByRole("alert")).toContainText("Investigation changed");
  await expect(reloadAndSave).toHaveCount(0);
  await live.getByRole("button", { name: "Dismiss error" }).click();
  refusal = "invalid";
  await saveCase.click();
  await expect(live.getByRole("alert")).toContainText("failed validation");
  await expect(reloadAndSave).toHaveCount(0);
  refusal = "conflict";
  await saveCase.click();
  await expect(live.getByRole("alert")).toContainText("Investigation changed");
  await expect(reloadAndSave).toBeVisible();
  await live.getByRole("button", { name: "Refresh case", exact: true }).click();
  await expect(live.getByRole("alert")).toHaveCount(0);
  // A save that goes through retires an earlier refusal and its offer.
  await saveCase.click();
  await expect(reloadAndSave).toBeVisible();
  refusal = null;
  await saveCase.click();
  await expect(
    live.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  await expect(live.getByRole("alert")).toHaveCount(0);
  expect(savedBody.updatedAt).toBe(revision);
  expect(savedBody.notes).toBe("Retain unsaved local notes");
  results.push(
    "Mocked live UI contract: 10-row cursors, Arbitrum expansion, unsaved notes, stale-save recovery offered only for its own refusal, and revision-safe saves; no live provider requests",
  );
  await liveCtx.close();
  expect(errors).toEqual([]);
  await writeFile(
    "artifacts/browser-results.json",
    JSON.stringify(
      {
        base,
        passed: results.length,
        results,
        pageErrors: errors,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { passed: results.length, results, pageErrors: errors },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
