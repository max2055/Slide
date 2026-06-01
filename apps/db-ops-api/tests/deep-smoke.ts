/**
 * Deep Smoke Test — multi-variant coverage + workflow validation + type assertions.
 *
 * Usage:
 *   npx tsx tests/deep-smoke.ts
 */
import { multiTest, assertShape, workflow, getToken, setToken, getBaseUrl, setBaseUrl } from "./test-kit.js";

// Reuse basic auth
async function login() {
  const BASE = "http://localhost:3000";
  setBaseUrl(BASE);

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Tpam1234" }),
  });
  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error("Login failed");
  setToken(data.token);
  return data.token;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║           Slide Deep Smoke Test                      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── Login ──
  process.stdout.write("🔑 Logging in... ");
  try { await login(); console.log("OK\n"); }
  catch (e) { console.log(`FAIL - ${e}`); process.exit(1); }

  let totalPassed = 0;
  let totalFailed = 0;

  // ══════════════════════════════════════════════════════
  // 1. MULTI-VARIANT: Report generation — all 4 types
  // ══════════════════════════════════════════════════════
  console.log("─".repeat(55));
  console.log("📊 Multi-variant: Report generation (all types)");
  console.log("─".repeat(55));

  const reportResult = await multiTest(
    "report-gen",
    "POST",
    "/api/reports/generate",
    [
      { name: "health", body: { type: "health", instanceId: 1 } },
      { name: "performance", body: { type: "performance", instanceId: 1 } },
      { name: "slow_query", body: { type: "slow_query", instanceId: 1 } },
      { name: "capacity", body: { type: "capacity", instanceId: 1 } },
    ],
  );
  totalPassed += reportResult.passed;
  totalFailed += reportResult.failed;

  // ══════════════════════════════════════════════════════
  // 2. WORKFLOW: Generate → List → Verify → Download
  // ══════════════════════════════════════════════════════
  console.log("\n─".repeat(55));
  console.log("🔄 Workflow: Report generate → list → verify");
  console.log("─".repeat(55));

  const wfResult = await workflow("report-lifecycle", [
    {
      name: "1. Generate health report",
      method: "POST",
      path: "/api/reports/generate",
      body: { type: "health", instanceId: 1 },
      extract: "id",
      assert: (res, body) => {
        const b = body as Record<string, unknown>;
        return typeof b.id === "number" && b.status === "completed";
      },
    },
    {
      name: "2. GET reports list",
      method: "GET",
      path: "/api/reports",
      assert: (res, body) => {
        return Array.isArray(body) && body.length > 0;
      },
    },
    {
      name: "3. New report appears in list",
      method: "GET",
      path: "/api/reports",
      assert: (res, body, vars) => {
        const list = body as Array<Record<string, unknown>>;
        return list.some((r) => r.id === vars.id);
      },
    },
    {
      name: "4. GET report detail",
      method: "GET",
      path: `/api/reports/${1}`, // use last id from step 1
      assert: (res, body) => {
        const b = body as Record<string, unknown>;
        // Report detail from GET /api/reports/:id
        return b !== null && (typeof b.id === "number" || typeof b.name === "string");
      },
    },
  ]);
  totalPassed += wfResult.stepResults.filter((s) => s.passed).length;
  totalFailed += wfResult.stepResults.filter((s) => !s.passed).length;

  // ══════════════════════════════════════════════════════
  // 3. TYPE ASSERTION: Validate response shapes
  // ══════════════════════════════════════════════════════
  console.log("\n─".repeat(55));
  console.log("🔬 Type assertions: response shape validation");
  console.log("─".repeat(55));

  // 3a. Metric response
  const { raw: metricBody } = await safeGet("/api/metrics/1");
  const metricErrors = assertShape("metrics", metricBody, [
    { field: "cpu_usage", type: "number" },
    { field: "memory_usage", type: "number" },
    { field: "disk_usage", type: "number" },
    { field: "connections", type: "number" },
    { field: "instance_id", type: "number" },
  ]);
  if (metricErrors.length === 0) {
    console.log("  ✅ /api/metrics/:id — all fields correct types");
    totalPassed++;
  } else {
    for (const e of metricErrors) { console.log(`  ❌ ${e}`); totalFailed++; }
  }

  // 3b. Report list item shape
  const { raw: reportsBody } = await safeGet("/api/reports");
  if (Array.isArray(reportsBody) && reportsBody.length > 0) {
    const reportErrors = assertShape("report-item", reportsBody[0], [
      { field: "id", type: "number" },
      { field: "name", type: "string" },
      { field: "type", type: "string" },
      { field: "status", type: "string" },
      { field: "created_at", type: "string" },
    ]);
    if (reportErrors.length === 0) {
      console.log("  ✅ /api/reports — report item shape correct");
      totalPassed++;
    } else {
      for (const e of reportErrors) { console.log(`  ❌ ${e}`); totalFailed++; }
    }
  }

  // 3c. Alert item shape
  const { raw: alertsBody } = await safeGet("/api/alerts");
  if (Array.isArray(alertsBody) && alertsBody.length > 0) {
    const alertErrors = assertShape("alert-item", alertsBody[0], [
      { field: "id", type: "number" },
      { field: "severity", type: "string" },
      { field: "message", type: "string" },
    ]);
    if (alertErrors.length === 0) {
      console.log("  ✅ /api/alerts — alert item shape correct");
      totalPassed++;
    } else {
      for (const e of alertErrors) { console.log(`  ❌ ${e}`); totalFailed++; }
    }
  }

  // 3d. Instance item shape
  const { raw: instancesBody } = await safeGet("/api/database/instances");
  if (Array.isArray(instancesBody) && instancesBody.length > 0) {
    const instErrors = assertShape("instance-item", instancesBody[0], [
      { field: "id", type: "number" },
      { field: "name", type: "string" },
      { field: "db_type", type: "string" },
      { field: "host", type: "string" },
      { field: "port", type: "number" },
    ]);
    if (instErrors.length === 0) {
      console.log("  ✅ /api/database/instances — instance shape correct");
      totalPassed++;
    } else {
      for (const e of instErrors) { console.log(`  ❌ ${e}`); totalFailed++; }
    }
  }

  // 3e. User item shape
  const { raw: usersBody } = await safeGet("/api/users");
  if (Array.isArray(usersBody) && usersBody.length > 0) {
    const userErrors = assertShape("user-item", usersBody[0], [
      { field: "id", type: "number" },
      { field: "username", type: "string" },
      { field: "role", type: "string" },
    ]);
    if (userErrors.length === 0) {
      console.log("  ✅ /api/users — user shape correct");
      totalPassed++;
    } else {
      for (const e of userErrors) { console.log(`  ❌ ${e}`); totalFailed++; }
    }
  }

  // ══════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(55));
  console.log(`  DEEP SMOKE: ${totalPassed} passed, ${totalFailed} failed`);
  console.log("═".repeat(55));

  if (totalFailed > 0) {
    console.log("\n💡 Tips:");
    console.log("  - Type errors usually mean DB returns strings for numeric columns");
    console.log("  - Workflow failures indicate a broken user journey");
    console.log("  - Variant failures mean some valid parameter values are rejected");
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

async function safeGet(path: string): Promise<{ res: Response; raw: unknown }> {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers["Authorization"] = `Bearer ${t}`;
  const res = await fetch(`${getBaseUrl()}${path}`, { headers });
  let raw: unknown;
  try { raw = await res.json(); } catch { raw = await res.text(); }
  return { res, raw };
}

main();
