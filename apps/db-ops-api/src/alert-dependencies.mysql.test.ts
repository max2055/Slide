/** Isolated real Lit -> JWT -> Fastify -> MySQL; controlled read-only SQL transport, local owned worker only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import Fastify from "fastify";
import mysql from "mysql2/promise";
import { it, vi } from "vitest";
import { registerAlertDependencyRoutes } from "./alert-dependency-routes.js";
import { registerAlertEscalationRoute } from "./alert-escalation-routes.js";
import { createVerifyToken } from "./auth-middleware.js";
import { actorContextService, signAccessToken } from "./auth/actor-context.js";
import { requirePermission } from "./auth/require-permission.js";
import { AlertDependencySchemas } from "./contracts/alert-dependencies.js";
import { dbConnection } from "./db-connection.js";
import {alertEngine} from "./alert-engine.js";
import {alertDatabaseService} from "./alert-database-service.js";
import { MaintenanceIntervals } from "./maintenance-intervals.js";
import { registerMaintenanceRoutes } from "./maintenance-routes.js";
import { assetCollectionEnabled } from "./metrics/config/effective-state.js";
import { configurationInventory } from "./metrics/config/inventory.js";
import { createConfigurationRegistry } from "./metrics/config/registry.js";
import { MetricScheduler } from "./metrics/scheduler/service.js";
import { MysqlScheduleStore } from "./metrics/scheduler/store.js";
import { TemplateBindingService } from "./metrics/templates/binding-service.js";
import { CollectNowService, createCollectNowAuthorizer } from "./metrics/templates/collect-now.js";
import { TemplateGovernance } from "./metrics/templates/governance.js";
import { MySqlTemplateRepository } from "./metrics/templates/mysql-repository.js";
import { registerMetricTemplateRoutes } from "./metrics/templates/routes.js";
import { MetricTemplateService } from "./metrics/templates/service.js";
import { registerTemplateTriggerRoutes } from "./metrics/triggers/routes.js";
import { evaluateTemplateClock } from "./metrics/triggers/runtime.js";
import { MigrationRunner } from "./migrations/runner.js";
import { notificationDatabaseService } from "./notification-database-service.js";
import { notificationService } from "./notification-service.js";
import * as outbound from "./security/outbound-policy.js";
import { createOwnedDatabase } from "./testing/owned-fixture.js";
import { registerDeliveryRoutes } from "./workflows/delivery-routes.js";
import { JobRegistry } from "./workflows/job-registry.js";
import { registerNotificationHandlers } from "./workflows/notification-handlers.js";
import { NotificationDispatchScheduler } from "./workflows/notification-dispatch.js";
import { MysqlWorkflowStore, WorkerRuntime } from "./workflows/worker-runtime.js";
vi.mock("node:https", async (original) => {
  const actual = await original<typeof import("node:https")>();
  return { ...actual, request: vi.fn(actual.request) };
});
it.skipIf(process.env.MAX244_DEPENDENCIES !== "1")(
  "MAX244 real dependency and notification user flow",
  async () => {
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const nonce = randomBytes(8).toString("hex"),
      directory = resolve("/Users/max/Coding/40-Slide/outputs/max244-dependencies-" + nonce);
    mkdirSync(directory, { recursive: true });
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const handle = {
      nonce,
      pid: process.pid,
      cwd: process.cwd(),
      container: "",
      schema: "",
      port: 0,
      api: "",
      frontend: "",
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    };
    const save = () =>
      writeFileSync(resolve(directory, "lifecycle.json"), JSON.stringify(handle, null, 2));
    save();
    let root: mysql.Pool | undefined,
      owned: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined,
      vite: any,
      browser: any;
    let receiver: http.Server | undefined;
    const app = Fastify();
    let pool: mysql.Pool;
    let failures = 0;
    try {
      handle.container = docker(
        "run",
        "-d",
        "--rm",
        "--label",
        `slide.max244.nonce=${nonce}`,
        "-e",
        "MYSQL_ALLOW_EMPTY_PASSWORD=yes",
        "-p",
        "127.0.0.1::3306",
        "mysql:8.4",
      );
      save();
      handle.port = Number(docker("port", handle.container, "3306/tcp").split(":").at(-1));
      assert(handle.port !== 3306 && handle.port > 0);
      save();
      root = mysql.createPool({ host: "127.0.0.1", port: handle.port, user: "root", password: "" });
      const deadline = Date.now() + 45000;
      for (;;) {
        try {
          await root.query("SELECT 1");
          break;
        } catch (e) {
          if (Date.now() > deadline) throw e;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      owned = await createOwnedDatabase(root as any, {
        nonce,
        purpose: "dependencies",
        handleDir: directory,
      });
      handle.schema = owned.database;
      save();
      assert(
        await dbConnection.initialize({
          host: "127.0.0.1",
          port: handle.port,
          user: "root",
          password: "",
          database: owned.database,
        }),
      );
      pool = dbConnection.getPool()!;
      await new MigrationRunner(pool as any).run();
      await pool.query(
        "INSERT INTO users(id,username,password_hash) VALUES(701,'operator','no-login'),(702,'A-only','no-login')",
      );
      await pool.query("INSERT INTO roles(id,name) VALUES(701,'noise-fixture')");
      await pool.query(
        "INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('metric:view','指标读取','metric','view'),('metric:manage','指标配置','metric','manage'),('instance:manage','实例管理','instance','manage'),('alert:manage','问题管理','alert','manage'),('notification:view','投递读取','notification','view'),('notification:manage','投递管理','notification','manage'),('maintenance:manage','维护管理','maintenance','manage')",
      );
      await pool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('metric:view','metric:manage','instance:manage','alert:manage','notification:view','notification:manage','maintenance:manage')",
      );
      await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES(701,701),(702,701)");
      await pool.query(
        "INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,username,password_encrypted,status,lifecycle_state) VALUES(701,'上游 A','testing','mysql','9.6','fixture.invalid',1,'fixture','','active','available'),(702,'下游 B','testing','mysql','9.6','fixture.invalid',1,'fixture','','active','available'),(703,'无权 C','testing','mysql','9.6','fixture.invalid',1,'fixture','','active','available')",
      );
      await pool.query(
        "INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,701,'read-write'),(701,702,'read-write'),(702,701,'read-write')",
      );
      const actor = (await actorContextService.loadActiveActor(701))!,
        other = (await actorContextService.loadActiveActor(702))!;
      const secret = randomBytes(32).toString("hex"),
        token = signAccessToken(actor, secret),
        otherToken = signAccessToken(other, secret),
        verify = createVerifyToken(secret);
      const ref = (id: number) => ({ type: "instance" as const, id });
      const endpoint = (id: number) => ({ resource: ref(id), rule_id: "*" });
      const value = { name: "上游 A → 下游 B", upstream: endpoint(701), downstream: endpoint(702) };
      await registerAlertDependencyRoutes(app, verify);
      await registerAlertEscalationRoute(app, verify);
      let now = Date.now();
      const maintenance = new MaintenanceIntervals(
        () => pool,
        () => now,
      );
      await registerMaintenanceRoutes(app, verify, maintenance);
      registerDeliveryRoutes(app, { verifyToken: verify, requirePermission });
      const trace: any[] = [];
      const record = () =>
        writeFileSync(resolve(directory, "trace.json"), JSON.stringify(trace, null, 2));
      const api = async (method: string, url: string, payload?: any, t = token) => {
        const r = await app.inject({
          method: method as any,
          url,
          headers: { authorization: `Bearer ${t}` },
          payload,
        });
        const body = r.json();
        if (r.statusCode === 200) {
          if (url === "/api/alerts/dependencies")
            (method === "GET"
              ? AlertDependencySchemas.AlertDependencyList
              : AlertDependencySchemas.AlertDependencyResult
            ).parse(body);
          if (url === "/api/notification/deliveries")
            AlertDependencySchemas.NotificationDeliveryList.parse(body);
        }
        trace.push({ method, url, status: r.statusCode, body });
        record();
        return { status: r.statusCode, body };
      };
      const post = async (url: string, payload: any) => {
        const r = await api("POST", url, payload);
        assert.equal(r.status, 200, JSON.stringify(r));
        return r.body;
      };
      const registry = createConfigurationRegistry(),
        inventory = configurationInventory,
        values = new Map([
          [701, 60],
          [702, 60],
        ]);
      let reads = 0;
      const access = {
        resolve: async (r: any) => ({
          resource: await inventory(r),
          credential_ref: "credential:fixture",
          evidence: {},
          resolve: async () => ({
            method: "sql",
            pool: {
              query: async () => {
                reads++;
                return [
                  [
                    { Variable_name: "Uptime", Value: String(values.get(r.id)) },
                    { Variable_name: "Queries", Value: "100" },
                  ],
                  [],
                ];
              },
            },
          }),
        }),
      };
      const reload = (a: typeof actor) => actorContextService.revalidateActor(a),
        reloadOn = (a: typeof actor, c: any) =>
          actorContextService.revalidateActorOn(c, a, a.requestId, true);
      const binding = new TemplateBindingService({
          pool: () => pool,
          registry,
          access: access as any,
          inventory,
          reload,
          reloadOn,
          reloadOnLocked: reloadOn,
        }),
        repository = new MySqlTemplateRepository(pool),
        templates = new MetricTemplateService(repository, registry);
      const collect = new CollectNowService({ pool: () => pool, registry, reload, reloadOn });
      await registerMetricTemplateRoutes(app, verify, binding, collect);
      await registerTemplateTriggerRoutes(app, verify, () => pool);
      const template = await templates.create(actor, { name: "依赖验收模板" }),
        pkg = registry
          .list()
          .map((v) => v.package)
          .find((v) => v.id === "mysql-basic" && v.version === "2.0.0")!;
      const selected = await templates.selectMetric(actor, template.template_id, {
        item_id: "uptime",
        package: { id: pkg.id, version: pkg.version, digest: pkg.digest },
        metric: { id: "db.uptime_seconds", semantic_version: "1.0.0" },
      });
      const draft = (await repository.getDraft(template.template_id))!;
      await templates.updateDraft(actor, template.template_id, {
        expected_draft_revision: draft.revision,
        aggregate: {
          ...draft.aggregate,
          items: [{ item_id: selected.item.item_id, version: selected.item.version }],
        },
      });
      const published = await templates.publish(actor, template.template_id, {
        expected_draft_revision: (await repository.getDraft(template.template_id))!.revision,
        expected_revision: 0,
      });
      const v = (await repository.getVersion(template.template_id, published.version))!;
      const triggered = await post(`/api/metrics/templates/${template.template_id}/triggers`, {
        expected_version: published.version,
        expected_content_hash: v.content_hash,
        item_id: v.items[0].item_id,
        parameters: {
          schema: { high: { type: "number" }, low: { type: "number" } },
          defaults: { high: 90, low: 70 },
        },
        problem: {
          node: "compare",
          select: { aggregation: "last" },
          operator: ">",
          threshold: { kind: "parameter", name: "high" },
        },
        recovery: {
          node: "compare",
          select: { aggregation: "last" },
          operator: "<",
          threshold: { kind: "parameter", name: "low" },
        },
        quality: { accepted_quality: ["good"], min_coverage: 1, allow_estimated: false },
        clock: { stale_after_ms: 120000, nodata: { enabled: false } },
      });
      const governance = new TemplateGovernance(() => pool, binding);
      const batch = await governance.create(actor, {
        operation_key: randomUUID(),
        pins: [
          {
            template_id: template.template_id,
            version: triggered.version,
            content_hash: triggered.content_hash,
          },
        ],
        resources: [701, 702].map((id) => ({ resource: ref(id), expected_revision: 0 })),
      });
      for (const id of [701, 702])
        await governance.step(actor, batch.id, ref(id), "apply", randomUUID());
      const jobs = new JobRegistry();
      new MetricScheduler(
        new MysqlScheduleStore(pool, registry, "production"),
        registry,
        access as any,
        () => now,
        undefined,
        undefined,
        createCollectNowAuthorizer({
          loadActor: (id, v) => actorContextService.loadActiveActor(id, v),
          loadActorOn: (c, id, v) =>
            actorContextService.loadActiveActorOn(c as any, id, v, undefined, true),
        }),
      ).register(jobs);
      registerNotificationHandlers(jobs, notificationDatabaseService, notificationService, {
        getReportById: async () => null,
      } as any);
      const store = new MysqlWorkflowStore(() => pool as any);
      let worker = new WorkerRuntime(store, "owned-" + nonce, 30);
      const heldKeys = new Set<string>();
      const run = async () => {
        // The queue claims at NOW() (whole seconds), whereas immediate enqueues
        // carry milliseconds. Advance only this owned fixture's immediate
        // notification lane to the controlled ready boundary; never alter production predicates.
        await pool.query("UPDATE workflow_jobs SET available_at=LEAST(available_at,NOW()) WHERE job_type='notification.deliver' AND state='queued'" + (heldKeys.size ? ` AND idempotency_key NOT IN (${[...heldKeys].map(() => '?').join(',')})` : ''), [...heldKeys]);
        return worker.runOnce((j,c)=>jobs.execute(j,c),Date.now());
      };
      const formal = async (id: number, key: string, value: number) => {
        values.set(id, value);
        now += 1000;
        await collect.collect(actor, ref(id), { caller_key: key, expected_revision: 1 });
        let result: any;
        for (let n = 0; n < 35; n++) {
          await run();
          result = await collect.task(actor, ref(id), key);
          if (["completed", "failed"].includes(result.state)) break;
          await new Promise((r) => setTimeout(r, 40));
        }
        assert.equal(result.state, "completed", JSON.stringify(result));
        trace.push({ formal: id, key, value, state: result.state });
        return result;
      };
      const scalar = async (sql: string, params: any[] = []) => {
        const [r] = await pool.query<any[]>(sql, params);
        return Number(r[0].n);
      };
      const episodes = async (id: number) => {
        const [r] = await pool.query<any[]>(
          "SELECT * FROM metric_trigger_episodes WHERE resource_key=? ORDER BY event_id",
          [`instance:${id}`],
        );
        return r.map((v) => ({
          ...v,
          payload: typeof v.payload === "string" ? JSON.parse(v.payload) : v.payload,
        }));
      };
      // Isolated receiver persists deduplication before deliberately dropping one response.
      await pool.query(
        "CREATE TABLE max244_receiver_receipts (business_key VARCHAR(128) PRIMARY KEY,body JSON NOT NULL,requests INT NOT NULL,received_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))",
      );
      let lose = true;
      receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          void (async () => {
            const key = String(req.headers["idempotency-key"] ?? "");
            assert(key);
            const [prior]=await pool.query<any[]>('SELECT body FROM max244_receiver_receipts WHERE business_key=?',[key]);
            if(prior.length)assert.deepEqual(typeof prior[0].body==='string'?JSON.parse(prior[0].body):prior[0].body,JSON.parse(body));
            await pool.execute(
              "INSERT INTO max244_receiver_receipts(business_key,body,requests) VALUES(?,?,1) ON DUPLICATE KEY UPDATE requests=requests+1",
              [key, body],
            );
            if (lose) {
              lose = false;
              res.destroy();
            } else {
              res.writeHead(200);
              res.end("{}");
            }
          })().catch((e) => {
            trace.push({ receiver_error: String(e) });
            res.destroy();
          });
        });
      });
      await new Promise<void>((resolve) => receiver!.listen(0, "127.0.0.1", resolve));
      const receiverPort = (receiver.address() as any).port;
      vi.spyOn(outbound, "resolveOutboundTarget").mockImplementation(async (url) => ({
        url: new URL(url),
        addresses: ["127.0.0.1"],
      }));
      vi.mocked(https.request).mockImplementation(((options: any, callback: any) =>
        http.request(
          {
            ...options,
            protocol: "http:",
            hostname: "127.0.0.1",
            port: receiverPort,
            lookup: undefined,
          },
          callback,
        )) as any);
      await pool.execute(
        "INSERT INTO notification_channels(id,name,type,enabled,config,delivery_start_at) VALUES(701,'受控本机接收端','webhook',1,?,'2026-01-01')",
        [
          JSON.stringify({
            webhook_url: "https://receiver.fixture.invalid/",
            idempotency_contract: "receiver-deduplicates",
            idempotency_retention_seconds: 120,
          }),
        ],
      );
      await formal(702, "old-b", 95);
      const oldB = (await episodes(702))[0];
      assert(oldB);
      // Response applied at receiver but lost: restart worker and retry the SAME durable identity.
      await run();
      assert.equal(
        await scalar("SELECT COUNT(*) n FROM notification_delivery_states WHERE state='unknown'"),
        1,
      );
      worker = new WorkerRuntime(
        new MysqlWorkflowStore(() => pool as any),
        "restarted-" + nonce,
        30,
      );
      await pool.query(
        "UPDATE workflow_jobs SET available_at=NOW() WHERE job_type='notification.deliver' AND state='retry'",
      );
      await run();
      assert.equal(await scalar("SELECT COUNT(*) n FROM max244_receiver_receipts"), 1);
      assert.equal(await scalar("SELECT SUM(requests) n FROM max244_receiver_receipts"), 2);
      assert.equal(
        await scalar("SELECT COUNT(*) n FROM notification_delivery_states WHERE state='sent'"),
        1,
      );
      await formal(701, "upstream-open", 95);
      await run();
      // Existing downstream problem is retained after dependency creation and acknowledgement.
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      handle.api = address;
      save();
      const { createServer } =
        await import("../../../frontend/node_modules/vite/dist/node/index.js");
      vite = await createServer({
        configFile: false,
        root: resolve("../../frontend"),
        server: { host: "127.0.0.1", port: 0, proxy: { "/api": address } },
      });
      await vite.listen();
      handle.frontend = `http://127.0.0.1:${vite.httpServer.address().port}`;
      save();
      const req = createRequire(resolve("../../frontend/package.json"));
      const { chromium } = req("@playwright/test");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(15000);
      await page.addInitScript((t) => (globalThis as any).localStorage.setItem("token", t), token);
      await page.goto(handle.frontend + "/e2e/fixtures/max244-dependencies.html");
      await page.getByText("暂无依赖，请选择有管理权限的上下游资源。").waitFor();
      const fill = async () => {
        await page.getByRole("button", { name: "新增依赖", exact: true }).click();
        await page.getByLabel("依赖名称", { exact: true }).fill(value.name);
        await page.getByLabel("上游资源", { exact: true }).selectOption("instance:701");
        await page.getByLabel("下游资源", { exact: true }).selectOption("instance:702");
      };
      await fill();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await scalar("SELECT COUNT(*) n FROM alert_dependencies"), 0);
      // Real save succeeds while browser response is lost; query intent recovers without another audit.
      await fill();
      const depRoute = "**/api/alerts/dependencies";
      await page.route(depRoute, async (route) => {
        if (route.request().method() === "POST") {
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
      await page.getByRole("button", { name: "保存依赖", exact: true }).click();
      await page.getByText("结果未知，请核对原操作，勿重复新建。").waitFor();
      await page.unroute(depRoute);
      assert.equal(await scalar("SELECT COUNT(*) n FROM alert_dependency_audit"), 1);
      await page.getByRole("button", { name: "核对操作结果", exact: true }).click();
      await page.getByRole("cell", { name: value.name }).waitFor();
      assert.equal(await scalar("SELECT COUNT(*) n FROM alert_dependency_audit"), 1);
      const dep = (await api("GET", "/api/alerts/dependencies")).body[0];
      assert.equal(
        (await api("GET", "/api/alerts/dependencies", undefined, otherToken)).body.length,
        0,
      );
      assert.equal(
        (
          await api(
            "POST",
            "/api/alerts/dependencies",
            { operation_key: randomUUID(), expected_revision: 0, value },
            otherToken,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api("POST", "/api/alerts/dependencies", {
            operation_key: randomUUID(),
            expected_revision: 0,
            value: { ...value, downstream: endpoint(703) },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("POST", "/api/alerts/dependencies", {
            operation_key: randomUUID(),
            expected_revision: 0,
            value: { ...value, upstream: endpoint(702), downstream: endpoint(701) },
          })
        ).status,
        409,
      );
      const upstream = (await episodes(701))[0];
      await pool.execute(
        "UPDATE alerts SET status='acknowledged',acknowledged_by=701,acknowledged_at=NOW() WHERE id=?",
        [upstream.alert_id],
      );
      await formal(702, "existing-still-open", 96);
      assert.equal((await episodes(702)).length, 1);
      assert.equal((await episodes(702))[0].payload.state, "open");
      await formal(702, "old-b-recovered", 60);
      await run();
      assert.equal((await episodes(702))[0].payload.state, "closed");
      await formal(702, "new-b-blocked", 95);
      assert.equal((await episodes(702)).length, 1);
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM alert_dependency_decisions WHERE JSON_EXTRACT(payload,'$.blocked')=true",
        ),
        1,
      );
      await formal(701, "upstream-recovered", 60);
      await run();
      await formal(702, "new-b-unblocked", 96);
      await run();
      assert.equal((await episodes(702)).length, 2);
      // Escalation is atomic and idempotent even when repeated or concurrent.
      const newB = (await episodes(702)).at(-1)!;
      const esc = await Promise.all([
        api("POST", `/api/alerts/${newB.alert_id}/escalate`, { new_level: "error" }),
        api("POST", `/api/alerts/${newB.alert_id}/escalate`, { new_level: "error" }),
      ]);
      assert(esc.every((r) => r.status === 200));
      assert.equal(esc.filter((r) => r.body.changed).length, 1);
      await run();
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM alert_event_logs WHERE alert_id=? AND action='escalated'",
          [newB.alert_id],
        ),
        1,
      );
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM notification_delivery_states WHERE business_key=? AND state='sent'",
          [`notification:${newB.alert_id}:701:escalation-error`],
        ),
        1,
      );
      // Maintenance keeps existing and fresh problem facts; expiry does not replay suppressed messages.
      const window = await post("/api/maintenance-windows", {
        operation_key: randomUUID(),
        expected_revision: 0,
        value: {
          name: "降噪维护",
          reason: "受控时钟边界",
          resources: [ref(702)],
          starts_at: new Date(now - 1000).toISOString(),
          ends_at: new Date(now + 5000).toISOString(),
          timezone: "Asia/Shanghai",
        },
      });
      assert(await assetCollectionEnabled(pool, ref(702)));
      await formal(702, "maintenance-recover", 60);
      await run();
      await formal(702, "maintenance-problem", 95);
      const maintained = (await episodes(702)).at(-1)!;
      assert.notEqual(maintained.alert_id, newB.alert_id);
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM workflow_jobs WHERE job_type='notification.deliver' AND JSON_EXTRACT(payload,'$.alertId')=?",
          [maintained.alert_id],
        ),
        0,
      );
      now += 6000;
      await evaluateTemplateClock(pool, now);
      await formal(702, "maintenance-expired-still-problem", 96);
      await run();
      assert.equal((await episodes(702)).length, 3);
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM workflow_jobs WHERE job_type='notification.deliver' AND JSON_EXTRACT(payload,'$.alertId')=?",
          [maintained.alert_id],
        ),
        0,
      );
      const [notifyJobs] = await pool.query<any[]>(
        "SELECT id FROM workflow_jobs WHERE job_type='notification.deliver' AND JSON_EXTRACT(payload,'$.alertId')=? AND JSON_EXTRACT(payload,'$.transition') IS NULL",
        [newB.alert_id],
      );
      assert.equal(notifyJobs.length, 1);
      const replayId = notifyJobs[0].id;
      await pool.execute("UPDATE workflow_jobs SET state='dead_letter' WHERE id=?", [replayId]);
      assert.equal(
        (
          await api(
            "POST",
            `/api/notification/jobs/${replayId}/replay`,
            { reason: "越权负例" },
            otherToken,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api("POST", `/api/notification/jobs/${replayId}/replay`, {
            reason: "已发送不能重放",
          })
        ).status,
        409,
      );
      await pool.execute(
        "UPDATE notification_delivery_states SET state='retryable' WHERE workflow_job_id=?",
        [replayId],
      );
      const replayResults = await Promise.all(
        ["受控重试", "并发受控重试"].map((reason) =>
          api("POST", `/api/notification/jobs/${replayId}/replay`, { reason }),
        ),
      );
      assert.deepEqual(replayResults.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        await scalar(
          "SELECT COUNT(*) n FROM notification_delivery_replays WHERE workflow_job_id=?",
          [replayId],
        ),
        1,
      );
      await run();
      assert.equal(
        await scalar("SELECT COUNT(*) n FROM max244_receiver_receipts WHERE business_key=?", [
          `notification:${newB.alert_id}:701`,
        ]),
        1,
      ); // Same identity; receiver retains exactly one effect.
      // Actual owned-schema fault: unknown maintenance must preserve samples/problem facts and suppress delivery.
      await formal(702, "before-unknown-recover", 60);
      await run();
      await pool.query("RENAME TABLE maintenance_interval_history TO max244_hidden_intervals");
      try {
        await formal(702, "unknown-maintenance-problem", 95);
        const fact = (await episodes(702)).at(-1)!;
        const [alerts] = await pool.query<any[]>("SELECT tags FROM alerts WHERE id=?", [
          fact.alert_id,
        ]);
        const tags =
          typeof alerts[0].tags === "string" ? JSON.parse(alerts[0].tags) : alerts[0].tags;
        assert.equal(tags.maintenance.state, "unknown");
        assert.equal(
          await scalar(
            "SELECT COUNT(*) n FROM workflow_jobs WHERE job_type='notification.deliver' AND JSON_EXTRACT(payload,'$.alertId')=?",
            [fact.alert_id],
          ),
          0,
        );
      } finally {
        await pool.query("RENAME TABLE max244_hidden_intervals TO maintenance_interval_history");
      }
      await pool.query("RENAME TABLE alert_dependencies TO max244_hidden_dependencies");
      try {
        assert.equal((await api("GET", "/api/alerts/dependencies")).status, 503);
      } finally {
        await pool.query("RENAME TABLE max244_hidden_dependencies TO alert_dependencies");
      }
      // Concurrent dependency edits and post-lock revocation.
      const changes = await Promise.all(
        ["first", "second"].map((name) =>
          api("PUT", "/api/alerts/dependencies/" + dep.id, {
            operation_key: randomUUID(),
            expected_revision: dep.revision,
            value: { ...value, name },
          }),
        ),
      );
      assert.deepEqual(changes.map((r) => r.status).sort(), [200, 409]);
      const latest = (await api("GET", "/api/alerts/dependencies")).body[0],
        locker = await pool.getConnection();
      await locker.beginTransaction();
      await locker.execute("SELECT id FROM alert_dependency_lock WHERE id=1 FOR UPDATE");
      const denied = api("PUT", "/api/alerts/dependencies/" + dep.id, {
        operation_key: randomUUID(),
        expected_revision: latest.revision,
        value,
      });
      await new Promise((r) => setTimeout(r, 50));
      await pool.query("DELETE FROM instance_permissions WHERE user_id=701 AND instance_id=702");
      await locker.commit();
      locker.release();
      assert.equal((await denied).status, 403);
      const hidden = await api("GET", "/api/notification/deliveries", undefined, otherToken);
      assert.equal(hidden.status, 200);
      assert(hidden.body.every((v: any) => v.alert_id === upstream.alert_id));
      assert.equal(
        (
          await api(
            "GET",
            `/api/notification/jobs/${(await pool.query<any[]>("SELECT id FROM workflow_jobs WHERE job_type='notification.deliver' AND JSON_EXTRACT(payload,'$.alertId')=? LIMIT 1", [newB.alert_id]))[0][0].id}/delivery`,
            undefined,
            otherToken,
          )
        ).status,
        403,
      );
      await pool.query(
        "INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(701,702,'read-write')",
      );
      for (const [width, height] of [
        [1440, 900],
        [1366, 768],
        [1920, 1080],
      ]) {
        await page.setViewportSize({ width, height });
        await page.getByRole("button", { name: "刷新依赖", exact: true }).click();
        await page.getByRole("cell", { name: /first|second/ }).waitFor();
        await page.getByRole("button", { name: "刷新投递回执", exact: true }).click();
        await page.getByRole("cell", { name: "升级", exact: true }).first().waitFor();
        await page.screenshot({
          path: resolve(directory, `dependencies-${width}.png`),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(
            () =>
              (globalThis as any).document.documentElement.scrollWidth >
              (globalThis as any).innerWidth,
          ),
          false,
        );
      }
      await fill();
      await page.getByRole("button", { name: "保存依赖", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "保存依赖", exact: true })
        .waitFor({ state: "hidden" });
      await page.waitForFunction(() => {
        let e: any = (globalThis as any).document.activeElement;
        while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
        return e?.textContent?.includes("新增依赖");
      });
      // Error, late response, principal isolation, and disabled/noop lifecycle through actual Lit.
      await page.route(depRoute, (r) =>
        r.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "DEPENDENCY_STATE_UNKNOWN" }),
        }),
      );
      await page.getByRole("button", { name: "刷新依赖", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "依赖状态暂时无法查询，请重试" }).waitFor();
      await page.screenshot({ path: resolve(directory, "dependencies-error.png"), fullPage: true });
      await page.unroute(depRoute);
      await page.getByRole("button", { name: "刷新依赖", exact: true }).click();
      await page.getByRole("button", { name: "禁用", exact: true }).click();
      await page.getByRole("cell", { name: /已禁用/ }).waitFor();
      const disabled = (await api("GET", "/api/alerts/dependencies")).body[0];
      assert.equal(
        (
          await api("PUT", "/api/alerts/dependencies/" + disabled.id, {
            operation_key: randomUUID(),
            expected_revision: disabled.revision,
            disabled: true,
          })
        ).body.noop,
        true,
      );
      let releaseLate!: () => void, lateEntered!: () => void, lateDone!: () => void;
      const lateGate = new Promise<void>((r) => (releaseLate = r)),
        lateReady = new Promise<void>((r) => (lateEntered = r)),
        lateFinished = new Promise<void>((r) => (lateDone = r));
      let first = true;
      await page.route(depRoute, async (route) => {
        if (first) {
          first = false;
          const response = await route.fetch();
          lateEntered();
          await lateGate;
          try {
            await route.fulfill({ response });
          } finally {
            lateDone();
          }
        } else await route.continue();
      });
      await page.getByRole("button", { name: "刷新依赖", exact: true }).click();
      await lateReady;
      await page.evaluate((t) => {
        (globalThis as any).localStorage.setItem("token", t);
        (globalThis as any).dispatchEvent(
          new (globalThis as any).StorageEvent("storage", { key: "token" }),
        );
      }, otherToken);
      await page.getByText("暂无依赖，请选择有管理权限的上下游资源。").waitFor();
      assert.equal(await page.getByRole("cell", { name: /first|second/ }).count(), 0);
      releaseLate();
      await lateFinished;
      await page.unroute(depRoute);
      assert.equal(await page.getByRole("cell", { name: /first|second/ }).count(), 0);
      // The touched legacy bridge also obeys dependencies and keeps recovery idempotent.
      const currentDependency=(await api('GET','/api/alerts/dependencies')).body[0];
      assert.equal((await api('PUT','/api/alerts/dependencies/'+currentDependency.id,{operation_key:randomUUID(),expected_revision:currentDependency.revision,value})).status,200);
      const legacy=await alertDatabaseService.createAlert({instance_id:701,alert_type:'performance',level:'warning',title:'受控旧规则上游',message:'legacy bridge regression',source:'legacy-fixture',metric_name:'fixture_legacy_upstream'});
      assert(legacy.success&&legacy.alertId);
      const legacyInput={rule:{id:999,name:'受控旧规则下游',metric_name:'fixture_legacy_downstream',threshold:90,operator:'>',severity:'warning',silence_minutes:0},instanceId:702,instanceName:'下游 B',currentValue:95};
      await (alertEngine as any).createAlertFromRule(legacyInput);
      assert.equal(await scalar("SELECT COUNT(*) n FROM alerts WHERE metric_name='fixture_legacy_downstream'"),0);
      assert((await alertDatabaseService.resolveAlert(legacy.alertId!,701)).success);
      await (alertEngine as any).createAlertFromRule(legacyInput);
      assert.equal(await scalar("SELECT COUNT(*) n FROM alerts WHERE metric_name='fixture_legacy_downstream'"),1);
      assert((await alertDatabaseService.resolveAlert(legacy.alertId!,701)).success);
      // Chief R2: a durable recovery must survive a pending original, restart,
      // and repeated closure without burning retry attempts or sending alone.
      await formal(701, 'r2-pending-open', 95);
      const pending = (await episodes(701)).at(-1)!, pendingKey = `notification:${pending.alert_id}:701`;
      heldKeys.add(pendingKey);
      await pool.execute("UPDATE workflow_jobs SET available_at='2099-01-01' WHERE idempotency_key=?", [pendingKey]);
      await pool.execute("UPDATE notification_channels SET config=JSON_SET(config,'$.severity','p0') WHERE id=701");
      await formal(701, 'r2-pending-recovery', 60);
      await formal(701, 'r2-pending-repeat', 60);
      await pool.execute("UPDATE notification_channels SET config=JSON_SET(config,'$.severity','info') WHERE id=701");
      for (let i=0;i<7;i++) await run();
      const [waiting] = await pool.query<any[]>('SELECT id,state,attempts FROM workflow_jobs WHERE idempotency_key=?', [pendingKey+':recovery']);
      assert.equal(waiting.length, 1);
      assert.equal(waiting[0].state, 'queued');
      assert.equal(waiting[0].attempts, 0);
      assert.equal(await scalar('SELECT COUNT(*) n FROM max244_receiver_receipts WHERE business_key IN (?,?)', [pendingKey,pendingKey+':recovery']),0);
      worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as any), 'r2-restarted-'+nonce, 30);
      heldKeys.delete(pendingKey);
      await pool.execute('UPDATE workflow_jobs SET available_at=NOW() WHERE idempotency_key=?', [pendingKey]);
      await run(); await run();
      const assertOrderedPair = async (key:string) => {
        const [pair] = await pool.query<any[]>('SELECT business_key,requests,received_at FROM max244_receiver_receipts WHERE business_key IN (?,?) ORDER BY received_at', [key,key+':recovery']);
        assert.deepEqual(pair.map(r=>r.business_key),[key,key+':recovery']);
        assert(pair.every(r=>r.requests===1));
        assert.equal(await scalar("SELECT COUNT(*) n FROM notification_delivery_states WHERE business_key IN (?,?) AND state='sent'",[key,key+':recovery']),2);
        return pair;
      };
      trace.push({r2_pending:await assertOrderedPair(pendingKey),waiting_attempts:waiting[0].attempts});
      // Chief R1: real critical -> P0 route, stable escalation key, and P0 recovery.
      await formal(701, 'r1-p0-open', 95); await run();
      const p0 = (await episodes(701)).at(-1)!, p0Key=`notification:${p0.alert_id}:701`;
      assert.equal((await api('POST',`/api/alerts/${p0.alert_id}/escalate`,{new_level:'urgent'})).status,400);
      for (const level of ['critical','p0']) {
        assert.equal((await api('POST',`/api/alerts/${p0.alert_id}/escalate`,{new_level:level})).body.changed,true);
        await run();
        assert.equal(await scalar("SELECT COUNT(*) n FROM notification_delivery_states WHERE business_key=? AND state='sent'",[p0Key+':escalation-'+level]),1);
      }
      await formal(701, 'r1-p0-recovery', 60); await run();
      trace.push({r1_p0:await assertOrderedPair(p0Key)});
      // The legacy producer can create P0 directly; exercise the same scheduler
      // and sender with a real persisted P0 problem, without the legacy poller.
      const directP0=await alertDatabaseService.createAlert({instance_id:701,alert_type:'performance',level:'p0',title:'受控 P0 原始问题',message:'Chief R1 direct P0 regression',source:'legacy-fixture',metric_name:'fixture_p0'});
      assert(directP0.success&&directP0.alertId);
      await new NotificationDispatchScheduler({
        getPendingAlerts:async()=>(await notificationDatabaseService.getPendingAlerts()).filter(a=>a.id===directP0.alertId),
        getEnabledChannels:()=>notificationDatabaseService.getEnabledChannels(),
      },notificationService,store).enqueuePending();
      await run();
      assert((await alertDatabaseService.resolveAlert(directP0.alertId!,701)).success);
      await run();
      trace.push({r1_direct_p0:await assertOrderedPair(`notification:${directP0.alertId}:701`)});
      // Chief R2: receiver committed, response lost; recover before any retry.
      // The existing JWT reconciliation API confirms sent, then the same queue
      // releases exactly one recovery after a worker/store restart.
      await pool.query("INSERT INTO permissions(code,name,resource,action) VALUES('admin:*','受控核对','admin','*') ON DUPLICATE KEY UPDATE code=code");
      await pool.query("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='admin:*'");
      const reconciliationToken=signAccessToken((await actorContextService.loadActiveActor(701))!,secret);
      lose=true;
      await formal(701, 'r2-unknown-open', 95); await run();
      const uncertain=(await episodes(701)).at(-1)!, uncertainKey=`notification:${uncertain.alert_id}:701`;
      heldKeys.add(uncertainKey);
      await pool.execute("UPDATE workflow_jobs SET available_at='2099-01-01' WHERE idempotency_key=?",[uncertainKey]);
      await formal(701,'r2-unknown-recovery',60);
      await run();
      assert.equal(await scalar('SELECT COUNT(*) n FROM max244_receiver_receipts WHERE business_key=?',[uncertainKey+':recovery']),0);
      const [unknownJobs]=await pool.query<any[]>('SELECT id FROM workflow_jobs WHERE idempotency_key=?',[uncertainKey]);
      const inspection=await api('GET',`/api/notification/jobs/${unknownJobs[0].id}/delivery`);
      assert.equal(inspection.body.delivery.state,'unknown');
      worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as any), 'r2-reconciled-'+nonce, 30);
      const decision={version:inspection.body.delivery.version,decision:'sent',reason:'受控接收端持久回执核对',reconciliation:`owned receipt ${uncertainKey}`};
      const decisions=await Promise.all([1,2].map(()=>api('POST',`/api/notification/jobs/${unknownJobs[0].id}/recover`,decision,reconciliationToken)));
      assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
      await run(); await run();
      trace.push({r2_reconciled:await assertOrderedPair(uncertainKey),decisions:decisions.map(r=>r.status)});
      assert.equal(await scalar("SELECT COUNT(*) n FROM notification_delivery_replays WHERE business_key=? AND decision='sent'",[uncertainKey]),1);
      assert.equal(await scalar('SELECT COUNT(*) n FROM workflow_jobs WHERE idempotency_key=?',[uncertainKey+':recovery']),1);
      await page.evaluate((t:string)=>{(globalThis as any).localStorage.setItem('token',t);(globalThis as any).dispatchEvent(new (globalThis as any).StorageEvent('storage',{key:'token'}));},token);
      await page.getByRole('button',{name:'刷新投递回执',exact:true}).click();
      await page.getByRole('cell',{name:'恢复',exact:true}).first().waitFor();
      await page.screenshot({path:resolve(directory,'r1-r2-deliveries.png'),fullPage:true});
      const [receipts] = await pool.query<any[]>(
        "SELECT business_key,requests,received_at FROM max244_receiver_receipts ORDER BY received_at",
      );
      const [states] = await pool.query<any[]>(
        "SELECT business_key,state,error_code FROM notification_delivery_states ORDER BY business_key",
      );
      writeFileSync(resolve(directory, "trace.json"), JSON.stringify(trace, null, 2));
      writeFileSync(
        resolve(directory, "result.json"),
        JSON.stringify(
          {
            handle,
            reads,
            receipts,
            states,
            checks:
              "Lit create/cancel/lost-response; graph cycle/access/revision/concurrent/revoked; old/new/ack independent; normal formal writer problem/recovery/escalation; R1 P0 direct problem/escalation/recovery; R2 pending and unknown recovery intents, zero waiting attempts, receiver-confirmed sent/concurrent reconcile/restart/idempotence; maintenance facts/end/no storm; A-only delivery filtering; three desktops/focus/error/principal isolation",
            boundary:
              "Controlled SQL collector response; actual formal sample/event/outbox/delivery persistence. HTTPS adapter redirected only to owned loopback HTTP receiver; not real external delivery or hardware collector.",
          },
          null,
          2,
        ),
      );
      console.log("MAX244_DEPENDENCIES_RESULT " + directory);
    } finally {
      try {
        await browser?.close();
        await vite?.close();
        await app.close();
        if (receiver) await new Promise<void>((r, j) => receiver!.close((e) => (e ? j(e) : r())));
        await dbConnection.close();
        if (owned) await owned.drop();
        await root?.end();
        if (handle.container) {
          assert.equal(
            docker(
              "inspect",
              "--format",
              '{{ index .Config.Labels "slide.max244.nonce" }}',
              handle.container,
            ),
            nonce,
          );
          docker("stop", "--time", "10", handle.container);
        }
        writeFileSync(
          resolve(directory, "cleanup.json"),
          JSON.stringify({ nonce, verified: true }),
        );
      } catch (e) {
        writeFileSync(
          resolve(directory, "cleanup.json"),
          JSON.stringify({ nonce, verified: false, error: String(e) }),
        );
        throw e;
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  },
  240000,
);
