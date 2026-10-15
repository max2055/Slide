import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { startMax181Server } from "./max181-server";

test.skip(
  !process.env.MAX181_DB_ENV,
  "Opt in with an authorized database environment; creates and removes only slide_max181_*",
);
test.describe.configure({ mode: "serial" });
let env: Awaited<ReturnType<typeof startMax181Server>>;
const baseline = process.env.MAX181_BASELINE === "1";
const output = resolve(process.env.MAX181_OUTPUT ?? "../docs/slide/development/MAX-181/evidence");
const geometry: unknown[] = [];
const network: unknown[] = [];
const browserErrors: string[] = [];
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/docs/"))
      network.push({ test: testInfo.title, path: url.pathname, status: response.status() });
  });
});
test.afterEach(() => {
  expect(browserErrors).toEqual([]);
});
let authenticatedSession: any;
test.beforeAll(async () => {
  test.setTimeout(150000);
  await mkdir(output, { recursive: true });
  env = await startMax181Server(output);
});
test.afterAll(async () => {
  await writeFile(
    resolve(output, "geometry.json"),
    JSON.stringify(
      {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        baseline,
        productSha256: createHash("sha256")
          .update(await readFile("src/app/ui/views/docs-viewer.ts"))
          .digest("hex"),
        environment: env?.identity,
        geometry,
        network,
        browserErrors,
      },
      null,
      2,
    ),
  );
  await env?.close();
});
async function login(page: Page, theme: string) {
  await page.addInitScript((theme) => {
    localStorage.setItem("slide.i18n.locale", "zh-CN");
    localStorage.setItem("app-theme-mode", theme);
    localStorage.setItem(
      "slide.control.settings.v1:default",
      JSON.stringify({ theme: "claw", themeMode: theme, locale: "zh-CN" }),
    );
  }, theme);
  await page.goto(env.url + "/docs");
  // Obtain the real session through the product login service, never fabricate JWT/permissions.
  if (!authenticatedSession) {
    const result = await page.request.post(env.apiUrl + "/api/auth/login", {
      data: { username: "max181-reader", password: env.password },
    });
    expect(result.ok()).toBe(true);
    authenticatedSession = await result.json();
  }
  const session = authenticatedSession;
  expect(
    (
      await page.request.put(env.apiUrl + "/api/user/preferences", {
        headers: { Authorization: `Bearer ${session.token}` },
        data: { preferences: { theme: "claw", themeMode: theme, locale: "zh-CN" } },
      })
    ).ok(),
  ).toBe(true);
  await page.evaluate((session) => {
    localStorage.setItem("token", session.token);
    localStorage.setItem("user", JSON.stringify(session.user));
    localStorage.setItem(
      "permissions",
      JSON.stringify(session.permissions ?? session.user?.permissions ?? []),
    );
  }, session);
  await page.reload();
  await expect(page.locator("docs-viewer-page h1").first()).toBeVisible();
}
async function capture(page: Page, name: string) {
  const view = page.locator("docs-viewer-page");
  const metrics = await view.evaluate((el) => {
    const root = el.shadowRoot!;
    const content = root.querySelector(".docs-content")!;
    const style = getComputedStyle(content);
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      host: el.getBoundingClientRect().width,
      content: content.getBoundingClientRect().width,
      readable:
        content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      regions: Array.from(root.querySelectorAll<HTMLElement>('[role="region"]')).map((el) => ({
        name: el.getAttribute("aria-label"),
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
        tabIndex: el.tabIndex,
      })),
      sidebar: root.querySelector(".docs-sidebar")?.getBoundingClientRect().width,
      title: root.querySelector("h1")?.textContent,
    };
  });
  geometry.push({ name, ...metrics });
  expect(metrics.pageWidth).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await page.screenshot({
    path: resolve(output, name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
  return metrics;
}
for (const width of [390, 768, 1280])
  for (const theme of ["light", "dark"])
    test(`docs real service ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 950 });
      await login(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
      const view = page.locator("docs-viewer-page");
      const metrics = await capture(page, `${baseline ? "before" : "after"}-${width}-${theme}`);
      if (baseline) return;
      if (width <= 768) {
        expect(metrics.readable).toBeGreaterThan(metrics.host - 65);
        const trigger = view.getByRole("button", { name: "打开文档目录", exact: true });
        await trigger.click();
        const dialog = view.locator("app-dialog");
        await expect(dialog.getByRole("dialog")).toBeVisible();
        await page.screenshot({
          path: resolve(output, `directory-${width}-${theme}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        await trigger.click();
        const buttons = dialog.locator(".docs-sidebar__item");
        const title = await buttons.nth(1).innerText();
        await buttons.nth(1).click();
        await expect(dialog.getByRole("dialog")).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(view.locator(".docs-current")).toHaveText(title);
        const selected = new URL(page.url()).searchParams.get("doc");
        expect(selected).toBeTruthy();
        await page.reload();
        await expect(view.locator(".docs-current")).toHaveText(title);
        await view.getByRole("button", { name: "打开文档目录", exact: true }).click();
        await view.locator("app-dialog .docs-sidebar__item").first().click();
        await expect(page).not.toHaveURL(new RegExp(`doc=${selected}`));
        await page.goBack();
        await expect(view.locator(".docs-current")).toHaveText(title);
      } else {
        await expect(view.locator(".docs-sidebar")).toBeVisible();
      }
    });

test("real documents: keyboard regions, selection/scroll context and resize without overlay", async ({
  page,
}) => {
  test.skip(baseline);
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 950 });
  await login(page, "light");
  const view = page.locator("docs-viewer-page");
  const list = await (
    await page.request.get(env.apiUrl + "/api/docs/list", {
      headers: { Authorization: `Bearer ${authenticatedSession.token}` },
    })
  ).json();
  for (const doc of list.docs) {
    await view
      .locator(".docs-sidebar")
      .getByRole("button", { name: doc.title, exact: true })
      .click();
    await expect(view.locator(".docs-current")).toHaveText(doc.title);
    await expect(view.locator(".docs-content")).toHaveAttribute("aria-busy", "false");
    await expect(view.locator("h1").first()).toBeVisible();
    expect(
      await view.locator(".docs-content").evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
  await view.locator(".docs-sidebar .docs-sidebar__item").first().click();
  await expect(view.locator(".docs-content")).toHaveAttribute("aria-busy", "false");
  await view.locator(".docs-content").evaluate((el) => {
    el.scrollTo({ top: 450, behavior: "instant" });
  });
  const position = await view.locator(".docs-content").evaluate((el) => el.scrollTop);
  expect(position).toBeGreaterThan(0);
  await view.locator(".docs-sidebar .docs-sidebar__item").nth(1).click();
  await expect(view.locator(".docs-content")).toHaveAttribute("aria-busy", "false");
  await view.locator(".docs-sidebar .docs-sidebar__item").first().click();
  await expect(view.locator(".docs-content")).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() => view.locator(".docs-content").evaluate((el) => el.scrollTop))
    .toBeCloseTo(position, 0);
  await page.setViewportSize({ width: 390, height: 950 });
  await expect(view.getByRole("button", { name: "打开文档目录", exact: true })).toBeVisible();
  const regions = view.locator(".docs-image-scroll");
  expect(await regions.count()).toBeGreaterThan(0);
  const region = regions.first();
  await region.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await capture(page, "real-diagram-keyboard-390-light");
  await view.getByRole("button", { name: "打开文档目录", exact: true }).click();
  const dialog = view.locator("app-dialog");
  await expect(dialog.getByRole("dialog")).toBeVisible();
  await dialog.locator(".docs-sidebar__item").last().focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(".docs-sidebar__item").last()).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 950 });
  await expect(dialog.getByRole("dialog")).toHaveCount(0);
  await expect(view.locator(".docs-sidebar")).toBeVisible();
});

for (const width of [390, 768, 1280])
  for (const theme of ["light", "dark"])
    test(`controlled long content and explicit abnormal states ${width} ${theme}`, async ({
      page,
    }) => {
      test.skip(baseline);
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 950 });
      await login(page, theme);
      const view = page.locator("docs-viewer-page");
      const content = `<h1>受控长内容验收</h1><p><a href="https://example.test/${"long-link-".repeat(40)}">https://example.test/${"long-link-".repeat(40)}</a></p><pre><code>${"select resource_name,observed_at from resources;".repeat(20)}</code></pre><table><tr><th>${"long_column_".repeat(15)}</th><th>参数</th></tr><tr><td>${"long_value_".repeat(15)}</td><td>受控数据</td></tr></table><div class="doc-diagram"><div class="doc-flow"><div class="doc-lane">来源</div><div class="doc-arrow">→</div><div class="doc-lane">结果未知</div></div></div><script>window.MAX181_UNSAFE=true</script>`;
      const route = "**/api/docs/files/*";
      await page.route(route, (r) => r.fulfill({ json: { content } }));
      await page.reload();
      await expect(view.getByRole("heading", { name: "受控长内容验收" })).toBeVisible();
      expect(await page.evaluate(() => (window as any).MAX181_UNSAFE)).toBeUndefined();
      for (const selector of ["pre", ".docs-table-scroll", ".doc-diagram"]) {
        const region = view.locator(selector).first();
        await expect(region).toHaveAttribute("tabindex", "0");
        await expect(region).toHaveAttribute("role", "region");
        const dimensions = await region.evaluate((el) => ({
          client: el.clientWidth,
          scroll: el.scrollWidth,
        }));
        expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
        await region.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      }
      expect(
        await view.locator(".docs-content").evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await capture(page, `controlled-long-${width}-${theme}`);
      await page.unroute(route);
      await page.route(route, (r) =>
        r.fulfill({ status: 500, json: { error: "controlled failure" } }),
      );
      await page.reload();
      await expect(view.getByRole("alert")).toContainText("无法加载文档内容");
      await capture(page, `controlled-error-${width}-${theme}`);
      await page.unroute(route);
      await page.route(route, (r) =>
        r.fulfill({ status: 403, json: { error: "controlled forbidden" } }),
      );
      await view.getByRole("button", { name: "重试", exact: true }).click();
      await expect(view.getByRole("alert")).toContainText("无权读取文档");
      await capture(page, `controlled-forbidden-${width}-${theme}`);
      await page.unroute(route);
      await page.route(route, (r) => r.fulfill({ json: { content: "" } }));
      await view.getByRole("button", { name: "重试", exact: true }).click();
      await expect(view).toContainText("当前文档暂无内容");
      await capture(page, `controlled-content-empty-${width}-${theme}`);
      await page.unroute(route);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await page.route(route, async (r) => {
        await gate;
        await r.continue();
      });
      await page.reload();
      await expect(view.getByRole("status")).toContainText("加载中");
      await capture(page, `controlled-loading-${width}-${theme}`);
      release();
      await expect(view.locator("h1").first()).toBeVisible();
      await page.unroute(route);
      await page.route("**/api/docs/list", (r) => r.fulfill({ json: { docs: [] } }));
      await page.reload();
      await expect(view.locator(".docs-content")).toContainText("暂无可用文档");
      await capture(page, `controlled-list-empty-${width}-${theme}`);
      await page.unroute("**/api/docs/list");
      await page.route("**/api/docs/list", (r) =>
        r.fulfill({ status: 500, json: { error: "controlled list failure" } }),
      );
      await page.reload();
      await expect(view.getByRole("alert")).toContainText("无法加载文档列表");
      await capture(page, `controlled-list-error-${width}-${theme}`);
      await page.unroute("**/api/docs/list");
      await view.getByRole("button", { name: "重试", exact: true }).click();
      await expect(view.locator("h1").first()).toBeVisible();
    });

test("controlled out-of-order reads retain the final document and its anchors", async ({
  page,
}) => {
  test.skip(baseline);
  await page.setViewportSize({ width: 1280, height: 950 });
  await login(page, "light");
  const view = page.locator("docs-viewer-page");
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (arrived = r));
  const list = await (
    await page.request.get(env.apiUrl + "/api/docs/list", {
      headers: { Authorization: `Bearer ${authenticatedSession.token}` },
    })
  ).json();
  const first = list.docs[0],
    second = list.docs[1];
  await page.route("**/api/docs/files/" + second.file, async (route) => {
    arrived();
    await gate;
    await route.fulfill({ json: { content: "<h1>过时请求</h1>" } });
  });
  await view
    .locator(".docs-sidebar")
    .getByRole("button", { name: second.title, exact: true })
    .click();
  await started;
  await view
    .locator(".docs-sidebar")
    .getByRole("button", { name: first.title, exact: true })
    .click();
  await expect(view.locator("h1").first()).toBeVisible();
  release();
  await expect(view.locator(".docs-current")).toHaveText(first.title);
  await expect(view).not.toContainText("过时请求");
  await expect(view.locator(".docs-content")).toHaveAttribute("aria-busy", "false");
  // Known cross-document link and heading still use the sanitized document path.
  await page.unroute("**/api/docs/files/" + second.file);
  await page.route("**/api/docs/files/" + first.file, (r) =>
    r.fulfill({ json: { content: `<h1>受控链接</h1><a href="${second.file}">下一文档</a>` } }),
  );
  await page.reload();
  await view.getByRole("link", { name: "下一文档", exact: true }).click();
  await expect(view.locator(".docs-current")).toHaveText(second.title);
  await expect(page).toHaveURL(new RegExp("doc=" + second.file));
});

test("real topbar entry retains document selection through refresh and browser history", async ({
  page,
}) => {
  test.skip(baseline);
  await login(page, "light");
  await page.goto(env.url + "/dashboard");
  await page.getByRole("button", { name: "文档", exact: true }).click();
  const view = page.locator("docs-viewer-page");
  await expect(view.locator("h1").first()).toBeVisible();
  const entries = view.locator(".docs-sidebar .docs-sidebar__item");
  const first = await entries.first().innerText(),
    second = await entries.nth(1).innerText();
  await entries.nth(1).click();
  await expect(view.locator(".docs-current")).toHaveText(second);
  await page.reload();
  await expect(view.locator(".docs-current")).toHaveText(second);
  await view.locator(".docs-sidebar .docs-sidebar__item").first().click();
  await expect(view.locator(".docs-current")).toHaveText(first);
  await page.goBack();
  await expect(view.locator(".docs-current")).toHaveText(second);
  expect(new URL(page.url()).searchParams.get("doc")).toBeTruthy();
  // Controlled popstate to another tab exercises the live shell and viewer listeners together.
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.search = "?tab=dashboard";
    history.pushState({}, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("dashboard-page")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("doc")).toBe(false);
});
