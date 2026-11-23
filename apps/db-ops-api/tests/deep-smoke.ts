/**
 * Deep Smoke Test — multi-variant coverage + workflow validation + type assertions.
 *
 * Usage:
 *   npx tsx tests/deep-smoke.ts
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { multiTest, assertShape, workflow, getToken, setToken, getBaseUrl, setBaseUrl, readResponseBody, type TypeAssertion, type WorkflowStep } from "./test-kit.js";

// Reuse basic auth
async function login() {
  const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
  if (!process.env.SMOKE_PASS) throw new Error("SMOKE_PASS must be explicitly injected");
  setBaseUrl(BASE);

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.SMOKE_USER || "admin", password: process.env.SMOKE_PASS }),
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

  const wfResult = await workflow("report-lifecycle", reportLifecycleSteps());
  totalPassed += wfResult.stepResults.filter((s) => s.passed).length;
  totalFailed += wfResult.stepResults.filter((s) => !s.passed).length;

  // ══════════════════════════════════════════════════════
  // 3. TYPE ASSERTION: Validate response shapes
  // ══════════════════════════════════════════════════════
  console.log("\n─".repeat(55));
  console.log("🔬 Type assertions: response shape validation");
  console.log("─".repeat(55));

  const shapeChecks: ShapeCheck[] = [
    {
      path: "/api/metrics/1",
      label: "metrics",
      fields: [
        { field: "cpu_usage", type: "number" },
        { field: "memory_usage", type: "number" },
        { field: "disk_usage", type: "number" },
        { field: "connections", type: "number" },
        { field: "instance_id", type: "number" },
      ],
    },
    {
      path: "/api/reports",
      label: "report-item",
      list: true,
      fields: [
        { field: "id", type: "number" },
        { field: "name", type: "string" },
        { field: "type", type: "string" },
        { field: "status", type: "string" },
        { field: "created_at", type: "string" },
      ],
    },
    {
      path: "/api/alerts",
      label: "alert-item",
      list: "items",
      fields: [
        { field: "id", type: "number" },
        { field: "severity", type: "string" },
        { field: "message", type: "string" },
      ],
    },
    {
      path: "/api/database/instances",
      label: "instance-item",
      list: true,
      fields: [
        { field: "id", type: "number" },
        { field: "name", type: "string" },
        { field: "db_type", type: "string" },
        { field: "host", type: "string" },
        { field: "port", type: "number" },
      ],
    },
    {
      path: "/api/users",
      label: "user-item",
      list: true,
      fields: [
        { field: "id", type: "number" },
        { field: "username", type: "string" },
        { field: "status", type: "string" },
      ],
    },
  ];

  for (const check of shapeChecks) {
    const errors = await checkShape(check);
    if (errors.length === 0) totalPassed++;
    for (const error of errors) console.log(`  ❌ ${error}`);
    totalFailed += errors.length;
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

interface ShapeCheck {
  path: string;
  label: string;
  fields: TypeAssertion[];
  list?: true | "items";
}

async function checkShape({ path, label, fields, list }: ShapeCheck): Promise<string[]> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${getBaseUrl()}${path}`, { headers, redirect: "manual" }).catch(() => undefined);
  if (!res) return [`${path} — request failed`];

  const status = `${path} — HTTP ${res.status}`;
  const body = await readResponseBody(res).catch(() => undefined);
  if (!body) return [`${status}: could not read response body`];
  if (!body.isJson) return [`${status}: ${describeNonJson(res, body.raw)}`];
  if (!res.ok) return [`${status}: JSON response`];

  let item = body.raw;
  if (list) {
    const items = list === "items" ? (item as { items?: unknown } | null)?.items : item;
    if (!Array.isArray(items)) {
      const expected = list === "items" ? "a JSON object with an items array" : "a JSON array";
      return [`${status}: expected ${expected}`];
    }
    if (items.length === 0) {
      console.log(`  ✅ ${path} — empty list`);
      return [];
    }
    item = items[0];
  }

  const errors = assertShape(label, item, fields);
  if (errors.length === 0) console.log(`  ✅ ${path} — response shape correct`);
  return errors.map(error => `${status}: ${error}`);
}

function describeNonJson(res: Response, raw: string): string {
  // Response bodies may contain credentials or terminal control sequences.
  const text = raw.trimStart();
  if (!text) return "empty response body";
  const mime = res.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml" || /^(?:<!doctype\s+html\b|<html[\s>])/i.test(text)) {
    return "HTML response";
  }
  return "non-JSON text response";
}

/** Report workflow used by `pnpm smoke:deep`. Detail uses the id captured in step 1. */
export function reportLifecycleSteps(): WorkflowStep[] {
  return [
    {
      name: "1. Generate health report",
      method: "POST",
      path: "/api/reports/generate",
      body: { type: "health", instanceId: 1 },
      extract: "id",
      assert: (_res, body) => {
        const b = body as Record<string, unknown>;
        return typeof b.id === "number" && b.status === "completed";
      },
    },
    {
      name: "2. GET reports list",
      method: "GET",
      path: "/api/reports",
      assert: (_res, body) => {
        return Array.isArray(body) && body.length > 0;
      },
    },
    {
      name: "3. New report appears in list",
      method: "GET",
      path: "/api/reports",
      assert: (_res, body, vars) => {
        const list = body as Array<Record<string, unknown>>;
        return list.some((r) => r.id === vars.id);
      },
    },
    {
      name: "4. GET report detail",
      method: "GET",
      path: "/api/reports/${{id}}",
      assert: (res, body, vars) => {
        if (!res.ok || !body || typeof body !== "object" || Array.isArray(body)) return false;
        return (body as Record<string, unknown>).id === vars.id;
      },
    },
  ];
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main();
}
