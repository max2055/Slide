# Instance-Host Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect database instances to Linux hosts and make host metrics, logs, filesystems, and physical files available to safe database diagnostics.

**Architecture:** Keep `resource_relations` as the temporal graph and add a domain service for canonical instance-to-host mappings. Collect typed, bounded Linux evidence before detached Agent invocation, then expose association and evidence views through Fastify and Lit.

**Tech Stack:** TypeScript, Fastify, MySQL, ssh2, Lit 3.3, Vitest, Playwright

---

### Task 1: Relationship Schema And Domain Service

**Files:**
- Create: `apps/db-ops-api/sql/migrations/060_instance_host_relations.sql`
- Create: `apps/db-ops-api/src/resources/instance-host-service.ts`
- Create: `apps/db-ops-api/src/resources/instance-host-service.test.ts`
- Modify: `apps/db-ops-api/src/resources/types.ts`
- Modify: `apps/db-ops-api/src/resources/resource-service.ts`

- [ ] Write failing tests for canonical topology, multi-host replacement, active duplicate rejection, expiry, filtered reads, and server delete protection.
- [ ] Run `pnpm --filter slide-api exec vitest run src/resources/instance-host-service.test.ts` and confirm failures are caused by missing behavior.
- [ ] Add relation metadata/current-edge indexes and implement the minimal transactional service.
- [ ] Re-run the focused tests and existing resource tests until green.

### Task 2: Relationship APIs And Contracts

**Files:**
- Create: `apps/db-ops-api/src/instance-host-routes.test.ts`
- Modify: `apps/db-ops-api/server.ts`
- Modify: `apps/db-ops-api/src/server-database-service.ts`
- Modify: `apps/db-ops-api/src/contracts/public-api.ts`
- Regenerate: `frontend/src/api/generated/public-api.ts`

- [ ] Write failing route contract tests for instance hosts, replacement, unlink, reverse server instances, invalid payloads, and RBAC.
- [ ] Run the focused route tests and confirm expected failures.
- [ ] Register domain routes, preserve not-found authorization behavior, and block deletion of actively linked servers.
- [ ] Regenerate contracts and run contract checks.

### Task 3: Linux Host Evidence

**Files:**
- Create: `apps/db-ops-api/src/linux-host-evidence-service.ts`
- Create: `apps/db-ops-api/src/linux-host-evidence-service.test.ts`
- Modify: `apps/db-ops-api/src/ssh-session-pool.ts`
- Modify: `apps/db-ops-api/src/server-collector.ts`

- [ ] Write failing tests with representative RHEL 7/8 `df`, `journalctl`, `stat`, and inode output plus hostile input cases.
- [ ] Confirm RED with `pnpm --filter slide-api exec vitest run src/linux-host-evidence-service.test.ts`.
- [ ] Implement fixed-command filesystem and journal collection with strict service/path validation, time/output bounds, redaction, and typed quality reasons.
- [ ] Persist richer filesystem observations without breaking existing disk percentage consumers.
- [ ] Run Linux evidence, SSH security, and server collector tests.

### Task 4: Database Storage Discovery

**Files:**
- Create: `apps/db-ops-api/src/database-storage-discovery-service.ts`
- Create: `apps/db-ops-api/src/database-storage-discovery-service.test.ts`
- Modify: `apps/db-ops-api/src/database-service.ts`

- [ ] Write failing adapter tests for MySQL, PostgreSQL, Oracle, and Dameng storage paths, unsupported adapters, path limits, and invalid paths.
- [ ] Run the focused test and confirm RED.
- [ ] Implement read-only SQL discovery and normalized physical-file descriptors.
- [ ] Correlate discovered paths with related Linux filesystems using the host evidence service.
- [ ] Run focused and database-service security tests.

### Task 5: Diagnostic Evidence Aggregation

**Files:**
- Create: `apps/db-ops-api/src/instance-diagnostic-context-service.ts`
- Create: `apps/db-ops-api/src/instance-diagnostic-context-service.test.ts`
- Modify: `apps/db-ops-api/src/fault-diagnosis-service.ts`
- Modify: `apps/db-ops-api/src/ai-agent-bridge.ts`
- Modify: `apps/db-ops-api/src/prompts/versions/fault-diagnosis-v2.md`
- Modify: `apps/db-ops-api/src/skills/generated/fault-diagnosis/SKILL.md`

- [ ] Write failing tests proving database and all authorized host evidence are aggregated with freshness and missing reasons.
- [ ] Write failing tests proving manual actor scope and automated read-only identity are enforced.
- [ ] Confirm RED with the focused diagnosis tests.
- [ ] Build the evidence pack before `invoke()`, bind it to the analysis subject, and update prompts to analyze supplied evidence rather than unavailable tools.
- [ ] Run diagnosis, bridge, policy, and DirectAdapter tests.

### Task 6: Frontend Association And Evidence UI

**Files:**
- Create: `frontend/src/app/ui/components/instance-host-field.ts`
- Create: `frontend/src/app/ui/components/instance-host-field.test.ts`
- Create: `frontend/src/app/ui/components/instance-host-summary.ts`
- Create: `frontend/src/app/ui/components/instance-host-summary.test.ts`
- Modify: `frontend/src/app/ui/views/instances-db.ts`
- Modify: `frontend/src/app/ui/components/instance-overview-tab.ts`
- Modify: `frontend/src/app/ui/views/server-detail.ts`

- [ ] Write failing component tests for load/save, multiple host roles, empty state, stale evidence, and reverse hosted-instance display.
- [ ] Run focused frontend tests and confirm RED.
- [ ] Implement reusable association field and summary using existing shared form, card, badge, empty-state, button, spacing, color, and radius conventions.
- [ ] Wire instance create/edit, detail, and server detail APIs.
- [ ] Run frontend tests, typecheck, and build.

### Task 7: End-To-End Verification

**Files:**
- Create: `frontend/e2e/instance-host-diagnostics.spec.ts`
- Modify only production/test files required by failures found during verification.

- [ ] Add an E2E flow that associates an instance, verifies both detail directions, loads evidence, and starts diagnosis.
- [ ] Run migrations and schema validation against the configured MySQL database.
- [ ] Run full backend and frontend tests, both type checks, contract check, security tests, and production build.
- [ ] Start backend and frontend, verify health, and run Playwright at desktop and mobile viewports.
- [ ] Inspect screenshots for overflow, overlap, empty states, and responsive behavior; fix and repeat until clean.

