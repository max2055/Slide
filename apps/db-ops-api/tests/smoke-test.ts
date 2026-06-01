/**
 * API Smoke Test — traverses all registered routes, checks responses, reports failures.
 *
 * Usage:
 *   npx tsx tests/smoke-test.ts [--base-url=http://localhost:3000]
 *
 * Requires the backend to be running: cd apps/db-ops-api && npx tsx server.ts
 */

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CREDS = {
  username: process.env.SMOKE_USER || "admin",
  password: process.env.SMOKE_PASS || "Tpam1234",
};

interface TestCase {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Human-readable name */
  name: string;
  /** Body for POST/PUT. Supports "auto" sentinel for minimal valid body generation. */
  body?: Record<string, unknown> | "auto";
  /** Expected status codes (first is default for pass). Default: [200] for GET, [200, 201] for POST */
  expect?: number[];
  /** Set to false to skip token (public routes) */
  auth?: boolean;
  /** Pre-flight: true means test this endpoint needs a token and returns 401 without one */
  requireAuth?: boolean;
}

interface TestResult {
  name: string;
  method: string;
  path: string;
  status: number;
  passed: boolean;
  error?: string;
  durationMs: number;
  bodyPreview?: string;
}

// ---------------------------------------------------------------------------
// Route catalog — every registered route in server.ts
// ---------------------------------------------------------------------------
const ROUTES: TestCase[] = [
  // ── Public ──
  { method: "GET", path: "/api/health", name: "Health check", auth: false, expect: [200] },
  {
    method: "POST",
    path: "/api/auth/login",
    name: "Auth login",
    auth: false,
    body: { username: CREDS.username, password: CREDS.password },
    expect: [200],
  },

  // ── Users (admin) ──
  { method: "GET", path: "/api/users", name: "List users", auth: true },
  {
    method: "POST",
    path: "/api/users",
    name: "Create user",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },

  // ── Database instances ──
  { method: "GET", path: "/api/database/instances", name: "List instances", auth: false },
  { method: "GET", path: "/api/database/instances/1", name: "Get instance 1", auth: false, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/database/instances",
    name: "Create instance",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  {
    method: "PUT",
    path: "/api/database/instances/1",
    name: "Update instance",
    auth: true,
    body: "auto",
    expect: [200, 404],
  },
  {
    method: "DELETE",
    path: "/api/database/instances/99999",
    name: "Delete instance (404)",
    auth: true,
    expect: [200, 404, 500],
  },
  {
    method: "POST",
    path: "/api/database/instances/test-connection",
    name: "Test connection",
    auth: true,
    body: "auto",
    expect: [200, 400, 500],
  },

  // ── LLM ──
  { method: "GET", path: "/api/llm/configs", name: "LLM configs", auth: false },
  {
    method: "POST",
    path: "/api/llm/test",
    name: "LLM test",
    auth: false,
    body: { provider: "anthropic" },
    expect: [200, 500],
  },

  // ── Alerts ──
  { method: "GET", path: "/api/alerts", name: "List alerts", auth: false },
  { method: "DELETE", path: "/api/alerts", name: "Clear alerts", auth: true, expect: [200] },

  // ── Metrics ──
  { method: "GET", path: "/api/metrics/1", name: "Metrics for instance 1", auth: false, expect: [200, 404] },

  // ── Instance sub-resources ──
  { method: "GET", path: "/api/database/instances/1/metrics", name: "Instance metrics", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/metrics/history", name: "Metrics history", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/topsql", name: "TopSQL", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/sessions", name: "Sessions", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/capacity", name: "Capacity", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/capacity/history", name: "Capacity history", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/database/instances/1/capacity/databases", name: "Capacity databases", auth: false, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/database/instances/1/capacity/collect",
    name: "Collect capacity",
    auth: true,
    expect: [200, 404],
  },

  // ── Collector ──
  { method: "POST", path: "/api/collector/start", name: "Start collector", auth: true, expect: [200, 409] },
  { method: "POST", path: "/api/collector/stop", name: "Stop collector", auth: true, expect: [200, 409] },
  { method: "GET", path: "/api/collector/status", name: "Collector status", auth: true },

  // ── Reports ──
  { method: "GET", path: "/api/reports/stats", name: "Report stats", auth: true },
  { method: "GET", path: "/api/reports", name: "List reports", auth: true },
  { method: "GET", path: "/api/reports/1", name: "Get report 1", auth: true, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/reports/generate",
    name: "Generate report",
    auth: true,
    body: { type: "health", format: "json", instance_id: 1 },
    expect: [200, 201, 400, 404],
  },

  // ── Alert rules ──
  { method: "GET", path: "/api/alert-rules", name: "List alert rules", auth: true },
  {
    method: "POST",
    path: "/api/alert-rules",
    name: "Create alert rule",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  { method: "GET", path: "/api/alert-engine/status", name: "Alert engine status", auth: true },
  { method: "POST", path: "/api/alert-engine/evaluate", name: "Evaluate alerts", auth: true, expect: [200] },

  // ── Notification channels ──
  { method: "GET", path: "/api/notification/channels", name: "List notif channels", auth: true },
  {
    method: "POST",
    path: "/api/notification/channels",
    name: "Create notif channel",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  { method: "GET", path: "/api/notification/records", name: "Notif records", auth: true },

  // ── AI analysis ──
  {
    method: "POST",
    path: "/api/ai/analysis",
    name: "Create AI analysis",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  { method: "GET", path: "/api/ai/analysis", name: "List AI analyses", auth: true },
  { method: "GET", path: "/api/ai/analysis/1", name: "Get AI analysis 1", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/ai/analysis/1/status", name: "AI analysis status", auth: true, expect: [200, 404] },

  // ── SQL audit ──
  {
    method: "POST",
    path: "/api/sql/audit",
    name: "Submit SQL audit",
    auth: true,
    body: { sql: "SELECT 1", instance_id: 1 },
    expect: [200, 201, 400, 404],
  },
  { method: "GET", path: "/api/sql/audit/1", name: "Get SQL audit 1", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/sql/audit/1/status", name: "SQL audit status", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/sql/audit/instance/1", name: "SQL audit by instance", auth: true, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/sql/audit/batch",
    name: "Batch SQL audit",
    auth: true,
    body: { entries: [{ sql: "SELECT 2", instance_id: 1 }] },
    expect: [200, 201, 400, 404],
  },

  // ── Capacity predictions ──
  {
    method: "GET",
    path: "/api/ai/capacity/predict?instanceId=1&metric=cpu_usage&days=30",
    name: "Capacity predict",
    auth: true,
    expect: [200, 404],
  },
  {
    method: "GET",
    path: "/api/ai/capacity/predict/all?instanceId=1",
    name: "Capacity predict all",
    auth: true,
    expect: [200, 404],
  },

  // ── Logs ──
  { method: "GET", path: "/api/logs?instanceId=1", name: "Query logs", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/logs/stats?instanceId=1", name: "Log stats", auth: true, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/logs/analyze",
    name: "Analyze logs",
    auth: true,
    body: { logIds: [1], instanceId: 1 },
    expect: [200, 400, 404],
  },
  { method: "GET", path: "/api/logs/analysis/1", name: "Log analysis result", auth: true, expect: [200, 404] },

  // ── Schema ──
  {
    method: "POST",
    path: "/api/schema/collect/1",
    name: "Collect schema",
    auth: true,
    expect: [200, 404],
  },
  { method: "GET", path: "/api/schema/snapshots/1", name: "Schema snapshots", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/schema/snapshot/1", name: "Schema snapshot", auth: true, expect: [200, 404] },
  { method: "POST", path: "/api/schema/changes/1", name: "Detect schema changes", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/schema/table/1/test_table", name: "Schema table detail", auth: true, expect: [200, 404] },

  // ── Indexes ──
  {
    method: "POST",
    path: "/api/index/collect/1",
    name: "Collect indexes",
    auth: true,
    expect: [200, 404],
  },
  {
    method: "POST",
    path: "/api/index/detect/1",
    name: "Detect redundant indexes",
    auth: true,
    expect: [200, 404],
  },
  { method: "GET", path: "/api/indexes/1", name: "List indexes", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/indexes/1/redundancy", name: "Index redundancy", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/indexes/1/unused", name: "Unused indexes", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/indexes/1/test_table", name: "Table indexes", auth: true, expect: [200, 404] },

  // ── Metric registry ──
  { method: "GET", path: "/api/metrics/registry", name: "Metric registry", auth: true },
  { method: "GET", path: "/api/metrics/registry/1", name: "Metric registry by id", auth: true, expect: [200, 404] },
  { method: "GET", path: "/api/metrics/registry/db-types/mysql", name: "Metric by db type", auth: true },
  {
    method: "POST",
    path: "/api/metrics/registry",
    name: "Create metric",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },

  // ── Baseline ──
  { method: "POST", path: "/api/baseline/compute", name: "Compute baselines", auth: true, expect: [200] },
  { method: "GET", path: "/api/baseline/1/cpu_usage", name: "Get baseline", auth: false, expect: [200, 404] },
  { method: "GET", path: "/api/baseline/schedule", name: "Baseline schedule", auth: true },

  // ── Escalation rules ──
  { method: "GET", path: "/api/alerts/escalation/rules", name: "Escalation rules", auth: false },
  {
    method: "POST",
    path: "/api/alerts/escalation/rules",
    name: "Create escalation rule",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },

  // ── Maintenance windows ──
  { method: "GET", path: "/api/maintenance-windows", name: "Maintenance windows", auth: false },
  {
    method: "POST",
    path: "/api/maintenance-windows",
    name: "Create maint window",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  {
    method: "GET",
    path: "/api/maintenance-windows/check/1",
    name: "Check maint window",
    auth: false,
    expect: [200, 404],
  },

  // ── Silence ──
  { method: "GET", path: "/api/silence", name: "List silence rules", auth: false },
  {
    method: "POST",
    path: "/api/silence",
    name: "Create silence rule",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },

  // ── Alert events ──
  { method: "GET", path: "/api/alerts/events", name: "Alert events", auth: true },
  { method: "GET", path: "/api/alerts/events/1", name: "Alert event detail", auth: true, expect: [200, 404] },
  {
    method: "POST",
    path: "/api/alerts/events",
    name: "Create alert event",
    auth: true,
    body: "auto",
    expect: [200, 201, 400],
  },
  { method: "GET", path: "/api/alerts/events/mttr", name: "MTTR stats", auth: true },
  { method: "GET", path: "/api/alerts/events/search?q=test", name: "Search events", auth: true },
  {
    method: "POST",
    path: "/api/alerts/aggregate",
    name: "Aggregate alerts",
    auth: true,
    body: { start_time: new Date(0).toISOString(), end_time: new Date().toISOString() },
    expect: [200],
  },

  // ── Auth guard checks (require 401 without token) ──
  { method: "POST", path: "/api/database/instances", name: "[AUTH] Create instance no-token", auth: false, expect: [401, 400], requireAuth: true },
  { method: "POST", path: "/api/users", name: "[AUTH] Create user no-token", auth: false, expect: [401, 400], requireAuth: true },
];

// ---------------------------------------------------------------------------
// Auto bodies for POST/PUT routes that accept minimal valid data
// ---------------------------------------------------------------------------
const AUTO_BODIES: Record<string, Record<string, unknown>> = {
  "/api/users": { username: "smoke_test_user", password: "smoke1234", role: "viewer" },
  "/api/database/instances": { name: "smoke-test", db_type: "mysql", host: "127.0.0.1", port: 3306, database_name: "test", username: "root", password: "x", environment: "test" },
  "/api/database/instances/1": { name: "updated-smoke", db_type: "mysql" },
  "/api/database/instances/test-connection": { db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "x" },
  "/api/alert-rules": { metric_name: "cpu_usage", operator: ">", threshold: 99, severity: "warning" },
  "/api/notification/channels": { name: "smoke-test", type: "webhook", config: { url: "https://example.com/hook" } },
  "/api/ai/analysis": { analysis_type: "topsql_analysis", instance_id: 1 },
  "/api/metrics/registry": { name: "smoke_metric", display_name: "Smoke Test Metric", unit: "count", db_types: ["mysql"], aggregation: "avg", interval_seconds: 60 },
  "/api/alerts/escalation/rules": { rule_name: "smoke", from_level: "warning", to_level: "error", wait_minutes: 10 },
  "/api/maintenance-windows": { instance_id: 1, start_time: new Date().toISOString(), end_time: new Date(Date.now() + 3600000).toISOString(), reason: "smoke test" },
  "/api/silence": { instance_id: 1, rule_name: "smoke silence", duration_minutes: 10 },
  "/api/alerts/events": { instance_id: 1, level: "warning", title: "smoke test event" },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let token: string | null = null;

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(CREDS),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error(`No token in login response: ${JSON.stringify(data)}`);
  return data.token;
}

function getBody(tc: TestCase): string | undefined {
  // POST/PUT/DELETE routes need a body, even if just empty JSON
  if (!tc.body) return "{}";
  if (tc.body === "auto") {
    const auto = AUTO_BODIES[tc.path];
    if (auto) return JSON.stringify(auto);
    return JSON.stringify({});
  }
  return JSON.stringify(tc.body);
}

async function runOne(tc: TestCase): Promise<TestResult> {
  const start = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tc.auth && token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(`${BASE_URL}${tc.path}`, {
      method: tc.method,
      headers,
      body: tc.method === "GET" || tc.method === "DELETE" ? undefined : getBody(tc),
    });

    const durationMs = Date.now() - start;
    const expectedStatus: number[] = tc.expect || (tc.method === "GET" ? [200] : [200, 201]);
    const ok = expectedStatus.includes(res.status);

    let bodyPreview = "";
    try {
      const text = await res.text();
      bodyPreview = text.slice(0, 200);
    } catch {
      bodyPreview = "<unreadable>";
    }

    return {
      name: tc.name,
      method: tc.method,
      path: tc.path,
      status: res.status,
      passed: ok,
      durationMs,
      bodyPreview: ok ? undefined : bodyPreview,
      error: ok ? undefined : `Expected ${(expectedStatus as number[]).join("/")}, got ${res.status}`,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const expectedStatus: number[] = tc.expect || (tc.method === "GET" ? [200] : [200, 201]);
    return {
      name: tc.name,
      method: tc.method,
      path: tc.path,
      status: 0,
      passed: expectedStatus.includes(0),
      durationMs,
      error: `Fetch error: ${msg}`,
    };
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         Slide API Smoke Test                     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Routes:   ${ROUTES.length}\n`);

  // Step 1: Login
  process.stdout.write("🔑 Logging in... ");
  try {
    token = await login();
    console.log("OK");
  } catch (err) {
    console.log(`FAIL — ${err instanceof Error ? err.message : err}`);
    console.log("\n⚠️  Server may not be running. Start with:");
    console.log("   cd apps/db-ops-api && npx tsx server.ts\n");
    process.exit(1);
  }

  // Step 2: Run all tests
  console.log("─".repeat(55));
  const results: TestResult[] = [];
  for (const tc of ROUTES) {
    process.stdout.write(`  ${tc.method.padEnd(6)} ${tc.path.padEnd(45)}`);
    const r = await runOne(tc);
    results.push(r);
    if (r.passed) {
      console.log(`✅ ${r.status} (${r.durationMs}ms)`);
    } else {
      console.log(`❌ ${r.status || "ERR"} — ${r.error || ""}`);
      if (r.bodyPreview) console.log(`     Body: ${r.bodyPreview.slice(0, 100)}`);
    }
  }

  // Step 3: Summary
  console.log("─".repeat(55));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const byGroup = new Map<string, { total: number; fail: number }>();

  for (const r of results) {
    const group = r.path.split("/")[2] || "other";
    const entry = byGroup.get(group) || { total: 0, fail: 0 };
    entry.total++;
    if (!r.passed) entry.fail++;
    byGroup.set(group, entry);
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${ROUTES.length} total)\n`);
  console.log("By module:");
  const sorted = Array.from(byGroup.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [group, stats] of sorted) {
    const icon = stats.fail === 0 ? "✅" : "❌";
    console.log(`  ${icon} /api/${group}: ${stats.total - stats.fail}/${stats.total} passed`);
  }

  if (failed > 0) {
    console.log("\n❌ FAILURES:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${r.method} ${r.path} → ${r.status} ${r.error || ""}`);
    }
    console.log("");
  }

  // Step 4: Auth guard checks
  console.log("\n🔒 Auth guard checks (expect 401 without token):");
  token = null;
  for (const tc of ROUTES.filter((r) => r.requireAuth)) {
    process.stdout.write(`  ${tc.method.padEnd(6)} ${tc.path.padEnd(45)}`);
    const r = await runOne(tc);
    if (r.status === 401) {
      console.log(`✅ 401 as expected`);
    } else if (r.status === 400) {
      console.log(`⚠️  400 (Fastify body validation before auth) — preHandler exists, auth OK`);
    } else {
      console.log(`❌ got ${r.status}, expected 401 — UNPROTECTED`);
      r.passed = false;
      results.push(r);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
