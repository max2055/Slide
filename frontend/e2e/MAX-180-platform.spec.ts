import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test, expect, type Page } from "@playwright/test";
const require = createRequire(new URL("../../apps/db-ops-api/package.json", import.meta.url));
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
test.describe.configure({ mode: "serial" });
test.skip(!process.env.MAX180_ISOLATED_MYSQL, "Use run-MAX-180.sh");
const output = "test-results/MAX-180-evidence";
let pool: any, token: string, reviewer: number, role: number;
let realSnapshot: any;
test.beforeAll(async ({ request }) => {
  pool = mysql.createPool({
    host: "127.0.0.1",
    port: Number(process.env.DB_PORT),
    user: "root",
    password: "",
    database: "db_ops_ai_qualification_MAX180",
  });
  const password = randomBytes(24).toString("hex");
  const [user] = await pool.execute(
    "INSERT INTO users(username,password_hash,status) VALUES ('max180-reader',?,'active')",
    [await bcrypt.hash(password, 10)],
  );
  reviewer = user.insertId;
  const [insert] = await pool.execute("INSERT INTO roles(name) VALUES ('max180-reader')");
  role = insert.insertId;
  await pool.execute("INSERT INTO user_roles(user_id,role_id) VALUES (?,?)", [reviewer, role]);
  await pool.execute(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='config:view'",
    [role],
  );
  const login = await request.post("/api/auth/login", {
    data: { username: "max180-reader", password },
  });
  expect(login.status()).toBe(200);
  token = (await login.json()).token;
  const observed = await request.get("/api/platform/observations", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(observed.status()).toBe(200);
  realSnapshot = await observed.json();
  await mkdir(output, { recursive: true });
  await writeFile(
    `${output}/metadata.json`,
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sources: await Promise.all(
          ["platform-observations", "health-center"].map(async (name) => ({
            file: `${name}.ts`,
            sha256: createHash("sha256")
              .update(await readFile(`src/app/ui/views/${name}.ts`))
              .digest("hex"),
          })),
        ),
        data: "Isolated MySQL; unchanged production observations/health handlers, consistency checker, JWT and live RBAC. Task-owned HTTP login uses production password/actor/token functions. No provider/Agent/collector/worker started; no model requests.",
        widths: [1440, 768, 390],
        themes: ["light", "dark"],
      },
      null,
      2,
    ),
  );
});
test.afterAll(async () => {
  await pool?.end();
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ token, reviewer }) => {
      localStorage.setItem("token", token);
      localStorage.setItem("user", JSON.stringify({ id: reviewer, username: "max180-reader" }));
      localStorage.setItem("permissions", JSON.stringify(["config:view"]));
      localStorage.setItem("slide.i18n.locale", "zh-CN");
    },
    { token, reviewer },
  );
});
async function harness(page: Page, tag = "platform-observations-page") {
  await page.route("**/MAX-180-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/app/styles/tokens.css"><style>body{margin:0;padding:32px;background:var(--bg);font:14px/1.6 system-ui}@media(max-width:850px){body{padding:24px}}@media(max-width:600px){body{padding:16px}}</style><body><script type="module">import '/src/app/ui/views/platform-observations.ts';import '/src/app/ui/views/health-center.ts';document.body.append(document.createElement('${tag}'));</script></body></html>`,
    }),
  );
  await page.goto("/MAX-180-harness");
  return page.locator(tag);
}
async function capture(
  page: Page,
  name: string,
  source = "real production handlers / isolated MySQL",
) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: "disabled" });
  await writeFile(
    `${output}/${name}.json`,
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        viewport: page.viewportSize(),
        theme: await page.evaluate(() => document.documentElement.dataset.themeMode ?? "default"),
        source,
        at: new Date().toISOString(),
        measurement: await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
        })),
      },
      null,
      2,
    ),
  );
}
async function captureMatrix(page: Page, name: string, source: string) {
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((t) => (document.documentElement.dataset.themeMode = t), theme);
      await capture(page, `${name}-${width}-${theme}`, source);
    }
}
test("platform representative real service: summary, same response evidence, responsive themes and keyboard", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const response = page.waitForResponse((r) => r.url().endsWith("/api/platform/observations"));
  const view = await harness(page);
  const actual = await (await response).json();
  expect(actual.components).toHaveLength(6);
  await expect(view.locator("tbody tr")).toHaveCount(6);
  await expect(view.locator(".status-grid")).toContainText("部分可用");
  await view.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(view.locator("tbody tr")).toHaveCount(3);
  await expect(view.locator("tbody")).toContainText("版本与部署");
  await view.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(view).toContainText("尚不能判断平台整体健康");
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => (document.documentElement.dataset.themeMode = theme), theme);
      await capture(page, `platform-${width}-${theme}`);
    }
  const scroll = view.getByRole("region", { name: "平台观测证据，可横向滚动" });
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const trigger = view.getByRole("button", { name: "查看详情" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = view.locator("app-dialog");
  await expect(dialog.locator(".dialog")).toBeVisible();
  await dialog.locator("summary").click();
  const raw = JSON.parse(await dialog.locator("pre").innerText());
  expect(raw.evidence).toEqual(actual.components[0]);
  expect(raw.generatedAt).toBe(actual.generatedAt);
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => (document.documentElement.dataset.themeMode = theme), theme);
      await capture(page, `platform-detail-${width}-${theme}`);
      expect((await dialog.locator(".dialog").boundingBox())!.width).toBeLessThan(width);
    }
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().focus();
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((e) => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return e.contains(active) || e.shadowRoot?.contains(active);
    }),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
  expect((await request.get("/api/platform/observations")).status()).toBe(401);
});
test("platform controlled supplements: unknown, empty, partial/stale, long evidence, loading, refresh failure and invalidation", async ({
  page,
}) => {
  const long = "long-category-".repeat(80);
  const scenarios: any[] = [
    { name: "unknown", value: { schemaVersion: 1 } },
    {
      name: "empty",
      value: {
        schemaVersion: 1,
        components: [],
        logs: { quality: "unknown", groups: [], gaps: ["LOG_EVIDENCE_MISSING"] },
      },
    },
    {
      name: "partial-stale",
      value: {
        ...realSnapshot,
        commitSha: "f".repeat(240),
        components: [
          {
            component: long,
            quality: "unknown",
            gaps: ["LOG_EVIDENCE_STALE", "LOG_BUFFER_TRUNCATED"],
            groups: [{ count: 1, lastObservedAt: "2026-10-01T00:00:00Z" }],
          },
          {
            component: "agent",
            quality: "degraded",
            gaps: ["LOG_STATUS_UNKNOWN"],
            groups: [{ count: 2 }],
          },
        ],
      },
    },
  ];
  for (const scenario of scenarios) {
    await page.route("**/api/platform/observations", (r) => r.fulfill({ json: scenario.value }));
    const view = await harness(page);
    await expect(view.locator("tbody")).toBeVisible();
    for (const width of [1440, 768, 390])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate((t) => (document.documentElement.dataset.themeMode = t), theme);
        await capture(
          page,
          `controlled-${scenario.name}-${width}-${theme}`,
          "HTTP controlled supplement; no collection switches changed",
        );
      }
    if (scenario.name === "partial-stale") {
      await view.getByRole("button", { name: "查看详情" }).first().click();
      await view.locator("summary").click();
      await expect(view.locator("pre")).toContainText(long);
      await capture(page, "controlled-long-detail", "HTTP controlled long category");
      await page.keyboard.press("Escape");
      await view.getByRole("button", { name: "查看缺口", exact: true }).click();
      await view.locator("summary").click();
      await expect(view.locator("pre")).toContainText("f".repeat(240));
      await capture(
        page,
        "controlled-long-commit",
        "HTTP controlled 240-character commit identifier",
      );
      await page.keyboard.press("Escape");
    }
    await page.unroute("**/api/platform/observations");
  }
  const view = page.locator("platform-observations-page");
  let release!: () => void;
  await page.route("**/api/platform/observations", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ status: 503, json: { error: "controlled" } });
  });
  await view.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(view).toContainText("正在读取");
  await expect(view.locator("tbody")).toHaveCount(0);
  await captureMatrix(page, "controlled-loading", "HTTP response held pending");
  release();
  await expect(view).toContainText("HTTP 503");
  await captureMatrix(page, "controlled-refresh-failure", "HTTP 503 after successful read");
  await page.unroute("**/api/platform/observations");
  await view.getByRole("button", { name: "重试", exact: true }).click();
  await expect(view.locator("tbody")).toBeVisible();
  await view.getByRole("button", { name: "查看详情" }).first().click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("slide-permissions-loaded", { detail: { permissions: [] } }),
    ),
  );
  await expect(view.locator("tbody")).toHaveCount(0);
  await expect(view.locator("app-dialog")).toHaveCount(0);
  await capture(
    page,
    "controlled-event-revocation",
    "Client permission invalidation event; real server denial tested separately",
  );
});
test("health real service and compatible empty/failed evidence states", async ({ page }) => {
  const view = await harness(page, "health-center-page");
  await expect(view.locator(".health-bar")).toBeVisible();
  await expect(view).toContainText("自检");
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((t) => (document.documentElement.dataset.themeMode = t), theme);
      await capture(page, `health-${width}-${theme}`);
    }
  await view.getByRole("button", { name: /显示正常检查/ }).click();
  await capture(page, "health-expanded-390-dark");
  await page.route("**/api/health/overview*", (r) =>
    r.fulfill({
      json: {
        timestamp: "2026-10-15T00:00:00Z",
        summary: { pass: 0, warn: 0, fail: 0, deferred: 0, total: 0 },
        checks: [],
        readiness: {},
      },
    }),
  );
  await view.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(view).toContainText("尚无有效检查");
  await expect(view).not.toContainText("100%");
  await captureMatrix(page, "controlled-health-empty", "HTTP controlled empty overview");
  await page.unroute("**/api/health/overview*");
  let release!: () => void;
  await page.route("**/api/health/overview*", async (r) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await r.fulfill({ status: 503, json: { error: "controlled" } });
  });
  await view.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(view).toContainText("正在读取自检");
  await captureMatrix(page, "controlled-health-loading", "HTTP response held pending");
  release();
  await expect(view).toContainText("503");
  await expect(view.locator(".health-bar")).toHaveCount(0);
  await captureMatrix(page, "controlled-health-error", "HTTP controlled 503");
});
test("actual application shell uses the same real observations and health reads", async ({
  page,
}) => {
  await page.goto("/health?view=observations");
  const view = page.locator("platform-observations-page");
  await expect(view.locator("tbody")).toBeVisible();
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((t) => (document.documentElement.dataset.themeMode = t), theme);
      await capture(page, `app-shell-platform-${width}-${theme}`);
    }
  await page.getByRole("tab", { name: "平台自检", exact: true }).click();
  await expect(page.locator("health-center-page .health-bar")).toBeVisible();
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((t) => (document.documentElement.dataset.themeMode = t), theme);
      await capture(page, `app-shell-health-${width}-${theme}`);
    }
});
test("both pages clear evidence on real live permission revocation", async ({ page, request }) => {
  for (const tag of ["platform-observations-page", "health-center-page"]) {
    await pool.execute(
      "INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code='config:view'",
      [role],
    );
    const view = await harness(page, tag);
    await expect(view.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await pool.execute("DELETE FROM role_permissions WHERE role_id=?", [role]);
    const url =
      tag === "health-center-page" ? "/api/health/overview" : "/api/platform/observations";
    expect(
      (await request.get(url, { headers: { authorization: `Bearer ${token}` } })).status(),
    ).toBe(403);
    await view.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(view).toContainText("无权");
    await expect(view.locator("tbody")).toHaveCount(0);
    await captureMatrix(
      page,
      `real-revocation-${tag}`,
      "Real MySQL role removal; existing JWT denied with HTTP 403",
    );
  }
});
