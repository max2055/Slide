# Stack Research: SSH-Based Server Monitoring

**Domain:** SSH server monitoring in Node.js/TypeScript
**Researched:** 2026-07-07
**Confidence:** HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `ssh2` | ^1.17.0 | Pure JS SSH2 client — all SSH connectivity | Gold standard for Node.js SSH since 2012 (13+ years). Zero native deps, actively maintained (Aug 2025), 2M+ weekly downloads. Supports exec, shell, SFTP, key auth, host verification, keepalive — everything needed for server monitoring. Chosen over wrappers because we need direct control over connection lifecycle for pooling. |
| `@types/ssh2` | ^1.15.5 | TypeScript type definitions for ssh2 | ssh2 does not bundle TS declarations. Latest release Apr 2025, compatible with ssh2@1.17.x. Required for type-safe SSH operations. |
| Node.js built-in `crypto` (AES-256-CBC) | (built-in) | Encrypt SSH keys at rest | Already used in project for DB password encryption (see `db-connection.ts`). Reuse same pattern — no new crypto dependency. |
| Node.js built-in `stream` | (built-in) | Process command output streams | ssh2 `Channel` extends `stream.Readable`. Process stdout/stderr with standard stream API. No wrapper needed. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none for metric parsing) | — | Parse `top`, `free`, `df`, `netstat` output | Linux CLI output is columnar/whitespace-delimited. Parse with line-by-line `.split()` + `.trim()` + regex. No npm parser is standard or necessary — each monitoring project rolls its own parsing because output format varies by OS flavor/flags. |
| (build our own connection pool) | — | Manage concurrent SSH connections | No mature SSH connection-pooling npm package exists. `node-ssh` wraps individual connections but offers no pooling. Best practice: a simple Map<string, ssh2.Client> pool with TTL, max connections, and idle timeout. Pattern identical to how `database-service.ts` manages DB pools. |
| (existing `cron` ^4.4.0) | ^4.4.0 | Schedule periodic metric collection | Already in `apps/db-ops-api/package.json`. Reuse the 30-second cron infrastructure from `collector.ts` for server metrics collection. |
| (existing notification service) | — | Alert notifications for server metrics | Already in `notification-service.ts`. Server alerts reuse the same DingTalk/WeCom/Feishu/Webhook channels. |
| (existing report service) | — | Generate server inspection reports | Already in `report-service.ts`. Server inspection PDF/HTML/JSON/MD reports follow the same export patterns. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `tsx` | Run TypeScript directly | Already in devDeps, use for testing SSH connections during development |
| `vitest` | Unit/integration tests | Already in devDeps. Test SSH parsing with fixture output files. |
| Local SSH server (`sshd` on localhost) | Integration testing | For CI, use `ssh-keygen -t ed25519 -f test_key -N ""` to generate test keys. For local dev, test against an actual SSH server or Docker `linuxserver/openssh-server`. |

## Installation

```bash
cd apps/db-ops-api
npm install ssh2@^1.17.0
npm install -D @types/ssh2@^1.15.5
```

That is the complete set of new npm dependencies. Everything else needed (cron infrastructure, notification channels, report generation, metric storage, encryption) already exists in the platform.

## Alternatives Considered

### Why ssh2 directly, not node-ssh

`node-ssh@13.2.1` wraps ssh2 with a Promise-based API. It is well-maintained (Mar 2025) and bundles TypeScript types. However, it is not recommended because:

1. **Extra dependencies**: `node-ssh` pulls in ~6 additional packages (`is-stream`, `make-dib`, `sb-promise-queue`, `sb-scandir`, `shell-escape`, `ssh2`). None are needed for server monitoring.
2. **Connection pooling**: `node-ssh` is designed for one-off connections. Its internal queue (`sb-promise-queue`) serializes commands on a single connection — not what we need for pooling. We would end up managing our own pool anyway, bypassing node-ssh entirely.
3. **Control**: Direct `ssh2` access gives us control over `keepaliveInterval`, `readyTimeout`, `hostVerifier`, and `debug` callbacks — all critical for reliable monitoring connections.

Use `node-ssh` only if you needed SFTP file transfer convenience in a one-off script. For a server monitoring system, go direct to `ssh2`.

### Alternatives Rejected

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `ssh2` | `node-ssh` | For one-off SSH scripts or SFTP-heavy tasks where you want a quick Promise wrapper. Not for production monitoring. |
| `ssh2` | `ssh2-promise@1.0.3` | **Never.** Last published June 2022, unmaintained. Repo is archived. Do not use. |
| `ssh2` | `ssh-exec@2.0.0` | **Never.** Last published January 2016, unmaintained. |
| `ssh2` | `simple-ssh` | **Never.** Unmaintained, callback-only API, no TypeScript support. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `ssh2-promise` | Unmaintained since June 2022. No guarantees for compatibility with ssh2@1.x. | Direct `ssh2` with native `util.promisify` callbacks. |
| `node-ssh` for pooling | Its queue-based design serializes commands — we need parallel collection across many servers. | Build a thin connection pool over raw `ssh2.Client`. |
| Any npm package for parsing `top`/`free`/`df` output | No standard package exists for this; every project rolls custom parsers because output format is OS-dependent. Adding a parser dependency adds fragility (wrong format assumptions). | Write simple line-split parsers with regex. ~20 lines per command. See patterns below. |
| `procps` or `sysstat` installation on monitored servers | Avoid requiring agents or additional packages on monitored servers. | Use built-in Linux commands (`cat /proc/stat`, `free`, `df`) or parse `/proc` files directly. |
| Storing SSH keys in plaintext in the DB | Credential leak would expose SSH access to all monitored servers. | Use existing AES-256-CBC `encryptData`/`decryptData` from `db-connection.ts`. Same pattern as DB passwords. |
| Storing SSH key passphrases in code | Plaintext passphrases in config files. | Encrypt with same AES-256-CBC key. Store encrypted alongside the key in the `server_instances` table. |

## Linux Command Output Parsing Patterns

No npm library needed. These are the standard Linux monitoring commands and their parseable output format with Node.js parsing approaches:

### CPU Usage — `/proc/stat`
```typescript
// Command: cat /proc/stat | grep '^cpu '
// Output: cpu  12345 678 90123 456789 111 222 333 444 555 666
// Columns: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
// Parse: split on whitespace, slice(1), map to numbers
// Rate calculation: delta(active) / delta(total) where total = sum of all columns
// Active = total - idle - iowait
const parts = line.trim().split(/\s+/);
const columns = parts.slice(1).map(Number);
const total = columns.reduce((a, b) => a + b, 0);
const idle = columns[3]; // index 3 = idle
const active = total - idle;
// Store across two collection cycles to compute delta
```

### Memory — `/proc/meminfo`
```typescript
// Command: cat /proc/meminfo
// Output:
// MemTotal:       16384972 kB
// MemFree:         8354560 kB
// MemAvailable:   11123784 kB
// Buffers:          435672 kB
// Cached:          6128744 kB
// ...
// Parse: /^(\w+):\s+(\d+)\s+kB$/gm
const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
if (match) meminfo[match[1]] = parseInt(match[2], 10);
// Used = MemTotal - MemAvailable
// Usage% = (MemTotal - MemAvailable) / MemTotal * 100
```

### Disk Usage — `df`
```typescript
// Command: df -B1 --exclude-type=tmpfs --exclude-type=devtmpfs
// Output:
// Filesystem      1B-blocks         Used   Available Use% Mounted on
// /dev/sda1      51195701248  2147483648 49048217600   5% /
// devtmpfs         ...        ...
// Parse: skip header line, split on whitespace
// Columns: filesystem, blocks (1B), used, available, usePct, mountPoint
// For percentage: parse usePct as integer (remove '%')
```

### Network — `/proc/net/dev`
```typescript
// Command: cat /proc/net/dev
// Output:
// Inter-|   Receive                                                |  Transmit
//  face |bytes    packets errs drop fifo frame ...  |bytes    packets errs drop fifo ...
//   eth0: 1234567  1234    0    0    0     0    ...  7654321  4321    0    0    0 ...
// Parse: skip 2 header lines, match /^\s*(\w+):\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/
// Key columns: rxBytes[1], rxPackets[2], rxErrors[3], txBytes[9], txPackets[10], txErrors[11]
// Rate = delta / elapsed_seconds (since counters are cumulative)
```

### Load Average — `/proc/loadavg`
```typescript
// Command: cat /proc/loadavg
// Output: 0.45 0.32 0.21 2/345 67890
// Columns: 1min, 5min, 15min, running/total, last_pid
// Parse: line.split(/\s+/).slice(0, 3).map(Number)
```

### Process Count — `/proc/loadavg` or `ps`
```typescript
// Command: ps aux --no-headers | wc -l
// Output: 345
// OR from /proc/loadavg: the 4th field "2/345" — parse as running/total
```

### Uptime — `cat /proc/uptime`
```typescript
// Command: cat /proc/uptime
// Output: 1234567.89 2345678.90
// Columns: uptime_seconds, idle_seconds
// Parse: split, parseFloat
```

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `ssh2@1.17.0` | Node >=10.16.0 (we have v22.22.1) | Fully compatible |
| `@types/ssh2@1.15.5` | `ssh2@1.x`, `@types/node@>=18.11.18` | Compatible with our `@types/node@^20.10.0` |
| `ssh2` | TypeScript `target: ES2022` | No conflicts. ssh2 uses callbacks; wrap with `util.promisify` or use in async patterns. |
| ssh2 with existing `mysql2` | No conflict | Different transport layers, independent connection lifecycle. |
| SSH connections with existing pool connections | No conflict | `ssh2.Client` manages its own socket; DB pools manage MySQL/PostgreSQL connections. They share the Node.js event loop but are independent. |

## Stack Patterns by Variant

**If monitoring both Linux and Windows servers:**
- Use the same `ssh2` library for Linux. For Windows, use WinRM instead of SSH (Windows OpenSSH server uses different default metrics format). WinRM setup is out of scope — keep the first version Linux-only.

**If the project needs to run custom scripts (not just built-in commands):**
- Upload scripts via ssh2 SFTP `sftp()` method before executing them. Store script content in a `server_scripts` table. This is a Phase 2 feature — start with built-in commands only.

**If SSH key rotation is needed:**
- SSH key pairs can be rotated by the same `encryptData`/`decryptData` pattern. Store the new key encrypted, test connectivity, then replace the old key. Add a `last_key_rotated_at` column to `server_instances`.

**If monitoring needs to scale beyond 100 servers:**
- Add connection pooling with max concurrent connections (e.g. 50). Queue excess connections. This isn't needed at initial scale (5-20 servers) but should be architected from day one. See Architecture Pattern below.

## Architecture Pattern: Connection Pool

The server monitoring stack introduces a `ServerSSHPool` class that parallels the existing `database-service.ts` connection management:

```typescript
interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey?: Buffer;   // Decrypted at runtime
  passphrase?: string;
  password?: string;
  readyTimeout: number;   // default 10000ms
  keepaliveInterval: number; // default 10000ms
  keepaliveCountMax: number; // default 3
}

class ServerSSHPool {
  private pool = new Map<number, ssh2.Client>(); // server_id -> Client
  private configs = new Map<number, SSHConnectionConfig>();

  async connect(serverId: number, config: SSHConnectionConfig): Promise<void>;
  async exec(serverId: number, command: string): Promise<{ stdout: string; stderr: string; code: number | null }>;
  async disconnect(serverId: number): Promise<void>;
  isConnected(serverId: number): boolean;
  async healthCheck(serverId: number): Promise<boolean>;
  dispose(): void; // Close all connections
}
```

This is intentionally thin — it does NOT implement queuing (that is handled by the collector scheduler which controls concurrency), and it does NOT implement retry (that is handled by the metric collection infrastructure with its 3-failure auto-disable).

## Integration Points with Existing Platform

| Existing Component | Integration for Server Monitoring |
|-------------------|----------------------------------|
| `collectors/registry.ts` | Register `ServerMetricProvider` with `db_type: 'server'` |
| `collectors/base-provider.ts` | `SSHProvider extends BaseMetricProvider` — same `collect(conn, metricDef)` interface |
| `UnifiedCollector` | Reuse `collectInstance()` — server instances treated as a new `db_type` |
| `metric_registry` table | Register server-specific metrics (cpu_usage_pct, memory_usage_pct, disk_usage_pct...) with `db_types: ['server']` |
| `metrics-history` table | Add `source: 'server' | 'database'` column or use new `server_metrics_history` table |
| `alert-engine.ts` | Reuse `evaluateRule()` — add `source_type: 'server'` to alert rules |
| `event-aggregator.ts` | Reuse — server alerts aggregated same way as DB alerts |
| `notification-service.ts` | Reuse — notifications go through same channels |
| `report-service.ts` | Add server inspection report template |
| `instance-database-service.ts` | Add `ServerInstance` model in a new `server-database-service.ts` (separate table from database_instances) |
| `database-service.ts` | **Do NOT reuse** — server SSH connections use `ssh2.Client`, not SQL pools |

## Sources

- npm registry — `ssh2@1.17.0`, `@types/ssh2@1.15.5`, `node-ssh@13.2.1`, `ssh2-promise@1.0.3` (verified versions, publish dates, dependencies) — HIGH confidence
- GitHub — `mscdex/ssh2` (documented API, best practices) — HIGH confidence
- GitHub — `steelbrain/node-ssh` (documented wrapper API) — MEDIUM confidence
- npm search results — validated no mature SSH connection-pooling package exists — HIGH confidence
- Existing codebase audit — `db-connection.ts`, `encryptData`/`decryptData`, `BaseMetricProvider`, `UnifiedCollector`, `alert-engine.ts`, `notification-service.ts` — HIGH confidence (first-hand audit of the project source)

---
*Stack research for: SSH-based server monitoring in the Slide platform*
*Researched: 2026-07-07*
