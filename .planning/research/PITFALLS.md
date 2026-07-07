# Pitfalls Research

**Domain:** SSH-based Server Monitoring (no-agent, via Node.js ssh2) on existing DB Ops Platform
**Researched:** 2026-07-07
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: SSH Host Key Verification Bypass (MITM Attack)

**What goes wrong:**
All server connections are silently accepted without verifying the remote host's identity. The ssh2 library defaults to auto-accepting any host key when `hostVerifier` is not set. An attacker on the network path (same VLAN, compromised switch, ARP spoofing) can intercept SSH connections, capture credentials, and return fake metrics. The platform operator never knows the key was wrong.

**Why it happens:**
Setup is quicker when you skip host key verification. In development, every new server needs its key manually accepted (like `ssh-keygen -R` for known_hosts). Developers disable verification "temporarily" and it ships to production. The team is familiar with SSH key pairs for user access but unfamiliar with `known_hosts` as a verification mechanism for automation. The ssh2 documentation explicitly states keys are "auto-accept if hostVerifier is not set" — silent authorization, not a helpful error.

**How to avoid:**
- Implement a `hostVerifier` callback in every SSH connection. Always hash with `hostHash: 'sha256'`.
- Store accepted host keys in a dedicated `known_hosts` table (MySQL `server_known_hosts`) alongside the server record. On first connection, prompt an admin to verify and accept the key before collection begins.
- For initial onboarding, support a "verify on first use" (TOFU) mode that stores the first-seen key and raises an alert if it changes — do NOT accept TOFU and never mention it.
- Ship with strict verification enabled. Add a config flag `SSH_STRICT_HOST_KEY_CHECK=false` as a KNOWN INSECURE override, logged on startup, with a warning sentry event.

**Warning signs:**
- SSH connection code that only calls `connect()` with `host`, `port`, `username`, `privateKey` — no `hostVerifier` or `hostHash` parameters.
- A `hostVerifier: () => true` or similar always-return-true function.
- Connections work but there's no "first time connecting to new host" prompt anywhere in the UI.

**Phase to address:**
Phase "SSH Connection Security" — must be implemented before ANY production server is registered. The host key verification model (strict vs. TOFU vs. database-backed) needs to be designed upfront because it affects the server registration flow, database schema, and UI.

---

### Pitfall 2: Plaintext SSH Key Storage in Database

**What goes wrong:**
SSH private keys are stored unencrypted in the `servers` table or a `server_credentials` table. Anyone with database read access (DBA, support staff, SQL injection vulnerability) can extract all private keys and access every monitored server. Unlike database passwords that are usually database-specific, SSH keys often grant broad system access (passwordless sudo, `root` login).

**Why it happens:**
The existing platform already stores database passwords in encrypted form (via `encryptData()` / `decryptData()`), so the team likely plans to reuse this pattern for SSH keys. But SSH private keys are fundamentally different from passwords in three ways:
1. SSH keys are permanent credentials that users often reuse across multiple servers
2. A compromised key can be used for lateral movement (SSH agent forwarding, key-based `sudo`)
3. The `ssh2` library expects keys in a specific format (PEM, OpenSSH), not an encrypted blob that needs decryption at connection time

**How to avoid:**
- Store private keys encrypted at rest using the same `encryptData()` / `decryptData()` pattern already used for database passwords. Decrypt only in memory at connection time, never write the decrypted key to a temp file or log.
- Add a dedicated `server_credentials` table (separate from `servers` or reuse `database_instances`-like pattern) with a `credential_type` column (`ssh_key` / `password`) and encrypted value storage.
- Implement a key rotation endpoint (`POST /api/servers/:id/rotate-key`) that accepts a new key and re-encrypts it. This forces the API design to account for rotation from day one, rather than having keys be permanent once stored.
- Add a `fingerprint` column (derived from the public key) so the platform can detect when a server's key changes unexpectedly.

**Warning signs:**
- A `server_credentials` column that stores private keys in plaintext (or base64 only, no actual encryption).
- No credential rotation endpoint on the server management API.
- The team plans to "just encrypt it the same way as database passwords" without auditing whether SSH keys are equivalent to database passwords in terms of exposure risk.

**Phase to address:**
Phase "Server Registration & Credential Management" — credential storage model is a design constraint that affects the database schema, API design, and agent tool registration.

---

### Pitfall 3: SSH Connection Pool Exhaustion (Memory / Socket Leak)

**What goes wrong:**
Every metric collection cycle opens a new SSH connection to each server. If there are 100 servers, each with CPU, memory, disk, and network metrics collected at 30-second intervals, the platform opens 400 SSH connections per cycle. Many of these connections are not properly closed — the `exec()` callback completes but the channel or session is left open, or the `Client.end()` is never called on error. Within hours, the Node.js process exhausts the file descriptor limit (typically 1024 on macOS, 65535 on Linux but still finite) or the remote SSH servers exhaust their `MaxSessions` limit, causing all connections to start failing.

**Why it happens:**
The ssh2 library has a multi-level object model: `Client` (connection), `Session`, `Channel`. A common mistake is:
- Creating a new `Client` for every collection without pooling
- Calling `exec()` but not listening for the `close` event on the channel (SSH2 spec says the `exit` event is optional)
- On error, only logging the error without calling `client.end()`
- Assuming the `Client` auto-cleans when garbage collected (Node.js GC does not close TCP sockets)
- The existing `unifiedCollector` acquires a database connection per instance and releases it — but a direct `getConnection()` pattern for SSH would be much more expensive, since each SSH connection involves a TCP handshake + key exchange + authentication

**How to avoid:**
- Implement a **connection pool** per SSH server, not per metric. Reuse the same `ssh2.Client` for all metrics on the same server within a collection cycle.
- Set `keepaliveInterval: 60000` and `keepaliveCountMax: 3` on the Client so idle connections are detected and cleaned.
- In the pool, set a `maxConnections: 3` limit per server (SSH default `MaxSessions` is often 10, but limit yourself to 3 to be safe).
- On every `exec()` call, attach ALL channel event listeners: `close`, `error`, `exit`, `end`. The `close` handler MUST call `channel.close()` and the `error` handler MUST call `client.end()`.
- Add a health check: monitor open file descriptors (`process.resourceUsage()`) and SSH connection count. Alert when either exceeds 80% of the system limit.
- Set `readyTimeout: 30000` (30s) to fail fast on unreachable hosts instead of hanging for 2+ minutes.

**Warning signs:**
- Metric collection that works for 1-2 servers but silently fails for 10+.
- Increasing `ETIMEDOUT` or `ECONNRESET` errors over time.
- The platform's file descriptor usage growing monotonically with each collection cycle.
- Remote SSH servers logging "max sessions" errors or refusing new connections.
- No test for "collect metrics from 50 servers simultaneously" — single-server tests never catch pool leaks.

**Phase to address:**
Phase "SSH Metric Collection Engine" — connection pooling is the architectural foundation. Written correctly here, performance and reliability issues are avoided. Written as a quick prototype, the pool leak will only surface later under load.

---

### Pitfall 4: Collection Output Parsing Fragility (Brittle `exec()` Output Processing)

**What goes wrong:**
Metric collection relies on parsing the stdout of shell commands like `cat /proc/stat`, `free -m`, `df -h`, or `top -bn1`. These commands have different output formats across Linux distributions (Debian vs RHEL vs Alpine vs Ubuntu), different kernel versions, different locale settings (`LANG=de_DE.UTF-8` produces German decimal commas instead of dots), and different language packs. A metric that works on Ubuntu 22.04 fails silently on CentOS 7, returning `NaN` or garbage values that pass threshold checks incorrectly.

**Why it happens:**
The developer tests on one OS (their dev machine or a single Ubuntu test server) and assumes the output format is universal. In reality:
- `free -m` output differs between `procps-ng` and BusyBox (Alpine uses BusyBox)
- `df` column alignment varies by filesystem name length — fixed-width parsing breaks on long mount paths
- `cat /proc/stat` CPU line format differs across kernel versions (older kernels don't have guest/steal columns)
- Locale affects number formatting: `LANG=de_DE.UTF-8 free` shows `3,1` instead of `3.1`
- `awk` or `sed` may not be available on minimal Docker images (Alpine uses BusyBox `awk` with different behavior)
- The remote server's default shell might be `sh`, not `bash`, with different pipe/expansion semantics

**How to avoid:**
- Read metrics from `/proc` and `/sys` filesystem directly over SFTP instead of parsing `exec()` output. SFTP avoids shell interpretation issues entirely and returns raw file contents.
- If using `exec()`, always set `LANG=C` and `LC_ALL=C` in the command prefix to get consistent English output: `LANG=C LC_ALL=C free -b`.
- Use JSON-capable command lines where possible: `LANG=C LC_ALL=C free -b --json` (available on newer procps), or parse `/proc/meminfo` (key-value format, highly portable).
- Maintain a **per-metric compatibility matrix** in code: e.g., `{ command: ['/proc/cpuinfo', 'sftp'], fallback: ['top -bn1 | head -5', 'exec'] }`. If the primary method fails for a distro, try the fallback.
- Validate every parsed metric: if a CPU percentage exceeds 100 or memory usage is negative, treat it as a collection failure, not a valid data point.
- Unit test against fixture files from Ubuntu 20.04, 22.04, CentOS 7, 8, Rocky Linux 9, Alpine 3.18, and Debian 11/12. Do not trust that "Linux is Linux."

**Warning signs:**
- Metric collection that only uses `exec()` with pipe-heavy shell commands (`cat file | awk '{print $2}' | grep ...`).
- No `LANG=C` prefix on any SSH command.
- All testing performed on a single OS (the dev's Mac with a single Ubuntu VM).
- Metric values that are occasionally `0`, `Infinity`, or `NaN` but collected successfully.

**Phase to address:**
Phase "SSH Metric Collection Engine" — the collection strategy (SFTP vs exec, locale handling, fallback chains) is a design decision that affects every single metric. Changing it later means rewriting every provider.

---

### Pitfall 5: Blocking the Node.js Event Loop with SSH Operations

**What goes wrong:**
SSH key exchange (especially RSA 4096-bit key exchange) is CPU-intensive and can block the event loop for 50-200ms per connection. With 50 servers reconnecting simultaneously on a collection cycle, the event loop is blocked for 2.5-10 seconds. During this time, the platform's HTTP server cannot respond to requests, alert evaluation is delayed, WebSocket heartbeats time out, and the platform appears unresponsive. In extreme cases, the health check endpoint times out and supervisors (PM2, Docker healthcheck) restart the process.

**Why it happens:**
The ssh2 library's crypto operations run synchronously in the main thread (Node.js does not offload crypto to a thread pool by default for all operations, especially the OpenSSL key exchange). The developer sees that ssh2 is "async" (use of callbacks/promises) and assumes it doesn't block the event loop. The existing DB metric collection uses a connection pool that holds persistent connections, so there's no reconnect overhead per cycle. SSH connections are brand new each cycle, so the overhead is dramatically higher.

**How to avoid:**
- **Connection reuse**: Hold persistent SSH connections per server (with keepalive). Do not reconnect every collection cycle. The existing DB collector model (persistent pool connections) is the right pattern — replicate it for SSH.
- **Staggered collection**: Do not start all SSH connections simultaneously. Use a semaphore (e.g., `async-sema`) limited to 5-10 concurrent SSH connections. The existing `monitor-collector` has a 5-second heartbeat — use it to distribute collection across the cycle window.
- **Worker thread for heavy collections**: If reconnection is unavoidable (e.g., after network partition), consider offloading the reconnect + key exchange to a `worker_threads` sub-process. This is overkill for most cases but essential if managing 200+ servers.
- **Monitor event loop lag**: Add a metric for event loop delay (via `monitorEventLoopDelay` from Node.js `perf_hooks`). Alert if it exceeds 1000ms during collection cycles.
- **Set collection jitter**: Each server's first collection should be randomized within the collection window to prevent thundering herd of key exchanges.

**Warning signs:**
- HTTP API latency spikes during collection cycles.
- WebSocket disconnections during the "top of the minute" (when all cron jobs run simultaneously).
- Health check endpoint sometimes returns 503 during collection.
- Event loop lag metrics showing >1000ms during collection.

**Phase to address:**
Phase "SSH Metric Collection Engine" — the connection reuse strategy directly determines whether event loop blocking is a problem at scale. Must be designed upfront.

---

### Pitfall 6: Creating a Parallel Monitoring System Instead of Extending the Existing One

**What goes wrong:**
Server monitoring is implemented as a separate, parallel system — its own scheduler, its own metric storage model, its own alert rules engine, its own notification dispatch, and its own frontend that doesn't share components with the existing DB monitoring views. This doubles the maintenance burden and creates inconsistency: server alert rules are configured differently than DB alert rules, server metrics are queried differently in the frontend, and the "unified view" of all monitored resources never materializes.

**Why it happens:**
The existing platform's scheduling system (`monitor-collector.ts` + `unifiedCollector`) and alert engine are designed around database instances. The team assumes they need to build a separate system because "SSH servers are different from databases." In reality, 80% of the infrastructure is identical: periodic metric collection, threshold evaluation, alert creation, notification dispatch. The temptation to build a clean new system rather than fitting into the existing one is strong — the new system feels simpler because it doesn't have to accommodate the existing quirks.

**How to avoid:**
- Extend `collector.ts` / `MonitorCollector` to accept a second `collectable` type (servers alongside database instances). The heartbeat scheduler should schedule both DB and server metrics.
- Reuse the `metrics_history` table by adding an optional `server_id` foreign key (alongside the existing `instance_id`). Keep the same metric names for comparable metrics (`cpu_usage`, `memory_usage`, `disk_usage`).
- Add server-specific metric names prefixed with `server_` for clarity (`server_cpu_usage`, `server_disk_io_wait`).
- Reuse the `alert_rules` table with a new `target_type` column: `'database' | 'server'` to distinguish alert scopes. The `alert-evaluator.ts` already handles `evaluateRule()` generically.
- Reuse `notification-service.ts` and `alert-event-service.ts` unchanged — notifications don't care where the metric came from.
- Add a new provider type (SSH provider) to the `collectorRegistry` alongside the existing `mysql.provider.ts`, `postgresql.provider.ts`, etc. Follow the `MetricProvider` interface pattern from `base-provider.ts`.

**Warning signs:**
- Architecture document or plan that describes a "separate server monitoring engine" or "server alert system" rather than extending the existing one.
- New database tables that re-invent `metrics_history`, `alert_rules`, or `alerts`.
- The team creates a separate frontend component for server monitoring charts instead of reusing the existing ECharts-based metric dashboard.
- "It would be cleaner to build it fresh" appears in design discussions — this is almost always the wrong call for an existing platform.

**Phase to address:**
Phase "Architecture Planning" — before any code is written, the integration model must be decided. This decision affects ALL subsequent phases.

---

### Pitfall 7: Connection Test Works But Periodic Collection Fails

**What goes wrong:**
The server registration flow includes a "Test Connection" button that successfully connects via SSH, authenticates, runs a simple command (like `hostname` or `uptime`), and returns success. The server is registered as "Connected." But when periodic collection starts, every single metric fails with `ETIMEDOUT`, authentication errors, or "command not found" — because the test connection used a different authentication method, a different command, or bypassed a restriction that production collection hits.

**Why it happens:**
The test connection and the periodic collection use different code paths:
- Test connection uses the admin user's SSH key (via agent forwarding)
- Periodic collection uses the stored private key (which may be incorrect or passphrase-protected)
- Test connection runs `echo success` (available everywhere)
- Periodic collection runs `cat /proc/stat` (which may be restricted by SELinux, AppArmor, or `restricted shell` environments)
- Test connection runs on the API server's local network
- Periodic collection runs on a container with different DNS resolution or network ACLs

**How to avoid:**
- Make the "Test Connection" button execute the SAME code path as periodic collection. Specifically, it should:
  1. Retrieve the stored credential from the database (not prompt for a new one)
  2. Call the EXACT same connect() parameters as the collector
  3. Run a representative command from the metric set (e.g., `cat /proc/stat` instead of `echo success`)
  4. Return the list of metrics it could collect, not just "connection OK"
- Add a mandatory "dry run" step after server registration: a full collection cycle that runs all metrics and reports which ones succeeded and which failed, with error messages for each failure.
- Distinguish "connection status" from "collection status" in the UI: a server can be "connected" (SSH auth works) but "unhealthy" (metrics consistently fail).
- For each metric, implement a "readiness probe" that verifies the specific command or file path is available on the target system.

**Warning signs:**
- "Test Connection" is quick but uses a different code path than collection.
- Test connection only tests SSH connectivity, not the actual metric commands.
- A server shows as "online" but produces no metrics.
- No visible distinction between "connection failed" and "collection failed" error states.

**Phase to address:**
Phase "Server Registration & Credential Management" — the test connection flow must be designed to use the same code path as production collection.

---

### Pitfall 8: One Server Connects, But 100 Servers Crash — No Concurrency Throttling

**What goes wrong:**
The SSH collector works perfectly with 1-5 servers during development. When deployed with 100 servers, the platform starts failing unpredictably:
- Some servers return `ETIMEDOUT` (OS connection queue saturated)
- The API server becomes unresponsive (too many concurrent crypto operations on the event loop)
- Existing database metric collection starts failing (the SSH collectors consumed all available resources)
- Remote SSH servers refuse connections (the platform opened 100 simultaneous SSH connections from the same IP)

**Why it happens:**
The collector was tested with a few servers and no concurrency limit. The developer assumed SSH connections are like HTTP connections (which Node.js handles well concurrently). But SSH key exchange is significantly more expensive than HTTP:
- Each key exchange does asymmetric crypto (CPU-bound)
- Each connection involves a TCP handshake + SSH version exchange + key exchange + authentication (multiple round trips, latency-bound)
- The combination of CPU-bound crypto and I/O-bound connection setup means the operation can't be parallelized efficiently
- Node.js doesn't have a built-in semaphore; the developer must explicitly implement concurrency limiting

**How to avoid:**
- Implement a **global semaphore** (e.g., `async-sema` library) that limits concurrent SSH operations across ALL servers. Start with `maxConcurrentSsh: 10` and tune based on event loop lag.
- Implement a **per-host semaphore** limited to 3 concurrent channels (matching SSH default `MaxSessions`).
- Use staggered scheduling: distribute server collection across the full collection interval, not all at the same second. The existing `MonitorCollector.heartbeatMs = 10000` provides natural staggering.
- Test with at least 50 simulated servers before shipping. Use a test harness that runs local SSH daemons (e.g., `sshd` on high-numbered ports) to simulate load.
- If the platform uses multiple worker processes (PM2 cluster mode), ensure SSH semaphores are scoped per-worker or use a shared Redis-based semaphore.

**Warning signs:**
- `ssh2.Client.connect()` calls all metrics in a synchronous `for` loop with no concurrency limiting.
- No semaphore or concurrency limiter in the SSH collector.
- Testing with only 1-2 servers.
- No `EventLoopUtilization` metrics being collected.

**Phase to address:**
Phase "SSH Metric Collection Engine" — the concurrency model (semaphore, semaphore scoping, staggering) must be part of the initial collector design.

---

### Pitfall 9: Not Handling SSH Connection Failures at Scale (Transient Errors vs Permanent Failure)

**What goes wrong:**
When 1 out of 100 servers has a transient SSH failure (temporary network issue, SSH daemon restart, key rotation in progress), the collector either:
1. Treats it as a permanent failure, disables monitoring and fires a P0 alert
2. Ignores it silently, leaving the operator unaware their server is unmonitored
3. Retries aggressively, causing a thundering herd of reconnection attempts that amplify the problem

**Why it happens:**
The existing DB collector pattern has a "3 consecutive failures disables the provider" rule (D-13). This makes sense for DB providers where a failure means the database configuration is wrong. For SSH, failures are often transient (network blips, SSH daemon restarting, DNS resolution timing out) and disabling monitoring after 3 failures means the server goes dark during a real incident because the network is flaky — exactly when monitoring is most needed.

**How to avoid:**
- Differentiate failure types: `ETIMEDOUT` (network issue) vs `ERR_SSH_AUTH` (credential issue) vs `EHOSTUNREACH` (server down). Network errors should backoff and retry; auth errors should alert immediately.
- Implement exponential backoff: wait 30s, 2min, 5min, 15min between retries. After 5 consecutive failures of the same type, fire a "Server Unreachable" alert but keep retrying at 15-minute intervals.
- Do NOT disable metric collection for a server due to SSH failures. Keep the server's metric schedule active; just skip and retry the failed collection.
- Add a "last successful collection" timestamp to the server record. Alert if it exceeds 2x the collection interval (e.g., if metrics are collected every 60s, alert after 120s without success).
- When a server recovers, detect the gap and backfill if possible (some metrics like disk usage can be corrected on recovery; CPU utilization over the gap is lost).

**Warning signs:**
- The existing "3 consecutive failures disables provider" pattern is used directly for SSH without modification.
- No distinction between network errors, auth errors, and command errors.
- No server-level "last successful collection" timestamp.
- Retry logic that retries immediately (no backoff) or retries indefinitely.

**Phase to address:**
Phase "SSH Metric Collection Engine" — the failure handling strategy is part of the collector design.

---

### Pitfall 10: Over-Engineering the Server Model with Unnecessary Abstraction

**What goes wrong:**
Instead of adding a simple `servers` table that mirrors existing `database_instances`, the team builds a generic "Resource" abstraction layer to support "any type of monitored resource." This adds weeks of development time, introduces abstraction bugs, and the generic layer never gets used for anything beyond SSH servers. The existing `database_instances` table has worked well for DB monitoring; the server model should follow the same pattern, not introduce a new paradigm.

**Why it happens:**
The developer sees that databases and servers share some attributes (host, port, credentials, status) and decides to extract a common "monitored resource" base class or table. This is a classic "premature generalization" — the abstraction solves a future problem that may never materialize. The existing `database_instances` table is concrete and works; adding a similar `servers` table with server-specific columns is faster, simpler, and easier to maintain.

**How to avoid:**
- Start with a concrete `servers` table that mirrors `database_instances` structure:
  ```sql
  CREATE TABLE servers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    host VARCHAR(255) NOT NULL,
    port INT DEFAULT 22,
    username VARCHAR(255) NOT NULL,
    auth_method ENUM('password', 'key') DEFAULT 'key',
    credential_id INT REFERENCES server_credentials(id),
    os_type VARCHAR(50),
    tags JSON,
    status ENUM('active', 'inactive', 'error') DEFAULT 'active',
    health_score DECIMAL(5,2) DEFAULT 100.00,
    health_status ENUM('healthy', 'warning', 'critical', 'unknown') DEFAULT 'unknown',
    last_collected_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
  ```
- If future generalization is needed, extract the shared interface after 2+ concrete implementations exist. Not before.
- Reuse the existing `DatabaseInstance` pattern in code. Create a `ServerInstance` interface that mirrors `DatabaseInstance`, not a generic `MonitoredTarget<SpecificFields>`.
- The SSR details port (22 vs custom), auth method (key vs password), and OS type are server-specific fields that don't fit databases. Accept that they're different and model them separately.

**Warning signs:**
- Planning documents discussing "abstract resource model" or "generic monitoring target" or "unified resource abstraction."
- Feature creep: "While we're at it, we can model network devices and storage arrays too."
- The table design has a `resource_type` ENUM and a generic `connection_config` JSON column instead of concrete columns.
- Design discussions that last more than one session about table structure.

**Phase to address:**
Phase "Architecture Planning" — the server model decision (concrete vs abstract) must be made before any schema or code is written. The FEATURES.md research already advocates for the concrete approach.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store all server metrics in a generic JSON blob instead of typed columns | Fast schema iteration, no schema migrations | Can't query by metric value, no indexing, slow trend views, harder to join with alert rules | Never — the existing `metrics_history` pattern already solves this with typed columns |
| Disable host key verification (hostVerifier = noop) | No first-connect UI needed, all servers connect on first try | MITM attacks possible, no tamper detection, compliance violation (PCI-DSS, SOC2) | Only in isolated dev environments with non-production servers |
| Same SSH connection for all metrics, no pooling | Simple code, easy to understand | If connection drops mid-cycle, partial metrics are lost and harder to attribute | Acceptable temporarily in MVP if documented as tech debt, must fix before v0.8 ships |
| Use shell commands ("top -bn1", "df -h") instead of SFTP /proc reads | Faster to prototype, works on most systems | Brittle across distros, locale issues, shell injection risk, no error locality | Only for metrics that have NO /proc alternative (e.g., network metrics that need `ss -s` or `/proc/net/dev`) |
| SSH password authentication instead of key-based | Password can re-use existing database credential storage pattern | Exposed if DB leaked, no key rotation support, weaker against brute force, harder to audit | Never for production; acceptable only for dev/test servers with non-sensitive data |
| Collection via `exec()` with `sudo` to read privileged metrics | Allows collecting any metric without managing SSH user permissions | sudo escalation is a critical security boundary, sudo failures break collection, audit trail lost | Use `ssh user@host command` with proper sshd_config `Match` rules instead of sudo |
| Alert rules for server metrics via independent cron (not the existing alert engine) | Faster initial implementation, no risk of breaking existing alert engine | Two alert systems to maintain, inconsistent user experience for threshold configuration | Never — the existing alert engine is designed for extensibility |
| Single-server test as "proof of concept" | Quick validation, demo works | Hides all scale-related issues: pool exhaustion, event loop blocking, concurrency limits, parsing variance | Acceptable only in the earliest prototyping phase, must be followed by multi-server test |
| Hardcoded metric list in the provider code | No need for metric_registry integration | Cannot add/remove server metrics without code changes, no per-server customization | Acceptable temporarily in MVP; must integrate with `metricRegistry` before general availability |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| **ssh2 library** | Only attaching `error` listener, not `close` and `end` listeners | Attach ALL lifecycle listeners: `error`, `close`, `end`, `handshake`, `ready`. The `close` event is the only reliable signal the connection is fully cleaned up. |
| **ssh2 exec()** | Assuming `exit` event always fires | The SSH2 spec says `exit` is optional. Always also listen for `close` on the channel. The `close` event is guaranteed. |
| **SSH keepalive** | Not configuring `keepaliveInterval` | Default is off. Without keepalive, idle connections are never detected as dead until the next `exec()` attempt. Set `keepaliveInterval: 60000` and `keepaliveCountMax: 3`. |
| **SFTP vs exec** | Using exec for everything because it resembles local shell scripting | SFTP (via `client.sftp()`) is superior for file reads: no shell injection risk, no locale issues, no parsing of stdout. Use SFTP for `/proc` and `/sys` file reads; use `exec()` only for commands like `ss -s` or `uptime`. |
| **Existing metricRegistry** | Creating a separate metric definition system for server metrics | Add server metrics to the existing `metric_registry` table with a new `target_type: 'server'` filter. The `metric-registry.ts` already supports filtering by `getByDbType()`. |
| **Existing alert_rules** | Creating a separate alert rule model for servers | Add a `target_type` column to `alert_rules` (default `'database'`). The existing alert evaluator's `evaluateRule()` is metric-value-agnostic and works with any numeric value. |
| **Existing notification-service** | Building a separate notification dispatch for server alerts | Notifications don't differentiate by metric source. Reuse `notification-service.ts` unchanged. |
| **Existing auth middleware** | Building separate permission model for server management | Reuse `requireRole('admin')` for server CRUD, reuse `requirePermission('alert:view')` for alert viewing. Add `requirePermission('server:view')` and `requirePermission('server:manage')` permissions. |
| **Frontend ECharts components** | Building new chart components for server metrics | The existing dashboard components (ECharts time-series charts, stat tiles, data tables) are metric-name-driven. Server metrics with the same names (`cpu_usage`, `disk_usage`) will render in the existing charts automatically. |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| **Reconnecting every collection cycle** | Event loop delay > 1000ms, HTTP timeouts during collect, SSH `ETIMEDOUT` errors | Hold persistent SSH connections per server, use keepalive to detect dead connections | 10-20 concurrent servers |
| **No concurrency limit on SSH operations** | Socket exhaustion, remote SSH daemon refuses new connections after `MaxSessions` limit | Global semaphore (limit 10 concurrent) and per-host semaphore (limit 3) | 30-50 concurrent servers |
| **Heavy shell pipelines in exec()** | Command takes 1-3 seconds per execution, collection cycle time exceeds interval | Use SFTP for file reads, or compound commands (`LANG=C free -b` instead of `cat /proc/meminfo | grep ... | awk ...`) | Variable — CPU parsing overhead grows with metric count |
| **Collection all servers at exactly the same time (no jitter)** | Key exchange thundering herd, all servers respond with delay simultaneously, platform appears down | Randomize each server's first collection offset within the heartbeat window | 10+ servers starting collection simultaneously |
| **Collecting all metrics every cycle** | Collection cycle takes longer than interval (seconds), metrics get stale | Heartbeat-based scheduling (existing pattern in `monitor-collector.ts`): check which metrics are due, collect only those | When every metric's collection time × metric count > collection interval |
| **Parsing metric output on every collection** | Repeated `parseInt()` / `parseFloat()` on SSH stdout is CPU-intensive for 100 metrics × 100 servers | Cache heavy parsing results, use typed columns in `metrics_history` instead of JSON, batch metric writes | 5000+ metric values per collection cycle |
| **Writing each metric to DB individually** | 100 servers × 10 metrics = 1000 DB writes per cycle, overwhelming MySQL | Batch metric writes — collect all metrics in memory, INSERT with multi-value `VALUES (..),(..)`. The existing `metrics-database-service` may already support batch operations. | 50+ servers or 5+ metrics per server |
| **SSH credential decryption for each connection attempt** | `decryptData()` on every retry adds latency to already-hot retry loops | Decrypt credential once per connection pool startup, cache in memory for the pool's lifetime | When retry frequency increases during network issues |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| **Storing SSH private keys in plaintext** (encrypted or not) in same table as server metadata | SQL injection or DB snapshot leads to total compromise of all monitored servers | Store credentials in a separate table with column-level encryption. The existing `encryptData()` / `decryptData()` pattern is acceptable but verify key derivation strength. |
| **No host key verification** (`hostVerifier` not set — ssh2 auto-accepts) | MITM attack — attacker on same network can intercept SSH connections, steal server credentials, and return fake metrics | Always set `hostVerifier` + `hostHash: 'sha256'`. Store accepted keys in `server_known_hosts` table. |
| **Using SSH password instead of key-based auth** | Password stored encrypted but is still weaker than key auth. If password is compromised, it can be used from any machine without the key file. | Prefer SSH key authentication (ED25519). Only accept password auth for servers that explicitly cannot use keys, and log a security warning. |
| **Allowing root/sudo-level SSH access for monitoring** | If platform is compromised, attacker has full root access to ALL monitored servers | Create a dedicated `slide_monitor` user on each server with a restricted shell and read-only file access. Use `sudo` only for specific metrics via `sudo -l` whitelist, not blanket sudo access. |
| **Exposing credentials in error messages or logs** | SSH connection errors often include the full connect configuration object, which includes the private key or password | Before logging any SSH error, sanitize the error object to remove `privateKey`, `password`, and `passphrase` fields. Use a custom error serializer. |
| **SSH key reuse across environments** | Compromise of dev environment's SSH keys grants access to production servers | Use separate SSH key pairs per environment (dev/staging/production). Store them in environment-specific secret storage. |
| **No SSH key rotation policy** | Keys that have been compromised are never discovered or rotated. Long-lived keys increase exposure window. | Implement a key rotation endpoint. Alert on keys older than 90 days. Generate new key pairs server-side and upload via authorized_keys API. |
| **Ignoring `known_hosts` changes** | A changed host key could indicate a legitimate server reinstall OR a MITM attack. Silent acceptance of new keys hides both. | When host key changes, fire a P1 alert. Do not auto-accept. Require admin acknowledgment of key change. |
| **Forwarding SSH Agent** | Using `agent: process.env.SSH_AUTH_SOCK` forwards the local SSH agent to remote hosts, enabling lateral movement | Never set `agent` in the Node.js ssh2 Client config for automation. Only set `privateKey`. |
| **Logging SSH commands and output without sanitization** | Commands may contain arguments with sensitive data (e.g., passwords in environment variables) | Implement a command whitelist. Never log the full stdout of arbitrary commands. Sanitize before persisting. |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| **"Test Connection" only checks connectivity, not metric collection** | User sees green checkmark, server is "connected," but no metrics appear. User assumes platform is broken. | Make "Test Connection" run a full dry-run collection with per-metric success/failure results. Show which STDOUT/STDERR for each failed metric. |
| **No server grouping / tagging** | With 50+ servers, the server list is unmanageable without filtering. Users cannot group by environment, role, or region. | Reuse the existing `tags` JSON column pattern from `database_instances`. Add tag filtering to the server list view from day one. |
| **Per-server metric customization not available** | Users want different metrics / intervals for different server types (web servers vs DB servers vs cache servers), but the configuration is global. | Make metric sets configurable per-server via tags. `tags.role === 'database'` gets disk and memory; `tags.role === 'web'` gets CPU, network, and process count. |
| **Alert threshold applied globally** | A 90% CPU alert threshold works for a 2-core dev server but triggers constant false alerts for a 64-core production server. | Support per-server alert threshold overrides in `alert_rules`. The existing `resolveMacrosForRule()` pattern already supports this via instance-level macros. |
| **No acknowledgment of network latency impact** | SSH commands take 2-5 seconds on high-latency links (monitoring across data centers), causing collection timeouts and stale data. | Implement a latency-aware timeout: `readyTimeout: Math.max(10000, hostLatency * 3)`. Measure and display host latency in the UI. |
| **Metric chart shows gaps without explanation** | When SSH connection fails during a collection cycle, the chart shows a flat gap. User doesn't know if server was down or just collection failed. | Show "collection gap" annotations on metric charts. Add a collection status indicator per metric (last success, last failure, failure count). |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Server Registration:** Server is saved to DB, appears in list, shows "Connected" status, BUT there is no corresponding `server_known_hosts` entry and the `hostVerifier` is not set — connection auto-accepts any host key.
- [ ] **Test Connection:** Returns "Connection successful" from `hostname` command, BUT the connection was established with a different credential than the stored one (e.g., user's SSH agent, not the stored private key). Verify the test connection retrieves the credential from the database.
- [ ] **Metric Collection** (single server): CPU, memory, disk values show 42%, 67%, 34% on Ubuntu 22.04, BUT on CentOS 7, CPU is always 0 and disk is NaN. Verify collection against at least 3 different distros.
- [ ] **Multiple Servers:** 5 servers all collect and show metrics, BUT at 10 servers the API starts timing out and at 20 servers SSH connections start failing. Verify event loop lag and file descriptor limits at target scale.
- [ ] **Alert Rules:** Server alert rules are created in the database and appear in the alert list, BUT the `alert-engine.ts` cron job doesn't evaluate them because it only queries rules with `target_type = 'database'` (hardcoded filter). Verify alert rules for servers are evaluated.
- [ ] **Metric Trends:** Server metric trend charts render correctly, BUT they use a different frontend component than the DB metric charts, creating visual inconsistency, code duplication, and higher maintenance burden. Verify charts reuse the existing ECharts components.
- [ ] **SSH Key Authentication:** Private key connection works in the "Test Connection" flow, BUT period collection never recovers `ECONNRESET` errors on long-lived connections because there's no keepalive configured. Verify `keepaliveInterval` and `keepaliveCountMax` are configured.
- [ ] **SSH Connection Pool:** The pool opens and reuses connections correctly, BUT only one connection is ever created per server. When an `exec()` call takes 60 seconds to complete (slow command on remote host), no other metrics can be collected for that server during that time. Verify the pool supports at least 2-3 concurrent channels per server.
- [ ] **Server Health Report:** Report generates PDF with server metrics, BUT the page footer still says "Database Health Report" and the logo references "DB Ops Platform." Verify all templates are generalized.
- [ ] **Agent Integration:** The AI Chat agent can "query server metrics," BUT the tool is implemented as a generic SQL query against `metrics_history` and the agent has no awareness of what server-specific metrics exist or what they mean. Verify agent tools have server-specific descriptions and context.
- [ ] **Performance Dashboard:** The main dashboard shows server metrics, BUT it's loading all historical metric data for every server (instead of aggregating) and the page takes 30+ seconds to load. Verify dashboard queries use time-bucketed aggregation for trend views.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| **SSH private key compromise** | HIGH — requires key rotation on ALL affected servers | 1. Revoke compromised key on each server (remove from `~/.ssh/authorized_keys`)<br>2. Generate new key pair<br>3. Upload public key to all servers<br>4. Update stored private key in platform<br>5. Rotate database encryption key if stored credentials were exposed |
| **Host key verification bypass allowed MITM** | CRITICAL — incident response required | 1. Rotate ALL SSH credentials (keys and passwords)<br>2. Audit all metric data collected during exposure window for tampering<br>3. Harden all servers (disallow password auth, restrict access to monitoring IPs)<br>4. Add host key verification post-deployment |
| **SSH connection pool leak (zombie connections)** | MEDIUM — may require process restart | 1. Restart the process to close all stale sockets<br>2. Add monitoring of open file descriptors<br>3. Add a scheduled pool health check that force-kills connections idle for >5 minutes<br>4. Reduce pool TTL as immediate mitigation |
| **Collecting garbage metrics (parsing failures)** | LOW — metric values are overwritten on next cycle | 1. Set invalid metric values to `null` instead of `0` so they don't trigger false alerts<br>2. Add a metric validation step (e.g., reject CPU > 100 or disk < 0)<br>3. Implement the fallback command chain |
| **All metric collection failing** | HIGH — platform loses visibility into all servers | 1. Check if SSH daemon on remote servers is reachable (port 22)<br>2. Check if platform's network connectivity to servers is intact<br>3. Check if the stored credentials are still valid (key rotation happened without updating platform)<br>4. Check if the SSH connection pool has a deadlock (all channels in use, none releasing)<br>5. As a temporary measure, consider stateless reconnection with a retry backoff |
| **Alert engine not evaluating server rules** | MEDIUM — alerts are not firing for server issues | 1. Check `target_type` filter in `alert-engine.ts`<br>2. Add missing filter support<br>3. Create manual alert for any unresolved server health issues<br>4. Verify fix by running a manual alert evaluation cycle |
| **False alerts from metric parsing errors** | MEDIUM — operators stop trusting alerts | 1. Implement metric validation (min/max thresholds at collection time)<br>2. Add a "stale data" filter — don't alert on metrics older than 2x the collection interval<br>3. Add a metric quality score to alert provenance |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| **Host Key Verification Bypass** (Pitfall 1) | SSH Connection Security | Audit all `ssh2.Client.connect()` calls in the codebase — every one must have a `hostVerifier`. |
| **Plaintext SSH Key Storage** (Pitfall 2) | Server Registration & Credential Management | Verify `server_credentials` table stores encrypted values. Verify no log statement can leak `privateKey` or `password`. |
| **Connection Pool Exhaustion** (Pitfall 3) | SSH Metric Collection Engine | Run 10+ concurrent servers in integration test. Verify `process.resourceUsage()` file descriptor count is stable after 100 collections. |
| **Parsing Fragility** (Pitfall 4) | SSH Metric Collection Engine | Unit test against fixture files from Ubuntu 20.04, 22.04, CentOS 7, 8, Alpine 3.18. Verify `LANG=C LC_ALL=C` prefix on all `exec()` commands. |
| **Event Loop Blocking** (Pitfall 5) | SSH Metric Collection Engine | Run `perf_hooks.monitorEventLoopDelay()` during collection. Verify lag < 100ms for 20 concurrent servers. |
| **Parallel Monitoring System** (Pitfall 6) | Architecture Planning | Code review: verify server monitoring reuses `MonitorCollector`, `metrics_history`, `alert_rules`, `notification-service`. |
| **Test vs. Prod Collection Discrepancy** (Pitfall 7) | Server Registration & Credential Management | Verify "Test Connection" uses the same credential retrieval and same `connect()` parameters as periodic collection. |
| **Concurrency Meltdown at Scale** (Pitfall 8) | SSH Metric Collection Engine | Load test with 50 simulated servers. Verify all connections succeed and event loop stays responsive. |
| **Failure Response at Scale** (Pitfall 9) | SSH Metric Collection Engine | Test scenarios: 5 servers unreachable, 1 server has wrong credentials, 1 server has network blip. Verify correct per-type handling. |
| **Over-Engineering Server Model** (Pitfall 10) | Architecture Planning | Code review: verify `servers` table is concrete (not a generic "resource" table). Verify no abstract MonitoredTarget or similar wrapper. |
| **`exec()` output locale issue** | SSH Metric Collection Engine | Search for all `exec()` calls and verify `LANG=C LC_ALL=C` prefix on each. |
| **No SSH key rotation** | Security Hardening | Verify `POST /api/servers/:id/rotate-key` endpoint exists. Verify key age is tracked and key expiry alerts are configured. |
| **Credential logged in error messages** | Security Hardening | Inject an intentional SSH connection error and verify error message does NOT contain `privateKey`, `password`, or `passphrase`. |
| **Separate metric definitions for server metrics** | Metric Registry Integration | Verify `metric_registry` table has entries for server metrics. Verify `getByDbType('server')` or equivalent filter returns them. |
| **Separate alert configuration for server alerts** | Alert Integration | Verify `alert_rules` table's `target_type` column works. Verify `AlertEngine.evaluateAndCreateAlerts()` evaluates server rules. |
| **Batch metric writes** | Metric Registry Integration | Verify `metrics-database-service.ts` batch INSERT is used for server metrics. Verify DB write count per collection cycle is stable. |
| **Event loop / file descriptor monitoring** | Platform Hardening | Verify `monitor-event-loop.ts` or equivalent exists. Verify alert fires when event loop lag > 1000ms or FD count > 80% of limit. |

---

## Sources

- **ssh2 library documentation** — `github.com/mscdex/ssh2` (connection lifecycle, host verification behavior, channel events)
- **Mozilla SSH Guidelines** — `infosec.mozilla.org/guidelines/openssh` (key management best practices for automation)
- **ssh2 GitHub Issues** — Common bugs: missing `close` event listener (#610), algorithm negotiation (#841), error propagation patterns
- **ssh2 README** — Security section: `hostVerifier` auto-accept warning, timing-safe comparison guidance
- **Existing Slide Platform Codebase** — `monitor-collector.ts`, `unifiedCollector.ts`, `base-provider.ts`, `alert-engine.ts`, `alert-evaluator.ts`, `instance-database-service.ts` (patterns to extend vs. replace)
- **Slide FEATURES.md Research** — `.planning/research/FEATURES.md` (feature scope and integration points for v0.8 server monitoring)
- **Slide PROJECT.md** — `.planning/PROJECT.md` (current architecture, existing monitoring patterns, milestone context)

---
*Pitfalls research for: SSH-based Server Monitoring (no-agent, via Node.js ssh2) on existing DB Ops Platform*
*Researched: 2026-07-07*
