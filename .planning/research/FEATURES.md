# Feature Research: SSH-based Server Monitoring

**Domain:** SSH-based Server Monitoring (add-on to existing Database Operations Platform)
**Researched:** 2026-07-07
**Confidence:** HIGH (well-established domain, patterns from Nagios/Zabbix/Checkmk/Prometheus node_exporter)

## Feature Landscape — SSH Server Monitoring (v0.8)

This document defines the feature scope for adding SSH-based ("no agent required") server monitoring to the existing Slide database operations platform. The platform already has database instance monitoring, metrics collection, alerting, reporting, and notification infrastructure. Server monitoring extends these capabilities to general Linux servers without requiring any OS-level agent installation.

### Pre-Reading: Existing Infrastructure to Extend

The following components from the existing platform are directly reusable for server monitoring:

| Existing Component | File / Service | Relevance to Server Monitoring |
|---|---|---|
| `monitor-collector.ts` | Collector scheduling (10s heartbeat) | Same scheduling engine, add SSH collector alongside DB collectors |
| `metric_definitions` table | Metric definition metadata | Can reuse or extend with server-specific metric definitions |
| `metrics_history` table | Timeseries metric storage | Store server metrics in same pattern as DB metrics |
| `alert-engine.ts` | Cron-based alert evaluation (60s) | Reuse for server metric alert rules |
| `alert_rules` table | Metric threshold definitions | Reuse with server metric names |
| `notification-service.ts` | Multi-channel notification | Reuse for server alert notifications |
| `alert-rca-service.ts` | AI-powered root cause analysis | Reuse for server alert analysis |
| `report-service.ts` | Report generation (PDF/HTML/JSON/MD) | Extend to generate server health reports |
| `database_instances` table | Instance registry | Similar model for server registry |
| `database-service.ts` | Instance CRUD + health check | Pattern to follow for server CRUD service |
| RBAC middleware (`requirePermission`, `requireInstanceAccess`) | Auth + permission enforcement | Reuse with new server resource type |
| ECharts dashboard components | Frontend charts | Reuse for server metric trend charts |

---

## Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

### 1. Server Registration and Credential Management

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Register/unregister servers by IP/hostname | Must add targets to monitor | LOW | Model after existing `database_instances` pattern. New table `server_instances` (id, host, port, label, os_type, credential_id, status, tags, created_at, updated_at). |
| SSH credential management (username + password) | Auth to connect | MEDIUM | Must store securely. Use encrypted storage (AES-256-GCM with app-level master key) or a dedicated `server_credentials` table storing encrypted credentials. Never store plaintext. |
| SSH credential management (key-based auth) | Preferred auth method for automation | MEDIUM | Support PEM private key passphrase unlock. Store encrypted RSA/Ed25519 keys. Allow inline key text or key file path. |
| Test SSH connection before saving | Validate credentials + reachability | LOW | Simple `ssh.connect()` + `ssh.exec('uptime')` test. Show result in UI. |
| Server list view with status indicators | See all monitored servers at a glance | LOW | Reuse existing instance list view pattern. Columns: host, label, OS type, connection status (online/offline/error), last check time, CPU/memory summary badge. |
| Server detail view | Drill into one server's metrics | MEDIUM | Tabs: Overview (key metrics), Metrics (trend charts), Alerts, Configuration. |

### 2. SSH-Collectable System Metrics

Uses SSH to collect without installing any agent. All metrics gathered by issuing standard Linux commands and parsing output.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| CPU usage (%) | Basic health signal | LOW | `top -bn1` or `/proc/stat` parsing. Collect: user, system, idle, iowait, steal percentages. |
| CPU load average (1/5/15 min) | Capacity planning signal | LOW | `/proc/loadavg` or `uptime`. 3 values: 1min, 5min, 15min load. |
| Memory usage | OOM risk detection | LOW | `free -m` or `/proc/meminfo`. Collect: total, used, free, buffers/cache, available. |
| Swap usage | Memory pressure signal | LOW | `free -m` or `/proc/meminfo`. Collect: total, used, free. |
| Disk usage per mount point | Disk full prevention | LOW | `df -h` or `df -B1`. Collect per mount: total, used, available, usage_percent. |
| Disk I/O (read/write ops, latency) | Disk performance | MEDIUM | `iostat -x 1 2` or `/proc/diskstats`. Collect: tps, read_kbps, write_kbps, await, svctm, avgqu-sz. |
| Network interface stats | Bandwidth monitoring | LOW | `/proc/net/dev` or `sar -n DEV`. Collect per interface: rx_bytes, tx_bytes, rx_packets, tx_packets, rx_errors, tx_errors, rx_drop, tx_drop. |
| Uptime | Server stability / reboot detection | LOW | `uptime -s` or `uptime` parse. |
| Number of running processes | Process explosion detection | LOW | `ps aux --no-headers | wc -l` or `/proc/loadavg`. |
| Top processes by CPU/memory | Identify resource hogs | MEDIUM | `ps aux --sort=-%cpu | head -20` (CPU tops) and same for `-%mem`. Parse and store top-N per collection. |
| Open file descriptors | Connection leak detection | LOW | `lsof | wc -l` or `cat /proc/sys/fs/file-nr` (allocated vs max). |
| Disk inode usage | Inode exhaustion detection | MEDIUM | `df -i`. Inode exhaustion causes "no space left on device" even with free blocks. |
| System load vs CPU count ratio | Overloaded CPU detection | LOW | Compare load_1min to `nproc` value. Ratio > 1.0 (single core) or > #cores (multi-core) = overloaded. |

### 3. Server Metrics Visualization

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Real-time metric values on server card | Quick health check from list | LOW | Sparkline or mini gauge in server list row: CPU %, memory %, disk %. |
| CPU/memory/disk trend chart (1h/6h/24h/7d/30d) | Pattern analysis | LOW | Reuse existing ECharts trend line components from DB monitoring. |
| Disk usage breakdown by mount point (pie/bar) | Capacity planning visualization | LOW | ECharts pie or stacked bar showing each mount point's total/used. |
| Network traffic chart (in/out over time) | Traffic pattern analysis | LOW | Dual-area EChart: inbound (blue) + outbound (orange) over time axis. |
| Top processes table (snapshot) | Identify resource hogs without SSH | MEDIUM | Table view showing current top-N processes with CPU%, MEM%, PID, command. |
| Health score card for server | At-a-glance health assessment | MEDIUM | Model after existing DB instance health_score. Weighted formula from key metrics: CPU usage, memory pressure, disk fullness, swap, load. 0-100 scale. |

### 4. Server Alert Rules

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| CPU threshold alert (> X% for > Y seconds) | Prevent CPU saturation unnoticed | LOW | Reuse existing alert_engine.ts. Just define new server metrics as alertable metric names. |
| Memory threshold alert (> X% used) | OOM prevention | LOW | Same pattern as CPU alert. |
| Disk usage threshold alert (> X% per mount) | Disk full prevention | LOW | Per-mount-point evaluation. Alert rule must specify which mount or "any mount". |
| Disk inode usage alert | Inode exhaustion detection | MEDIUM | Common hidden pitfall. Must be separate from disk space alert. |
| Swap usage alert (> X%) | Memory pressure detection | LOW | Often forgotten. High swap = performance issue. |
| Load average threshold alert | Capacity overrun detection | LOW | Compare load to CPU core count. Rule: `load_5min / cpu_cores > X`. |
| Server unreachable / SSH connection failure alert | Server went down detection | LOW | If SSH fails for 2+ consecutive collection cycles, raise "unreachable" alert. |
| Process count threshold alert | Process fork bomb detection | LOW | Upper bound on total process count. |
| Disk I/O latency alert (> X ms await) | Disk performance degradation | MEDIUM | Reads `iostat` await > threshold over multiple cycles. |

### 5. Server Monitoring Agent (No-Agent via SSH)

Users understand this is "no agent required" — but they still expect automated collection:

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|--------------|-------|
| Automated periodic metric collection (configurable, e.g., 60s/5min/15min) | Must collect without manual intervention | MEDIUM | Reuse existing collector scheduling. Default server interval: 5min (less aggressive than DB's 30s). |
| Concurrent SSH connections (server-per-collection) | Multiple servers collected simultaneously | MEDIUM | Connection pool. Max N concurrent SSH sessions. Reuse existing async collector dispatch pattern. |
| Graceful handling of SSH failures | Transient network issues shouldn't crash | LOW | Reconnect on next cycle. Mark as UNREACHABLE after N consecutive failures. Log error, don't cascade. |
| Connection timeout + command timeout | Zombie SSH connections | MEDIUM | Set `readyTimeout: 10000` and exec `maxTimeout: 15000`. Kill stale connections. |
| SSH keepalive | Long idle collection intervals | MEDIUM | Enable `keepaliveInterval: 5000` on SSH client to detect dropped connections faster. |

---

## Differentiators (Competitive Advantage)

Features that set Slide apart from basic SSH monitoring solutions.

### 1. AI Integration Layer

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **AI auto-analysis of server health** | "This server's CPU is at 85% due to a memory-leaking Java process (PID 1234)" instead of just "CPU > 80%" | MEDIUM | Feed collected metrics + top process data to LLM via existing `ai-agent-bridge.ts`. Already have the infrastructure. |
| **AI root cause analysis for server alerts** | Alert fires -> Agent investigates: checks recent metric history, top processes, log timeline -> produces plain-text RCA report | MEDIUM | Extend existing `alert-rca-service.ts` with server context (metric history + process snapshot + connection events). |
| **Natural language server query** | "Show me all servers with disk > 80% in production" | MEDIUM | AI Agent can query server metrics tables. Uses existing Agent chat tools. |
| **AI-driven server capacity prediction** | "This server's disk grows 2GB/day, it will be full in 14 days" | HIGH | Extend existing `capacity-predictor.ts` to server metrics. Linear regression on disk usage, memory, CPU trends. |

### 2. Unified DB + Server Dashboard

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Unified instance view: saw servers and DB instances in one dashboard** | Operators see all their infrastructure: DB instances + their hosts, in one place | MEDIUM | New "Infrastructure" overview tab: shows servers, their health, hosted DB instances. New `server_instances` ↔ `database_instances` relation. |
| **Server-to-DB relationship mapping** | "Instance MySQL-Prod is running on server 10.0.1.50" | MEDIUM | Optionally link a DB instance to its host server. When server goes down, all linked DB instances show "host unreachable" context. |
| **SSH-based OS-level health context for DB instances** | Currently DB monitoring has no OS context. Now: "Is this MySQL issue caused by the host being out of memory?" | MEDIUM | When a DB instance has a linked server, DB health score factors server metrics. DB alert panel shows "Host CPU: 92%, Host Memory: 97%" context. |

### 3. Smart SSH Optimization

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Batched SSH commands over single connection** | Full metric collection in one SSH session (not one connection per metric) | MEDIUM | Open one SSH connection per server, execute all commands sequentially on that session, close. Instead of connect-command-disconnect per metric. Significant latency reduction. |
| **SSH connection reuse across collection cycles** | If collecting every 5min, maintain persistent connection pool | MEDIUM | Long-lived SSH session with keepalive. But: risk of stale connections. Trade-off vs fresh-connection-per-cycle. |
| **Command output caching (short TTL)** | Same metric collected in 30s window shouldn't re-execute SSH | LOW | In-memory cache with 15s TTL within a server's collection cycle. Prevents repeated SSH exec of same command within same cycle. |
| **Adaptive collection frequency** | If CPU is spiking, collect every 30s until stable; then revert to 5min | HIGH | Dynamic interval based on metric anomaly detection. Anomaly triggers temporary increased collection rate. Needs: anomaly detection heuristic + collector rescheduling. Defer to post-MVP. |

### 4. Enterprise-Grade SSH Security

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **SSH credential encryption at rest** | Encrypted server_credentials table. AES-256-GCM with app master key. | MEDIUM | Generate master key on first startup (store in env or vault). Derive per-credential encryption key. Decrypt only for the duration of SSH connection. |
| **SSH host key verification (known_hosts)** | Prevent MITM attacks on SSH connections | MEDIUM | Store server's host key fingerprint on first connection (TOFU). Or allow operator to pre-add known host key. Warn/reject on mismatch. |
| **Minimal SSH user principle (read-only commands)** | SSH user should only be able to run read commands | MEDIUM | Document that monitoring user should have restricted shell (rbash), or use command whitelist. Not enforced by code, but recommended. |
| **Credential rotation reminder** | Periodic prompt to rotate SSH keys | LOW | Track `last_rotated_at` on credential record. Alert if > 90 days. |
| **Jump host / bastion support** | SSH through a jump host for isolated networks | HIGH | SSH proxy command support. Complex: session multiplexing over bastion adds latency and failure modes. Defer to post-MVP. |

---

## Anti-Features (Commonly Over-Engineered)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Real-time streaming metrics via SSH (1s interval)** | "I want live CPU monitoring like htop" | SSH has ~50-200ms latency per command. 1s interval generates 3600 SSH sessions/hour per server. Wastes SSH connections, burns CPU on client. Also this is what agents (node_exporter) are for. | Use SSH for 5min-interval collection. If real-time is needed, deploy an agent (node_exporter). Clearly label "no-agent" vs "agent" modes. |
| **Install OS packages / run shell scripts via SSH** | "Can also fix things through the monitoring tool" | Expands scope from monitoring to remote execution. Massive security risk (unintended command injection). SSH credential compromise escalates to full server control. | Monitoring is read-only. If remote execution is needed, build a separate "automation" tool with explicit approval workflow. |
| **Agentless Windows monitoring** | "Also monitor Windows servers" | Windows doesn't have SSH by default. PowerShell Remoting (WinRM) is a different protocol entirely. SSH on Windows requires OpenSSH Server, which is optional. Feature creep. | Declare "Linux servers only" for v0.8. Add Windows support later if demand justifies it (via WinRM or SSH extension). |
| **Monitor every possible thing (100+ metrics)** | "More data is better" | 90% of collected metrics never viewed. Costs CPU, SSH bandwidth, storage, and UI complexity. Operator gets overwhelmed by options. | Start with standard core metrics (CPU/memory/disk/network/uptime/load). Add advanced metrics (inodes, IO latency, top processes) as enhancements. Let users add custom metrics via config. |
| **Built-in remote SSH terminal** | "Convenient to SSH from the dashboard" | SSH-in-browser is a whole product (like GateOne or Apache Guacamole). Major security surface (key log, session recording). And it's monitoring, not a terminal emulator. | Click "Open SSH" that copies `ssh user@host` command to clipboard. Or link to a dedicated SSH tool (Termius, iTerm2, etc.). |
| **Automatic server discovery (network scan)** | "Find all servers on my network automatically" | ARP scan / subnet sweep triggers security alerts. Violates change management policies in enterprise. May accidentally sweep production or sensitive networks. | Manual add is safer and expected for enterprise. Provide "Add multiple" (bulk upload CSV) for initial setup. |
| **Docker container metrics via SSH** | "cAdvisor-like container monitoring" | Requires container runtime access (Docker socket or cgroups v2), not just standard Linux commands. SSH doesn't expose containers. | Separate Docker monitoring feature, not under server monitoring. |

---

## Feature Dependencies

```
[Server Registration]
    └──requires──> [SSH Credential Management]
    └──requires──> [server_instances table + service]
    └──requires──> [Test Connection functionality]

[SSH Metric Collection]
    └──requires──> [Server Registration]
    └──requires──> [SSH Session Manager (connect/exec/close)]
    └──requires──> [Metric Definition (server metrics added)]
    └──uses──> [Existing monitor-collector.ts scheduling]
    └──uses──> [Existing metrics_history table]

[Server Alert Rules]
    └──requires──> [SSH Metric Collection] (needs data to alert on)
    └──uses──> [Existing alert-engine.ts]
    └──uses──> [Existing alert_rules table]
    └──enhances──> [Existing notification-service.ts]

[Server Metrics Visualization]
    └──requires──> [SSH Metric Collection]
    └──uses──> [Existing ECharts components]
    └──uses──> [Existing dashboard pattern]

[Server Health Report]
    └──requires──> [SSH Metric Collection]
    └──requires──> [Server Alert Rules] (report includes alert history)
    └──uses──> [Existing report-service.ts]

[AI Server Analysis]
    └──requires──> [SSH Metric Collection]
    └──uses──> [Existing ai-agent-bridge.ts]
    └──uses──> [Existing alert-rca-service.ts]

[Server-DB Relationship Mapping]
    └──requires──> [Server Registration]
    └──uses──> [Existing database_instances table]
    └──enhances──> [Unified Infrastructure Dashboard]

[Unified Infrastructure Dashboard]
    └──requires──> [Server Registration]
    └──requires──> [SSH Metric Collection]
    └──requires──> [Server-DB Relationship Mapping] (for full value)

[Bastion / Jump Host Support]
    └──requires──> [SSH Session Manager] (extend to support proxy command)
    └──defer──> [Post-MVP]

[Adaptive Collection Frequency]
    └──requires──> [SSH Metric Collection]
    └──requires──> [Anomaly detection logic]
    └──defer──> [Post-MVP]
```

### Dependency Notes

- **[SSH Metric Collection] requires [SSH Session Manager]:** The session manager is the core abstraction that opens SSH connections, executes commands, and closes. All metric collection flows through this. Must support connection pooling, timeouts, and error handling.

- **[Server Alert Rules] uses [existing alert-engine.ts]:** The existing cron-based alert engine evaluates rules and creates alerts. For server monitoring, we just define new metric names (e.g., `server_cpu_percent`, `server_memory_percent`, `server_disk_usage`) and add them as alertable metrics. The alert evaluation pipeline stays unchanged.

- **[AI Server Analysis] uses [existing ai-agent-bridge.ts]:** The AI bridge already sends metric data to LLM for analysis. We extend the tool context with server metrics. No new AI infrastructure needed.

- **[Server-DB Relationship Mapping] enhances [Unified Infrastructure Dashboard]:** The relationship mapping provides maximum value only when presented in a unified view. Standalone relationship mapping (without dashboard) has limited utility.

---

## MVP Definition (v0.8)

### Launch With (v0.8 Minimum)

Minimum viable server monitoring that delivers real value to operators:

- [x] **Server registration (add/list/edit/delete via API + UI)** — Must have. Cannot monitor without registering targets.
- [x] **SSH credential management (encrypted, password + key auth)** — Must have. Cannot connect without credentials.
- [x] **SSH connection test before save** — Must have. Operators need to validate connectivity before saving.
- [x] **Core SSH metric collection** — CPU (usage % + load average), memory (used + swap), disk (per mount: usage %, inodes). These cover 80% of server health monitoring needs.
- [x] **Metric storage in existing metrics_history table** — Reuse existing time-series storage. No new storage infrastructure.
- [x] **Server list view with status + mini metrics** — Show online/offline status, CPU %, memory %, disk warning in list.
- [x] **Server detail view with trend charts** — CPU, memory, disk trend over selectable time ranges. Reuse existing ECharts components.
- [x] **Server alert rules (CPU, memory, disk thresholds)** — Reuse existing alert engine. Define new server metric rules.

**Total MVP scope:** 8 features. Estimated backend effort: ~2 phases (server registry + credential management; SSH collector + metrics storage). Frontend effort: ~1 phase (list + detail + chart views, reusing existing patterns).

### Add After Validation (v0.8.x)

These are important but not MVP. Add after core monitoring is stable:

- [ ] **Network traffic metrics (rx/tx per interface)** — Uses `/proc/net/dev`. Low effort. Add immediately after MVP.
- [ ] **Disk I/O latency (await, iops)** — Uses `iostat`. Medium effort. Depends on `iostat` being available on target servers.
- [ ] **Top N processes table** — Uses `ps` snapshot. Medium effort. Requires storing process lists as JSON in metrics_history.
- [ ] **Server health score card** — Aggregate CPU/memory/disk into a single health score. Medium effort. Model after existing DB health_score.
- [ ] **Server health report (PDF/HTML)** — Extends existing report-service.ts. Medium effort. Reuses report generation pipeline.
- [ ] **AI auto-analysis of server health** — AI bridge integration with server metrics. Low effort. Already have AI infrastructure.
- [ ] **AI server alert RCA** — Extend alert-rca-service.ts with server context. Low effort.
- [ ] **Server → DB relationship mapping** — Relate server_instances to database_instances. Medium effort. Enables unified views.
- [ ] **SSH command timeout and retry configuration** — Per-server configurable timeouts. Low effort. Important for unreliable networks.
- [ ] **Bulk server import (CSV)** — Import 20+ servers at once for initial setup. Low effort.

### Future Consideration (v0.9+)

- [ ] **Adaptive collection frequency** — Anomaly-driven interval change. High complexity. Not needed until user base grows.
- [ ] **Bastion / jump host support** — Proxy command SSH. High complexity. Niche need for isolated networks.
- [ ] **Docker container metrics** — Separate feature scope. Not server monitoring.
- [ ] **Windows server support** — WinRM protocol. Separate feature scope.
- [ ] **Real-time streaming metrics** — Requires node_exporter deployment. Agent vs no-agent decision.
- [ ] **Unified server + DB infrastructure dashboard** — Overarching cross-instance view. High UI effort. Best after both monitoring types are mature.

---

## Data Model

### New Tables

```
server_instances
  id              INT AUTO_INCREMENT PRIMARY KEY
  host            VARCHAR(255) NOT NULL          -- IP or hostname
  port            INT DEFAULT 22
  label           VARCHAR(255)                   -- Display name
  os_type         VARCHAR(50)                    -- linux, windows, etc.
  credential_id   INT REFERENCES server_credentials(id)
  status          ENUM('online','offline','error','unknown') DEFAULT 'unknown'
  last_check_at   DATETIME                       -- Last successful collection
  tags            JSON                           -- For filtering and grouping
  notes           TEXT
  enabled         BOOLEAN DEFAULT TRUE
  collection_interval_seconds INT DEFAULT 300    -- Default: 5 minutes
  created_at      DATETIME DEFAULT NOW()
  updated_at      DATETIME DEFAULT NOW() ON UPDATE NOW()

server_credentials
  id              INT AUTO_INCREMENT PRIMARY KEY
  name            VARCHAR(255)                   -- Human-readable credential name
  auth_type       ENUM('password','key') NOT NULL
  username        VARCHAR(255) NOT NULL
  encrypted_password  TEXT                       -- AES-256-GCM encrypted (if auth_type='password')
  encrypted_private_key TEXT                     -- AES-256-GCM encrypted (if auth_type='key')
  passphrase_encrypted TEXT                      -- For encrypted private keys
  fingerprint_sha256   VARCHAR(64)              -- Host key verification
  last_rotated_at DATETIME
  created_at      DATETIME DEFAULT NOW()
  updated_at      DATETIME DEFAULT NOW() ON UPDATE NOW()

server_metrics (alternative: reuse existing metrics_history)
  id              BIGINT AUTO_INCREMENT PRIMARY KEY
  server_id       INT REFERENCES server_instances(id)
  metric_name     VARCHAR(100)                   -- e.g., cpu_percent, memory_percent, disk_usage
  metric_value    DECIMAL(20,4)
  tags            JSON                           -- e.g., {"mount":"/data","interface":"eth0"}
  collected_at    DATETIME INDEX
```

**Decision: Use `metrics_history` table but add a `server_id` column (nullable) alongside existing `instance_id`.**

Rationale: The existing `metrics_history` table already has the time-series storage pattern, partitioning strategy, and query optimization. Adding an optional `server_id` column reuses all existing infrastructure. A fully separate `server_metrics` table would duplicate the storage layer without clear benefit for MVP. For high-volume server fleets (100+), partitioning by server_id may become necessary, but that's a scale concern, not an MVP concern.

### Extended Existing Tables

```sql
-- Extend metrics_history (currently uses instance_id for DB instances)
ALTER TABLE metrics_history ADD COLUMN server_id INT NULL;
ALTER TABLE metrics_history ADD INDEX idx_server_id_metric (server_id, metric_name, collected_at);

-- Extend alert_rules to support server metric types
-- Currently: metric_name references DB metrics.
-- Server metrics use prefix: 'server_cpu_percent', 'server_memory_percent', etc.
-- No schema change needed if metric_name is already VARCHAR and free-form.
-- But add a target_type column to distinguish DB vs server:
ALTER TABLE alert_rules ADD COLUMN target_type ENUM('database','server') DEFAULT 'database';

-- Extend database_instances to optionally link to host server
ALTER TABLE database_instances ADD COLUMN host_server_id INT NULL REFERENCES server_instances(id);
```

---

## SSH Collection Command Reference

| Metric | Linux Command | Output Parsing | Notes |
|--------|--------------|----------------|-------|
| CPU percent | `top -bn1 \| head -5` | Parse "%Cpu(s): us, sy, id, wa, hi, si, st" line | Collection takes ~0.5s. Cached by /proc/stat for low overhead. |
| Load average | `cat /proc/loadavg` | Parse "1min 5min 15min" first 3 values | Zero overhead. Single file read. |
| Memory + swap | `free -m` | Parse "Mem:" and "Swap:" lines for total/used/free/available | Standard on all Linux. |
| Disk usage | `df -B1 --exclude-type=tmpfs --exclude-type=devtmpfs` | Parse per mount: filesystem, 1K-blocks, used, available, use% | -B1 gives bytes for precision. Exclude tmpfs to avoid noise. |
| Disk I/O | `iostat -x 1 2 \| tail -n +4` | Parse per device: rrq/s, wrq/s, r/s, w/s, rkB/s, wkB/s, await, svctm, %util | Depends on sysstat package. Fallback: parse /proc/diskstats directly. |
| Network traffic | `cat /proc/net/dev` | Parse per interface: bytes/packets/errors/drop in + out | Zero overhead. Available on all Linux. |
| Top processes CPU | `ps aux --sort=-%cpu --no-headers \| head -20` | Parse PID, %CPU, %MEM, COMMAND for top 20 | Output ~20 lines. ~0.2s execution. |
| Top processes MEM | `ps aux --sort=-%mem --no-headers \| head -20` | Same as above, sorted by memory | Can be combined with the above in one `ps` call. |
| Uptime | `cat /proc/uptime` or `uptime -s` | Parse seconds since boot | Zero overhead. |
| Process count | `ps aux --no-headers \| wc -l` | Single integer | Lightweight. |
| Inode usage | `df -i --exclude-type=tmpfs --exclude-type=devtmpfs` | Parse per mount: Ifree, Iused, Iuse% | Same df pattern as disk usage. |

### Multi-command Execution Strategy

Rather than running each command as a separate SSH exec (which adds ~50-200ms per command), batch multiple commands into a single SSH exec:

```bash
# Batched collection (~20-line output, single SSH roundtrip):
echo "---CPU---"; cat /proc/loadavg; echo "---MEM---"; free -m; \
echo "---DISK---"; df -B1 --exclude-type=tmpfs --exclude-type=devtmpfs; \
echo "---NET---"; cat /proc/net/dev; \
echo "---UPTIME---"; cat /proc/uptime; \
echo "---PROC---"; ps aux --no-headers | wc -l;
```

This reduces SSH roundtrips from 7+ to 1 per server per collection cycle. Major performance improvement for fleets of 10+ servers.

---

## SSH Session Manager Architecture

```
┌─────────────────────────────────────────────┐
│           SSH Session Manager                │
│  (ssh-session-manager.ts)                    │
│                                              │
│  Responsibilities:                           │
│  - Open/close SSH connections                │
│  - Execute commands on remote servers        │
│  - Parse command output into structured data │
│  - Connection pooling and reuse              │
│  - Timeout and error handling                │
│  - Decrypt credentials on demand             │
└─────────────────────┬───────────────────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
┌─────────────────┐   ┌─────────────────────┐
│ Credential      │   │ SSH Connection Pool │
│ Decryptor       │   │ (Map<server_id,     │
│ (decrypts       │   │  Client>)           │
│  stored creds)  │   │                     │
└─────────────────┘   │ - getConnection()   │
                      │ - releaseConnection()│
                      │ - closeAll()        │
                      └─────────────────────┘
```

**Recommended SSH library:** `ssh2` (npm: `ssh2@^1.16.0`) — This is the de-facto Node.js SSH library. It supports password auth, private key auth (RSA, Ed25519), host key verification, connection keepalive, and command execution via `exec()`. The alternative `node-ssh` is a wrapper around `ssh2` with less direct control. For a monitoring tool where we need precise control over timeouts, connection pooling, and error handling, `ssh2` directly is preferred.

Alternative: `ssh2-promise` provides a promise-based wrapper. May be easier to integrate with async/await patterns already used in codebase.

---

## Interactive SSH Host Key Verification Flow

For the "test connection" flow:

1. User adds server (IP + port + credentials)
2. System connects via SSH (first time: host key not yet verified)
3. If host key fingerprint not stored:
   - Fetch host key from server
   - Show fingerprint to user: "This server's key fingerprint is SHA256:xxxx. Accept?"
   - User can accept (store) or reject
4. On subsequent connections:
   - Compare server's host key against stored fingerprint
   - If mismatch: raise alert, flag server status as ERROR, user must manually re-accept

This is a "trust on first use" (TOFU) model, similar to how SSH itself works with `~/.ssh/known_hosts`. For higher security environments, allow pre-provisioning of host keys via API.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Server registration CRUD + UI | HIGH | LOW | P1 |
| SSH credential management (encrypted) | HIGH | MEDIUM | P1 |
| SSH connection test | HIGH | LOW | P1 |
| Core SSH metric collection (CPU/mem/disk/load) | HIGH | MEDIUM | P1 |
| Metric storage in metrics_history | HIGH | LOW | P1 |
| Server list view with status | HIGH | MEDIUM | P1 |
| Server detail view + trend charts | HIGH | MEDIUM | P1 |
| Server alert rules (CPU/mem/disk) | HIGH | MEDIUM | P1 |
| Network traffic metrics | MEDIUM | LOW | P2 |
| Disk I/O metrics | MEDIUM | MEDIUM | P2 |
| Top processes snapshot | MEDIUM | MEDIUM | P2 |
| Server health score | MEDIUM | MEDIUM | P2 |
| Server health report | MEDIUM | MEDIUM | P2 |
| AI server health analysis | MEDIUM | LOW | P2 |
| AI server alert RCA | MEDIUM | LOW | P2 |
| Server-DB relationship mapping | MEDIUM | MEDIUM | P2 |
| Bulk server import CSV | MEDIUM | LOW | P2 |
| Unified infrastructure dashboard | HIGH | HIGH | P3 |
| Adaptive collection frequency | LOW | HIGH | P3 |
| Bastion/jump host support | LOW | HIGH | P3 |
| Windows server support | LOW | HIGH | P4 |
| Docker container metrics | LOW | HIGH | P4 |

**Priority key:**
- P1: Must have for v0.8 launch
- P2: Should have, add in v0.8.x
- P3: Nice to have, future milestone
- P4: Out of scope for foreseeable future

---

## Competitor Feature Analysis

| Feature | Nagios XI | Zabbix | Checkmk | Prometheus + node_exporter | Our Approach (SSH, no-agent) |
|---------|-----------|--------|---------|-----------------------------|------------------------------|
| No agent required | Agent-based (NRPE/NSClient) | Agent-based or SNMP | Agent-based for production, SNMP/SSH for agents | Pull model (agent required) | **SSH-only, zero install** |
| SSH-based collection | Via check_by_ssh plugin | Via Zabbix agent reachable through SSH | Via SSH check plugin | Not supported natively | **Core mechanism** |
| CPU/memory/disk/network | All monitored | All monitored | All monitored | All monitored | **P1 scope** (CPU/mem/disk/network) |
| Top processes | Plugin available | System statistics items | Check plugins | Node exporter process collector | **P2 scope** |
| Disk I/O latency | Plugin available | System statistics items | Check plugins | Node exporter diskstats | **P2 scope** |
| Alert engine | Built-in | Built-in | Built-in | Alertmanager (separate) | **Reuse existing alert-engine.ts** |
| AI analysis | Vague "AI" features in XI | No native AI | No native AI | No native AI | **Differentiator**: LLM-driven analysis |
| Credential encryption | Plaintext config | Plaintext config | Plaintext config | Plaintext config | **Encrypted at rest** (differentiator) |
| Dashboard | Built-in | Built-in (Widget-based) | Built-in (MkP) | Grafana (separate) | **Reuse existing ECharts dashboard** |
| Reporting | Built-in (PDF) | Built-in (PDF) | Built-in (PDF) | Requires Grafana | **Reuse existing report-service.ts** |
| Credential rotation | Manual | Manual | Manual | N/A (no credentials needed) | **Built-in rotation reminder** |
| Windows support | Yes | Yes | Yes | Yes (wmi_exporter) | **No** (v0.8 limitation) |

---

## Sources

- **Codebase analysis**: Existing Slide platform infrastructure (monitor-collector.ts, alert-engine.ts, metric_definitions, metrics_history, database-service.ts, report-service.ts, ai-agent-bridge.ts) — all verified via source code in apps/db-ops-api/src/
- **Schema analysis**: Existing database tables and patterns from `apps/db-ops-api/sql/schema.sql` (1295 lines including metrics_history, metric_definitions, alert_rules, database_instances)
- **Architecture patterns**: Nagios check_by_ssh, Zabbix SSH agent checks, Checkmk SSH checks — established industry patterns adapted to Node.js/TypeScript stack
- **SSH library evaluation**: `ssh2` (npm) as de-facto Node.js SSH implementation, 2M+ weekly downloads, actively maintained

---
*Feature research for: SSH-based Server Monitoring (v0.8)*
*Researched: 2026-07-07*
*Integrates with: Existing Slide DB Ops Platform infrastructure*
