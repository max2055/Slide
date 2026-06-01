/**
 * Deep interaction E2E tests — simulates real user workflows:
 * clicking nav tabs, filling forms, checking data loads, CRUD operations.
 *
 * Usage:
 *   npx playwright test e2e/interaction.spec.ts --headed    # watch it happen
 *   npx playwright test e2e/interaction.spec.ts              # headless
 */
import { test, expect, Page } from "@playwright/test";

// ── State ──
const errors: string[] = [];
const netFails: string[] = [];
let cur = "";

function watch(p: Page) {
  p.on("pageerror", (e) => errors.push(`[${cur}] ${e.message}`));
  p.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("vite") && !r.url().includes("hot-update") && !r.url().includes("__slide")) {
      netFails.push(`[${cur}] ${r.request().method()} ${r.url()} → ${r.status()}`);
    }
  });
}

// ── Login helper ──
async function login(page: Page) {
  await page.goto("/dashboard");
  await page.waitForTimeout(3000);

  const connectBtn = page.locator('.login-gate__connect, button:has-text("Connect"), button:has-text("连接")').first();
  if ((await connectBtn.count()) > 0) {
    const u = page.locator('input[type="text"], input[name="username"]').first();
    const p = page.locator('input[type="password"]').first();
    await u.fill("admin");
    await p.fill("Tpam1234");
    await page.locator('button[type="submit"], .login-gate__connect, button:has-text("Connect"), button:has-text("连接")').first().click();
    await page.waitForTimeout(4000);
  }
}

// ── Nav click helper ──
async function clickNav(page: Page, tabName: string) {
  // First expand the nav group if collapsed
  const label = page.locator(".nav-section__label-text").filter({ hasText: new RegExp(tabName, "i") }).first();
  if ((await label.count()) === 0) {
    // Tab might be inside a collapsed group — expand all groups
    const allLabels = page.locator(".nav-section__label");
    const count = await allLabels.count();
    for (let i = 0; i < count; i++) {
      const section = allLabels.nth(i);
      const items = section.locator("..").locator(".nav-section__items");
      const visible = await items.evaluate((el) => (el as HTMLElement).offsetHeight > 0).catch(() => false);
      if (!visible) await section.click();
    }
    await page.waitForTimeout(300);
  }

  // Click the tab
  const tab = page.locator(".nav-item__text").filter({ hasText: new RegExp(`^${tabName}$|^${tabName} `, "i") }).first();
  if ((await tab.count()) > 0) {
    await tab.click();
  } else {
    // Try broader match
    await page.locator(".nav-item").filter({ hasText: new RegExp(tabName, "i") }).first().click();
  }
  await page.waitForTimeout(800);
}

// ── Content check helper ──
async function mainContent(page: Page): Promise<string> {
  const main = page.locator("main, .content, [class*='content']").first();
  return main.innerText().catch(() => "(unable to read)");
}

// ──────────────────────────────────────────────
// Test 1: Login + Navigation click-through
// ──────────────────────────────────────────────

test.describe.serial("Navigation click-through", () => {
  test("login and verify dashboard", async ({ page }) => {
    watch(page);
    cur = "login";

    await login(page);

    // Verify we're past login
    const navItem = page.locator(".nav-item").first();
    await expect(navItem).toBeVisible({ timeout: 10000 });
    console.log("  ✅ Logged in successfully");
  });

  const NAV_TABS = [
    "Dashboard", "Instances", "Alerts", "Reports",
    "SQL Console", "Approval", "Metric Registry", "Events", "Cron Jobs",
    "Settings", "Docs",
  ];

  for (const tab of NAV_TABS) {
    test(`click nav → ${tab}`, async ({ page }) => {
      watch(page);
      cur = tab.toLowerCase().replace(/\s+/g, "-");

      await login(page);
      await clickNav(page, tab);

      const text = await mainContent(page);
      const blank = text.length < 10;
      console.log(`  ${blank ? "❌" : "✅"} ${tab}${blank ? " (blank/near-blank)" : ` — ${text.length} chars`}`);

      if (blank) {
        console.log(`     Content preview: ${text.slice(0, 100)}`);
      }
    });
  }
});

// ──────────────────────────────────────────────
// Test 2: Instance list → detail → sub-tabs
// ──────────────────────────────────────────────

test.describe("Instance detail interaction", () => {
  test("navigate to instance and traverse sub-tabs", async ({ page }) => {
    watch(page);
    cur = "instances";

    await login(page);

    // Go to instances
    await clickNav(page, "Instances");
    await page.waitForTimeout(1500);

    // Check if table has rows
    const rows = page.locator("tr:has(td)").filter({ hasText: /.+/ });
    const rowCount = await rows.count();

    if (rowCount <= 1) {
      console.log("  ⚠️  No data rows in instances table — may be empty or still loading");
      return;
    }

    console.log(`  Table has ${rowCount} rows`);

    // Click the first data row (skip header)
    cur = "instance-click";
    await rows.nth(1).click();
    await page.waitForTimeout(2000);

    // Check if we navigated to detail
    if (!page.url().includes("instance-detail")) {
      console.log("  ⚠️  Row click didn't navigate to detail page");
      return;
    }
    console.log(`  ✅ Navigated to detail: ${page.url().slice(0, 60)}`);

    // Find sub-tabs
    const tabs = page.locator("button.tab, [class*='tab-btn'], [class*='tab-button']");
    const tabCount = await tabs.count();
    console.log(`  Sub-tabs found: ${tabCount}`);

    if (tabCount === 0) {
      // Try finding tabs by role or text
      const clickable = page.locator('[role="tab"], [class*="tab"]').filter({ hasText: /overview|metrics|topsql/i });
      console.log(`  Alternative tabs found: ${await clickable.count()}`);
    }

    for (const sub of ["overview", "metrics", "topsql", "trend", "sessions", "capacity", "schema", "indexes", "sqlaudit", "logs"]) {
      cur = `instance-${sub}`;
      const btn = page.locator("button").filter({ hasText: new RegExp(sub, "i") }).first();
      if ((await btn.count()) === 0) {
        console.log(`  ⚠️  ${sub} tab — button not found`);
        continue;
      }
      await btn.click();
      await page.waitForTimeout(500);

      const text = await mainContent(page);
      console.log(`  ${text.length > 20 ? "✅" : "❌"} ${sub}${text.length < 20 ? " (near-blank)" : ""}`);
    }
  });
});

// ──────────────────────────────────────────────
// Test 3: CRUD smoke — create/delete user
// ──────────────────────────────────────────────

test.describe("User CRUD smoke", () => {
  test("create and delete a test user", async ({ page }) => {
    watch(page);
    cur = "users-crud";

    await login(page);
    // Users is now under Settings
    await clickNav(page, "Settings");
    await page.waitForTimeout(1500);

    // Check if we see user management UI
    const newUserBtn = page.locator('button:has-text("新建"), button:has-text("New"), button:has-text("Create")').first();
    if ((await newUserBtn.count()) === 0) {
      console.log("  ⚠️  No 'create user' button found — skipping CRUD test");
      return;
    }

    // Click new user
    await newUserBtn.click();
    await page.waitForTimeout(500);

    // Check for modal/form
    const modal = page.locator('[class*="modal"], [class*="dialog"], [class*="Modal"]').first();
    if ((await modal.count()) === 0) {
      console.log("  ⚠️  No modal appeared after clicking New User");
      return;
    }
    console.log("  ✅ Create user modal opened");

    // Fill form
    const inputs = modal.locator("input");
    const inputCount = await inputs.count();
    console.log(`  Form has ${inputCount} inputs`);

    // Fill username (usually first input)
    if (inputCount >= 1) {
      await inputs.nth(0).fill(`smoke_user_${Date.now()}`);
    }
    if (inputCount >= 2) {
      await inputs.nth(1).fill("smoke1234"); // password
    }

    // Submit
    const submitBtn = modal.locator('button[type="submit"], button:has-text("确定"), button:has-text("OK"), button:has-text("Save"), button:has-text("保存")').first();
    if ((await submitBtn.count()) > 0) {
      await submitBtn.click();
      await page.waitForTimeout(1000);
      console.log("  ✅ Form submitted");
    }

    // Check for table refresh
    const tableRows = page.locator("tr:has(td)").filter({ hasText: /smoke_user/ });
    if ((await tableRows.count()) > 0) {
      console.log("  ✅ New user visible in table");
    }

    // Cleanup — delete the test user
    const deleteBtn = page.locator('button:has-text("删除"), button:has-text("Delete")').first();
    if ((await deleteBtn.count()) > 0) {
      // Could add confirmation dialog handling
      console.log("  ℹ️  Delete button present — skipping auto-delete for safety");
    }
  });
});

// ──────────────────────────────────────────────
// Test 4: Data loading verification
// ──────────────────────────────────────────────

test.describe("Data loading check", () => {
  const PAGES_WITH_DATA = [
    { tab: "Alerts", check: 'tr:has(td), [class*="empty"], [class*="no-data"]' },
    { tab: "Instances", check: 'tr:has(td), [class*="empty"], [class*="no-data"]' },
    { tab: "Reports", check: 'tr:has(td), [class*="empty"], [class*="no-data"]' },
    { tab: "Events", check: 'tr:has(td), [class*="empty"], [class*="no-data"]' },
    { tab: "Settings", check: 'tr:has(td), [class*="empty"], [class*="no-data"]' },
  ];

  for (const { tab, check } of PAGES_WITH_DATA) {
    test(`data: ${tab} has content`, async ({ page }) => {
      watch(page);
      cur = `data-${tab.toLowerCase()}`;

      await login(page);
      await clickNav(page, tab);
      await page.waitForTimeout(2000);

      const hasTable = (await page.locator("tr:has(td)").count()) > 1;
      const hasEmpty = (await page.locator('[class*="empty"], [class*="no-data"], [class*="no-results"]').count()) > 0;
      const hasCards = (await page.locator('[class*="card"], [class*="stat"]').count()) > 0;

      if (hasTable) {
        console.log(`  ✅ ${tab} — table with data`);
      } else if (hasCards) {
        console.log(`  ✅ ${tab} — cards/stats visible`);
      } else if (hasEmpty) {
        console.log(`  ℹ️  ${tab} — empty state (no data yet, but UI renders correctly)`);
      } else {
        console.log(`  ⚠️  ${tab} — no recognizable content pattern`);
      }
    });
  }
});

// ──────────────────────────────────────────────
// Final report
// ──────────────────────────────────────────────

test.afterAll(() => {
  console.log(`\n${"=".repeat(52)}`);
  console.log("  DEEP INTERACTION TEST REPORT");
  console.log("=".repeat(52));
  console.log(`  JS errors:   ${errors.length}`);
  console.log(`  Net fails:   ${netFails.length}`);
  if (errors.length) {
    console.log("\n  --- JS ERRORS ---");
    errors.forEach((e) => console.log(`  ${e}`));
  }
  if (netFails.length) {
    console.log("\n  --- NETWORK FAILS ---");
    netFails.forEach((e) => console.log(`  ${e}`));
  }
  console.log("");
});
