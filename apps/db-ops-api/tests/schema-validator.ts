/**
 * Schema-code consistency checker.
 * Validates migration ENUM definitions against known code usage, offline.
 * Exit 1 means a mismatch, missing contract, or statically uncovered DDL.
 * Conditional/dynamic DDL is not executed and cannot count as verified.
 *
 * Usage:
 *   cd apps/db-ops-api && npx tsx tests/schema-validator.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import sqlParser from "node-sql-parser";
import { loadMigrations, splitSqlStatements } from "../src/migrations/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface EnumDef { table: string; column: string; values: string[] }
interface ContractCheck { enumDef: EnumDef; codeValues: Array<{ value: string; file: string }> }

// A conservative static projection, not evidence about any running database.
// Use the runner's file selection/order and quote-aware statement splitting.
async function extractEnums(directory: string) {
  const columns = new Map<string, string[] | null>();
  const uncovered = new Map<string, string>();
  const tables = new Set<string>();
  const targets = [...new Set(CHECKS.map((c) => c.enumDef.table))];
  const parser = new sqlParser.Parser();
  const variables = new Map<string, string[] | undefined>();
  const prepared = new Set<string>();
  const markTables = (affected: string[], migration: string) => {
    for (const c of CHECKS.filter((c) => affected.includes(c.enumDef.table))) {
      uncovered.set(`${c.enumDef.table}.${c.enumDef.column}`, migration);
    }
  };
  // Resolve only literal results and IF branches, never evaluate SQL/functions.
  const possibleStrings = (expr: any): string[] | undefined => {
    if (["single_quote_string", "double_quote_string"].includes(expr?.type)) {
      const quote = expr.type === "single_quote_string" ? "'" : '"';
      return [expr.value.replaceAll(quote + quote, quote).replace(/\\(['"\\])/g, "$1")];
    }
    if (expr?.type === "var" && expr.prefix === "@") return variables.get(expr.name.toLowerCase());
    if (expr?.ast?.type === "select" && expr.ast.columns?.length === 1 && !expr.ast._next) {
      return possibleStrings(expr.ast.columns[0].expr);
    }
    if (expr?.type === "function" && expr.name?.name?.[0]?.value?.toUpperCase() === "IF") {
      const args = expr.args?.value;
      if (args?.length !== 3) return undefined;
      const yes = possibleStrings(args[1]), no = possibleStrings(args[2]);
      if (yes && no) return [...yes, ...no];
    }
    return undefined;
  };
  const inspectDynamic = (literals: string[] | undefined, migration: string, fallback = targets) => {
    try {
      if (!literals?.length) throw new Error("Unresolved SQL source");
      for (const literal of literals) {
        const ddl: any = parser.astify(literal, { database: "MySQL" });
        if (["select", "insert", "update", "delete"].includes(ddl.type)) continue;
        const names = ddl.table ?? ddl.name;
        if (names?.length !== 1) throw new Error("Unresolved DDL target");
        const table = names[0].table.toLowerCase();
        if (!targets.includes(table)) continue;
        if (ddl.type !== "alter") { markTables([table], migration); continue; }
        for (const expr of ddl.expr) {
          if (expr.resource === "column") {
            for (const col of [expr.column?.column, expr.old_column?.column].filter(Boolean)) {
              const key = `${table}.${col.toLowerCase()}`;
              if (CHECKS.some((c) => `${c.enumDef.table}.${c.enumDef.column}` === key)) uncovered.set(key, migration);
            }
          } else if (expr.keyword?.toLowerCase() !== "comment" &&
            !["index", "constraint", "primary key", "foreign key"].includes(expr.resource)) {
            throw new Error("Unresolved DDL action");
          }
        }
      }
    } catch { markTables(fallback, migration); }
  };
  for (const migration of await loadMigrations(directory)) {
    for (const raw of splitSqlStatements(migration.sql)) {
      // Preserve quoted content. MySQL/MariaDB executable comments may alter
      // schema depending on the server version; they are not verified offline.
      const sql = raw.replace(/('(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`[^`]*`)|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g,
        (match, quoted) => {
          if (!quoted && /^\/\*(?:!|M!)/i.test(match)) {
            variables.clear();
            markTables(targets, migration.id);
          }
          return quoted ?? " ";
        }).trim();
      // Dynamic dispatch must be inspected before the contiguous DDL filter:
      // CONCAT/unknown expressions may contain no complete DDL keywords at all.
      if (/^CALL\b/i.test(sql)) {
        variables.clear();
        markTables(targets, migration.id);
        continue;
      }
      if (sql.includes("@")) {
        for (const m of sql.matchAll(/@(\w+)\s*(?::=|=(?!=))/gi)) variables.set(m[1].toLowerCase(), undefined);
        const into = sql.match(/\bINTO\s+(@\w+(?:\s*,\s*@\w+)*)/i);
        if (into) for (const m of into[1].matchAll(/@(\w+)/g)) variables.set(m[1].toLowerCase(), undefined);
        if (/^(?:SET|SELECT)\b/i.test(sql)) try {
          const ast: any = parser.astify(sql, { database: "MySQL" });
          if (ast.type === "set") for (const assignment of ast.expr) {
            if (assignment.left?.prefix === "@") {
              variables.set(assignment.left.name.toLowerCase(), possibleStrings(assignment.right));
            }
          }
        } catch { variables.clear(); }
      }
      if (/^PREPARE\b/i.test(sql)) {
        const m = sql.match(/^PREPARE\s+(\w+)\s+FROM\s+([\s\S]+)$/i);
        let literals: string[] | undefined;
        if (m) {
          prepared.add(m[1].toLowerCase());
          try {
            const select: any = parser.astify(`SELECT ${m[2]}`, { database: "MySQL" });
            literals = possibleStrings(select.columns?.[0]?.expr);
          } catch { /* Unknown source must invalidate verification. */ }
        }
        inspectDynamic(literals, migration.id);
        continue;
      }
      if (/^EXECUTE\b/i.test(sql)) {
        const m = sql.match(/^EXECUTE\s+(\w+)(?:\s+USING\s+[\s\S]+)?$/i);
        if (!m || !prepared.has(m[1].toLowerCase())) markTables(targets, migration.id);
        continue;
      }
      if (/^DEALLOCATE\s+PREPARE\b/i.test(sql)) {
        const name = sql.match(/^DEALLOCATE\s+PREPARE\s+(\w+)$/i)?.[1];
        if (name) prepared.delete(name.toLowerCase());
        continue;
      }
      if (!/\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|RENAME\s+TABLE)\b/i.test(sql)) continue;
      const affected = targets.filter((table) => new RegExp(
        `\\b(?:CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|ALTER\\s+TABLE\\s+|DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?|RENAME\\s+TABLE\\s+)(?:(?:\x60(?:\x60\x60|[^\x60])+\x60|[^\\s.\x60;(),]+)\\s*\\.\\s*)?\x60?${table}\\b`, "i",
      ).test(sql) || (/\b(?:DROP|RENAME)\s+TABLE\b/i.test(sql) && new RegExp(`\\b${table}\\b`, "i").test(sql)));
      if (!affected.length) continue;
      const markUncovered = () => markTables(affected, migration.id);
      // SQL stored in SET/IF/PREPARE cannot be assumed to have executed.
      if (!/^(?:CREATE|ALTER|DROP|RENAME)\s+TABLE\b/i.test(sql)) {
        // Literal DDL can still prove which columns it can affect. Do not
        // invalidate an ENUM merely because a conditional adds another column.
        const literals = [...sql.matchAll(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"/g)]
          .map((m) => m[0].slice(1, -1).replace(/''/g, "'").replace(/""/g, '"').replace(/\\(['"\\])/g, "$1"))
          .filter((s) => /^(?:CREATE|ALTER|DROP|RENAME)\s+TABLE\b/i.test(s));
        inspectDynamic(literals, migration.id, affected);
        continue;
      }
      try {
        // AST shape is provided by the existing node-sql-parser dependency.
        const ast: any = parser.astify(sql, { database: "MySQL" });
        if (Array.isArray(ast) || ast.table?.length > 1 || ast.name?.length > 1) { markUncovered(); continue; }
        const table = ast.table?.[0]?.table?.toLowerCase() ?? ast.name?.[0]?.table?.toLowerCase();
        if (!table || !targets.includes(table)) { markUncovered(); continue; }
        const setColumn = (column: string, definition: any) => {
          const values = definition?.dataType?.toUpperCase() === "ENUM"
            ? definition.expr?.value?.map((v: any) => v.value) : null;
          columns.set(`${table}.${column.toLowerCase()}`, values);
        };
        if (ast.type === "create" && ast.create_definitions) {
          if (tables.has(table) && ast.if_not_exists) continue;
          tables.add(table);
          for (const def of ast.create_definitions) {
            if (def.resource === "column") setColumn(def.column.column, def.definition);
          }
        } else if (ast.type === "alter") {
          for (const expr of ast.expr) {
            if (expr.keyword?.toLowerCase() === "comment") continue;
            if (expr.resource !== "column") {
              if (!["index", "constraint", "primary key", "foreign key"].includes(expr.resource)) markUncovered();
              continue;
            }
            const key = `${table}.${expr.column.column.toLowerCase()}`;
            if (expr.action === "drop") columns.delete(key);
            else if (expr.action === "rename") {
              const oldKey = `${table}.${expr.old_column.column.toLowerCase()}`;
              if (columns.has(oldKey)) columns.set(key, columns.get(oldKey)!);
              columns.delete(oldKey);
            } else if (["add", "modify", "change"].includes(expr.action)) {
              if (expr.old_column) columns.delete(`${table}.${expr.old_column.column.toLowerCase()}`);
              setColumn(expr.column.column, expr.definition);
            } else markUncovered();
          }
        } else if (ast.type === "drop") {
          for (const key of columns.keys()) if (key.startsWith(`${table}.`)) columns.delete(key);
          tables.delete(table);
        } else markUncovered();
      } catch {
        markUncovered();
      }
    }
  }
  return { columns, uncovered };
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
async function main() {
  const directory = join(__dirname, "..", "sql", "migrations");

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Schema-Code Consistency Checker        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const { columns, uncovered } = await extractEnums(directory);
  console.log(`📋 Checking ordered sql/migrations (static, no database connection)\n`);

  let ok = 0;
  let fail = 0;
  let missing = 0;
  let notCovered = 0;

  for (const check of CHECKS) {
    const key = `${check.enumDef.table}.${check.enumDef.column}`;
    const values = columns.get(key);

    console.log(`  ${key}:`);

    if (uncovered.has(key)) {
      console.log(`    ⚠️  UNCOVERED: unsupported or conditional DDL in ${uncovered.get(key)}`);
      notCovered++;
      continue;
    }
    if (!columns.has(key)) {
      console.log(`    ❌ MISSING: column not found in migration projection`);
      missing++;
      continue;
    }
    if (!values) {
      console.log(`    ❌ NOT ENUM: column type changed`);
      fail++;
      continue;
    }

    let checkOk = true;
    for (const cv of check.codeValues) {
      if (!values.includes(cv.value)) {
        console.log(`    ❌ '${cv.value}' (${cv.file}) — NOT IN ENUM`);
        console.log(`       Schema has: ${values.join(", ")}`);
        checkOk = false;
      }
    }

    if (checkOk) {
      console.log(`    ✅ ${check.codeValues.length} values all match (${values.length} in schema)`);
      ok++;
    } else fail++;
  }

  const unsuccessful = fail + missing + notCovered;
  console.log(`\n${unsuccessful === 0 ? "✅" : "❌"} ${ok} passed, ${fail} failed, ${missing} missing, ${notCovered} uncovered\n`);
  process.exitCode = unsuccessful > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`❌ Schema validation failed: ${error.message}`);
  process.exitCode = 1;
});
