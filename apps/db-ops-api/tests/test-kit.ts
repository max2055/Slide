/**
 * Deep Test Kit — multi-variant testing, type assertions, workflow validation.
 *
 * Usage:
 *   import { multiTest, assertShape, workflow, smoke } from './test-kit.js';
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiVariant {
  /** Variant name for reporting */
  name: string;
  /** Override base config for this variant */
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  /** Assertions to run on the response */
  assert?: (res: Response, body: unknown) => VariantResult;
}

export interface VariantResult {
  passed: boolean;
  details: string[];
}

export interface WorkflowStep {
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  /** If set, extract this value from the response body for use in later steps as ${{key}} */
  extract?: string;
  assert?: (res: Response, body: unknown, vars: Record<string, unknown>) => boolean | string;
}

export interface WorkflowResult {
  passed: boolean;
  stepResults: Array<{ name: string; passed: boolean; status: number; error?: string }>;
  errors: string[];
}

export interface TypeAssertion {
  field: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  nullable?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let BASE_URL = "http://localhost:3000";
let token: string | null = null;
const failures: string[] = [];
const warnings: string[] = [];

export function setBaseUrl(url: string) { BASE_URL = url; }
export function setToken(t: string) { token = t; }
export function getToken() { return token; }
export function getBaseUrl() { return BASE_URL; }
export function getFailures() { return failures; }
export function getWarnings() { return warnings; }
export function resetState() { failures.length = 0; warnings.length = 0; }

// ---------------------------------------------------------------------------
// Http helper
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<{ res: Response; raw: unknown }> {
  const url = new URL(path, BASE_URL);
  if (query) {
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let raw: unknown;
  try { raw = await res.json(); } catch { raw = await res.text(); }
  return { res, raw };
}

// ---------------------------------------------------------------------------
// Type assertion engine
// ---------------------------------------------------------------------------

export function assertShape(
  label: string,
  body: unknown,
  assertions: TypeAssertion[],
): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    errors.push(`[${label}] body is not an object: ${typeof body}`);
    return errors;
  }

  const obj = body as Record<string, unknown>;
  for (const a of assertions) {
    const val = obj[a.field];
    if (val === undefined || val === null) {
      if (!a.nullable) {
        errors.push(`[${label}] ${a.field}: expected ${a.type}, got null/undefined`);
      }
      continue;
    }
    const actual = Array.isArray(val) ? "array" : typeof val;
    if (actual !== a.type) {
      errors.push(`[${label}] ${a.field}: expected ${a.type}, got ${actual} (value: ${JSON.stringify(val).slice(0, 60)})`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Multi-variant tester
// ---------------------------------------------------------------------------

export async function multiTest(
  label: string,
  method: string,
  path: string,
  variants: MultiVariant[],
  base?: { body?: Record<string, unknown>; query?: Record<string, string> },
): Promise<{ passed: number; failed: number; errors: string[] }> {
  const errors: string[] = [];
  let passed = 0;
  let failed = 0;

  for (const v of variants) {
    const body = { ...(base?.body || {}), ...(v.body || {}) };
    const query = { ...(base?.query || {}), ...(v.query || {}) };

    try {
      const { res, raw } = await request(method, path, Object.keys(body).length > 0 ? body : undefined, Object.keys(query).length > 0 ? query : undefined);

      if (v.assert) {
        const result = v.assert(res, raw);
        if (result.passed) {
          passed++;
          console.log(`  ✅ ${v.name}`);
        } else {
          failed++;
          const detail = result.details.join("; ");
          console.log(`  ❌ ${v.name} — ${detail}`);
          errors.push(`[${label}] ${v.name}: ${detail}`);
        }
      } else if (res.ok) {
        passed++;
        console.log(`  ✅ ${v.name}`);
      } else {
        failed++;
        const preview = typeof raw === "string" ? raw.slice(0, 80) : JSON.stringify(raw).slice(0, 80);
        console.log(`  ❌ ${v.name} — HTTP ${res.status}: ${preview}`);
        errors.push(`[${label}] ${v.name}: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${v.name} — ERR: ${msg}`);
      errors.push(`[${label}] ${v.name}: ${msg}`);
    }
  }

  return { passed, failed, errors };
}

// ---------------------------------------------------------------------------
// Workflow validator
// ---------------------------------------------------------------------------

export async function workflow(
  label: string,
  steps: WorkflowStep[],
): Promise<WorkflowResult> {
  const vars: Record<string, unknown> = {};
  const stepResults: WorkflowResult["stepResults"] = [];
  const errors: string[] = [];

  for (const step of steps) {
    // Resolve template variables in body/path
    let resolvedBody: Record<string, unknown> | undefined;
    if (step.body) {
      resolvedBody = {};
      for (const [k, v] of Object.entries(step.body)) {
        if (typeof v === "string" && v.startsWith("${{") && v.endsWith("}}")) {
          const key = v.slice(3, -2);
          resolvedBody[k] = vars[key];
        } else {
          resolvedBody[k] = v;
        }
      }
    }

    try {
      const { res, raw } = await request(step.method, step.path, resolvedBody);

      if (step.extract && raw && typeof raw === "object") {
        const val = (raw as Record<string, unknown>)[step.extract];
        if (val !== undefined) vars[step.extract] = val;
      }

      let passed = res.ok;
      let assertErr = "";
      if (step.assert) {
        const result = step.assert(res, raw, vars);
        if (typeof result === "string") { passed = false; assertErr = result; }
        else passed = result;
      }

      stepResults.push({ name: step.name, passed, status: res.status, error: assertErr || undefined });
      if (passed) {
        console.log(`  ✅ ${step.name}`);
      } else {
        console.log(`  ❌ ${step.name} — ${assertErr || `HTTP ${res.status}`}`);
        errors.push(`[${label}] ${step.name}: ${assertErr || `HTTP ${res.status}`}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stepResults.push({ name: step.name, passed: false, status: 0, error: msg });
      console.log(`  ❌ ${step.name} — ERR: ${msg}`);
      errors.push(`[${label}] ${step.name}: ${msg}`);
    }
  }

  return { passed: errors.length === 0, stepResults, errors };
}

// ---------------------------------------------------------------------------
// Quick smoke (backward compatible)
// ---------------------------------------------------------------------------

export interface SmokeCase {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  name: string;
  body?: Record<string, unknown>;
  /** If true, also test all variants of a parameter */
  variants?: { param: string; values: Array<{ label: string; value: unknown }> };
  expect?: number[];
}

export async function smoke(cases: SmokeCase[]) {
  let passed = 0; let failed = 0;
  for (const tc of cases) {
    if (tc.variants) {
      const variants: MultiVariant[] = tc.variants.values.map((v) => ({
        name: `${tc.name} (${tc.variants!.param}=${v.label})`,
        body: { ...(tc.body || {}), [tc.variants!.param]: v.value },
      }));
      const result = await multiTest(tc.name, tc.method, tc.path, variants);
      passed += result.passed;
      failed += result.failed;
    } else {
      const { res, raw } = await request(tc.method, tc.path, tc.body);
      const expected = tc.expect || [200];
      if (expected.includes(res.status)) {
        passed++; console.log(`  ✅ ${tc.name}`);
      } else {
        failed++;
        const preview = typeof raw === "string" ? (raw as string).slice(0, 80) : JSON.stringify(raw).slice(0, 80);
        console.log(`  ❌ ${tc.name} — HTTP ${res.status}: ${preview}`);
      }
    }
  }
  return { passed, failed };
}
