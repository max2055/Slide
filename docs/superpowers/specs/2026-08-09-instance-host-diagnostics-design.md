# Instance-Host Diagnostics Design

## Goal

Connect managed database instances to managed Linux servers so database diagnostics can correlate database evidence with operating-system metrics, logs, filesystems, and physical database files.

## Scope

- Linux only: RHEL 7/8 and compatible distributions.
- One database instance may run on multiple servers.
- Cloud or otherwise host-inaccessible databases may remain unbound and must report unavailable capabilities explicitly.
- All host evidence collection is read-only, bounded, redacted, timed out, and audited through existing server credentials and target policy.
- Windows Server and non-Linux collection are out of scope.

## Architecture

The existing `resource_relations` table remains the source of truth. The canonical edge is `instance --runs_on--> server`; inverse `hosts` views are computed and never duplicated. A focused instance-host service adds topology validation, active-edge uniqueness, replacement/expiry semantics, authorization, and enriched summaries around the generic relation store.

The diagnostic path does not give a detached background Agent arbitrary SSH tools. An `InstanceDiagnosticContextService` collects a typed evidence pack before LLM invocation. It combines existing database metrics, alerts, and logs with evidence from every authorized related server. The LLM receives the evidence pack and can only persist its structured analysis result.

Linux evidence uses fixed command templates executed through the existing SSH session pool:

- host metrics: CPU, memory, load, uptime;
- filesystems: mount, total, used, available, utilization, inode utilization;
- system logs: bounded `journalctl` queries for known database services and kernel storage/OOM events;
- physical files: database-specific SQL discovers paths, then safe host-side `stat`, `df`, and bounded `du` inspect only those discovered absolute paths.

## Relationship Contract

- Canonical type: source `instance`, target `server`, relation `runs_on`.
- Multiple active servers per instance are allowed.
- Active duplicate edges are rejected.
- Relation writes require manage access to both resources.
- Relation reads only return related resources the actor can read.
- Unlinking expires the relation instead of deleting history.
- Server deletion is blocked while it has active instance relations.
- Optional metadata records node role (`standalone`, `primary`, `replica`, `shard`, `arbiter`, `unknown`) and operator notes.
- Hostname/IP similarity may be returned as a candidate but never creates a relation automatically.

## API

- `GET /api/database/instances/:id/hosts`: related server summaries and evidence capability state.
- `PUT /api/database/instances/:id/hosts`: atomically replace active host mappings.
- `DELETE /api/database/instances/:id/hosts/:serverId`: expire one mapping.
- `GET /api/servers/:id/instances`: reverse database summary.
- `GET /api/database/instances/:id/host-evidence`: bounded current evidence for the UI and diagnosis.

Errors use stable codes for invalid topology, missing resources, denied access, duplicate relations, unsupported Linux capability, stale evidence, and collection timeout. Cross-resource data requires the intersection of instance access and `servers:view`; no relation grants new authority.

## Frontend

The database add/edit dialog loads managed servers and provides an optional multi-select association field with node role. Saving the instance and relationship is explicit; a partial relationship failure is surfaced rather than hidden.

The instance overview displays related hosts with status and latest CPU, memory, and filesystem utilization, plus a host evidence section for logs and physical files. The server detail displays hosted database instances. Empty, unavailable, stale, and permission-denied states are distinct.

## Diagnostics

Manual diagnosis carries the authenticated actor into context collection. Automated diagnosis uses the existing explicit read-only system identity. The evidence pack contains values, timestamps, source, quality, and missing reasons. Analysis prompts must cite evidence references and must not claim host conclusions when no current authorized host evidence exists.

## Security

- No arbitrary shell command or arbitrary path parameter is exposed to the browser or model.
- Commands use constant templates; dynamic values are validated against allowlists and shell-quoted.
- Log windows, line counts, output bytes, path counts, and command duration are bounded.
- Secrets and credential payloads never enter evidence.
- Log output passes existing redaction before persistence or LLM use.
- SSH host-key verification and outbound target policy remain mandatory.

## Verification

- Migration and relation-service tests cover topology, uniqueness, expiry, cleanup, and permissions.
- Linux parser/command tests cover RHEL 7/8-compatible output and hostile path/service inputs.
- Diagnostic tests prove both database and host evidence are supplied, and missing/denied host evidence degrades explicitly.
- API tests cover both directions and RBAC.
- Frontend tests cover association save/load, reverse display, and empty/error states.
- Full backend/frontend tests, type checks, builds, live API health, and Playwright desktop/mobile flows must pass.

