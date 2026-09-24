# Metrics V2 Portfolio Cutover Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** Add a server-authoritative, resumable path that moves every supported managed resource to Metrics V2 and proves the platform has no remaining formal legacy metric source or legacy metric UI.

**Architecture:** A portfolio service inventories managed database, Linux server, and network-device assets from server-side tables, assigns only immutable built-in package pins that match recorded resource metadata, and reports blockers before any write. Mutating portfolio endpoints reuse `PolicyService` and `MysqlRolloutCoordinator` for each resource, require a matching inventory plan hash, stop on per-resource failures without hiding partial progress, and derive completion from persisted policy/rollout state. Resource pages remove remaining direct legacy metric reads and render only the shared semantic Metrics V2 components.

**Tech Stack:** TypeScript, Fastify, Zod, MySQL 8, Lit 3, Vitest.

---

### Task 1: Freeze portfolio inventory and package-selection behavior

**Files:**
- Create: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.test.ts`
- Create: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.ts`

- [ ] **Step 1: Write failing tests for server-side inventory and eligibility**

  Cover all three resource types, deterministic ordering, immutable pin selection (`<engine>-representative`, `linux-host`, `if-mib-basic`), unsupported database engines/versions, non-Linux hosts, disabled collection, absent credentials/capability evidence, and a stable plan hash that changes when inventory metadata changes. Assert that responses contain resource IDs and reasons but no address, username, password, community, command, SQL, or OID.

- [ ] **Step 2: Verify RED**

  Run `corepack pnpm --filter slide-api exec vitest run src/metrics-v2/rollout/portfolio.test.ts` and expect failure because `portfolio.ts` does not exist.

- [ ] **Step 3: Commit the RED checkpoint**

  Commit only the plan and failing test with `test(metrics): define portfolio cutover inventory (RED)`.

- [ ] **Step 4: Implement the inventory boundary**

  Add typed `PortfolioInventory`, `PortfolioResource`, and blocker codes. Query only server-owned resource tables and policy/rollout metadata. Normalize database engine/version and OS family through existing helpers, select pins from `createConfigurationRegistry()`, and calculate SHA-256 over the stable public plan. Do not resolve or expose secrets during inventory.

- [ ] **Step 5: Verify GREEN**

  Re-run the focused Vitest target and expect all inventory tests to pass.

### Task 2: Add resumable portfolio operations

**Files:**
- Modify: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.ts`
- Modify: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.test.ts`
- Modify: `apps/db-ops-api/src/metrics-v2/rollout/routes.ts`
- Modify: `apps/db-ops-api/src/metrics-v2/rollout/routes.test.ts`

- [ ] **Step 1: Write failing service and route tests**

  Specify `GET /api/metrics-v2/rollout/portfolio` plus fixed `POST` actions `prepare`, `shadow`, `cutover`, and `confirm`. Every write body is a strict `{ expected_plan_hash }`; unknown fields and stale hashes return 400/409 without mutations. Require platform-wide management permission, return one result row per inventory resource, and preserve explicit `blocked`, `pending`, `changed`, `already_complete`, or `failed` outcomes.

- [ ] **Step 2: Verify RED**

  Run the two focused test files and expect missing portfolio routes/service behavior.

- [ ] **Step 3: Implement operations by composing existing services**

  `prepare` publishes the selected pin only for eligible resources without a binding; existing incompatible bindings become blockers rather than being overwritten. `shadow` starts only applied prepared policies with observations. `cutover` accepts only resources whose persisted shadow gate passed, publishes the required next revision using the same pin, then calls the existing per-resource fenced CAS cutover. `confirm` confirms only fully applied resources. Process a bounded deterministic list, retain partial results for retry, and never bypass per-resource access, locking, generation, revision, or audit checks.

- [ ] **Step 4: Verify GREEN**

  Re-run the focused service/route targets and expect all tests to pass.

### Task 3: Prove portfolio state against MySQL

**Files:**
- Create: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.mysql.test.ts`
- Modify: `apps/db-ops-api/src/metrics-v2/rollout/portfolio.ts`

- [ ] **Step 1: Write a failing isolated-MySQL workflow test**

  Seed supported and unsupported managed resources. Verify that prepare/shadow/cutover/confirm survives retry, never advances unsupported resources, never marks completion while any supported resource is pending, and reports `complete=true` only after every eligible resource is V2 with equal published/applied revision and no mixed generation. Verify a concurrent or stale plan hash cannot change state.

- [ ] **Step 2: Verify RED on isolated MySQL**

  Run the target with `METRICS_V2_TEST_MYSQL_PORT=33385` against the task-owned loopback MySQL container and expect the new workflow assertions to fail before the final persistence logic exists.

- [ ] **Step 3: Implement the minimum persistence/status fixes**

  Add only the queries and state mapping required by the integration test. Do not add a second rollout table or state machine.

- [ ] **Step 4: Verify GREEN on isolated MySQL**

  Re-run the same MySQL target and expect all portfolio workflow cases to pass.

### Task 4: Remove remaining formal legacy metrics from resource pages

**Files:**
- Modify: `frontend/src/app/ui/views/instances-db.ts`
- Modify: `frontend/src/app/ui/views/servers-page.ts`
- Modify: `frontend/src/app/ui/views/network-device-detail.ts`
- Modify: `frontend/src/app/ui/views/instance-detail-metric-source.test.ts`
- Create: `frontend/src/app/ui/views/resource-lists-metric-source.test.ts`
- Modify: `frontend/src/app/ui/views/network-device-detail.test.ts`

- [ ] **Step 1: Write failing source-boundary tests**

  Assert that resource pages contain no `旧版数据`, `兼容数据`, legacy server metric summary request, legacy network metric request, or compatibility overview. Assert database/server/network metric surfaces use `resource-metrics-table` or `semantic-metrics`, preserving unknown/missing values rather than copying old fields.

- [ ] **Step 2: Verify RED**

  Run the focused frontend Vitest files and expect failures on the current legacy labels and requests.

- [ ] **Step 3: Remove legacy metric consumers**

  Remove the database size compatibility column, server CPU/memory summary fetch and dependent filters/columns, and the network-device legacy metrics overview. Keep identity, connection state, relations, collection configuration, and backup workflows unchanged. Render semantic V2 metrics for all remaining metric surfaces.

- [ ] **Step 4: Verify GREEN**

  Re-run focused frontend tests and typecheck. Confirm the longest Chinese labels fit existing shared table/dialog controls.

### Task 5: Document and validate the full candidate

**Files:**
- Modify: `docs/slide/metrics-v2/production.md`
- Modify: `docs/slide/metrics-v2/production-validation.md`
- Modify: `docs/slide/openapi.json` and generated frontend API only if the repository contract generator owns the new routes

- [ ] **Step 1: Document the portfolio sequence and completion invariant**

  Record `portfolio -> prepare -> collection/applied -> shadow -> persisted gate -> cutover -> confirm`, stale-plan recovery, partial retry, unsupported blockers, and the invariant that production is complete only when the portfolio response proves every supported managed resource is V2. Keep real production targets, physical-device validation, capacity, and rollout authorization as external acceptance gates.

- [ ] **Step 2: Run affected-module gates**

  Run rollout, policy, scheduler, consumers, resource-list, instance-detail, and network-device focused suites; then backend/frontend typechecks, contracts, qualification, secret scan, deployment security, and frontend build/CSP checks.

- [ ] **Step 3: Run one final full gate**

  Run the complete backend and frontend test suites once after the candidate stops changing. Classify environment skips separately and do not count them as production acceptance.

- [ ] **Step 4: Commit GREEN and update PR #94**

  Commit production code/tests/docs as the GREEN checkpoint, push `feat/max85-production`, update the PR description with portfolio behavior and fresh evidence, and leave the PR ready only after required local gates pass.
