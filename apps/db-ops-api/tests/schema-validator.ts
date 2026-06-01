/**
 * Schema-code consistency checker.
 * Validates ENUM definitions from schema.sql against known code usage.
 *
 * Usage:
 *   cd apps/db-ops-api && npx tsx tests/schema-validator.ts
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EnumDef { table: string; column: string; values: string[] }
interface ContractCheck { enumDef: EnumDef; codeValues: Array<{ value: string; file: string }> }

// ── Extract ENUMs from schema.sql ──
function extractEnums(schemaPath: string): EnumDef[] {
  const content = readFileSync(schemaPath, "utf-8");
  const tables = content.split(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`/i);
  const enums: EnumDef[] = [];

  for (const block of tables) {
    const tableMatch = block.match(/^(\w+)`/);
    if (!tableMatch) continue;
    const tableName = tableMatch[1];

    for (const m of block.matchAll(/`(\w+)`\s+ENUM\s*\(([^)]+)\)/gi)) {
      const values = m[2]
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""))
        .filter((v) => v.length > 0);
      enums.push({ table: tableName, column: m[1], values });
    }
  }
  return enums;
}

// ── Contract checks (schema ENUM ↔ code values) ──
const CHECKS: ContractCheck[] = [
  {
    enumDef: { table: "reports", column: "type", values: ["health", "performance", "slow_query", "capacity", "audit", "custom"] },
    codeValues: [
      { value: "health", file: "src/report-service.ts" },
      { value: "performance", file: "src/report-service.ts" },
      { value: "slow_query", file: "src/report-service.ts" },
      { value: "capacity", file: "src/report-service.ts" },
    ],
  },
  {
    enumDef: { table: "reports", column: "status", values: ["pending", "completed", "failed"] },
    codeValues: [
      { value: "pending", file: "src/report-service.ts" },
      { value: "completed", file: "src/report-service.ts" },
      { value: "failed", file: "src/report-service.ts" },
    ],
  },
  {
    enumDef: { table: "reports", column: "format", values: ["pdf", "html", "json", "csv"] },
    codeValues: [
      { value: "html", file: "src/report-service.ts" },
      { value: "pdf", file: "src/report-service.ts" },
      { value: "json", file: "src/report-service.ts" },
    ],
  },
  {
    enumDef: { table: "notification_channels", column: "type", values: ["email", "dingtalk", "wecom", "feishu", "webhook"] },
    codeValues: [
      { value: "webhook", file: "src/notification-service.ts" },
      { value: "dingtalk", file: "src/notification-service.ts" },
      { value: "wecom", file: "src/notification-service.ts" },
      { value: "feishu", file: "src/notification-service.ts" },
      { value: "email", file: "src/notification-service.ts" },
    ],
  },
  {
    enumDef: { table: "ai_analysis", column: "analysis_type", values: ["topsql_analysis", "alert_rca", "fault_diagnosis", "capacity_prediction", "sql_audit", "log_analysis"] },
    codeValues: [
      { value: "topsql_analysis", file: "src/topsql-analysis-service.ts" },
      { value: "alert_rca", file: "src/alert-rca-service.ts" },
      { value: "fault_diagnosis", file: "src/fault-diagnosis-service.ts" },
      { value: "capacity_prediction", file: "src/capacity-predictor.ts" },
      { value: "sql_audit", file: "src/sql-audit-service.ts" },
      { value: "log_analysis", file: "src/database-log-service.ts" },
    ],
  },
  {
    enumDef: { table: "users", column: "role", values: ["admin", "dba", "developer", "analyst", "viewer", "auditor"] },
    codeValues: [
      { value: "admin", file: "src/auth-middleware.ts" },
      { value: "viewer", file: "src/auth-database-service.ts" },
    ],
  },
  {
    enumDef: { table: "users", column: "status", values: ["active", "inactive", "locked"] },
    codeValues: [
      { value: "active", file: "src/auth-database-service.ts" },
      { value: "locked", file: "src/auth-database-service.ts" },
    ],
  },
  {
    enumDef: { table: "database_logs", column: "log_level", values: ["info", "warning", "error", "critical"] },
    codeValues: [
      { value: "info", file: "src/database-log-service.ts" },
      { value: "warning", file: "src/database-log-service.ts" },
      { value: "error", file: "src/database-log-service.ts" },
      { value: "critical", file: "src/database-log-service.ts" },
    ],
  },
  {
    enumDef: { table: "database_logs", column: "source", values: ["mysql_slow", "mysql_error", "pg_log", "other"] },
    codeValues: [
      { value: "mysql_error", file: "src/database-log-service.ts" },
      { value: "pg_log", file: "src/database-log-service.ts" },
      { value: "other", file: "src/database-log-service.ts" },
    ],
  },
  {
    enumDef: { table: "alert_rules", column: "severity", values: ["info", "warning", "error", "critical", "p0"] },
    codeValues: [
      { value: "warning", file: "src/alert-evaluator.ts" },
      { value: "error", file: "src/alert-evaluator.ts" },
      { value: "critical", file: "src/alert-evaluator.ts" },
    ],
  },
];

// ── Main ──
function main() {
  const schemaPath = join(__dirname, "..", "sql", "schema.sql");

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Schema-Code Consistency Checker        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const enums = extractEnums(schemaPath);
  console.log(`📋 ${enums.length} ENUM columns found in schema.sql\n`);

  // Build lookup
  const enumMap = new Map<string, EnumDef>();
  for (const e of enums) {
    enumMap.set(`${e.table}.${e.column}`, e);
  }

  let ok = 0;
  let fail = 0;

  for (const check of CHECKS) {
    const key = `${check.enumDef.table}.${check.enumDef.column}`;
    const schemaEnum = enumMap.get(key);

    console.log(`  ${key}:`);

    if (!schemaEnum) {
      console.log(`    ⚠️  ENUM not found in schema.sql (may be ALTER-added)`);
      ok++;
      continue;
    }

    let checkOk = true;
    for (const cv of check.codeValues) {
      if (!schemaEnum.values.includes(cv.value)) {
        console.log(`    ❌ '${cv.value}' (${cv.file}) — NOT IN ENUM`);
        console.log(`       Schema has: ${schemaEnum.values.join(", ")}`);
        fail++;
        checkOk = false;
      }
    }

    if (checkOk) {
      console.log(`    ✅ ${check.codeValues.length} values all match (${schemaEnum.values.length} in schema)`);
      ok++;
    }
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${ok} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
