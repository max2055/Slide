import { expect, test } from "@playwright/test";

// Controlled API responses verify UI behavior only. Live business acceptance is
// separate in max191-bulk.real.spec.ts; these screenshots are labelled accordingly.
const pin = (type: string) => ({
  id: type === "instance" ? "mysql-basic" : "linux-basic",
  version: "2.0.0",
  digest: `fixture-${type}`,
});
const makeJob = (resources: any[], overrides: any = {}) => ({
  id: "controlled-job",
  digest: "a".repeat(64),
  state: "draft",
  cancel_requested: false,
  created_at: "2026-10-17T04:00:00Z",
  expires_at: "2026-10-17T04:30:00Z",
  updated_at: "2026-10-17T04:00:00Z",
  retry_of: null,
  requested_overrides: overrides,
  items: resources.map((r) => ({
    resource: r,
    state: r.type === "network_device" ? "unsupported" : "eligible",
    code: r.type === "network_device" ? "BULK_CAPABILITY_UNKNOWN" : null,
    group: r.type,
    checks: [
      {
        attribute: "engine",
        value: r.type === "instance" ? "MySQL 9.6" : r.type === "server" ? "Linux 24.04" : null,
        status: "supported",
      },
    ],
    choices:
      r.type === "network_device"
        ? []
        : [{ package: pin(r.type), compatibility: "compatible", recommended: true }],
    before:
      r.type === "network_device"
        ? null
        : {
            package: pin(r.type),
            revision: 1,
            overrides: {
              interval_ms: { mode: "set", value: 60000 },
              max_rows: { mode: "set", value: 7 },
            },
          },
    change:
      r.type === "network_device"
        ? null
        : {
            expected_revision: 1,
            package: pin(r.type),
            overrides: {
              interval_ms: { mode: "set", value: 60000 },
              max_rows: { mode: "set", value: 7 },
              ...overrides,
            },
          },
    changed: Object.keys(overrides),
    retained: ["max_rows"],
    coverage: ["db.uptime_seconds"],
    missing: ["db.connections"],
    cost:
      r.type === "network_device"
        ? null
        : { before: 60, after: 720, estimate: true, unit: "logical_reads_per_hour" },
    settings: {},
    revision: null,
    status: null,
  })),
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"])
    test(`controlled R1 bulk ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const writes: string[] = [];
      const previews: any[] = [];
      let current: any;
      await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith("/api/")) return route.fallback();
        if (path === "/api/database/instances")
          return route.fulfill({
            json: [
              {
                id: 1,
                name: "订单数据库",
                db_type: "mysql",
                db_version: "9.6",
                host: "192.0.2.1",
                port: 3306,
                health_status: "unknown",
              },
            ],
          });
        if (path === "/api/servers")
          return route.fulfill({
            json: [
              {
                id: 2,
                label: "应用服务器",
                host: "192.0.2.2",
                os_type: "linux",
                os_version: "24.04",
                status: "online",
              },
            ],
          });
        if (path === "/api/network-devices")
          return route.fulfill({
            json: [
              {
                id: 3,
                name: "待核验交换机",
                host: "192.0.2.3",
                vendor: "cisco",
                status: "unknown",
              },
            ],
          });
        if (path === "/api/servers/metrics/summary")
          return route.fulfill({ json: { servers: {} } });
        if (path.endsWith("/bulk/preview")) {
          const input = route.request().postDataJSON();
          previews.push(input);
          current = makeJob(input.resources, input.overrides);
          return route.fulfill({ json: current });
        }
        if (path.endsWith("/bulk")) return route.fulfill({ json: { jobs: [] } });
        if (path.endsWith("/confirm")) {
          writes.push(path);
          current = {
            ...current,
            state: "completed",
            items: current.items.map((i: any) =>
              i.state !== "eligible"
                ? i
                : {
                    ...i,
                    state: i.resource.type === "instance" ? "pending_takeover" : "failed",
                    revision: i.resource.type === "instance" ? 2 : null,
                    code: i.resource.type === "server" ? "CONFIGURATION_TRIAL_FAILED" : null,
                  },
            ),
          };
          return route.fulfill({ json: current });
        }
        if (path.endsWith("/retry")) {
          writes.push(path);
          current = makeJob(
            current.items.filter((i: any) => i.state === "failed").map((i: any) => i.resource),
            { interval_ms: { mode: "set", value: 5000 } },
          );
          return route.fulfill({ json: current });
        }
        if (path.endsWith("/controlled-job")) return route.fulfill({ json: current });
        if (path.endsWith("/query"))
          return route.fulfill({ json: { metrics: [], profile: { columns: [] } } });
        return route.fulfill({ json: [] });
      });
      await page.route("**/bulk-fixture", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html lang="zh-CN" data-theme="claw" data-theme-mode="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:16px;background:var(--bg);color:var(--text)"><p>受控 UI 验证 · 非真实业务采集</p><instances-page></instances-page><servers-page></servers-page><network-devices-page></network-devices-page><script type="module">localStorage.setItem('permissions','["*"]');import '/src/app/styles.css';import '/src/app/ui/views/instances-db.ts';import '/src/app/ui/views/servers-page.ts';import '/src/app/ui/views/network-devices-page.ts';</script></body></html>`,
        }),
      );
      await page.goto("/bulk-fixture");
      for (const tag of ["instances-page", "servers-page", "network-devices-page"]) {
        await page
          .locator(tag)
          .getByRole("checkbox", { name: /用于批量绑定/ })
          .check();
      }
      const table = page.locator("instances-page resource-metrics-table");
      const trigger = table.getByRole("button", { name: "批量绑定采集模板", exact: true });
      await trigger.click();
      const dialog = table.locator("metric-bulk-dialog");
      await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toBeEnabled();
      await expect(dialog).toContainText(/3\s*个已选对象/);
      await expect(dialog).toContainText("引擎、版本或能力未知");
      const capture = async (name: string) => {
        await page.evaluate(() => document.fonts.ready);
        const box = await dialog.locator("app-dialog .dialog").boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: info.outputPath(`${name}.png`) });
      };
      await capture("match");
      await dialog.getByText("修改字段（可选）", { exact: false }).click();
      await dialog.getByLabel("批量采集间隔（秒）修改方式", { exact: true }).selectOption("set");
      await dialog.getByLabel("批量采集间隔（秒）", { exact: true }).fill("5");
      await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "重新匹配与预览 →", exact: true }).click();
      await dialog.getByRole("button", { name: "预览变更 →", exact: true }).click();
      await dialog.getByText("覆盖字段详情", { exact: true }).first().click();
      await expect(dialog).toContainText("60 → 5");
      await expect(dialog).toContainText("7 → 7（保留）");
      expect(writes).toHaveLength(0);
      await capture("preview");
      await dialog.getByRole("button", { name: "确认并应用 2 个对象", exact: true }).click();
      await expect(dialog.locator(".notice[role=status]")).toContainText(
        /正式就绪 0\s*· 待正式就绪 1\s*· 失败\s*1/,
      );
      await capture("results");
      expect(writes.filter((w) => w.endsWith("/confirm"))).toHaveLength(1);
      await dialog.getByRole("button", { name: "仅重新预览失败项", exact: true }).click();
      await expect(
        dialog.getByRole("button", { name: "确认并应用 1 个对象", exact: true }),
      ).toBeEnabled();
      expect(writes.filter((w) => w.endsWith("/confirm"))).toHaveLength(1);
      await dialog.getByRole("button", { name: "上一步", exact: true }).click();
      await dialog.getByText("修改字段（可选）", { exact: false }).click();
      await expect(dialog.getByLabel("批量采集间隔（秒）", { exact: true })).toHaveValue("5");
      await dialog.getByLabel("批量采集间隔（秒）", { exact: true }).fill("10");
      await dialog.getByRole("button", { name: "重新匹配与预览 →", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toBeEnabled();
      expect(previews.at(-1).resources).toEqual([{ type: "server", id: 2 }]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });
