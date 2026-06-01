/**
 * Frontend Smoke Test — traverses all pages + instance sub-tabs.
 *
 * Usage:
 *   npx playwright test                 # headless, full traversal
 *   npx playwright test --headed        # visible browser
 *   npx playwright test -g "spot:"      # spot checks only
 *
 * Requires: cd frontend && npm run dev
 * Requires: cd apps/db-ops-api && npx tsx server.ts
 */
import { test, expect, Page } from "@playwright/test";

// All pages in the app
const ALL_PAGES = ["dashboard", "instances-db", "alerts", "reports", "metric-registry", "events", "chat", "overview", "sessions", "usage", "cron", "agents", "skills", "config", "appearance", "system", "users"];

const INSTANCE_SUB_TABS: Record<string, string> = {
  overview: "概览", metrics: "实时监控", topsql: "慢查询", trend: "趋势",
  sessions: "会话", capacity: "容量", schema: "表结构", indexes: "索引",
  sqlaudit: "SQL 审核", logs: "日志",
};

// Collectors
const pageErrors: string[] = [];
const netErrors: string[] = [];
let cur = "";

function watch(page: Page) {
  page.on("pageerror", (e) => pageErrors.push(`[${cur}] ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("vite") && !r.url().includes("hot-update") && !r.url().includes("__slide")) {
      netErrors.push(`[${cur}] ${r.request().method()} ${r.url()} → ${r.status()}`);
    }
  });
}

// ── Full page traversal (each page via goto, check for errors) ──

test.describe("Page traversal", () => {
  for (const pg of ALL_PAGES) {
    test(`page: ${pg}`, async ({ page }) => {
      watch(page);
      cur = pg;

      await page.goto(`/${pg}`);
      await page.waitForTimeout(2000);

      await expect(page.locator("body")).not.toBeEmpty();

      // Check for visible error banners
      const errText = page.locator('[class*="error"], [class*="Error"]').filter({ hasText: /.+/ });
      if ((await errText.count()) > 0) {
        const t = await errText.first().innerText({ timeout: 1000 }).catch(() => "unreadable");
        console.log(`  ⚠️  ${pg} — error visible: ${t.slice(0, 80)}`);
      } else {
        console.log(`  ✅ ${pg}`);
      }
    });
  }
});

// ── Instance detail sub-tab traversal ──

test.describe("Instance sub-tabs", () => {
  test("traverse all sub-tabs", async ({ page }) => {
    watch(page);

    // Go to instances list
    cur = "instances-db";
    await page.goto("/instances-db");
    await page.waitForTimeout(2000);

    // Handle login gate if present
    const loginGate = page.locator(".login-gate__connect, button:has-text('Connect'), button:has-text('连接')").first();
    if (await loginGate.count() > 0) {
      console.log("  Login gate detected — authenticating...");
      const u = page.locator('input[type="text"], input[name="username"]').first();
      const p = page.locator('input[type="password"]').first();
      await u.fill("admin");
      await p.fill("Tpam1234");
      await page.locator('button[type="submit"], .login-gate__connect, button:has-text("Connect"), button:has-text("连接")').first().click();
      await page.waitForTimeout(3000);
    }

    // Try clicking the first clickable row to navigate to detail
    const row = page.locator('tr[data-instance-id], .instance-row, [class*="instance-row"], tr:has(td)').first();
    if ((await row.count()) > 0) {
      await row.click();
      await page.waitForTimeout(2000);
    }

    // If SPA navigation didn't happen, use direct URL
    if (!page.url().includes("instance-detail")) {
      await page.goto("/instance-detail?id=1");
      await page.waitForTimeout(2000);
    }

    for (const [sub, label] of Object.entries(INSTANCE_SUB_TABS)) {
      cur = `instance-detail/${sub}`;

      // Click the sub-tab button
      const tabBtn = page.locator("button.tab").filter({ hasText: label }).first();
      if ((await tabBtn.count()) === 0) {
        console.log(`  ⚠️  ${sub} — button not found`);
        continue;
      }

      await tabBtn.click();
      await page.waitForTimeout(500);

      // Look for visible error elements
      const errEl = page.locator('[class*="error"], [class*="Error"]').filter({ hasText: /.+/ });
      if ((await errEl.count()) > 0) {
        const t = await errEl.first().innerText({ timeout: 1000 }).catch(() => "");
        console.log(`  ⚠️  ${sub} — ${t.slice(0, 60)}`);
      } else {
        console.log(`  ✅ ${sub}`);
      }

      // Check for blank tab content
      const main = page.locator("main, .content, [class*='content']").first();
      const text = await main.innerText().catch(() => "");
      if (text.length < 10) {
        console.log(`       (blank or near-blank content)`);
      }
    }
  });
});

// ── API connectivity check ──

test.describe("API health", () => {
  test("backend is reachable", async ({ page }) => {
    cur = "api-health";
    const res = await page.request.get("http://localhost:3000/api/health");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    console.log("  ✅ Backend API healthy");
  });
});

// ── Summary ──

test.afterAll(() => {
  console.log(`\n${"=".repeat(50)}`);
  console.log("  FRONTEND SMOKE REPORT");
  console.log("=".repeat(50));
  console.log(`  Pages checked:    ${ALL_PAGES.length}`);
  console.log(`  Console errors:   ${pageErrors.length}`);
  console.log(`  Network errors:   ${netErrors.length}`);
  if (pageErrors.length) {
    console.log("\n  --- CONSOLE ERRORS ---");
    pageErrors.forEach((e) => console.log(`  ${e}`));
  }
  if (netErrors.length) {
    console.log("\n  --- NETWORK ERRORS ---");
    netErrors.forEach((e) => console.log(`  ${e}`));
  }
  console.log("");
});
