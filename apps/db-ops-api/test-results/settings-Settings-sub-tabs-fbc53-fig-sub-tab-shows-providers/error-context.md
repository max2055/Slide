# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings.spec.ts >> Settings sub-tabs >> click LLM Config sub-tab shows providers
- Location: e2e/settings.spec.ts:28:3

# Error details

```
TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('.settings-subtab') to be visible

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e5]:
    - img "Slide" [ref=e6]
    - generic [ref=e7]: Slide
    - generic [ref=e8]: Gateway Dashboard
  - generic [ref=e9]:
    - generic [ref=e10]:
      - generic [ref=e11]: overview.access.username
      - textbox "overview.access.username" [ref=e12]:
        - /placeholder: login.usernamePlaceholder
    - generic [ref=e13]:
      - generic [ref=e14]: overview.access.password
      - generic [ref=e15]:
        - textbox "overview.access.password Toggle password visibility" [ref=e16]:
          - /placeholder: optional
        - button "Toggle password visibility" [ref=e17] [cursor=pointer]:
          - img [ref=e18]
    - button "Connect" [ref=e23] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | const BASE = "http://localhost:5173";
  4  | 
  5  | async function login(page: any) {
  6  |   await page.goto(BASE, { waitUntil: "domcontentloaded" });
  7  |   await page.waitForSelector(".login-gate__connect", { timeout: 10000 });
  8  |   await page.fill('input[autocomplete="username"]', "admin");
  9  |   await page.fill('input[autocomplete="current-password"]', "Tpam1234");
  10 |   await page.click(".login-gate__connect");
  11 |   await page.waitForURL("**/dashboard", { timeout: 15000 });
  12 |   await page.waitForTimeout(1000);
  13 | }
  14 | 
  15 | test.describe("Settings sub-tabs", () => {
  16 |   test.beforeEach(async ({ page }) => {
  17 |     await login(page);
  18 |     await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  19 |     await page.waitForTimeout(2000);
> 20 |     await page.waitForSelector(".settings-subtab", { timeout: 5000 });
     |                ^ TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.
  21 |   });
  22 | 
  23 |   test("AI settings renders by default", async ({ page }) => {
  24 |     await expect(page.locator(".settings-subnav__title")).toHaveText("设置");
  25 |     await expect(page.locator(".settings-subtab.active").first()).toBeVisible();
  26 |   });
  27 | 
  28 |   test("click LLM Config sub-tab shows providers", async ({ page }) => {
  29 |     await page.locator(".settings-subtab").nth(1).click();
  30 |     await page.waitForTimeout(1000);
  31 |     await expect(page.locator("llm-config-page")).toBeAttached({ timeout: 5000 });
  32 |   });
  33 | 
  34 |   test("click Scoring sub-tab shows sliders", async ({ page }) => {
  35 |     await page.locator(".settings-subtab").nth(2).click();
  36 |     await page.waitForTimeout(1000);
  37 |     await expect(page.locator("scoring-settings-page")).toBeAttached({ timeout: 5000 });
  38 |   });
  39 | 
  40 |   test("click Appearance sub-tab shows theme options", async ({ page }) => {
  41 |     await page.locator(".settings-subtab").nth(3).click();
  42 |     await page.waitForTimeout(1000);
  43 |     await expect(page.locator("appearance-settings")).toBeAttached({ timeout: 5000 });
  44 |   });
  45 | 
  46 |   test("click Users sub-tab shows management page", async ({ page }) => {
  47 |     await page.locator(".settings-subtab").nth(4).click();
  48 |     await page.waitForTimeout(1000);
  49 |     await expect(page.locator("users-management")).toBeAttached({ timeout: 5000 });
  50 |   });
  51 | 
  52 |   test("click RBAC sub-tab shows admin page", async ({ page }) => {
  53 |     await page.locator(".settings-subtab").nth(5).click();
  54 |     await page.waitForTimeout(1000);
  55 |     await expect(page.locator("rbac-admin-page")).toBeAttached({ timeout: 5000 });
  56 |   });
  57 | });
  58 | 
  59 | test.describe("Navigation", () => {
  60 |   test.beforeEach(async ({ page }) => {
  61 |     await login(page);
  62 |   });
  63 | 
  64 |   test("sidebar has key tabs", async ({ page }) => {
  65 |     await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  66 |     await page.waitForTimeout(2000);
  67 |     const sidebar = await page.locator(".sidebar-nav").innerText();
  68 |     expect(sidebar).toContain("Dashboard");
  69 |     expect(sidebar).toContain("Alerts");
  70 |     expect(sidebar).toContain("Cron Jobs");
  71 |     expect(sidebar).toContain("SETTINGS");
  72 |   });
  73 | 
  74 |   test("alerts page loads with tabs", async ({ page }) => {
  75 |     await page.goto(`${BASE}/alerts`, { waitUntil: "domcontentloaded" });
  76 |     await page.waitForTimeout(2000);
  77 |     await expect(page.locator(".tabs").first()).toBeVisible({ timeout: 5000 });
  78 |   });
  79 | 
  80 |   test("reports page loads", async ({ page }) => {
  81 |     await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
  82 |     await page.waitForTimeout(2000);
  83 |     await expect(page.locator("reports-page")).toBeAttached({ timeout: 5000 });
  84 |   });
  85 | 
  86 |   test("metric registry page loads", async ({ page }) => {
  87 |     await page.goto(`${BASE}/metric-registry`, { waitUntil: "domcontentloaded" });
  88 |     await page.waitForTimeout(3000);
  89 |     // Page should load (may have cards or empty state)
  90 |     await expect(page.locator("metric-registry-viewer")).toBeAttached({ timeout: 5000 });
  91 |   });
  92 | 
  93 |   test("cron jobs page loads", async ({ page }) => {
  94 |     await page.goto(`${BASE}/cron-jobs`, { waitUntil: "domcontentloaded" });
  95 |     await page.waitForTimeout(2000);
  96 |     await expect(page.locator("cron-jobs-settings")).toBeAttached({ timeout: 5000 });
  97 |   });
  98 | });
  99 | 
```