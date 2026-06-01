import { test, expect } from "@playwright/test";

const BASE = "http://localhost:5173";
const API = "http://localhost:3000";

async function login(page: any) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', "admin");
  await page.fill('input[autocomplete="current-password"]', "Tpam1234");
  await page.click(".login-gate__connect");
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForTimeout(1000);
}

test.describe("Auth", () => {
  test("login page shows", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".login-gate__title")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".login-gate__connect")).toBeVisible();
  });

  test("login works and redirects to dashboard", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
    await page.fill('input[autocomplete="username"]', "admin");
    await page.fill('input[autocomplete="current-password"]', "Tpam1234");
    await page.click(".login-gate__connect");
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    await expect(page).toHaveURL(/dashboard/);
  });

  test("wrong password shows error", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
    await page.fill('input[autocomplete="username"]', "admin");
    await page.fill('input[autocomplete="current-password"]', "wrongpass");
    await page.click(".login-gate__connect");
    await expect(page.locator(".callout.danger")).toBeVisible({ timeout: 5000 });
  });

  test("Enter key login works", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
    await page.fill('input[autocomplete="username"]', "admin");
    await page.fill('input[autocomplete="current-password"]', "Tpam1234");
    await page.press('input[autocomplete="current-password"]', "Enter");
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    await expect(page).toHaveURL(/dashboard/);
  });

  test("wrong password + Enter shows error", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
    await page.fill('input[autocomplete="username"]', "admin");
    await page.fill('input[autocomplete="current-password"]', "wrong");
    await page.press('input[autocomplete="current-password"]', "Enter");
    await expect(page.locator(".callout.danger")).toBeVisible({ timeout: 5000 });
  });

  test("unprotected API routes return 401", async ({ request }) => {
    for (const route of ["/api/llm/configs", "/api/database/instances/1/tables", "/api/dashboard/ai-stats"]) {
      expect((await request.get(`${API}${route}`)).status()).toBe(401);
    }
  });

  test("health check is public", async ({ request }) => {
    expect((await request.get(`${API}/api/health`)).status()).toBe(200);
  });
});

test.describe("Protected pages", () => {
  test("dashboard without auth shows login", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".login-gate__connect")).toBeVisible({ timeout: 5000 });
  });

  test("settings without auth shows login", async ({ page }) => {
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".login-gate__connect")).toBeVisible({ timeout: 5000 });
  });

  test("logged in user can access settings", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator(".settings-subtab").first()).toBeVisible({ timeout: 5000 });
  });

  test("logged in user can access alerts", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/alerts`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator(".tabs .tab").first()).toBeVisible({ timeout: 5000 });
  });

  test("logged in user can access reports", async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await expect(page.locator("reports-page")).toBeVisible({ timeout: 5000 });
  });
});
