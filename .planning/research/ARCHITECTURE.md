# Architecture Research: v1.3 New Features

**Domain:** AI-Powered Database Operations Platform
**Researched:** 2026-05-20
**Confidence:** HIGH

## Current System Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Frontend (Lit 3.3 + Vite)                      │
│  :5173                                                                │
│  ┌─────────┐  ┌─────────┐  ┌───────────┐  ┌────────────┐             │
│  │ Alerts  │  │ Reports │  │ Rbac Page │  │ Events     │             │
│  │ View    │  │ View    │  │           │  │ Management │             │
│  └────┬────┘  └────┬────┘  └─────┬─────┘  └──────┬─────┘             │
│       │            │             │               │                    │
│  ┌────┴────────────┴─────────────┴───────────────┴────────────────┐   │
│  │                 HTTP REST (Authorization: Bearer <JWT>)         │   │
│  └─────────────────────────────┬──────────────────────────────────┘   │
│                                │                                      │
└────────────────────────────────┼──────────────────────────────────────┘
                                 │
┌────────────────────────────────┼──────────────────────────────────────┐
│                     Backend (Fastify + TypeScript)                     │
│  :3000                                                                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │  Middleware Chain                                              │     │
│  │  verifyToken -> requirePermission(code) -> requireInstanceAccess│   │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              │                                         │
│  ┌──────────────────────────┴───────────────────────────────────┐     │
│  │                    Route Handlers (server.ts)                  │     │
│  │  /api/auth/*  /api/alerts/*  /api/reports/*  /api/users/*     │     │
│  │  /api/alert-rules/*  /api/notification/*  /api/rbac/*          │     │
│  │  /api/metrics/*  /api/database/instances/*                     │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              │                                         │
│  ┌──────────────────────────┴───────────────────────────────────┐     │
│  │                    Service Layer                               │     │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  │     │
│  │  |Alert Engine|  |Notification|  |  Report  |  |  RBAC     |  │     │
│  │  |(Cron 60s)  |  |(Cron 10s)  |  | Service  |  |  Service  |  │     │
│  │  └────────────┘  └───────────┘  └──────────┘  └───────────┘  │     │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────┐                 │     │
│  │  | Escalation |  |  Event    |  | Baseline |                 │     │
│  │  | (Cron 5m)  |  |Aggregator |  |Calculator|                 │     │
│  │  └────────────┘  └───────────┘  └──────────┘                 │     │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────┐                 │     │
│  │  | Alert RCA  |  | AI Config |  |  Skills  |                 │     │
│  │  |  Service   |  |  Service  |  |  Service |                 │     │
│  │  └────────────┘  └───────────┘  └──────────┘                 │     │
│  │  ┌────────────┐  ┌───────────┐                               │     │
│  │  |  Monitor   |  |  Metrics  |                               │     │
│  │  | Collector  |  |DatabaseSvc|                               │     │
│  │  └────────────┘  └───────────┘                               │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              │                                         │
│  ┌──────────────────────────┴───────────────────────────────────┐     │
│  │                    Database Services                           │     │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐   │     │
│  │  | auth-    |  | alert-    |  | report-  |  | metrics-  |   │     │
│  │  | db-svc   |  | db-svc    |  | db-svc   |  | db-svc    |   │     │
│  │  └──────────┘  └───────────┘  └──────────┘  └───────────┘   │     │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐                 │     │
│  │  | instance-|  |notificatio|  | llm-     |                 │     │
│  │  | db-svc   |  |n-db-svc   |  | db-svc   |                 │     │
│  │  └──────────┘  └───────────┘  └──────────┘                 │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              │                                         │
│  ┌──────────────────────────┴───────────────────────────────────┐     │
│  │                      Data Stores                              │     │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐   │     │
│  │  |  MySQL   |  | Elastic   |  | MongoDB  |  |  Redis    |   │     │
│  │  | (primary)|  | (logs)    |  | (metrics)|  | (cache)   |   │     │
│  │  └──────────┘  └───────────┘  └──────────┘  └───────────┘   │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  |         Gateway / AI Layer (OpenClaw native, :28789)          |     │
│  |  WebSocket -> SessionManager -> dispatchInboundMessage -> AI  |     │
│  └──────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

### Existing Component Inventory by Feature Area

#### Alert System (already built)

| Component | Status | Purpose |
|-----------|--------|---------|
| `alert-engine.ts` | PRODUCTION | Cron (60s) -- evaluates all rules, creates alerts |
| `alert-evaluator.ts` | PRODUCTION | Rule evaluation with threshold templates (warning/error/critical) |
| `alert-database-service.ts` | PRODUCTION | CRUD for alerts, alert_rules, alert metadata |
| `alert-rca-service.ts` | PRODUCTION | AI-powered root cause analysis per alert |
| `alert-escalation-service.ts` | PRODUCTION | Cron (5m) -- auto escalate unresolved alerts |
| `alert-silence-service.ts` | PRODUCTION | Instance+metric silence periods after alert creation |
| `alert-event-service.ts` | PRODUCTION | Event lifecycle (open -> investigating -> handled -> resolved -> closed) |
| `event-aggregator.ts` | PRODUCTION | Groups same-type alerts from same instance into events |
| `notification-service.ts` | PRODUCTION | Cron (10s) -- sends alerts to dingtalk/wecom/feishu/webhook |
| `notification-database-service.ts` | PRODUCTION | CRUD for notification channels and records |
| `maintenance-window-service.ts` | PRODUCTION | Maintenance window suppression |
| Tables: `alerts`, `alert_rules`, `alert_events`, `alert_event_members`, `alert_event_logs`, `escalation_rules`, `maintenance_windows`, `silence_periods`, `notification_channels`, `notification_records` | EXIST | All alert-related tables exist |

#### Auth and Permissions (already built)

| Component | Status | Purpose |
|-----------|--------|---------|
| `auth-database-service.ts` | PRODUCTION | User CRUD, login/password (bcrypt), login/action logging |
| `auth/rbac-service.ts` | PRODUCTION | Role/Permission/User-Role/Instance-Permission CRUD + permission lookup |
| `auth/rbac-api.ts` | PRODUCTION | REST API routes for RBAC management |
| `auth/require-permission.ts` | PRODUCTION | Middleware factory with wildcard support (resource:*, *:action, *) |
| `auth/require-instance-access.ts` | PRODUCTION | Instance-level access check middleware |
| `auth-middleware.ts` | DEPRECATED | Replaced by require-permission.ts, kept as marker |
| Tables: `users`, `user_login_logs`, `user_action_logs`, `roles`, `permissions`, `role_permissions`, `user_roles`, `instance_permissions` | EXIST | Full RBAC schema migrated |

#### Report System (already built)

| Component | Status | Purpose |
|-----------|--------|---------|
| `report-service.ts` | PRODUCTION | Generates health/performance/slow-query/capacity HTML reports |
| `report-database-service.ts` | PRODUCTION | CRUD for reports and templates |
| `report-exporter.ts` | PRODUCTION | Export/download reports |
| `frontend views/reports.ts` | PRODUCTION | Reports page UI (uses ov-card pattern) |
| Tables: `reports`, `report_templates` | EXIST | Report data schema |

#### Data Quality / Metrics (already built)

| Component | Status | Purpose |
|-----------|--------|---------|
| `monitor-collector.ts` | PRODUCTION | Zabbix-like heartbeat collection (10s tick, per-instance interval) |
| `metrics-database-service.ts` | PRODUCTION | CRUD for metrics_history and realtime metrics |
| `metric-registry.ts` | PRODUCTION | Metric definition registry (DB-backed + memory fallback) |
| `metric-database-service.ts` | PRODUCTION | CRUD for metric_definitions table |
| `baseline-calculator.ts` | PRODUCTION | Mean/stddev baseline from metrics_history (SQL STDDEV_POP + simple-statistics fallback) |
| Tables: `metrics_history`, `metric_definitions`, `metric_baselines`, `capacity_history`, `instance_pool_stats` | EXIST | All metric-related tables exist |

#### UI Icon System (already built)

| Component | Status | Purpose |
|-----------|--------|---------|
| `frontend icons.ts` | PRODUCTION | ~50 Lucide-style SVG icons as Lit TemplateResults |
| `frontend navigation.ts` | PRODUCTION | Tab group definitions (slide, openclaw, settings) |
| `frontend views/*` | PRODUCTION | 25+ view components |

---

## v1.3 Feature Architecture Analysis

### 1. Alert System Enhancements

#### 1.1 Threshold Editing (current missing)

**Current state:** Alert rules have a flat `threshold` field set on creation via POST /api/alert-rules. The `PUT /api/alert-rules/:id` route handler at `server.ts:1496` only accepts a flat `threshold` and does not write to the `threshold_template` JSON column. The `alertDatabaseService.updateAlertRule()` method lacks `threshold_template` support.

**Problem location:**

- `server.ts` lines 1496-1522: PUT route body parsing does not extract `threshold_template`
- `alert-database-service.ts` `updateAlertRule()` signature: accepts `{ name, description, metric_name, operator, threshold, duration_seconds, severity, enabled, notification_channels }` -- no `threshold_template`

**Data flow gap:**

```
Frontend wants to edit threshold_template
  -> PUT /api/alert-rules/:id  { threshold_template: {warning: 80, error: 90, critical: 95} }
  -> alert_rules table has JSON column `threshold_template`
  -> Currently no code path writes to this column from the API
```

**Required changes:**

1. `alert-database-service.ts` -- add `threshold_template` to `updateAlertRule()` params, write to JSON column via `JSON_SET` or direct stringify
2. `server.ts` PUT route -- extract `threshold_template` from request body, pass to service
3. Frontend `alerts.ts` -- add inline threshold editor (sliders or number inputs for warning/error/critical)

#### 1.2 AI Learning Thresholds (current missing)

**Current state:** `baseline-calculator.ts` computes `mean +/- sigma * stddev` from `metrics_history` using SQL `STDDEV_POP`. `alert-evaluator.ts` has `evaluateRuleWithLevels()` that reads `threshold_template` from the rule. But there is NO automatic mechanism to update `threshold_template` based on baseline calculations.

**Data flow needed:**

```
BaselineCalculator.computeBaselineForMetric(instanceId, metricName)
  -> returns { mean, stddev, upperBound, lowerBound }
  -> AlertThresholdLearner (NEW)
    -> computes new thresholds as mean +/- sigma * stddev
    -> updates alert_rules.threshold_template
    -> stores learning result in alert_threshold_learning_log (NEW TABLE)
    -> fires notification if adjustment exceeds max_change_pct
```

**New component: `alert-threshold-learner.ts`**

```
class AlertThresholdLearner {
  // Cron: daily (configurable)
  async learn(): Promise<{ adjusted: number; skipped: number }>

  // Per-rule learning
  async learnForRule(ruleId: number): Promise<{ adjusted: boolean; newThreshold?: any }>

  // Learning history
  async getLearningHistory(ruleId: number, limit?: number): Promise<LearningLogEntry[]>
}
```

**Integration points:**

- New cron job in `server.ts` (alongside alertEngine, escalationService)
- Reads enabled rules that have `dynamic_config.sigma` set (JSON field on `alert_rules`)
- Calls `BaselineCalculator.computeBaselineForMetric()`
- Computes new thresholds as `mean +/- sigma * stddev`
- Updates `threshold_template` in `alert_rules`
- Logs adjustment in new table

**New DB table needed:**

```sql
CREATE TABLE IF NOT EXISTS `alert_threshold_learning_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rule_id` INT UNSIGNED NOT NULL,
  `instance_id` INT UNSIGNED DEFAULT NULL,
  `previous_threshold` JSON NOT NULL,
  `new_threshold` JSON NOT NULL,
  `baseline_mean` DECIMAL(12,4) NOT NULL,
  `baseline_stddev` DECIMAL(12,4) NOT NULL,
  `sigma` DECIMAL(4,2) NOT NULL,
  `adjustment_pct` DECIMAL(8,4) NOT NULL,
  `applied` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_rule_id` (`rule_id`),
  INDEX `idx_instance_id` (`instance_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### 1.3 Multi-Session Event Aggregation (current limited)

**Current state:** `event-aggregator.ts` groups alerts within a 5-minute window by `instance_id + alert_type + metric_name`. This is single-instance, single-metric aggregation only.

**Gaps:**

- No cross-instance aggregation (e.g., all MySQL instances with high CPU simultaneously)
- No cross-metric correlation (e.g., high CPU + high connections = load spike event)
- Events are purely time-window based, not correlation-based

**Required changes to `event-aggregator.ts`:**

- Add multi-instance aggregation mode: group events by `alert_type` across instances (add optional `multi_instance` boolean to `alert_events`)
- Add correlation aggregation: new method `correlateAndMerge()` that looks for related metrics firing simultaneously within a configurable window and merges them into a single correlation event
- Add AI-powered correlation: accept optional `ai_analysis_id` FK on `alert_events` to link AI-generated correlation analysis

**Frontend impact:**

- Event detail view needs to display correlated alerts across instances
- Add "correlation map" view showing which metrics/instances are linked

#### 1.4 Data Flow: Alert System v1.3

```
MonitorCollector (10s tick)
  -> writes to metrics_history

AlertEngine.evaluateAndCreateAlerts() (cron 60s)
  -> reads metrics_history, evaluates rules
  -> alert-database-service.createAlert() -> alerts table
  ->
  EventAggregator.aggregate() -> alert_events + alert_event_members
    (new) MultiInstanceAggregator.correlateAndMerge()
  ->
  (new) AlertThresholdLearner.learn() (cron daily)
    -> reads baseline, adjusts alert_rules.threshold_template
  ->
  AlertEscalationService.checkEscalations() (cron 5m)
    -> escalate unresolved alert levels
  ->
  NotificationService.pollLoop() (cron 10s)
    -> send via notification channels
```

---

### 2. Auth and Permissions Enhancements

#### 2.1 Token Refresh (current missing)

**Current state:** `server.ts` lines 254-296 -- `POST /api/auth/login` generates a single JWT with `{ userId, username }` and a hardcoded `expiresIn` (from `auth.jwt_expiration_minutes` in `system_config`, default 1440 minutes = 24 hours). There is NO refresh token mechanism. When the JWT expires, the user must re-login.

Frontend stores the token in `localStorage` (seen in `event-management.ts` `authHeaders()` pattern). No refresh logic exists.

**Data flow needed:**

```
Login:
  Frontend -> POST /api/auth/login { username, password }
    -> AuthDatabaseService.verifyPassword() [bcrypt]
    -> Generate JWT (15m short-lived) + Refresh Token (30d)
    -> Return { token, refreshToken, user }
    -> Frontend stores both in localStorage

API request:
  Frontend -> GET /api/alerts [Authorization: Bearer <token>]
    -> verifyToken: jwt.verify(), decode userId
    -> requirePermission -> route handler
    -> If response 401:
      -> POST /api/auth/refresh { refreshToken }
        -> Hash refreshToken, lookup in refresh_tokens table
        -> Check not revoked, not expired
        -> Revoke old refresh token (rotation)
        -> Issue new JWT (15m) + new refresh token (30d)
        -> Return { token, refreshToken }
      -> Retry original request with new token
```

**New backend components:**

- New table: `refresh_tokens`
  ```sql
  CREATE TABLE IF NOT EXISTS `refresh_tokens` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` INT UNSIGNED NOT NULL,
    `token_hash` VARCHAR(64) NOT NULL,
    `expires_at` DATETIME NOT NULL,
    `revoked` BOOLEAN NOT NULL DEFAULT FALSE,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_token_hash` (`token_hash`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_expires_at` (`expires_at`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  ```

- New backend service: extend `auth-database-service.ts` with refresh token methods
  - `createRefreshToken(userId, ttlMinutes)` -> stores hash, returns raw token
  - `validateRefreshToken(rawToken)` -> checks hash, expiry, revocation; returns userId
  - `revokeRefreshToken(rawToken)` -> one-time rotation

- New route in `server.ts`:
  ```typescript
  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body;
    // validate -> issue new tokens -> revoke old -> respond
  });
  ```

**New frontend component: `api/client.ts`**

```typescript
class ApiClient {
  private token: string | null = localStorage.getItem('token');
  private refreshToken: string | null = localStorage.getItem('refreshToken');
  private refreshing: Promise<void> | null = null;

  async fetch(url: string, options?: RequestInit): Promise<Response> {
    const res = await fetch(url, {
      ...options,
      headers: { ...options?.headers, Authorization: `Bearer ${this.token}` }
    });
    if (res.status === 401 && this.refreshToken) {
      // Deduplicate concurrent refresh attempts
      if (!this.refreshing) {
        this.refreshing = this.doRefresh();
      }
      await this.refreshing;
      this.refreshing = null;
      return this.fetch(url, options); // retry with new token
    }
    return res;
  }
}
```

#### 2.2 Permission Granularity (enhancement)

**Current state:** `require-permission.ts` uses `resource:action` code format with wildcard support. This is already reasonably granular for role-based access. The gaps for v1.3:

1. No **session-scoped** permissions -- temporary grants that expire
2. No **deny rules** -- only allow rules via `role_permissions`
3. No per-instance permission level differentiation (read vs write vs admin)

**v1.3 recommendations:**

- Add `grant_expires_at` column to `user_roles` for time-bound role assignments
- Add `access_level` ENUM to `instance_permissions` (`read | write | admin`)
- Keep deny rules OUT OF SCOPE -- not needed for current feature set, would require re-architecting the middleware chain

**New DB migration:**

```sql
ALTER TABLE user_roles ADD COLUMN expires_at DATETIME DEFAULT NULL
  COMMENT 'NULL = permanent, otherwise grant expires at this time';

ALTER TABLE instance_permissions ADD COLUMN access_level ENUM('read', 'write', 'admin') NOT NULL DEFAULT 'read';
```

**Modified middleware:**

- `require-permission.ts` -- add `expires_at` check: if grant has expired, treat as no permission
- `require-instance-access.ts` -- add `access_level` parameter variant: `requireInstanceAccess('admin')` for destructive operations

---

### 3. Report Refactoring

#### 3.1 Current Architecture Problems

**Problem 1: ov-card pattern in frontend** -- The `reports.ts` view uses `.ov-cards` / `.ov-card` CSS classes, a legacy pattern from early development. Other views have migrated to more consistent `.card` based styling. This is a visual inconsistency.

**Problem 2: Report/Report concept conflation** -- The app uses both `reports` (HTML document content stored in DB) and `report_templates` (table exists but unused). The distinction between a report definition (config) and a report run (instance) is unclear.

**Problem 3: Report types are rigid** -- Only 4 hardcoded types: `health`, `performance`, `slow-query`, `capacity`. No extensibility mechanism.

**Problem 4: HTML generation in service layer** -- `report-service.ts` has ~250 lines of inline HTML templates as JavaScript template strings. This is unmaintainable -- cannot be edited without code changes, no syntax highlighting, no testing.

#### 3.2 Recommended Architecture Changes

**Consolidate report concepts:**

```
OLD: reports (one-off HTML docs) + report_templates (unused table)
NEW: report_configs (definitions) -> report_runs (execution instances)
```

**Old table adaptation:**

Rather than renaming `reports`, add `config_id` FK column and repurpose:

```sql
ALTER TABLE reports ADD COLUMN config_id INT UNSIGNED DEFAULT NULL AFTER id;
ALTER TABLE reports ADD COLUMN params JSON DEFAULT NULL AFTER data;
ALTER TABLE reports ADD INDEX idx_config_id (config_id);

CREATE TABLE IF NOT EXISTS `report_configs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `type` VARCHAR(50) NOT NULL,
  `schedule_cron` VARCHAR(100) DEFAULT NULL,
  `params` JSON DEFAULT NULL,
  `template` TEXT DEFAULT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_type` (`type`),
  INDEX `idx_enabled` (`enabled`),
  INDEX `idx_created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Service refactoring:**

```
report-service.ts
  ->
  ReportConfigService (NEW) - CRUD for report_configs
    - createConfig, getConfig, listConfigs, updateConfig, deleteConfig
    - runConfig: generate a report from a config

  ReportExecutionService (EXTRACT from existing report-service.ts)
    - generateReport(type, instanceId, options) -- keeps existing per-type methods
    - runScheduled() -- check configs with matching cron, execute
    - generateFromConfig(configId, options) -- new unified entry point

  report-templates/ (NEW DIRECTORY)
    - health.html (template file, not inline)
    - performance.html
    - slow-query.html
    - capacity.html
    Using a simple {{ variable }} replacement engine (NO heavy template lib needed for v1.3)
```

**Frontend changes:**

- `reports.ts` -- replace `.ov-card` with standard `.card` pattern (shared CSS class)
- Add report config management UI (create/edit/re-run existing configs)
- Separate list view (past runs) from config view (definitions with schedules)
- Remove inline SVGs/emojis for report type icons, use shared `icons.ts`

#### 3.3 Data Flow: Reports v1.3

```
Create config:
  Frontend -> POST /api/report/configs { name, type, params, schedule_cron }
    -> ReportConfigService.createConfig()
    -> INSERT INTO report_configs

Generate report from config:
  Frontend -> POST /api/reports/generate { config_id }
    -> OR Cron trigger on schedule
    -> ReportExecutionService.generateFromConfig(config_id)
      -> Load config, merge with template
      -> Collect data (existing: collectHealthMetrics / collectPerformanceMetrics)
      -> Render template with data
      -> INSERT INTO reports (config_id, type, status='completed', content, data)
    -> Return report_id

Migrate existing reports to config_id:
  Existing one-off reports get config_id = NULL (backward compatible)

Remove ov-card:
  Frontend reports.ts -> change CSS class from ov-cards/ov-card to standard card pattern
```

---

### 4. Data Quality Enhancements

#### 4.1 Instance Scoring Algorithm (current missing)

**Current state:** `report-service.ts` line 321 -- `health_score` is hardcoded to `100` with a TODO comment `TODO: implement health scoring logic`. The `health_check_history` table exists but is rarely used.

**New component: `instance-score-service.ts`**

```typescript
interface InstanceScore {
  instanceId: number;
  overall: number;               // 0-100 composite
  categoryScores: {
    availability: number;         // 0-100
    performance: number;          // 0-100
    capacity: number;             // 0-100
    security: number;             // 0-100
  };
  categoryWeights: {
    availability: number;         // default 0.35
    performance: number;          // default 0.35
    capacity: number;             // default 0.20
    security: number;             // default 0.10
  };
  trend: 'improving' | 'stable' | 'declining';
  computedAt: Date;
}

class InstanceScoreService {
  async computeScore(instanceId: number): Promise<InstanceScore>;
  async getScoreHistory(instanceId: number, days: number): Promise<InstanceScore[]>;
  async getScoreBreakdown(instanceId: number): Promise<ScoreBreakdown>;
}
```

**Scoring algorithm:**

```
overall = SUM(categoryWeight * categoryScore) / SUM(weights)   [0-100]

Availability (weight 0.35):
  Base: 100
  -5 per unresolved critical alert in last 24h
  -2 per unresolved warning alert
  -10 if any maintenance window is active (planned degredation)
  +5 if no alerts in last 7 days
  Min: 0

Performance (weight 0.35):
  Average of individual metric scores:
  - cpu_usage, memory_usage, connections, qps, slow_queries
  - Each metric: 100 - normalized distance from baseline threshold
    - metric > critical threshold -> 0
    - metric > warning threshold -> linear 70->0
    - metric < warning threshold -> 100
  - slow_queries: 100 - (count * 5), min 0

Capacity (weight 0.20):
  - disk_usage < 70% -> 100
  - disk_usage 70-85% -> linear decline 100 -> 50
  - disk_usage > 85% -> 50 - (disk-85)*3, min 0
  - connection headroom: 100 - (current/max*100)
  - Average of both

Security (weight 0.10):
  Base: 100
  -10 per failed login attempt on instance in last hour
  -20 per privilege change detected
  -5 per schema change without approval
  Min: 0
```

**Integration points:**

- `report-service.ts` -- replace `health_score: 100` with `await instanceScoreService.computeScore(instanceId).overall`
- `monitor-collector.ts` -- optional: record score in `health_check_history` after each collection tick
- `alert-engine.ts` -- optional: create alert if score drops below configurable threshold
- New route: `GET /api/instances/:id/score`

#### 4.2 CPU/Memory Collection Permissions (current problem)

**Current state:** `monitor-collector.ts` collects CPU/memory metrics via `databaseService.getRealtimeMetrics()` which queries the monitored database. For MySQL this uses `SHOW GLOBAL STATUS` requiring the `PROCESS` privilege. No permission pre-check is done.

**Problem areas:**
1. No visibility into which permissions an instance credential has before attempting collection
2. No graceful degradation if permissions are insufficient -- the collector fails silently for that metric
3. No way for administrators to see which metrics are collectable per instance

**Solution approach:**

- Add `collection_capabilities` JSON column to `database_instances` table:
  ```json
  { "cpu": true, "memory": true, "disk": true, "slow_queries": true }
  ```

- `monitor-collector.ts` reads this field before each collection iteration, skips metrics where capability is `false`

- Add capability check endpoint:
  ```typescript
  POST /api/database/instances/:id/check-permissions
    -> Test each metric collection, return { capabilities, failed: string[] }
    -> Example response: { cpu: true, memory: true, disk: false, slow_queries: true }
  ```

- Frontend: Show capability status per instance (green/grey badges in instance list/detail)

**DB migration:**

```sql
ALTER TABLE database_instances ADD COLUMN collection_capabilities JSON DEFAULT NULL
  COMMENT '{"cpu":bool, "memory":bool, "disk":bool, "slow_queries":bool}';
```

**Modified components:**

- `monitor-collector.ts` `_collectInstanceMetrics()` -- check capabilities before each metric query
- `instance-database-service.ts` -- add `updateCollectionCapabilities()` method
- New frontend capability status display in instance detail view

#### 4.3 Data Flow: Data Quality v1.3

```
MonitorCollector._tick()
  -> For each instance in schedule:
    -> Read instance.collection_capabilities (JSON from database_instances)
    -> If cpu capability = true: collect CPU metrics
    -> If memory capability = true: collect memory metrics
    -> If disk capability = true: collect disk metrics
    -> Store in metrics_history
  ->
  (optional) InstanceScoreService.computeScore(instanceId)
    -> Read metrics_history for last 24h
    -> Read alerts for last 24h
    -> Read capacity_history for trend
    -> Compute category scores + overall score
    -> Write to health_check_history
  ->
  (if score < configured threshold) AlertEngine.createAlert()
    -> "Instance health score dropped to X"
```

---

### 5. UI Unification

#### 5.1 Icon Consistency (current problem)

**Current state:** `frontend/src/openclaw/ui/icons.ts` has ~50 Lucide-style SVG icons defined as Lit `TemplateResult` values. Usage across views is inconsistent:

- Some views import `{ icons }` and use `icons.iconName` directly
- Some views use the `renderIcon('iconName')` helper from `icons.ts`
- Several views embed inline SVG paths instead of using shared icons
- `reports.ts` uses emoji characters for report type icons
- `alerts.ts` uses partially inline SVG in alert badge classes
- `navigation.ts` uses tab icons not from the shared set

**Problem areas identified by view:**

| View | Issue |
|------|-------|
| `reports.ts` | Uses emoji, not shared icons |
| `alerts.ts` | Partially uses inline SVG |
| `event-management.ts` | Mixed: some shared, some inline |
| `overview-cards.ts` | Custom icon set not in icons.ts |
| `views/instances-db.ts` | Inline SVG for status indicators |
| `views/approval-dashboard.ts` | Inline SVG for status badges |

**Recommended approach:**

- Audit ALL views for icon usage (grep for `svg viewBox`, `<path`, `icons.`)
- Add any missing Lucide-style icons to `icons.ts` (check upstream Lucide for canonical paths)
- Create a lint rule or convention document: "All icons MUST come from icons.ts, never inline"
- Replace inline SVGs with `renderIcon('iconName')` calls
- Replace emoji icons in reports.ts with appropriate shared icons

**Anti-pattern to avoid:** Adding duplicate copies of the same SVG in multiple view files. Every icon must live in `icons.ts` exactly once.

#### 5.2 Layout/CSS Consistency

**Current state identified:**

- 15+ views have identical `@keyframes fade-in` animation CSS blocks -- code duplication
- `reports.ts` still uses legacy `.ov-card` / `.ov-cards` class names
- Other views use `.card` or `.card-container` patterns inconsistently
- Page entrance animations vary subtly (different easing, timing, naming)

**Recommended approach:**

- Move `@keyframes fade-in` to a shared CSS module or the main stylesheet
- Replace `.ov-card` classes in reports.ts with `.card` (standard pattern used elsewhere)
- Audit page entrance animations and standardize timing/easing

---

## Integration Matrix

| Feature | New Components | Existing Components to Modify | Backend Routes | Frontend Views |
|---------|---------------|------------------------------|----------------|----------------|
| **Alert: Threshold Editing** | Inline editor component (frontend) | `alertDatabaseService.updateAlertRule()` | `PUT /api/alert-rules/:id` (add threshold_template) | `views/alerts.ts` rule editor |
| **Alert: AI Learning** | `alert-threshold-learner.ts` | `baseline-calculator.ts` (reuse) | `GET /api/alert-rules/:id/learning-history` (new) | learning history panel (new) |
| **Alert: Multi-Session** | Correlation logic in `event-aggregator.ts` | `event-aggregator.ts` (extend) | `POST /api/events/correlate` (optional) | `views/event-management.ts` |
| **Auth: Token Refresh** | `api/client.ts` (frontend), `refresh_tokens` table | `server.ts` login route, `auth-database-service.ts` | `POST /api/auth/refresh` (new) | `login-gate.ts`, app lifecycle |
| **Auth: Granularity** | `expires_at` + `access_level` columns | `rbac-service.ts`, `require-permission.ts` | `POST /api/rbac/grants` (new) | `views/rbac-page.ts` |
| **Report: ov-card removal** | None | `views/reports.ts` (CSS) | None | `views/reports.ts` |
| **Report: Concept unification** | `report-configs` table, `ReportConfigService` | `report-database-service.ts`, `report-service.ts` | `POST /api/report/configs` (new), migrate existing | `views/reports.ts` config UI |
| **Data Quality: Scoring** | `instance-score-service.ts` | `report-service.ts` (replace hardcoded score) | `GET /api/instances/:id/score` (new) | Instance detail page |
| **Data Quality: Collection perms** | Capability check logic | `monitor-collector.ts`, `instance-database-service.ts` | `POST /api/instances/:id/check-permissions` (new) | Instance detail page |
| **UI Unification** | None | `icons.ts` (expand), ALL views (audit) | None | ALL frontend views |

---

## Build Order and Dependencies

```
Phase 1: Auth Token Refresh  ---------------+
  (dependency: needed by ALL authenticated  |
   features that call backend after token    |
   expiry)                                   |
                                             |
Phase 2: UI Unification  -------------------+--+
  (plumbing: icon audit + CSS stand-         |  |
   ardization touches all views, better      |  |
   done first to avoid rework)               |  |
                                             |  |
Phase 3: Report Refactoring  ---------------+--+--+
  (ov-card removal + concept unification     |  |  |
   depends on CSS standards from Phase 2)    |  |  |
                                             |  |  |
Phase 4a: Alert Threshold Editing  ---------+-----+
  (independent sub-feature, quick win)       |  |  |
                                             |  |  |
Phase 4b: Data Quality - Collection Perms ---+--+--+
  (independent sub-feature)                  |  |  |
                                             |  |  |
Phase 5: Data Quality - Instance Scoring ----+--+--+
  (score algorithm needed by AI learning)    |  |  |
                                             |  |  |
Phase 6: Alert AI Learning Thresholds -------+--+--+
  (depends on Phase 5 baseline integration)  |  |  |
                                             |  |  |
Phase 7: Multi-Session Aggregation +         |  |  |
         Auth Granularity                    +--+--+
  (final polish features, no dependencies)   |  |  |
```

**Recommended 7-phase build order:**

1. **Auth Token Refresh** -- baseline infra, all other features need stable auth
2. **UI Unification** -- icon audit is high-touch, do early to minimize merge conflicts
3. **Report Refactoring** -- ov-card removal benefits from Phase 2 CSS standards
4. **Alert Threshold Editing** -- quick win, independent
5. **Data Quality: Collection Permissions** -- independent, small scope
6. **Data Quality: Instance Scoring** -- needed for AI learning
7. **Alert AI Learning Thresholds** -- depends on scoring from Phase 6
8. **Multi-Session Aggregation + Auth Granularity** -- final polish

---

## Scaling Considerations (for v1.3)

| Concern | Current (v1.2) | v1.3 Target | Architecture Adjustment |
|---------|---------------|-------------|------------------------|
| Alert evaluation | Cron 60s, single-threaded | Same | No change needed |
| Notification polling | Cron 10s, processes all pending | Same + escalation alerts | No change needed |
| AI learning thresholds | Not implemented | Cron daily, ~1s per rule | New cron, trivial load |
| Token refresh | Not implemented | Per-login + per-refresh | Stateless (JWT), minimal server-side storage |
| Report generation | Single instance | Same + scheduled configs | Queue-based for large reports (deferred) |
| Instance scoring | Not implemented | On-demand + optional scheduled | Lightweight O(n), n = number of metrics |
| Collection permissions | Static all-or-nothing | Per-instance capability check | Read from DB, cached per tick |

**First bottleneck:** Alert evaluation at 60s interval with 100+ instances. Currently loads ALL rules and evaluates ALL instances. At 500+ instances this may timeout. Mitigation: batch evaluation -- NOT in v1.3 scope.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: JWT Without Refresh

**Current state:** Single JWT with 24h expiration and zero refresh capability.

**Why it is wrong:** Users lose work when token expires mid-session. No graceful re-auth.

**v1.3 fix:** Implement refresh token rotation. Keep JWT short-lived (15 min) but auto-refresh transparently via `ApiClient` interceptor.

### Anti-Pattern 2: Inline HTML Templates in Service Code

**Current state:** `report-service.ts` has ~250 lines of HTML template strings embedded in JavaScript.

**Why it is wrong:** Templates are not editable, not testable, mix presentation with logic.

**v1.3 fix:** Extract templates to separate files. Use simple `{{ variable }}` replacement or minimal template engine.

### Anti-Pattern 3: Hardcoded Health Score

**Current state:** `report-service.ts` line 321: `health_score: 100, // TODO: implement health scoring logic`

**Why it is wrong:** The score is meaningless and misleads users. The TODO has been in the codebase since initial implementation.

**v1.3 fix:** Implement `instance-score-service.ts` with the weighted algorithm described in section 4.1.

### Anti-Pattern 4: Duplicate CSS Animations Across All Views

**Current state:** 15+ views have identical `@keyframes fade-in` CSS blocks.

**Why it is wrong:** Code bloat, inconsistent if one is modified. Violates DRY.

**v1.3 fix:** Move `fade-in` keyframes to a shared CSS stylesheet. Reference via CSS class import.

### Anti-Pattern 5: Silent Metrics Collection Failure

**Current state:** `monitor-collector.ts` fails silently when instance credentials lack necessary permissions (e.g., no PROCESS privilege for MySQL CPU metrics).

**Why it is wrong:** Users see missing metrics with no indication why. Debugging requires log spelunking.

**v1.3 fix:** Add collection capability detection + per-instance capability JSON column. Show capability status in UI.

---

## Sources

- Slide codebase: `/apps/db-ops-api/server.ts` -- all route registrations
- Slide codebase: `/apps/db-ops-api/src/alert-engine.ts` -- existing alert evaluation and event aggregation
- Slide codebase: `/apps/db-ops-api/src/alert-evaluator.ts` -- rule evaluation with threshold templates
- Slide codebase: `/apps/db-ops-api/src/event-aggregator.ts` -- existing event aggregation logic
- Slide codebase: `/apps/db-ops-api/src/auth/rbac-service.ts` -- full RBAC CRUD
- Slide codebase: `/apps/db-ops-api/src/auth/require-permission.ts` -- middleware factory
- Slide codebase: `/apps/db-ops-api/src/report-service.ts` -- inline HTML generation
- Slide codebase: `/apps/db-ops-api/src/monitor-collector.ts` -- metrics collection
- Slide codebase: `/apps/db-ops-api/src/baseline-calculator.ts` -- baseline computation
- Slide codebase: `/apps/db-ops-api/sql/schema.sql` -- all table schemas
- Slide codebase: `/apps/db-ops-api/sql/migrations/002_add_rbac_tables.sql` -- RBAC migration
- Slide codebase: `frontend/src/openclaw/ui/icons.ts` -- icon set
- Slide codebase: `frontend/src/openclaw/ui/views/*.ts` -- all frontend views
- Slide codebase: `frontend/src/openclaw/ui/navigation.ts` -- tab definitions
