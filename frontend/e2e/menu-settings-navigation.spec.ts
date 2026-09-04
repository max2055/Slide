import { expect, test, type Page } from "@playwright/test";

async function installFixtures(page: Page) {
  await page.addInitScript(() => {
    class FixtureWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = FixtureWebSocket.CONNECTING;
      bufferedAmount = 0;
      protocol = '';
      extensions = '';
      binaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          if (this.readyState !== FixtureWebSocket.CONNECTING) return;
          this.readyState = FixtureWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }, 0);
      }

      send(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}

      close(code = 1000, reason = ''): void {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close', { code, reason }));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FixtureWebSocket,
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("token", "fixture-navigation-token");
    localStorage.setItem("refreshToken", "fixture-refresh-token");
    localStorage.setItem("permissions", JSON.stringify(["*"]));
    localStorage.setItem("slide.control.session_token.v1", "fixture-navigation-token");
    localStorage.setItem("slide.control.settings.v1:default", JSON.stringify({ locale: "zh-CN" }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    const body = path === "/api/auth/permissions"
      ? ["*"]
      : path === "/api/version"
        ? { version: "fixture-e2e" }
        : path === "/api/user/preferences"
          ? { preferences: { locale: "zh-CN" } }
          : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
});

test("desktop navigation uses the new groups and fixed utility entries", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator(".sidebar-nav")).toBeVisible();

  await expect(page.locator(".nav-section__label-text")).toHaveText([
    "工作台", "资源管理", "运维中心", "安全与治理",
  ]);
  await expect(page.locator(".sidebar-utility-group .nav-item__text")).toHaveText([
    "平台状态", "问题反馈", "设置",
  ]);
  await expect(page.locator('.topnav-shell__docs-btn')).toBeVisible();

  await page.locator('.sidebar-utility-group a[href="/feedback"]').click();
  await expect(page).toHaveURL(/\/feedback(?:\?|$)/);
  await expect(page.locator('feedback-page')).toBeVisible();

  await page.locator('.sidebar-utility-group a[href="/settings"]').click();
  await expect(page).toHaveURL(/\/settings\/platform\/branding(?:\?|$)/);
  await expect(page.locator('.sidebar-utility-group a[href="/settings"]')).toHaveClass(/nav-item--active/);
  await expect(page.locator('.sidebar-nav a[href="/dashboard"]')).not.toHaveClass(/nav-item--active/);
  await expect(page.locator("settings-shell .settings-group__label")).toHaveText([
    "平台设置", "监控与分析", "AI 与 Agent", "用户与权限",
  ]);
});

test("legacy routes preserve query parameters and merged views restore through history", async ({ page }) => {
  await page.goto("/scoring-settings?instance=42");
  await expect(page).toHaveURL(/\/settings\/monitoring\/analysis\?[^#]*instance=42[^#]*view=scoring/);
  await expect(page.locator("settings-shell .content-tab.active")).toHaveText("评分权重");

  await page.locator("settings-shell .content-tab", { hasText: "自动分析" }).click();
  await expect(page).toHaveURL(/view=automatic/);
  await page.goBack();
  await expect(page.locator("settings-shell .content-tab.active")).toHaveText("评分权重");

  await page.reload();
  await expect(page.locator("settings-shell .content-tab.active")).toHaveText("评分权重");
});

test("mobile settings use a grouped selector without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/ai/capabilities?view=skills");

  await expect(page.locator("settings-shell .desktop-groups")).toBeHidden();
  const selector = page.locator("settings-shell .settings-select");
  await expect(selector).toBeVisible();
  await expect(selector.locator("optgroup")).toHaveCount(4);
  await selector.selectOption("appearance");
  await expect(page).toHaveURL(/\/settings\/platform\/appearance(?:\?|$)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("permission updates hide inaccessible groups and merged views", async ({ page }) => {
  await page.goto("/settings/ai/security?view=policy");
  await page.evaluate(() => {
    localStorage.setItem("permissions", JSON.stringify(["ai:view"]));
    window.dispatchEvent(new CustomEvent("slide-permissions-loaded", {
      detail: { permissions: ["ai:view"] },
    }));
  });

  await expect(page.locator("settings-shell .content-tab", { hasText: "沙箱配置" })).toHaveCount(0);
  await expect(page.locator("settings-shell .settings-group__label", { hasText: "用户与权限" })).toHaveCount(0);
  await expect(page.locator("settings-shell agent-security-policy-page")).toBeVisible();
});

test("feedback history is usable on desktop and mobile", async ({ page }, testInfo) => {
  await page.route("**/api/feedback", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        feedback: [{
          id: 3,
          title: "连接页保存失败",
          description: "用户在连接页保存配置后看到请求失败提示，重新加载后配置仍未保存。",
          source: "agent",
          createdBy: 7,
          createdByUsername: "alice",
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T01:00:00.000Z",
        }],
      }),
    });
  });

  await page.goto("/feedback");
  await expect(page.locator("feedback-page")).toBeVisible();
  await expect(page.getByText("连接页保存失败")).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑 连接页保存失败" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除 连接页保存失败" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("feedback-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "新增反馈" })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑 连接页保存失败" })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除 连接页保存失败" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("feedback-mobile.png"), fullPage: true });
});
