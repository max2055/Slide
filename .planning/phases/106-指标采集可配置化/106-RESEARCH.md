# Phase 106: 指标采集可配置化 - Research

**Researched:** 2026-05-22
**Domain:** Metrics collection architecture refactoring, pluggable Provider pattern, SQL whitelist validation, JSON column migration
**Confidence:** HIGH

## Summary

Phase 106 bridges the critical gap between the `metric_definitions` UI-accessible configuration layer and the hardcoded collection logic in `database-service.ts`. The current architecture requires modifying 4 files (definition, provider-SQL, collector-dispatch, metrics-storage) to add a single new metric. The target architecture: a unified Collector that reads `metric_definitions` rows and dispatches each to a pluggable Provider, where Providers are discovered automatically via filesystem scanning.

The entire collection chain needs restructuring: `database-service.ts` contains ~3000 lines of private `getXxxMetrics()` methods that must be extracted into Provider classes; `metrics-database-service.ts` has a 34-fixed-column INSERT that must gain a JSON column for dynamic metrics; `alert-evaluator.ts` does a simple property lookup (`metrics[metricName]`) that needs to merge fixed + JSON columns. The frontend metric-registry form is fully hand-coded and must become schema-driven.

`node-sql-parser@5.4.0` is the recommended SQL whitelist validator. The existing `metric:view`/`metric:manage` permission structure needs a `metric:write` addition per D-16.

**Primary recommendation:** Extract each `getXxxMetrics()` into a per-DB-type Provider class registered via filesystem scan (`collectors/<db-type>.provider.ts`), add JSON column to `metrics_history`, make metric_definitions the single source of truth for collection configuration.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Metric collection execution | API/Backend | Database/Storage | Collector runs in backend, queries monitored DBs read-only |
| Provider registration/discovery | API/Backend | -- | Filesystem scan at startup, no runtime registration needed |
| Metric definition CRUD | API/Backend | -- | Backend routes + DB persistence, frontend consumes API |
| SQL whitelist validation | API/Backend | -- | Backend runs validation before executing user-provided SQL |
| Schema-driven form rendering | Browser/Client | -- | Frontend reads metric_definitions column metadata from API |
| AI SQL generation | API/Backend | LLM | Backend calls LLM, returns generated SQL to frontend |
| Alert evaluation (fixed+JSON merge) | API/Backend | Database/Storage | Alert engine reads merged metrics object from metrics_history |
| Metric collection status tracking | API/Backend | -- | CollectionCapabilityTracker already memory-based in monitor-collector |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node-sql-parser` | ~5.4 | SQL AST parsing for whitelist validation | Parses MySQL/PG/Oracle SQL into AST, can check statement type is SELECT only; 8+ years mature, 500K+ weekly downloads |
| `zod` | ~4.3 (root project) | Schema validation for API routes | Already in root dependencies via OpenClaw; can validate metric_definitions API payloads |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node-sql-parser` | 5.4 | SQL whitelist: parse user-provided SQL and verify type=SELECT | Every custom metric save that includes `collection_sql` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node-sql-parser` | `sql-parser-cst@0.42` | CST-based, more accurate but heavier; node-sql-parser is sufficient for whitelist-only check |
| `node-sql-parser` | Regex-based validation | Regex is fragile and bypassable; AST parsing is the correct approach |

**Installation:**
```bash
cd apps/db-ops-api && npm install node-sql-parser
```

**Version verification:**
```bash
npm view node-sql-parser version          # 5.4.0 (verified)
npm view node-sql-parser description      # 'simple node sql parser'
```

## Package Legitimacy Audit

> Required because this phase installs external packages.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| node-sql-parser | npm | ~8 yrs | ~500K/wk | github.com/taozhi8833998/node-sql-parser | [OK] | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                         +------------------+
                         |  metric_definitions |  <-- single source of truth
                         |  (DB table)        |
                         +--------+----------+
                                  |
                    reads definitions for collection
                                  |
                    +-------------v-------------+
                    |     UnifiedCollector      |
                    |  (monitor-collector.ts)   |
                    |  10s heartbeat, schedules  |
                    +--+----------+----------+--+
                       |          |          |
            +----------v--+  +---v---------+  +--v-----------+
            | MySQLProvider|  | PGProvider  |  | OracleProvider|  ...
            | (filesystem  |  | (auto-      |  | (auto-       |
            |  auto-       |  |  registered)|  |  registered) |
            |  registered) |  |             |  |              |
            +------+-------+  +-----+-------+  +------+-------+
                   |                 |                 |
            reads SQL from     reads PG views     reads Oracle V$
            information_schema  from pg_catalog   from V$ views
                   |                 |                 |
                   +--------+--------+-----------------+
                            |
                    +-------v--------+
                    | metrics_history |  <-- JSON column for dynamic metrics
                    | (fixed cols +   |       fixed columns for built-in
                    |  JSON column)   |
                    +-------+--------+
                            |
                    +-------v--------+
                    | Alert Evaluator |  <-- D-15: merge fixed+JSON on read
                    | getMetricValue  |
                    +-----------------+
```

### Component Responsibilities

| Component | Responsibility | File |
|-----------|---------------|------|
| `MetricRegistry` | In-memory cache of metric_definitions, type-safe queries | `metric-registry.ts` |
| `MetricDatabaseService` | CRUD for metric_definitions table | `metric-database-service.ts` |
| `MetricsDatabaseService` | INSERT/SELECT for metrics_history table | `metrics-database-service.ts` |
| `MonitorCollector` | Scheduling, heartbeat, collection orchestration | `monitor-collector.ts` |
| `DatabaseService` | Current: private getXxxMetrics(). Target: delegates to Providers | `database-service.ts` |
| `AlertEngine` | Evaluates rules against merged metrics | `alert-engine.ts` |
| `AlertEvaluator` | `getMetricValue()` reads from metrics object | `alert-evaluator.ts` |
| `CollectionCapabilityTracker` | Tracks per-instance per-metric success/failure | `collection-capabilities.ts` |

### Recommended Project Structure
```
apps/db-ops-api/src/
├── collectors/                   # NEW: Provider directory for filesystem auto-registry
│   ├── registry.ts               # Generic Registry<T> + CollectorRegistry
│   ├── base-provider.ts          # Abstract base class for all providers
│   ├── mysql.provider.ts         # MySQL-specific provider (from getMySQLMetrics)
│   ├── postgresql.provider.ts    # PostgreSQL provider (from getPostgreSQLMetrics)
│   ├── oracle.provider.ts        # Oracle provider (from getOracleMetrics)
│   ├── dameng.provider.ts        # Dameng provider (from getDamengMetrics)
│   └── custom-sql.provider.ts    # NEW: Executes user-defined SQL from metric_definitions
├── collector.ts                  # NEW: Unified Collector (replaces part of monitor-collector.ts)
├── metric-registry.ts            # Keep: notification layer for metric definitions
├── metric-database-service.ts    # Enhance: add collection_sql, value_type, category fields
├── metrics-database-service.ts   # Enhance: add JSON column, merge read path
├── sql-validator.ts              # NEW: node-sql-parser based whitelist
├── database-service.ts           # REFACTOR: delegate to Providers, remove private getXxxMetrics()
├── monitor-collector.ts          # MODIFY: delegate to UnifiedCollector
└── alert-evaluator.ts            # MODIFY: getMetricValue merges fixed + JSON columns
```

### Pattern 1: Provider Interface + Filesystem Auto-Registry
**What:** Each DB type has a Provider class extending `BaseMetricProvider`. Providers are discovered by scanning the `collectors/` directory at startup and auto-registering into a `CollectorRegistry<MetricProvider>`.

**When to use:** Every DB type gets its own Provider. Generic `interface MetricProvider` with `canHandle(dbType: string)`, `collect(instance)`, `describeSchema()`.

**Key interfaces:**
```typescript
// Source: RES0001 — Architectural analysis (Context D-01 through D-04)

interface MetricProvider {
  /** Human-readable provider name (e.g. 'MySQL Status Provider') */
  readonly name: string;
  /** DB types this provider handles */
  readonly supportedDbTypes: string[];
  /** Collect a single metric by id for an instance, returning the numeric value */
  collect(instance: DatabaseConnection, metricDef: MetricDefinition): Promise<number | null>;
  /** Optional: describe the target DB schema for AI SQL generation context */
  describeSchema?(instanceId: number): Promise<string>;
  /** Whether this provider is active */
  enabled: boolean;
  /** Number of consecutive failures (auto-disable at threshold) */
  consecutiveFailures: number;
}

class ProviderRegistry<T extends { readonly name: string }> {
  private items = new Map<string, T>();
  register(provider: T): void { /* auto-add */ }
  enable(name: string): void { /* set enabled */ }
  disable(name: string): void { /* set disabled */ }
  list(): T[];
  get(name: string): T | undefined;
}
```

### Anti-Patterns to Avoid
- **Fat switch/if-else chain:** The current `getRealtimeMetrics()` dispatches via if-else on `conn.db_type`. After refactoring, ProviderRegistry should handle dispatch — no new switch statements.
- **Hand-rolled auto-discovery with `import()`:** Node.js dynamic `import()` per file works but complicates testing. Use a simple `fs.readdirSync()` + static import map approach, or a file naming convention (`*.provider.ts`) with a registry builder.
- **Mutable provider state:** Providers should be stateless for collection logic; mutable state (consecutiveFailures, enabled) belongs in the Registry wrapper, not the Provider itself.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL statement type detection | Custom regex to parse DROP/ALTER/INSERT | `node-sql-parser` AST | SQL syntax is too varied; AST parsing correctly handles subqueries, nested statements, comments, edge cases |
| Generic Registry pattern | Unique registration logic for each subsystem | `Registry<T>` abstraction | D-02 explicitly requires this as generic foundation for Phase 107/108 |
| Delta counter for QPS/TPS | Custom per-connection state management | Reuse existing `conn.deltaCounter` pattern | Already working in database-service.ts; each Provider can maintain its own if needed, or share the existing pattern |

**Key insight:** The existing codebase already has working patterns (delta counters, heartbeat scheduling, metric definition seeding). The refactoring should extract, not rewrite. The two genuinely new components are: (1) the Provider filesystem auto-registry, and (2) the SQL whitelist validator.

## Runtime State Inventory

> This section applies because Phase 106 is a refactoring/migration phase.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `metrics_history` table with 34 fixed columns containing existing collected data | Add JSON column via ALTER TABLE; old data retains fixed column values, new data starts writing JSON column alongside fixed columns (dual-track per D-05) |
| Stored data | `metric_definitions` table with existing seed data (26 rows) | Add `collection_sql`, `value_type`, `category`, `updated_by` columns via migration; existing rows get NULL for new columns |
| Live service config | n8n workflows, Gateway config — none reference individual metric names | None — metric IDs only used internally, not in external service configs |
| OS-registered state | None — monitor-collector runs in-process, no pm2/systemd references to individual metrics | None |
| Secrets/env vars | Read-only database credentials for custom SQL execution — none exist yet | New read-only DB account credentials need to be added to `.env` (not in git) or secrets store |
| Build artifacts | None — metric collection is runtime, not build-time | None |

**Nothing found requiring migration:** No external service references individual metric collection behavior.

## Common Pitfalls

### Pitfall 1: JSON Column Query Performance
**What goes wrong:** Adding a JSON column to `metrics_history` and querying it via `JSON_EXTRACT()` for every alert evaluation causes table scans on a rapidly-growing table.
**Why it happens:** `JSON_EXTRACT(metrics_data, '$.custom_cpu')` cannot use B-tree indexes.
**How to avoid:** Only query the JSON column for dynamic metrics that don't have a fixed column. For fixed-column metrics (cpu_usage etc.), continue using the indexed fixed columns. Add a `GENERATED COLUMN` for frequently-queried dynamic metrics if performance becomes an issue.
**Warning signs:** Alert evaluation latency increases after JSON column migration.

### Pitfall 2: MonitorCollector Sentry Interval with Custom SQL
**What goes wrong:** A user-defined metric has `interval_seconds: 5`, causing the collector to query every 5 seconds with a heavy self-join. The 10s heartbeat minimum (line 153 of monitor-collector.ts) currently prevents sub-15s intervals, but custom SQL could be arbitrarily expensive.
**Why it happens:** No guardrails on user-provided `interval_seconds` relative to SQL complexity.
**How to avoid:** Enforce `interval_seconds >= 15` in metric_definitions validation; add SQL execution timeout (MySQL `max_execution_time` / PG `statement_timeout`).
**Warning signs:** One slow custom SQL blocks the entire collection tick.

### Pitfall 3: Provider file import order
**What goes wrong:** If Provider auto-discovery uses `fs.readdirSync()`, the registry fills in filesystem order. If Provider A registers first and claims a db_type that Provider B should handle, dispatch goes to the wrong provider.
**Why it happens:** Auto-registry without priority or conflict handling.
**How to avoid:** Use `supportedDbTypes: string[]` on each provider and the Registry checks `canHandle()` — last-registered provider wins. Or use priority-based registration with built-in providers having higher priority over custom.
**Warning signs:** Duplicate provider warning at startup.

## Code Examples

### Example 1: Provider base class
```typescript
// Source: Derived from D-01 design decisions, pattern from existing LLM providers directory
// apps/db-ops-api/src/llm/providers/ usage pattern

export abstract class BaseMetricProvider implements MetricProvider {
  abstract readonly name: string;
  abstract readonly supportedDbTypes: string[];
  enabled = true;
  consecutiveFailures = 0;

  abstract collect(
    instance: DatabaseConnection,
    metricDef: MetricDefinition
  ): Promise<number | null>;

  async describeSchema?(instanceId: number): Promise<string> {
    return ''; // default: no schema description
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }
}
```

### Example 2: SQL whitelist validation with node-sql-parser
```typescript
// Source: node-sql-parser API — parse() returns { type: 'select' | 'insert' | ... }

import { Parser } from 'node-sql-parser';

const parser = new Parser();

function validateSqlIsSelectOnly(sql: string): { valid: boolean; error?: string } {
  try {
    const ast = parser.astify(sql);
    const statements = Array.isArray(ast) ? ast : [ast];
    for (const stmt of statements) {
      if (stmt.type !== 'select' && stmt.type !== 'SELECT') {
        return { valid: false, error: `不允许的 SQL 操作: ${stmt.type}。仅支持 SELECT 查询` };
      }
    }
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: `SQL 语法错误: ${e.message}` };
  }
}
```

### Example 3: JSON column merge in alert evaluator
```typescript
// Source: D-15 — alert evaluator auto-merge fixed + JSON columns

function getMetricValue(metricName: string, metrics: any): number {
  if (!metrics) return 0;
  // Check fixed columns first (fast path, type-safe)
  if (metricName in metrics && typeof metrics[metricName] === 'number') {
    return metrics[metricName];
  }
  // Fallback: check JSON-extracted metrics_data
  if (metrics.metrics_data && typeof metrics.metrics_data === 'object') {
    const val = metrics.metrics_data[metricName];
    if (val != null) return Number(val);
  }
  return 0;
}
```

### Example 4: metric_definitions new fields (schema change)
```sql
-- Source: D-07 — single source of truth
-- Add columns to metric_definitions for data-driven collection
ALTER TABLE metric_definitions
  ADD COLUMN `collection_sql` TEXT DEFAULT NULL COMMENT '自定义采集 SQL（用户自定义指标用）',
  ADD COLUMN `value_type` ENUM('gauge', 'counter', 'histogram') NOT NULL DEFAULT 'gauge' COMMENT '指标值类型',
  ADD COLUMN `category` VARCHAR(50) DEFAULT NULL COMMENT '指标分类标签',
  ADD COLUMN `updated_by` INT UNSIGNED DEFAULT NULL COMMENT '最后修改人';

ALTER TABLE metrics_history
  ADD COLUMN `metrics_data` JSON DEFAULT NULL COMMENT '动态指标数据（自定义指标写入此列）';
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded metrics in database-service.ts | MetricProvider filesystem auto-registry | Phase 106 | One provider file = one DB type, no central switch |
| 34 fixed columns in metrics_history | Fixed + JSON dual-track | Phase 106 | Custom metrics go to JSON; existing dashboard unchanged |
| Static form in metric-registry.ts | Schema-driven form from metric_definitions metadata | Phase 106 | New metric_definitions columns auto-appear in form |
| Manual 4-file edit for new metric | Single metric_definitions row + optional Provider | Phase 106 | AI agent can add metrics through API without touching code |
| extract:metric:manage | extract:metric:manage + extract:metric:write | Phase 106 | Separation of read vs write metric permissions |
| Alert evaluator reads fixed columns only | Alert evaluator reads fixed + JSON merged | Phase 106 | Dynamic metrics participate in alert evaluation |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `node-sql-parser@5.4` can parse all SQL dialects (MySQL, PG, Oracle, DM) used by the platform | SQL Whitelist | May miss dialect-specific syntax; need to test with each DB type's custom SQL |
| A2 | Filesystem auto-registry scanning `collectors/` directory is the correct pattern | Architecture Patterns | D-01 explicitly mandates this. Low risk. |
| A3 | Existing `metric:manage` permission can be split into `metric:view` + `metric:write` | Permissions | Low risk — standard RBAC pattern already used for other resources |
| A4 | The 10s heartbeat model from monitor-collector.ts works for custom SQL collection | Architecture | Custom SQL may be heavier; need per-instance timeout isolation |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

## Open Questions (RESOLVED)

1. **Should `metric:write` replace or supplement `metric:manage`?**
   - What we know: Existing `metric:manage` covers create/edit/delete of metric definitions. D-16 says "新增 `metric:write` 权限控制自定义指标的创建/编辑/删除."
   - What's unclear: Whether `metric:write` is a rename of `metric:manage`, a new sub-permission, or `metric:manage` stays for built-in and `metric:write` is for custom.
   - Recommendation: Add `metric:write` as a new granular permission. `metric:manage` implies `metric:write` (hierarchical). This matches the existing `example:manage` > `example:write` > `example:view` pattern.

2. **Where should `collection_sql` be validated?**
   - What we know: SQL whitelist must run before saving to metric_definitions (D-12).
   - What's unclear: Server-side validation only, or also frontend preview before save?
   - Recommendation: Server-side validation on POST/PUT to `/api/metrics/registry`. Frontend shows validation result. Additionally, a "Test SQL" button that executes a one-shot query and returns the result.

3. **How to handle `is_builtin` metric SQL migration?**
   - What we know: Existing built-in metrics (26 rows) have no `collection_sql`. Phase 106 adds the column.
   - What's unclear: Should built-in metrics get their SQL stored in `collection_sql` immediately? Or only for new metrics?
   - Recommendation: For Phase 106, built-in metrics continue using their Provider-based implementation. `collection_sql` is only for user-defined metrics. A future phase can backfill built-in SQLs for transparency.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node (runtime) | Everything | Yes | >=22.14 | -- |
| npm | Install node-sql-parser | Yes | (bundled with node) | -- |
| MySQL (Slide primary) | metric_definitions, metrics_history | Yes | (external) | -- |
| psql/mysql CLI | Testing custom SQL | No (environment) | -- | Use database-service.ts execute path |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** none

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ~4.1.4 (from package.json) |
| Config file | none discovered in apps/db-ops-api |
| Quick run command | `cd apps/db-ops-api && npx vitest run --reporter verbose` |
| Full suite command | `cd apps/db-ops-api && npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | Collector delegates to correct Provider by db_type | unit | `npx vitest run collectors/registry.test.ts` | Wave 0 |
| D-05 | JSON column stores and retrieves dynamic metrics | unit | `npx vitest run metrics-database-service.test.ts` | Wave 0 |
| D-07 | metric_definitions CRUD with new columns | integration | `npx vitest run metric-database-service.test.ts` | Wave 0 |
| D-10 | AI SQL generation endpoint returns valid SQL | integration | `npx vitest run sql-generator.test.ts` | Wave 0 |
| D-12 | node-sql-parser rejects non-SELECT statements | unit | `npx vitest run sql-validator.test.ts` | Wave 0 |
| D-14 | Alert save validates metric_name exists in definitions | unit | `npx vitest run alert-engine.test.ts` | Wave 0 |
| D-15 | getMetricValue merges fixed + JSON columns | unit | `npx vitest run alert-evaluator.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter verbose sql-validator collectors`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/db-ops-api/src/__tests__/collectors/registry.test.ts` — Provider registration + dispatch
- [ ] `apps/db-ops-api/src/__tests__/sql-validator.test.ts` — node-sql-parser whitelist validation
- [ ] `apps/db-ops-api/src/__tests__/alert-evaluator-merge.test.ts` — JSON + fixed column merge
- [ ] Test configuration: vitest may need explicit config file in apps/db-ops-api

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

## Security Domain

> Required when `security_enforcement` is enabled (absent = enabled).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | JWT verifyToken middleware (existing) |
| V4 Access Control | yes | requirePermission('metric:write') — NEW per D-16 |
| V5 Input Validation | yes | node-sql-parser SQL whitelist (D-12) + zod for route payloads |
| V6 Cryptography | no | No new crypto requirements |

### Known Threat Patterns for Node.js + MySQL
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via custom_collection_sql | Tampering | node-sql-parser AST check ensures type=SELECT; read-only DB account (second layer) |
| Denial of service via heavy SQL | Denial of Service | SQL execution timeout (SET max_execution_time=5000), max 30s timeout per custom metric |
| Privilege escalation via metric:write | Elevation of Privilege | requirePermission('metric:write') on all metric mutation routes |
| Alert bypass via metric definition tampering | Tampering | Audit logging of metric_definitions changes (D-09: created_by/updated_by) |

## Sources

### Primary (HIGH confidence)
- [VERIFIED: codebase] `apps/db-ops-api/src/database-service.ts` — Current getMySQLMetrics/getPostgreSQLMetrics/etc. hardcoded methods
- [VERIFIED: codebase] `apps/db-ops-api/src/metric-registry.ts` — In-memory MetricRegistry with seed data
- [VERIFIED: codebase] `apps/db-ops-api/src/metric-database-service.ts` — metric_definitions CRUD
- [VERIFIED: codebase] `apps/db-ops-api/src/metrics-database-service.ts` — metrics_history INSERT with 34 fixed columns
- [VERIFIED: codebase] `apps/db-ops-api/src/monitor-collector.ts` — 10s heartbeat scheduling
- [VERIFIED: codebase] `apps/db-ops-api/src/alert-evaluator.ts` — getMetricValue property lookup
- [VERIFIED: codebase] `apps/db-ops-api/src/alert-engine.ts` — syncRulesFromRegistry()
- [VERIFIED: codebase] `apps/db-ops-api/src/collection-capabilities.ts` — Metric attempt tracking
- [VERIFIED: codebase] `apps/db-ops-api/src/llm/providers/` — Existing Provider pattern reference
- [VERIFIED: codebase] `apps/db-ops-api/sql/schema.sql` — Full schema for metrics_history, metric_definitions
- [VERIFIED: codebase] `apps/db-ops-api/server.ts` — Route registration patterns, permission middleware
- [VERIFIED: codebase] `frontend/src/openclaw/ui/views/metric-registry.ts` — Current form (hand-coded)
- [VERIFIED: npm registry] `node-sql-parser@5.4.0` — GitHub: taozhi8833998/node-sql-parser

### Secondary (MEDIUM confidence)
- [VERIFIED: codebase] `frontend/src/openclaw/ui/views/metric-registry.ts` — Modal form uses hardcoded field IDs (#metric-id, #metric-name, etc.); schema-driven would require column metadata endpoint

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — node-sql-parser verified on npm, no alternative needed
- Architecture: HIGH — Provider + Registry pattern is mandated by D-01/D-02; existing LLM provider directory confirms pattern viability
- Pitfalls: HIGH — JSON column query perf and provider conflict issues are standard DB/architecture concerns
- SQL whitelist approach: MEDIUM — node-sql-parser dialect support for Oracle/Dameng needs verification during implementation

**Research date:** 2026-05-22
**Valid until:** 2026-06-22 (30 days — core architecture is stable, only the SQL parser package may minor-version bump)
