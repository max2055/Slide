# Architecture Research: SSH-Based Server Monitoring

**Domain:** SSH agentless server monitoring integrated into DB Ops platform
**Researched:** 2026-07-07
**Confidence:** HIGH — patterns adapted from existing Slide architectures (collector/registry, cron/alert/report)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Existing Slide Architecture                    │
│                                                                   │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐   │
│  │   MonitorCollector   │  │        AlertEngine                │   │
│  │   (cron heartbeat)   │  │   (cron 60s evaluation)          │   │
│  └──────┬──────────────┘  └────────┬─────────────────────────┘   │
│         │                          │                             │
│  ┌──────▼──────────────┐  ┌────────▼─────────────────────────┐   │
│  │  UnifiedCollector    │  │  evaluateAllRules → alerts       │   │
│  │  → metrics_history   │  │  → alert_events                  │   │
│  └──────────────────────┘  └──────────────────────────────────┘   │
│                                                                   │
├─────────────────────── NEW BLOCK ────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐   │
│  │  ServerCollector     │  │  ServerAlertEvaluator            │   │
│  │  (cron heartbeat)    │  │  (dedicated cron loop)           │   │
│  └──────┬──────────────┘  └────────┬─────────────────────────┘   │
│         │                          │                             │
│  ┌──────▼──────────────┐  ┌────────▼─────────────────────────┐   │
│  │  SshSessionPool      │  │  AlertEngine (shared, extended)  │   │
│  │  (ssh2 wrapper)      │  │  → server_id on alerts table     │   │
│  └──────┬──────────────┘  └──────────────────────────────────┘   │
│         │                                                        │
│  ┌──────▼──────────────┐  ┌──────────────────────────────────┐   │
│  │  server_metrics      │  │  ServerMetricProvider            │   │
│  │  (key-value table)   │  │  (commands + parsers registry)   │   │
│  └──────────────────────┘  └──────────────────────────────────┘   │
│                                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│   │  Servers  │  │ Database  │  │  Alerts  │  │  Events  │        │
│   │  (table)  │  │Instances │  │  (table) │  │  (table) │        │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|---------------|----------------|
| `servers` table | Server entity storage (IP, hostname, SSH config, credential ref, status, tags) | MySQL table, distinct from `database_instances` |
| `server_metrics` table | OS-level metric time series (key-value format) | MySQL table, metric_name + metric_value + recorded_at |
| `SshSessionPool` | SSH connection lifecycle: connect, keepalive, pool/reuse, auto-reconnect | Singleton wrapping `ssh2` Client pool |
| `ServerCollector` | Schedule-driven collection loop: heartbeat, tick check, batch collect per server | Class instantiated by `monitor-collector.ts` or standalone |
| `ServerMetricProvider` | Command definitions + output parsers for each OS metric | Registry of command definitions (command string + parse function) |
| `ServerDatabaseService` | CRUD for servers table, SSH key encryption, connection test | New service analogous to `instance-database-service.ts` |
| `ServerAlertEvaluator` | Evaluate rules for server metrics, reuse AlertEngine infrastructure | Extended `evaluateAllRules()` with server-scoped filtering |

## Entity Model

### servers Table

```sql
CREATE TABLE IF NOT EXISTS `servers` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL COMMENT '服务器名称/别名',
  `host` VARCHAR(255) NOT NULL COMMENT 'IP 或主机名',
  `port` INT NOT NULL DEFAULT 22 COMMENT 'SSH 端口',
  `username` VARCHAR(100) NOT NULL COMMENT 'SSH 登录用户名',
  `auth_method` ENUM('password', 'key', 'key_passphrase') NOT NULL DEFAULT 'key' COMMENT '认证方式',
  `password_encrypted` VARCHAR(500) DEFAULT NULL COMMENT '加密密码（password 模式）',
  `private_key_encrypted` TEXT DEFAULT NULL COMMENT '加密私钥内容（key 模式）',
  `passphrase_encrypted` VARCHAR(500) DEFAULT NULL COMMENT '加密私钥密码短语（key_passphrase 模式）',
  `fingerprint` VARCHAR(64) DEFAULT NULL COMMENT '服务器 SSH 指纹（host key）',
  `os_type` VARCHAR(50) DEFAULT NULL COMMENT '操作系统类型：linux, windows',
  `os_distro` VARCHAR(100) DEFAULT NULL COMMENT '发行版：ubuntu, centos, debian',
  `os_kernel` VARCHAR(100) DEFAULT NULL COMMENT '内核版本',
  `cpu_cores` INT DEFAULT NULL COMMENT 'CPU 核心数',
  `memory_total_mb` BIGINT DEFAULT NULL COMMENT '总内存 MB',
  `disk_total_gb` DECIMAL(10,2) DEFAULT NULL COMMENT '总磁盘 GB',
  `status` ENUM('active', 'inactive', 'error', 'unreachable') NOT NULL DEFAULT 'active',
  `reachable` BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'SSH 是否可达',
  `last_reachable_at` DATETIME DEFAULT NULL COMMENT '最后可达时间',
  `tags` JSON DEFAULT NULL COMMENT '标签数组',
  `description` TEXT DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_name` (`name`),
  UNIQUE KEY `idx_host_port` (`host`, `port`),
  INDEX `idx_status` (`status`),
  INDEX `idx_reachable` (`reachable`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'SSH 纳管服务器';
```

### Relationship: database_instances to servers

Add nullable FK on `database_instances`:

```sql
ALTER TABLE `database_instances`
  ADD COLUMN `server_id` INT UNSIGNED DEFAULT NULL AFTER `id`,
  ADD INDEX `idx_server_id` (`server_id`);
```

This creates a many-to-one relationship: many DB instances on one server. One server hosts zero to many DB instances. The FK is non-enforcing (application-level) to avoid cascade issues — Slide's existing pattern uses application-level relationships.

### server_metrics Table (Key-Value Time Series)

```sql
CREATE TABLE IF NOT EXISTS `server_metrics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_id` INT UNSIGNED NOT NULL,
  `metric_name` VARCHAR(64) NOT NULL COMMENT '指标名称，如 os_cpu_usage',
  `metric_value` DECIMAL(15,4) NOT NULL,
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_server_metric_time` (`server_id`, `metric_name`, `recorded_at`),
  INDEX `idx_recorded_at` (`recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '服务器 OS 级指标时间序列（key-value 格式）';
```

**Why key-value over fixed columns:**
- Server metrics have fewer conventions than DB metrics (Linux vs Windows differ)
- New metrics can be added without schema migration
- Query pattern is always "get metric X for server Y over time Z" — the index covers this
- Avoids the unwieldy 30+ column pattern of `metrics_history`

### Required Schema Changes: alerts + alert_rules

Minimal additions to reuse the existing alert infrastructure:

```sql
ALTER TABLE `alerts`
  ADD COLUMN `server_id` INT UNSIGNED DEFAULT NULL AFTER `instance_id`,
  ADD INDEX `idx_server_id` (`server_id`);

ALTER TABLE `alert_rules`
  ADD COLUMN `target_type` ENUM('database', 'server', 'both') NOT NULL DEFAULT 'database' COMMENT '规则目标类型',
  ADD COLUMN `server_ids` JSON DEFAULT NULL COMMENT '适用服务器 ID 列表(NULL=全部)',
  ADD INDEX `idx_target_type` (`target_type`);
```

The `alerts.alert_type` enum already covers `performance`, `availability`, `capacity` — these work for server metrics too. The enum is NOT extended; `server_id` disambiguates DB vs server origin.

### server_metric_definitions Table

Analogous to `metric_definitions` but for OS-level metrics:

```sql
CREATE TABLE IF NOT EXISTS `server_metric_definitions` (
  `id` VARCHAR(64) NOT NULL COMMENT '指标 ID，如 os_cpu_usage',
  `name` VARCHAR(100) NOT NULL COMMENT '指标名称',
  `description` TEXT DEFAULT NULL,
  `unit` VARCHAR(20) NOT NULL,
  `os_types` JSON NOT NULL COMMENT '适用操作系统类型',
  `aggregation` ENUM('avg', 'max', 'min', 'sum', 'last') NOT NULL DEFAULT 'avg',
  `default_interval` INT NOT NULL DEFAULT 30 COMMENT '默认采集间隔（秒）',
  `threshold_template` JSON DEFAULT NULL COMMENT '默认阈值模板',
  `is_collected` BOOLEAN NOT NULL DEFAULT TRUE,
  `is_builtin` BOOLEAN NOT NULL DEFAULT FALSE,
  `collection_command` VARCHAR(500) DEFAULT NULL COMMENT 'SSH 采集命令',
  `parse_pattern` VARCHAR(100) DEFAULT NULL COMMENT '解析器标识',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_collected` (`is_collected`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '服务器指标定义注册表';
```

### server_inspection_history Table (for daily inspection reports)

```sql
CREATE TABLE IF NOT EXISTS `server_inspection_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_id` INT UNSIGNED NOT NULL,
  `inspection_type` VARCHAR(50) NOT NULL COMMENT '巡检类型：daily, weekly, on_demand',
  `summary_score` INT NOT NULL COMMENT '综合评分 0-100',
  `checks` JSON NOT NULL COMMENT '检查项结果',
  `issues` JSON DEFAULT NULL COMMENT '发现的问题',
  `recommendations` JSON DEFAULT NULL COMMENT '建议',
  `generated_report_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联的报告 ID',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_server_id` (`server_id`),
  INDEX `idx_inspection_type` (`inspection_type`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = '服务器巡检历史';
```

## SSH Connection Architecture

### SshSessionPool Design

The SSH connection pool manages the lifecycle of SSH sessions. It is a new standalone component, not extending the DB connection pool.

```
┌──────────────────────────────────────────────────┐
│                  SshSessionPool                   │
│                                                   │
│  ┌────────────────────────────────────────────┐   │
│  │          Connection Manager                 │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐           │   │
│  │  │server1 │ │server2 │ │server3 │  ...     │   │
│  │  │ 3 sess │ │ 2 sess │ │ 1 sess │           │   │
│  │  └───┬────┘ └───┬────┘ └───┬────┘           │   │
│  │      │          │          │                  │   │
│  │  ┌───▼────┐ ┌───▼────┐ ┌───▼────┐            │   │
│  │  │sess[0] │ │sess[0] │ │sess[0] │            │   │
│  │  │sess[1] │ │sess[1] │ │        │            │   │
│  │  │sess[2] │ │        │ │        │            │   │
│  │  └────────┘ └────────┘ └────────┘            │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌────────────────────────────────────────────┐   │
│  │          Keepalive Heartbeat               │   │
│  │  30s interval per open session             │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌────────────────────────────────────────────┐   │
│  │          Idle Reaper                        │   │
│  │  Close sessions idle > 300s                │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### Connection Lifecycle

```
  ┌──────────┐
  │  REQUEST  │ -- acquire(serverId) -> return session or create new
  └─────┬────┘
        │
  ┌─────▼──────┐   ┌──────────┐
  │ Pool has   │───│  Return  │
  │ idle conn? │   │ existing │
  └─────┬──────┘   └──────────┘
        │ no
  ┌─────▼──────────┐
  │ At max session │── YES ──> Wait queue (promise-based)
  │ per server?    │
  └─────┬──────────┘
        │ no
  ┌─────▼───────────┐
  │ Create new ssh2 │
  │ Client instance │
  └─────┬───────────┘
        │
  ┌─────▼───────────┐
  │ Authenticate    │── FAIL ──> Mark server unreachable, throw
  │ & ready         │
  └─────┬───────────┘
        │ OK
  ┌─────▼──────────────┐
  │ Configure keepalive│
  │ Register in pool   │
  │ Return session     │
  └────────────────────┘
```

### Key Configuration Parameters

```typescript
interface SshPoolConfig {
  maxSessionsPerServer: number;     // Default: 3
  connectTimeoutMs: number;        // Default: 10000
  keepaliveIntervalMs: number;     // Default: 30000
  keepaliveCountMax: number;       // Default: 3
  idleTimeoutMs: number;           // Default: 300000 (5min)
  readyTimeoutMs: number;          // Default: 10000
  retryAttempts: number;           // Default: 2
  retryDelayMs: number;            // Default: 1000
  maxWaitQueueSize: number;        // Default: 10
}
```

### SshSessionPool Interface

```typescript
class SshSessionPool {
  async acquire(serverId: number): Promise<SshSession>;
  release(session: SshSession): void;
  invalidate(serverId: number): void;           // Force-close all sessions (auth failure)
  getStatus(): PoolStatus;
  async testConnection(config: ServerSshConfig): Promise<TestResult>;
  stop(): void;                                  // Graceful shutdown
}
```

### SshSession Wrapper

Each session wraps an `ssh2` Client connection. The wrapper:

- Tracks last-used timestamp for idle reaping
- Supports `execCommand(command: string): Promise<CommandResult>` for running individual commands
- Supports `execCommands(commands: string[]): Promise<CommandResult[]>` for batch execution
- Implements a health check heartbeat (simple `echo` or `uptime` command)
- Auto-reconnects on detected failure (configurable retry)

## Metrics Collection Integration

### How ServerCollector Plugs Into Existing Infrastructure

The server collection reuses the **MonitorCollector heartbeat scheduling pattern** but operates as a sibling component:

```
monitor-collector.ts (EXISTING — no changes needed)
  │
  ├──→ UnifiedCollector → DB metrics → metrics_history (EVERY 10s tick)
  │
  └──→ NEW: collectServerMetrics()
       → ServerCollector → server_metrics (same tick)

ServerCollector (NEW — standalone class)
  │
  ├──→ schedule per-server (like per-instance in MonitorCollector)
  │
  └──→ SshSessionPool.acquire(serverId) → execCommands(commands) → parse → write
```

The `ServerCollector` is instantiated alongside `MonitorCollector` but operates on its own heartbeat (same 10s interval) to avoid blocking DB metric collection with slow SSH operations.

### Collection Command Registry Pattern

Each metric type defines:
1. The SSH command to execute
2. A parser function from stdout to numeric value(s)
3. The interval and metric metadata

This mirrors the `MetricProvider` pattern but is structured as a command registry rather than a provider per DB type, because SSH metrics collection has no "provider per OS type" — all Linux servers use the same commands:

```typescript
// server-commands.registry.ts

interface ServerMetricCommand {
  id: string;                // metric name: 'os_cpu_usage'
  command: string;           // shell command to execute
  parse: (stdout: string) => number | Record<string, number>;
  interval: number;          // default collection interval (seconds)
  isDelta: boolean;          // true if rate-calculated from previous value
}
```

### Batch Execution Strategy

Rather than executing N individual SSH commands (N round trips), **batch commands with shell scripting**. One SSH round trip collects all metrics:

```typescript
// Batch command — all metrics in one exec
const BATCH_COMMAND = [
  `export LC_ALL=C;`,
  `echo "---BEGIN---";`,
  `top -bn1 | head -5 | awk '/%Cpu/{print $2","$10}';`,     // cpu_usage, io_wait
  `free | awk '/^Mem/{printf "%.1f,",$3/$2*100} /^Swap/{if($2>0) printf "%.1f",$3/$2*100; else print "0"}';`,
  `df / | awk 'NR==2{print $5}' | tr -d '%';`,              // root disk
  `cat /proc/loadavg | awk '{print $1","$2","$3}';`,        // 1m,5m,15m load
  `cat /proc/uptime | awk '{print int($1/86400)}';`,        // uptime days
  `ps aux --no-headers | wc -l;`,                            // process count
  `ss -t state established | tail -n +2 | wc -l;`,          // tcp connections
  `cat /proc/diskstats | awk '{r+=$6;w+=$10}END{print r*512","w*512}';`, // disk r/w bytes
  `ps aux --no-headers | awk '/Z/{count++}END{print count+0}';`, // zombie count
  `echo "---END---";`,
].join('\n');
```

Parsed with `parseBatchStdout(stdout: string): Record<string, number>` that splits on delimiter, maps each position to metric name.

### Collection Flow

```
ServerCollector._tick()
  │
  ├── For each active server:
  │    │
  │    ├── Check schedule: is server due for collection?
  │    │    (based on minimal interval across its enabled metrics)
  │    │
  │    ├── SshSessionPool.acquire(serverId)
  │    │    │
  │    │    ├── Have idle session? -> return it
  │    │    ├── At max sessions? -> wait in queue
  │    │    └── No session? -> create new ssh2 Client
  │    │
  │    ├── session.execCommand(BATCH_COMMAND)
  │    │    │
  │    │    ├── Success? -> parse stdout, produce metric values dict
  │    │    ├── Timeout? -> retry once, else invalidate session
  │    │    └── Auth failure? -> invalidate all sessions, set server unreachable
  │    │
  │    ├── Handle delta-calculated metrics
  │    │    (store previous counter values on SshSession for rate calc)
  │    │
  │    ├── Bulk INSERT into server_metrics
  │    │
  │    ├── Update schedule (next collection time)
  │    │
  │    └── session.release() -> back to pool
  │
  └── Wait for next heartbeat tick
```

### Delta Counter Handling (Rate Metrics)

Network and disk IO metrics are cumulative counters. Delta calculation follows the same pattern as `mysql.provider.ts`:

```typescript
interface ServerDeltaCounter {
  network_rx_bytes: number;
  network_tx_bytes: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  timestamp: number;
}

// On each collection:
//   rate = (current_value - previous_value) / elapsed_seconds
//   Store rate in server_metrics, not the raw counter
//   Update previous_value + timestamp on SshSession
```

This avoids the "increasing counter" problem in time-series charts.

## Alert Integration

### How Server Alerts Reuse Existing Infrastructure

The existing `AlertEngine` runs every 60s and calls `evaluateAllRules()`. Server alerts are added as a parallel evaluation call within the same engine:

```
AlertEngine (EXISTING) — runs every 60s
  │
  ├── evaluateAllRules()          -> DB instance rules (unchanged)
  │
  └── evaluateAllServerRules()    -> NEW
       │
       ├── Query alert_rules WHERE target_type IN ('server', 'both')
       │
       ├── For each rule:
       │    ├── Query latest server_metrics value
       │    ├── evaluateRuleWithLevels() — REUSED from alert-evaluator.ts
       │    ├── checkDuration() — pass server_metrics query instead of metrics_history
       │    └── If triggered → createServerAlert() — same logic as createAlertFromRule()
       │         with server_id set instead of instance_id
       │
       └── Existing eventAggregator.aggregate() picks up server alerts automatically
```

### Changes to AlertEngine

**Minimal.** The changes are:

1. **New `evaluateAllServerRules()` in `server-alert-evaluator.ts`** — structurally mirrors `evaluateAllRules()` but reads from `server_metrics` and `servers` tables instead of `metrics_history` and `database_instances`

2. **Extend `alert-engine.ts`** — add a call to `evaluateAllServerRules()` inside `evaluateAndCreateAlerts()`. This is 3-5 lines added to the existing method.

3. **Extend `alert-engine.ts` `createAlertFromRule()`** — accept optional `serverId` param. When `serverId` is set, use it instead of `instanceId` in the created `alerts` row.

4. **Auto-recovery loop** — extend the existing loop in `evaluateAndCreateAlerts()` that checks `activeAlerts` to also handle alerts that have `server_id` set instead of `instance_id`.

### Type Mapping for Server Metrics

The `createAlertFromRule()` method has a hardcoded `typeMap` — extend it:

```typescript
// Existing typeMap entries for DB metrics
const typeMap: Record<string, 'performance' | 'availability' | 'security' | 'capacity'> = {
  // ... existing DB metric entries ...
  // New server metric entries:
  os_cpu_usage: 'performance',
  os_memory_usage: 'performance',
  os_disk_usage_root: 'capacity',
  os_disk_usage_data: 'capacity',
  os_loadavg_1m: 'performance',
  os_io_wait: 'performance',
  os_swap_usage: 'capacity',
  os_zombie_processes: 'availability',
  os_connectivity: 'availability',  // special: set by health check, not by collector
};

// Fallback: if metric_name not in typeMap, default to 'performance'
```

### Alert Rule Examples for Server Metrics

| Rule Name | metric_name | Operator | Threshold Warning | Threshold Critical | Duration |
|-----------|-------------|----------|-------------------|---------------------|----------|
| 服务器 CPU 使用率 | os_cpu_usage | >= | 80% | 95% | 120s |
| 服务器内存使用率 | os_memory_usage | >= | 85% | 95% | 120s |
| 服务器负载 | os_loadavg_1m | >= | `cpu_cores * 2` | `cpu_cores * 4` | 300s |
| 服务器根分区 | os_disk_usage_root | >= | 80% | 92% | 600s |
| 服务器 Swap 使用 | os_swap_usage | >= | 50% | 75% | 300s |
| IO Wait 过高 | os_io_wait | >= | 30% | 50% | 120s |
| 服务器不可达 | os_connectivity | = | 0 | 0 | 60s |
| 僵尸进程数 | os_zombie_processes | >= | 5 | 20 | 300s |

Note: `os_loadavg_1m` threshold uses the `macro_defaults` system from `metric_templates` — the `cpu_cores` value is set per server via `instance_templates.macro_overrides`.

## Server Inspection Report Integration

Server inspection reports are a new report type that ships alongside the existing DB report types. The existing `ReportType` enum gains new entries:

| Report Type | Description | Integration Point |
|-------------|-------------|-------------------|
| `server_health` | Server health check report | Reuse `report-service.ts` generation pattern |
| `server_patrol` | Regular server inspection (daily/weekly) | Reuse `report-schedule` cron-based pattern |

The inspection flow:

```
Report Schedule (cron)
  │
  └── ReportService.generateReport(type='server_health')
       │
       ├── ServerCollector.collectAll()   -> force fresh collection before report
       ├── Query server_metrics (last 24h)
       ├── Aggregate and analyze trends
       ├── Calculate health score from metric averages
       ├── Write results to server_inspection_history
       ├── Generate PDF/HTML/MD using inspection template
       │    (reuse report-exporter.ts, new template)
       └── Return report_id
```

## Credential Management

### Storage Strategy

Slide already has `encryptData()` / `decryptData()` in `db-connection.ts` for DB passwords. **Reuse the same functions** for SSH credentials.

| Auth Method | Stored Column | How It's Stored |
|-------------|---------------|-----------------|
| `password` | `password_encrypted` | `encryptData(ssh_password)` |
| `key` | `private_key_encrypted` | `encryptData(private_key_contents)` — the PEM string |
| `key_passphrase` | `private_key_encrypted` + `passphrase_encrypted` | Both encrypted via `encryptData()` |

### Connection-time Decryption

```typescript
import { decryptData } from './db-connection';

function buildSshConfig(server: ServerRow): ssh2.ConnectConfig {
  const config: ssh2.ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    readyTimeout: SESSION_POOL_CONFIG.readyTimeoutMs,
    keepaliveInterval: SESSION_POOL_CONFIG.keepaliveIntervalMs,
    keepaliveCountMax: SESSION_POOL_CONFIG.keepaliveCountMax,
  };

  switch (server.auth_method) {
    case 'password':
      config.password = decryptData(server.password_encrypted);
      break;
    case 'key':
      config.privateKey = decryptData(server.private_key_encrypted);
      break;
    case 'key_passphrase':
      config.privateKey = decryptData(server.private_key_encrypted);
      config.passphrase = decryptData(server.passphrase_encrypted);
      break;
  }

  return config;
}
```

### Host Key Verification

The `fingerprint` field stores the expected host key hash. Verified via ssh2's `hostVerifier` callback:

```typescript
hostVerifier: (hashedKey: Buffer) => {
  if (!expectedFingerprint) return true; // accept on first connect
  const computed = crypto.createHash('sha256').update(hashedKey).digest('hex');
  return computed === expectedFingerprint;
}
```

On first connection: `fingerprint` is NULL, so the connection is accepted. The received hash is stored in the `servers` row. On subsequent connections, the received hash must match.

This is configurable — disable host key verification via `servers` config flag for environments with dynamic IPs.

## Recommended Project Structure

New files are added to the existing `apps/db-ops-api/src/` directory. No new top-level modules needed — the pattern is co-location with existing architecture:

```
apps/db-ops-api/src/
│
├── servers/                                    # NEW — Server management module
│   ├── server-database-service.ts              # CRUD for servers table
│   ├── server-session-pool.ts                  # SshSessionPool implementation
│   ├── server-collector.ts                     # Collection heartbeat + scheduling
│   ├── server-metric-commands.ts               # Command definitions + parsers registry
│   ├── server-metric-definitions.ts            # Predefined server metric defs
│   ├── server-alert-evaluator.ts               # Server-specific alert evaluation
│   ├── server-health-check.ts                  # Reachability + OS info detection
│   └── server-ssh-config.ts                    # Credential decryption + connection config building
│
├── types/
│   └── shared.ts                               # Add ServerInfo interface (frontend contract)
│
├── server.ts                                   # Add routes and start ServerCollector
```

### Where Each File Maps to Existing Patterns

| New File | Patterns From | Purpose |
|----------|---------------|---------|
| `server-database-service.ts` | `instance-database-service.ts` | DB operations for servers table |
| `server-session-pool.ts` | `database-service.ts` (connection pool) | SSH session lifecycle |
| `server-collector.ts` | `monitor-collector.ts` | Collection scheduling + delegation |
| `server-metric-commands.ts` | `collectors/mysql.provider.ts` command pattern | Command definitions + parse functions |
| `server-metric-definitions.ts` | `metric-registry.ts` | Predefined server metric metadata |
| `server-alert-evaluator.ts` | `alert-evaluator.ts` | Rule evaluation against server_metrics |
| `server-health-check.ts` | `database-service.ts` health check | OS info discovery + reachability test |

### Route Registration Pattern

Following the existing pattern in `server.ts` (inline route handlers), add:

```
# Server Management
GET    /api/servers                           # List all servers
POST   /api/servers                           # Create server
GET    /api/servers/:id                       # Get server detail
PUT    /api/servers/:id                       # Update server
DELETE /api/servers/:id                       # Delete server
POST   /api/servers/test-connection           # Test SSH connectivity
POST   /api/servers/:id/collect-now           # Force immediate collection

# Server Metrics
GET    /api/servers/:id/metrics               # Latest metrics (all or selected)
GET    /api/servers/:id/metrics/history       # Historical metrics with period + interval

# Server Alerts
GET    /api/servers/:id/alerts                # Alerts for this server (reuse /api/alerts)
POST   /api/servers/:id/alerts/rules          # Create server alert rule

# Server Health
GET    /api/servers/:id/health                # Health check result
GET    /api/servers/:id/inspections           # Inspection history

# Server Reports
POST   /api/reports/generate?type=server_health  # New report type
POST   /api/reports/generate?type=server_patrol   # New report type
```

Auth middleware follows existing `verifyToken` + `requirePermission` pattern. New permissions codes: `server:create`, `server:update`, `server:delete`, `server:view`, `server:collect`.

## Data Flow

### Complete Server Monitoring Data Flow

```
  ┌─────────────────────┐
  │  User adds server   │  POST /api/servers
  │  via UI or API      │  (test-connection first)
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  server-database-   │  Store encrypted credentials
  │  service.create()   │  Set status='active', reachable=false
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  ServerCollector     │  Heartbeat tick picks up new server
  │  _rebuildSchedule()  │  Creates schedule entry with interval
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  Collection Cycle    │  For each due server:
  │  1. Acquire session │   - Open or reuse SSH session
  │  2. Exec batch cmd  │   - Run batch commands in one exec
  │  3. Parse stdout    │   - Parse comma-separated results
  │  4. Bulk INSERT     │   - Write to server_metrics table
  │  5. Release session │   - Return to pool
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  server_metrics      │  Key-value time series
  │  (MySQL table)       │  index: (server_id, metric_name, recorded_at)
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  AlertEngine         │  evaluateAndCreateAlerts() (every 60s)
  │                      │  ├── evaluateAllRules()              -> DB alerts (existing)
  │                      │  └── evaluateAllServerRules()        -> Server alerts (new)
  │                      │        ├── Query server_metrics
  │                      │        ├── Evaluate thresholds
  │                      │        └── Create alert with server_id
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  alerts (table)      │  server_id set, alert_type from typeMap
  │  + alert_events      │  Same event aggregation flow as DB alerts
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │  Notification        │  Existing notification channels
  │  (poll loop 10s)     │  DingTalk, WeCom, Feishu, Webhook
  └──────────────────────┘
             │
  ┌──────────▼──────────┐
  │  User Notification  │  Alert appears in server alert list UI
  │  + Dashboard        │  Server metrics chart (ECharts, reuse)
  └──────────────────────┘
```

### Server Inspection Report Data Flow

```
  Report Schedule (cron) or manual trigger
  │
  └── ReportService.generateReport(type='server_health')
       │
       ├── Collect fresh server_metrics (force full collection)
       ├── Query 24h of metrics for each server
       ├── Calculate health score from metric averages
       ├── Identify anomalies (metric spikes, dips)
       ├── Write to server_inspection_history
       ├── Generate PDF via report-exporter.ts (reuse)
       └── Return report_id
```

## Scaling Considerations

### N Servers x M Metrics x 30s Interval

| Scenario | Approach | Limiting Factor |
|----------|----------|-----------------|
| 1-10 servers | Single thread, sequential batch per server | SSH connection setup cost |
| 10-50 servers | Concurrent collection with semaphore (max 10 parallel) | CPU for parse + DB write |
| 50-200 servers | Rate-limited concurrent (max 20), batch sizing | SSH connection count on target servers |
| 200+ servers | Dedicated ServerCollector process (separate from DB collector) | MySQL write throughput |

### SSH Connection Limits

**Per target server:** Most Linux servers allow 10-100 concurrent SSH sessions by default (`MaxStartups` in sshd_config). The pool limits to **3 concurrent sessions per target** to avoid overwhelming source or target.

**Global limit:** The pool enforces a hard cap on total concurrent sessions (configurable, default 50). If this limit is reached, acquisition blocks until a session is released.

### Heartbeat Tick Scheduling

Reuse the MonitorCollector Zabbix heartbeat model. All servers share one heartbeat interval (10s). Each tick checks which servers are due based on their minimal metric interval. This avoids per-server timers.

```typescript
// ServerCollector._tick() — simplified
private async _tick() {
  const now = Date.now();
  const servers = await serverDatabaseService.getAllActive();
  const promises: Promise<void>[] = [];

  for (const server of servers) {
    let sched = this.schedule.get(server.id);
    if (!sched) {
      sched = { lastCollected: 0, intervalMs: this.getMinInterval() };
      this.schedule.set(server.id, sched);
    }
    if (now >= sched.lastCollected + sched.intervalMs) {
      promises.push(this.collectServer(server));
      sched.lastCollected = now;
    }
  }

  // Limit concurrent SSH operations
  await this.throttledAll(promises, MAX_CONCURRENT);
}
```

**Start with** `maxConcurrentCollections = 5` (safe). Monitor actual concurrency against SSH session counts. Increase to 10-20 as needed.

### Monitoring the Monitor: SSH System Health Metrics

The monitoring system should collect its own health metrics (stored in `server_metrics` with `_system` prefix):

| Metric | What It Measures | When to Alert |
|--------|------------------|---------------|
| `_ssh_collection_duration_ms` | Time to complete one full collection cycle | If > heartbeat interval * 0.8 |
| `_ssh_session_pool_size` | Active sessions in pool | If approaching global limit |
| `_ssh_collection_failures` | Consecutive failures per server | If > 3, auto-disable server |
| `_ssh_pool_wait_queue` | Sessions waiting in acquire queue | If queue grows continuously |
| `_ssh_auth_failures` | Authentication failures | Immediate alert |

## Integration Points Summary

| Integration Point | Existing Component | Change Required | Complexity |
|-------------------|-------------------|-----------------|------------|
| Collection scheduling | `MonitorCollector` heartbeat | Add `ServerCollector` as sibling timer (same file or standalone) | Low — standalone class |
| Metrics storage | `metrics_history` (fixed columns) | New `server_metrics` (key-value table) | Low — independent table |
| Metric definitions | `metric-registry.ts` | New `server-metric-definitions.ts` (standalone) | Low — parallel structure |
| Alert evaluation | `alert-evaluator.ts` | Add `evaluateAllServerRules()` in new file; reuse `evaluateRuleWithLevels` | Medium — reuses same logic |
| Alert creation | `alert-engine.ts` — `createAlertFromRule()` | Accept `serverId` param, extend typeMap | Low — one method change |
| Alert events | `event-aggregator.ts` | Already works with any alert in `alerts` table | None — automatic |
| Notification | `notification-service.ts` | Already reads `alerts` table | None — automatic |
| Report generation | `report-service.ts` | Add `server_health` / `server_patrol` report types | Medium — new templates |
| Health check | `instance-database-service.ts` health pattern | New `server-health-check.ts` (separate concern) | Low — independent |
| Credential encryption | `db-connection.ts` — `encryptData/decryptData` | Reuse as-is | None — just import |
| Frontend components | Lit 3.3 shared components | New server-list, server-detail, server-metrics views | Medium — new views |

## Build Order Recommendation

```
Phase 1: Foundation (DB schema + CRUD)
  ├── servers table migration
  ├── server_metrics table migration
  ├── server_metric_definitions table migration
  ├── ALTER TABLE on alerts + alert_rules for server_id / target_type
  └── server-database-service.ts (CRUD + test-connection)
  └── Register /api/servers routes in server.ts

Phase 2: SSH Connection (core infrastructure)
  ├── npm install ssh2
  ├── server-ssh-config.ts (credential decryption)
  ├── server-session-pool.ts (connection pool + keepalive + reaping)
  └── Integration test: connect, exec, disconnect

Phase 3: Metrics Collection (data pipeline)
  ├── server-metric-commands.ts (command definitions + parsers)
  ├── server-metric-definitions.ts (metric metadata seeding)
  ├── server-collector.ts (heartbeat + scheduling)
  ├── server-health-check.ts (OS info detection, fingerprint capture)
  └── Wire into server.ts start sequence

Phase 4: Alert Integration (alert pipeline)
  ├── server-alert-evaluator.ts
  ├── Extend AlertEngine — server_id handling in createAlertFromRule()
  ├── Extend AlertEngine.evaluateAndCreateAlerts() — call server evaluator
  ├── Extend auto-recovery loop for server_id alerts
  └── Seed server alert rules

Phase 5: Server Inspection Reports
  ├── server_inspection_history table
  ├── Report templates for server_health / server_patrol
  └── Report scheduling (reuse existing report cron)

Phase 6: Frontend (parallel with Phases 3-5)
  ├── Server list view (table, status indicators)
  ├── Server detail view (info, metrics, alerts tabs)
  ├── Server metrics trend charts (ECharts, reuse pattern)
  └── Server alert rules management UI
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: One SSH Connection Per Collection Cycle

**What people do:** Create a new SSH connection, execute commands, close connection for every collection cycle. This adds 500ms-2s of connection overhead per cycle per server.

**Why it's wrong:** Creates unnecessary TCP handshake overhead, increases load on both monitor and target, delays collection.

**Do this instead:** Maintain persistent SSH connections via the session pool. Keep connections alive with keepalive pings. Only reconnect on failure or after idle timeout.

### Anti-Pattern 2: Extending metrics_history Table

**What people do:** Add server metric columns to the existing `metrics_history` table alongside DB metrics.

**Why it's wrong:** The table already has 30+ DB-specific fixed columns. Adding OS metrics would double the column count, create join confusion (server_metrics have no DB context), and waste storage with NULLs when collecting only local metrics.

**Do this instead:** Separate `server_metrics` key-value table. The query pattern is different: by metric name, not by fixed column.

### Anti-Pattern 3: Blocking the DB Collector Heartbeat With SSH Collection

**What people do:** Add server collection directly inside the existing `MonitorCollector._tick()` method, making slow SSH operations delay DB metric collection.

**Why it's wrong:** A slow SSH connection (timeout, unresponsive server) holds up DB metric collection for all monitored database instances.

**Do this instead:** Run SSH collection independently — either as a separate interval timer or as a fire-and-forget branch within the tick. Guard with a timeout semaphore.

### Anti-Pattern 4: Storing SSH Private Keys in Plaintext

**What people do:** Store SSH private keys or passwords as raw text in the database for simplicity.

**Why it's wrong:** Key compromise gives access to all monitored servers. Slide already has `encryptData()` — use it consistently.

**Do this instead:** Always encrypt via `encryptData()`. The key stays encrypted at rest and is decrypted only in memory during SSH connection setup.

### Anti-Pattern 5: Per-Server Timers

**What people do:** Set a separate `setInterval` per server, each running at the server's interval.

**Why it's wrong:** Creates N timers (bad for event loop), hard to stop/restart, drift over time.

**Do this instead:** Single heartbeat timer (10s) checks a schedule map. This is the Zabbix model that `MonitorCollector` already uses.

### Anti-Pattern 6: Blocking On SSH Pool Acquire

**What people do:** Use a synchronous blocking pool acquire that holds up the entire collection tick until a session is available.

**Why it's wrong:** If all sessions are in use or the acquire times out, the entire tick stalls for all servers, including healthy ones.

**Do this instead:** Use a non-blocking acquire with a short timeout (5s). If acquire fails, skip the server this tick and try again next tick. Log the skip.

## Sources

- Existing Slide architecture: `monitor-collector.ts` — Zabbix heartbeat scheduling model
- Existing Slide architecture: `collector.ts` + `collectors/` — Provider pattern for metric collection
- Existing Slide architecture: `alert-evaluator.ts` + `alert-engine.ts` — Alert evaluation pipeline
- Existing Slide architecture: `instance-database-service.ts` — CRUD + encrypted credential pattern
- Existing Slide architecture: `db-connection.ts` — `encryptData/decryptData` functions
- External: `ssh2` npm package — standard Node.js SSH client library

---
*Architecture research for: SSH-based server monitoring integration into Slide DB Ops platform*
*Researched: 2026-07-07*
