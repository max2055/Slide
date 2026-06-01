import { test, expect } from "@playwright/test";

const BASE = "http://localhost:5173";

async function login(page: any) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[autocomplete="current-password"]', "Tpam1234");
  await page.click(".login-gate__connect");
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForTimeout(1000);
}

test.describe("Settings sub-tabs", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.waitForSelector(".settings-subtab", { timeout: 5000 });
  });

  test("AI settings renders by default", async ({ page }) => {
    await expect(page.locator(".settings-subnav__title")).toHaveText("设置");
    await expect(page.locator(".settings-subtab.active").first()).toBeVisible();
  });

  test("click LLM Config sub-tab shows providers", async ({ page }) => {
    await page.locator(".settings-subtab").nth(1).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("llm-config-page")).toBeAttached({ timeout: 5000 });
  });

  test("click Scoring sub-tab shows sliders", async ({ page }) => {
    await page.locator(".settings-subtab").nth(2).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("scoring-settings-page")).toBeAttached({ timeout: 5000 });
  });

  test("click Appearance sub-tab shows theme options", async ({ page }) => {
    await page.locator(".settings-subtab").nth(3).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("appearance-settings")).toBeAttached({ timeout: 5000 });
  });

  test("click Users sub-tab shows management page", async ({ page }) => {
    await page.locator(".settings-subtab").nth(4).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("users-management")).toBeAttached({ timeout: 5000 });
  });

  test("click RBAC sub-tab shows admin page", async ({ page }) => {
    await page.locator(".settings-subtab").nth(5).click();
    await page.waitForTimeout(1000);
    await expect(page.locator("rbac-admin-page")).toBeAttached({ timeout: 5000 });
  });
});

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("sidebar has key tabs", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const sidebar = await page.locator(".sidebar-nav").innerText();
    expect(sidebar).toContain("Dashboard");
    expect(sidebar).toContain("Alerts");
    expect(sidebar).toContain("Cron Jobs");
    expect(sidebar).toContain("SETTINGS");
  });

  test("alerts page loads with tabs", async ({ page }) => {
    await page.goto(`${BASE}/alerts`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator(".tabs").first()).toBeVisible({ timeout: 5000 });
  });

  test("reports page loads", async ({ page }) => {
    await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator("reports-page")).toBeAttached({ timeout: 5000 });
  });

  test("metric registry page loads", async ({ page }) => {
    await page.goto(`${BASE}/metric-registry`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    // Page should load (may have cards or empty state)
    await expect(page.locator("metric-registry-viewer")).toBeAttached({ timeout: 5000 });
  });

  test("cron jobs page loads", async ({ page }) => {
    await page.goto(`${BASE}/cron-jobs`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator("cron-jobs-settings")).toBeAttached({ timeout: 5000 });
  });
});
