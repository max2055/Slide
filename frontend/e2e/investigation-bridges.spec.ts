import { test, expect, type Page } from "@playwright/test";
import { startInvestigationServer } from "./fixtures/investigation-server.ts";

let env: Awaited<ReturnType<typeof startInvestigationServer>>;
test.beforeAll(async () => {
  env = await startInvestigationServer({ databaseAlertPilot: true });
});
test.afterAll(async () => {
  if (env) {
    try {
      expect(env.workerErrors).toEqual([]);
      expect(env.observationErrors).toEqual([]);
    } finally {
      await env.close();
    }
  }
});
async function login(page: Page) {
  await page.addInitScript(
    ({ token, actor }) => {
      localStorage.setItem("token", token);
      localStorage.setItem("user", JSON.stringify({ id: actor.userId, username: actor.username }));
      localStorage.setItem("permissions", JSON.stringify(actor.permissions));
      localStorage.setItem(
        "slide.control.settings.v1",
        JSON.stringify({ locale: "zh-CN", navCollapsed: true }),
      );
    },
    { token: env.token(), actor: env.owner },
  );
}
async function source(metric: string) {
  await env.pool.query("UPDATE investigation_trigger_cooldowns SET cooldown_until='1970-01-01'");
  const [row] = await env.pool.query(
    `INSERT INTO alerts (instance_id,alert_type,level,title,message,status,metric_name,metric_value,threshold_value)
    VALUES (101,'performance','critical',?,?, 'unread',?, '95','80')`,
    [`受控 ${metric} 告警`, "合成 CPU/慢SQL 指标，非外部模型验收", metric],
  );
  return Number(row.insertId);
}
for (const metric of ["cpu_usage", "slow_queries"])
  test(`real SQL ${metric} source → alert UI → same Workspace id → one controlled provider chain`, async ({
    page,
  }) => {
    await login(page);
    const alert = await source(metric),
      before = env.counts();
    const receipt = await env.rca.analyzeAlert(alert, "auto");
    expect(receipt.investigationId).toBeTruthy();
    await expect
      .poll(async () => {
        const [rows] = await env.pool.query(
          "SELECT COUNT(*) n FROM investigation_results WHERE investigation_id=?",
          [receipt.investigationId],
        );
        return Number(rows[0].n);
      })
      .toBe(1);
    await page.goto(`${env.url}/alerts`);
    const list = page.locator("alert-list");
    const row = list.locator("tr").filter({ hasText: `受控 ${metric} 告警` });
    await expect(row).toBeVisible();
    const response = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/alerts/${alert}/investigation`) && r.request().method() === "POST",
    );
    await row.getByRole("button", { name: "AI", exact: true }).click();
    const value = await (await response).json();
    expect(value.investigationId).toBe(receipt.investigationId);
    await expect(page.locator("investigations-page")).toBeVisible();
    await expect(page.locator(".investigation-states")).toContainText("执行完成");
    expect(new URL(page.url()).searchParams.get("investigation")).toBe(receipt.investigationId);
    await page.reload();
    await expect(page.locator(".investigation-states")).toContainText("执行完成");
    const [rows] = await env.pool.query(
      "SELECT COUNT(*) n FROM investigation_requests WHERE investigation_id=?",
      [receipt.investigationId],
    );
    expect(Number(rows[0].n)).toBe(1);
    const [runs] = await env.pool.query(
      "SELECT id FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)",
      [receipt.investigationId],
    );
    expect(runs).toHaveLength(1);
    expect(env.counts().providerCalls - before.providerCalls).toBe(2);
    expect(env.counts().toolCalls - before.toolCalls).toBe(1);
    const [old] = await env.pool.query(
      "SELECT id FROM ai_analysis WHERE related_id=? AND analysis_type='alert_rca'",
      [alert],
    );
    expect(old).toHaveLength(0);
  });
test("flag rollback while real controlled tool is running leaves new job owner intact", async ({
  page,
}) => {
  await login(page);
  const alert = await source("rollback_cpu");
  env.hold(true);
  try {
    const receipt = await env.rca.analyzeAlert(alert, "auto");
    expect(receipt.investigationId).toBeTruthy();
    await expect
      .poll(async () => {
        const [r] = await env.pool.query(
          "SELECT state FROM agent_runs WHERE session_id=(SELECT session_id FROM investigations WHERE id=?)",
          [receipt.investigationId],
        );
        return r[0]?.state;
      })
      .toBe("running");
    env.bridgeFlags.opsAuto = false;
    env.bridgeFlags.manual = false;
    const response = await page.request.post(`${env.url}/api/alerts/${alert}/investigation`, {
      headers: { authorization: `Bearer ${env.token()}` },
      data: {},
    });
    expect(response.status()).toBe(202);
    expect((await response.json()).investigationId).toBe(receipt.investigationId);
    const [old] = await env.pool.query("SELECT id FROM ai_analysis WHERE related_id=?", [alert]);
    expect(old).toHaveLength(0);
    await page.goto(`${env.url}/investigations?investigation=${receipt.investigationId}`);
    await expect(page.locator(".investigation-states")).toContainText("运行中");
    const refused = page.waitForResponse(
      (r) => r.url().includes("/cancel") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "取消本次执行", exact: true }).click();
    expect((await refused).status()).toBe(403); // source grants viewer, not cancel/append authority
    await expect(page.getByRole("button", { name: "取消本次执行", exact: true })).toBeDisabled();
    await env.pool.query(
      "UPDATE investigation_requests SET cancel_requested_at=NOW() WHERE investigation_id=?",
      [receipt.investigationId],
    );
    await expect(page.locator(".investigation-states")).toContainText("已取消");
  } finally {
    env.hold(false);
    env.bridgeFlags.opsAuto = true;
    env.bridgeFlags.manual = true;
  }
});
test("old SQL/health/diagnosis results link lazily, render read-only and never call provider", async ({
  page,
}) => {
  await login(page);
  for (const kind of ["topsql_analysis", "fault_diagnosis", "sql_audit"]) {
    const before = env.counts();
    const [row] = await env.pool.query(
      "INSERT INTO ai_analysis (analysis_type,target_type,instance_id,trigger_type,status,result) VALUES (?,'instance',101,'auto','completed',?)",
      [kind, JSON.stringify(`原 ${kind} 历史报告`)],
    );
    const response = await page.request.post(
      `${env.url}/api/ai/analysis/${row.insertId}/investigation`,
      { headers: { authorization: `Bearer ${env.token()}` } },
    );
    expect(response.status()).toBe(200);
    const link = await response.json();
    await page.goto(`${env.url}/investigations?investigation=${link.id}`);
    await expect(page.locator(".legacy-analysis-result")).toContainText(`原 ${kind} 历史报告`);
    await expect(page.getByRole("button", { name: "提交新 Run", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.locator(".legacy-analysis-result")).toContainText(`原 ${kind} 历史报告`);
    if (kind === "topsql_analysis")
      for (const width of [1600, 1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(".legacy-analysis-result")).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        ).toBe(true);
      }
    const [rows] = await env.pool.query(
      "SELECT id FROM investigation_requests WHERE investigation_id=?",
      [link.id],
    );
    expect(rows).toHaveLength(0);
    expect(env.counts()).toEqual(before);
  }
});
test("same JWT real SQL revoke makes the alert link and Workspace deep link unreadable", async ({
  page,
}) => {
  await login(page);
  const alert = await source("revoke_cpu");
  const receipt = await env.rca.analyzeAlert(alert, "auto");
  expect(receipt.investigationId).toBeTruthy();
  const linked = await page.request.post(`${env.url}/api/alerts/${alert}/investigation`, {
    headers: { authorization: `Bearer ${env.token()}` },
    data: {},
  });
  expect(linked.status()).toBe(202);
  await page.goto(`${env.url}/investigations?investigation=${receipt.investigationId}`);
  await expect(page.locator(".investigation-states")).toBeVisible();
  await env.pool.query("DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101");
  const response = await page.request.post(`${env.url}/api/alerts/${alert}/investigation`, {
    headers: { authorization: `Bearer ${env.token()}` },
    data: {},
  });
  expect(response.status()).toBe(404);
  await page.reload();
  await expect(page.locator("investigations-page")).not.toContainText("受控 revoke_cpu 告警");
  const [old] = await env.pool.query("SELECT id FROM ai_analysis WHERE related_id=?", [alert]);
  expect(old).toHaveLength(0);
});
