import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { MetricBulkResultSchema } from "../../apps/db-ops-api/src/contracts/metrics/bulk.js";

test.skip(
  process.env.MAX191_REAL !== "1",
  "Requires authorized real MySQL/VM validation and a disposable platform",
);
const require = createRequire(resolve("../apps/db-ops-api/package.json"));
const mysql = require("mysql2/promise"),
  bcrypt = require("bcrypt"),
  dotenv = require("dotenv");
const output = process.env.MAX191_OUTPUT_DIR ?? "/Users/max/Coding/40-Slide/outputs/MAX-191-real";
const apiDirectory = resolve("../apps/db-ops-api"),
  api = "http://127.0.0.1:3191",
  site = "http://127.0.0.1:5197";
const schema = `max191_${process.pid}`,
  container = `max191-bulk-${process.pid}`;
const password = randomBytes(24).toString("hex"),
  rootPassword = randomBytes(24).toString("hex");
const lockName = `metric-bulk:${createHash("sha256").update("worker").digest("hex").slice(0, 40)}`;
const children: ChildProcess[] = [];
let source: any,
  pool: any,
  started = false,
  token = "",
  originalDigest = "",
  env: NodeJS.ProcessEnv,
  backend: ChildProcess;
const report: any = {
  product_llm_calls: 0,
  requests: [],
  checks: {},
  captures: [],
  processes: [],
  boundaries: {
    network: "Synthetic inventory without credentials; no physical SNMP target tested",
  },
};
const save = () => writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = async () => {
  const groups = [];
  for (const sql of [
    "SELECT id,name,host,port,username,password_encrypted,db_type,db_version,database_name,environment FROM database_instances WHERE id=1",
    "SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,collection_enabled FROM servers ORDER BY id",
    "SELECT * FROM llm_providers ORDER BY id",
    "SELECT * FROM llm_scene_bindings ORDER BY scene",
    "SELECT * FROM instance_templates WHERE instance_id=1 ORDER BY template_id",
    "SELECT id,target_type,unit,value_type,default_interval,collection_sqls,compute_expr FROM metric_definitions WHERE is_builtin=0 ORDER BY id",
  ])
    groups.push((await source.query(sql))[0]);
  return hash(groups);
};
async function launch(args: string[], cwd: string, environment: NodeJS.ProcessEnv, name: string) {
  const file = await open(`${output}/${name}.private.log`, "w", 0o600);
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: ["ignore", file.fd, file.fd],
  });
  children.push(child);
  await file.close();
  report.processes.push({
    pid: child.pid,
    cwd,
    command: ["node", ...args],
    log: `${name}.private.log`,
  });
  return child;
}
async function ready(url: string, child: ChildProcess) {
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null)
          throw new Error("Task-owned process exited; inspect private log");
        try {
          return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status;
        } catch {
          return 0;
        }
      },
      { timeout: 90000 },
    )
    .toBe(200);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      done();
    }, 10000).unref();
  });
}
async function request(path: string, body?: unknown, auth = token, expected = 200) {
  const response = await fetch(api + path, {
    signal: AbortSignal.timeout(15000),
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  report.requests.push({ path, status: response.status });
  const result = await response.json();
  expect(response.status, `${path}: ${result.error ?? "unexpected status"}`).toBe(expected);
  if (expected === 200 && result.items && path.includes("/bulk/"))
    MetricBulkResultSchema.parse(result);
  return result;
}
const preview = (resources: any[], overrides: any = {}, auth = token) =>
  request("/api/metrics/config/bulk/preview", { key: randomUUID(), resources, overrides }, auth);
const confirm = (p: any, auth = token) =>
  request(`/api/metrics/config/bulk/${p.id}/confirm`, { digest: p.digest }, auth);
async function finished(id: string, auth = token) {
  let result: any;
  await expect
    .poll(
      async () => {
        result = await request(`/api/metrics/config/bulk/${id}`, undefined, auth);
        return result.state;
      },
      { timeout: 90000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/completed|cancelled/);
  return result;
}
async function capture(page: Page, name: string) {
  for (const width of [1440, 390])
    for (const mode of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(async (mode) => {
        const app = document.querySelector("slide-app") as any;
        app.setThemeMode(mode);
        await app.updateComplete;
        await document.fonts.ready;
      }, mode);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (a) =>
                    a.playState === "running" &&
                    a.effect?.getComputedTiming().iterations !== Infinity,
                ).length,
          ),
        )
        .toBe(0);
      const geometry = await page.locator("metric-bulk-dialog app-dialog").evaluate((host: any) => {
        const dialog = host.shadowRoot.querySelector(".dialog") as HTMLElement;
        const rect = dialog.getBoundingClientRect();
        return {
          width: rect.width,
          x: rect.x,
          right: rect.right,
          viewport: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry.x).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.overflow).toBe(false);
      await page.screenshot({ path: `${output}/${name}-${width}-${mode}.png` });
      report.captures.push({ name, width, mode, geometry });
    }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    (document.querySelector("slide-app") as any).setThemeMode("light");
  });
  await save();
}
test.beforeAll(async () => {
  test.setTimeout(240000);
  await mkdir(output, { recursive: true });
  const cfg = dotenv.parse(await readFile(process.env.SLIDE_DEBUG_ENV_FILE!));
  source = mysql.createPool({
    host: cfg.DB_HOST || "127.0.0.1",
    port: Number(cfg.DB_PORT || 3306),
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    database: cfg.DB_NAME,
    timezone: "Z",
    connectTimeout: 5000,
    connectionLimit: 2,
  });
  const sourceQuery = source.query.bind(source);
  source.query = (sql: any, values?: any) =>
    sourceQuery(
      typeof sql === "string" ? { sql, timeout: 8000 } : { ...sql, timeout: 8000 },
      values,
    );
  const [[version]] = await source.query("SELECT VERSION() AS version");
  expect(version.version).toMatch(/^9\.6\./);
  originalDigest = await snapshot();
  report.source_configuration_digest = originalDigest;
  report.code = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diff: hash(execFileSync("git", ["diff"], { encoding: "utf8" })),
  };
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::3306",
      "-e",
      "MYSQL_ROOT_PASSWORD",
      "-e",
      "MYSQL_ROOT_HOST",
      "mysql:8.4",
      "--innodb-buffer-pool-size=64M",
      "--performance-schema=OFF",
    ],
    {
      env: { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_ROOT_HOST: "%" },
      stdio: "pipe",
      timeout: 30000,
    },
  );
  started = true;
  const port = Number(
    execFileSync("docker", ["port", container, "3306/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .at(-1),
  );
  await expect
    .poll(
      async () => {
        try {
          const c = await mysql.createConnection({
            host: "127.0.0.1",
            port,
            user: "root",
            password: rootPassword,
            connectTimeout: 1000,
          });
          await c.end();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 120000 },
    )
    .toBe(true);
  env = {
    ...process.env,
    DB_HOST: "127.0.0.1",
    DB_PORT: String(port),
    DB_USER: "root",
    DB_PASSWORD: rootPassword,
    DB_NAME: schema,
    JWT_SECRET_KEY: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: cfg.ENCRYPTION_KEY,
    PORT: "3191",
    HOST: "127.0.0.1",
    AGENT_WS_PORT: "29991",
    SLIDE_MEMORY_PIPELINE_ENABLED: "false",
    METRICS_COLLECTION_ENABLED: "true",
    INITIAL_ADMIN_USERNAME: "admin",
    INITIAL_ADMIN_PASSWORD: password,
  };
  const migration = await launch(["--import", "tsx", "init-db.ts"], apiDirectory, env, "migration");
  await new Promise<void>((ok, fail) => {
    migration.once("exit", (code) =>
      code === 0 ? ok() : fail(new Error("Disposable migration failed")),
    );
    migration.once("error", fail);
  });
  pool = mysql.createPool({
    host: "127.0.0.1",
    port,
    user: "root",
    password: rootPassword,
    database: schema,
    connectionLimit: 16,
    timezone: "Z",
  });
  await pool.query("UPDATE users SET password_hash=?,status='active' WHERE username='admin'", [
    await bcrypt.hash(password, 10),
  ]);
  await pool.query(
    "INSERT IGNORE INTO user_roles(user_id,role_id) SELECT u.id,r.id FROM users u JOIN roles r ON r.name='admin' WHERE u.username='admin'",
  );
  await pool.query("DELETE FROM llm_scene_bindings");
  await pool.query("DELETE FROM llm_providers");
  for (const table of ["llm_providers", "llm_scene_bindings"]) {
    const [rows] = await source.query("SELECT * FROM ??", [table]);
    const [columns] = await pool.query("SHOW COLUMNS FROM ??", [table]);
    const names = new Set(columns.map((c: any) => c.Field));
    for (const row of rows) {
      const copy = Object.fromEntries(
        Object.entries(row)
          .filter(([k]) => names.has(k))
          .map(([k, v]) => [
            k,
            v && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v,
          ]),
      );
      await pool.query("INSERT INTO ?? SET ?", [table, copy]);
    }
  }
  const [[instance]] = await source.query(
    "SELECT id,name,host,port,username,password_encrypted,db_type,db_version,database_name,environment,status FROM database_instances WHERE id=1",
  );
  await pool.query("INSERT INTO database_instances SET ?", [instance]);
  await pool.query("INSERT INTO database_instances SET ?", [
    { ...instance, id: 2, name: "MAX191 controlled disconnected target", port: 1 },
  ]);
  const [[server]] = await source.query(
    "SELECT * FROM servers WHERE id=3 AND host='192.168.49.130'",
  );
  expect(server).toBeTruthy();
  const [columns] = await pool.query("SHOW COLUMNS FROM servers");
  const names = new Set(columns.map((c: any) => c.Field));
  const copy = Object.fromEntries(Object.entries(server).filter(([key]) => names.has(key)));
  copy.collection_enabled = 1;
  await pool.query("INSERT INTO servers SET ?", [copy]);
  await pool.query(
    "INSERT INTO network_devices(id,name,host,vendor,collection_enabled) VALUES(191,'MAX191 synthetic unknown network','192.0.2.191','huawei',0)",
  );
  report.targets = {
    mysql: { id: 1, host: instance.host, port: instance.port, version: version.version },
    failure: { id: 2, port: 1, controlled: true },
    vm: {
      id: 3,
      host: server.host,
      original_asset_enabled: Boolean(server.collection_enabled),
      copy_asset_enabled: true,
    },
    network: { id: 191, synthetic: true, credentials: false },
  };
  report.fixture = {
    schema,
    container,
    port,
    platform: "MySQL8.4 disposable; original platform read only",
  };
  await save();
  backend = await launch(["--import", "tsx", "server.ts"], apiDirectory, env, "api");
  await ready(api + "/api/health/ready", backend);
  const vite = await launch(
    [
      resolve("node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "5197",
      "--strictPort",
    ],
    resolve("."),
    { ...env, VITE_API_PROXY_TARGET: api, VITE_AGENT_WS_PROXY_TARGET: "http://127.0.0.1:29991" },
    "vite",
  );
  await ready(site, vite);
});
test.afterAll(async () => {
  test.setTimeout(90000);
  for (const child of [...children].reverse()) await stop(child);
  try {
    if (source && originalDigest)
      report.checks.original_configuration_unchanged = (await snapshot()) === originalDigest;
  } catch {
    report.checks.original_configuration_unchanged =
      "unverified: source database unavailable during cleanup";
  } finally {
    await source?.end();
    await pool?.end();
    if (started) {
      execFileSync("docker", ["stop", container], { stdio: "pipe", timeout: 30000 });
      execFileSync("docker", ["rm", "--volumes", container], { stdio: "pipe", timeout: 30000 });
    }
    report.cleanup = {
      containerRemoved: started,
      processes: children.map((c) => ({ pid: c.pid, exitCode: c.exitCode, signal: c.signalCode })),
    };
    await save();
  }
});

test("real bulk workflow, mixed outcomes, retry, cancellation, live grants and restart recovery", async ({
  page,
}) => {
  test.setTimeout(300000);
  page.setDefaultTimeout(20000);
  const stage = async (name: string) => {
    report.stage = name;
    await save();
  };
  await page.addInitScript(() => {
    localStorage.setItem("slide.i18n.locale", "zh-CN");
    (window as any).__bulkEvents = [];
    for (const name of [
      "slide-permissions-loaded",
      "slide-session-expired",
      "slide-bulk-selection-changed",
    ])
      window.addEventListener(name, () => {
        (window as any).__bulkEvents.push({ name, at: performance.now() });
      });
  });
  await page.goto(site + "/instances-db");
  await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  const login = page.waitForResponse((r) => r.url().endsWith("/api/auth/login"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  expect((await login).status()).toBe(200);
  token = await page.evaluate(() => localStorage.getItem("token") ?? "");
  expect(token).not.toBe("");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const app = document.querySelector("slide-app") as any;
        return app.connected && !app.permissionsLoading && app.userPermissions?.size > 0;
      }),
    )
    .toBe(true);
  await stage("representative MySQL UI");
  await page.getByRole("checkbox", { name: /选择mysql.*用于批量绑定/ }).check();
  report.selectionDiagnostics = await page
    .locator("resource-metrics-table")
    .evaluate((table: any) => {
      return {
        events: (window as any).__bulkEvents,
        selection: table.shadowRoot.querySelector('[aria-label="批量采集配置"]')?.textContent,
        inputs: [...table.shadowRoot.querySelectorAll("input")].map((i: any) => ({
          label: i.getAttribute("aria-label"),
          checked: i.checked,
        })),
      };
    });
  await save();
  await page.getByRole("button", { name: "批量绑定采集模板", exact: true }).click();
  const dialog = page.locator("metric-bulk-dialog");
  await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toBeEnabled();
  await capture(page, "mysql-match");
  await dialog.getByText("修改字段（可选）", { exact: false }).click();
  await dialog.getByLabel("批量采集间隔（秒）修改方式", { exact: true }).selectOption("set");
  await dialog.getByLabel("批量采集间隔（秒）", { exact: true }).fill("5");
  await dialog.getByLabel("批量超时（秒）修改方式", { exact: true }).selectOption("set");
  await dialog.getByLabel("批量超时（秒）", { exact: true }).fill("5");
  await dialog.getByRole("button", { name: "重新匹配与预览 →", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "预览变更 →", exact: true }).click();
  await capture(page, "mysql-preview");
  const queued = page.waitForResponse(
    (r) => r.url().includes("/bulk/") && r.url().endsWith("/confirm"),
  );
  await dialog.getByRole("button", { name: "确认并应用 1 个对象", exact: true }).click();
  const queuedJob = await (await queued).json();
  const first = await finished(queuedJob.id);
  report.representative = first;
  await save();
  expect(first.items[0].revision).toBe(1);
  expect(first.items[0].state).toMatch(/succeeded|pending_takeover/);
  await expect
    .poll(
      async () => {
        const status = await request("/api/metrics/config/resources/instance/1/status");
        report.mysql_formal_status = status;
        await save();
        return status.formal_visibility.state;
      },
      { timeout: 90000, intervals: [2000] },
    )
    .toBe("available");
  await dialog.getByRole("button", { name: "刷新逐对象状态", exact: true }).click();
  await capture(page, "mysql-results");
  report.checks.mysql_representative = true;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "批量绑定采集模板", exact: true })).toBeFocused();
  await stage("mixed resource lists and partial results");
  await page.locator('a.nav-item[href="/servers"]').click();
  await expect(page.locator("servers-page")).toBeVisible();
  await page
    .getByRole("checkbox", { name: /用于批量绑定/ })
    .first()
    .check();
  await page.locator('a.nav-item[href="/network-devices"]').click();
  await page
    .getByRole("checkbox", { name: /用于批量绑定/ })
    .first()
    .check();
  await page.getByRole("button", { name: "批量绑定采集模板", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "预览变更 →", exact: true })).toBeEnabled();
  const mixedPreview = await dialog.evaluate((el: any) => el.job);
  expect(mixedPreview.items.map((i: any) => i.resource.type).sort()).toEqual([
    "instance",
    "network_device",
    "server",
  ]);
  expect(mixedPreview.items.find((i: any) => i.resource.type === "network_device").state).toBe(
    "unsupported",
  );
  await capture(page, "mixed-match");
  await dialog.getByRole("button", { name: "预览变更 →", exact: true }).click();
  const mixedQueued = page.waitForResponse((r) => r.url().endsWith("/confirm"));
  await dialog.getByRole("button", { name: "确认并应用 2 个对象", exact: true }).click();
  const mixed = await finished((await (await mixedQueued).json()).id);
  report.mixed = mixed;
  expect(mixed.items.find((i: any) => i.resource.type === "server").revision).toBe(1);
  await expect
    .poll(
      async () => {
        report.vm_formal_status = await request("/api/metrics/config/resources/server/3/status");
        await save();
        return report.vm_formal_status.formal_visibility.state;
      },
      { timeout: 120000, intervals: [2000] },
    )
    .toBe("available");
  report.checks.vm_formal_available = true;
  report.mixed_formal = await request(`/api/metrics/config/bulk/${mixed.id}`);
  expect(report.mixed_formal.items.find((i: any) => i.resource.type === "server").state).toBe(
    "succeeded",
  );
  await dialog.getByRole("button", { name: "刷新逐对象状态", exact: true }).click();
  await capture(page, "mixed-results");
  await page.keyboard.press("Escape");
  const timing = {
    interval_ms: { mode: "set", value: 5000 },
    timeout_ms: { mode: "set", value: 5000 },
  };
  const partial = await preview(
    [
      { type: "instance", id: 1 },
      { type: "instance", id: 2 },
    ],
    timing,
  );
  await confirm(partial);
  const partialResult = await finished(partial.id);
  expect(partialResult.items.map((i: any) => i.state)).toEqual([
    expect.stringMatching(/succeeded|pending_takeover/),
    "failed",
  ]);
  report.partial = partialResult;
  await stage("conflict and fresh failed-only retry");
  const conflict = await preview([{ type: "instance", id: 1 }], timing);
  await request("/api/metrics/config/resources/instance/1/activate", {
    ...conflict.items[0].change,
    overrides: { ...conflict.items[0].change.overrides, max_rows: { mode: "set", value: 7 } },
  });
  await confirm(conflict);
  const conflictResult = await finished(conflict.id);
  expect(conflictResult.items[0].code).toBe("POLICY_REVISION_CONFLICT");
  const retry = await request(`/api/metrics/config/bulk/${conflict.id}/retry`, {
    key: randomUUID(),
  });
  expect(retry.state).toBe("draft");
  expect(retry.items[0].change.overrides.max_rows).toEqual({ mode: "set", value: 7 });
  await confirm(retry);
  const retried = await finished(retry.id);
  expect(retried.items[0].state).toMatch(/succeeded|pending_takeover/);
  report.retry = { conflict: conflictResult, retry: retried };
  await stage("durable cancellation and restart");
  const connection = await pool.getConnection();
  await connection.execute("SELECT GET_LOCK(?,0)", [lockName]);
  try {
    const cancel = await preview([{ type: "instance", id: 1 }], timing);
    await confirm(cancel);
    await request(`/api/metrics/config/bulk/${cancel.id}/cancel`, {});
    const recovering = await preview([{ type: "instance", id: 1 }], timing);
    await confirm(recovering);
    const [[row]] = await pool.query("SELECT state FROM metric_bulk_jobs WHERE id=?", [
      recovering.id,
    ]);
    expect(row.state).toBe("queued");
    await stop(backend);
    backend = await launch(["--import", "tsx", "server.ts"], apiDirectory, env, "api-restarted");
    await ready(api + "/api/health/ready", backend);
    await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    expect((await finished(cancel.id)).items[0].state).toBe("cancelled");
    const restored = await finished(recovering.id);
    expect(restored.items[0].state).toMatch(/succeeded|pending_takeover/);
    report.recovery = restored;
    report.checks.restart_and_cancel = true;
  } finally {
    await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    connection.release();
  }
  await stage("live permission revocation");
  const userPassword = randomBytes(24).toString("hex");
  const [user] = await pool.query(
    "INSERT INTO users(username,password_hash,status) VALUES('max191_operator',?,'active')",
    [await bcrypt.hash(userPassword, 10)],
  );
  const [role] = await pool.query("INSERT INTO roles(name) VALUES('max191_operator')");
  await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES(?,?)", [
    user.insertId,
    role.insertId,
  ]);
  await pool.query(
    "INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('instance:manage','instance:view')",
    [role.insertId],
  );
  await pool.query(
    "INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(?,1,'admin')",
    [user.insertId],
  );
  const actorLogin = await request(
    "/api/auth/login",
    { username: "max191_operator", password: userPassword },
    "",
  );
  const operator = actorLogin.token ?? actorLogin.accessToken;
  expect(operator).toBeTruthy();
  const lock = await pool.getConnection();
  await lock.execute("SELECT GET_LOCK(?,0)", [lockName]);
  try {
    const restricted = await preview([{ type: "instance", id: 1 }], {}, operator);
    await confirm(restricted, operator);
    await pool.query("DELETE FROM instance_permissions WHERE user_id=?", [user.insertId]);
    await lock.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    const revoked = await finished(restricted.id, operator);
    expect(revoked.items[0]).toMatchObject({
      state: "failed",
      code: "POLICY_FORBIDDEN",
      before: null,
      change: null,
      choices: [],
    });
    report.revoked = revoked;
    await request(`/api/metrics/config/bulk/${restricted.id}`, undefined, token, 404);
  } finally {
    await lock.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    lock.release();
  }
  const [[audit]] = await pool.query(
    "SELECT COUNT(*) AS total,COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.request_id'))) AS distinct_requests FROM metric_policy_audit WHERE target='instance:1' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.request_id')) LIKE 'bulk:%'",
  );
  expect(Number(audit.total)).toBe(Number(audit.distinct_requests));
  report.checks.unique_bulk_publications = audit;
  report.checks.original_configuration_unchanged = (await snapshot()) === originalDigest;
  expect(report.checks.original_configuration_unchanged).toBe(true);
  await stage("complete");
});
