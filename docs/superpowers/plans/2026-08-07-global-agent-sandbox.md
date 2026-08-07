# Global Agent Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-disabled system-global switch whose enabled Agent Shell/Python/Node execution path exclusively calls `SandboxClient.execute()` and fails closed, with administrator APIs, approval, audit, UI, and security verification.

**Architecture:** A fail-closed configuration service owns the authoritative `system_config` value. A focused `AgentCodeExecutionService` validates code requests and has only `SandboxClient` as its execution dependency; the `execute_code` Agent tool routes through existing actor policy, mandatory approval, and tool audit. Existing SQL and structured tools remain unchanged.

**Tech Stack:** Fastify, TypeScript, MySQL, Vitest, Lit 3, Vite, rootless Docker Sandbox Controller.

---

### Task 1: Persistent fail-closed global configuration

**Files:**
- Create: `apps/db-ops-api/src/security/agent-sandbox-config-service.ts`
- Create: `apps/db-ops-api/src/security/agent-sandbox-config-service.test.ts`
- Create: `apps/db-ops-api/sql/migrations/059_agent_sandbox_global_config.sql`
- Modify: `apps/db-ops-api/sql/schema.sql`
- Modify: `apps/db-ops-api/src/migrations/invariants.ts`
- Modify: `apps/db-ops-api/src/migrations/invariants.test.ts`

- [ ] **Step 1: Write failing service tests**

Test an absent row, malformed value, unavailable database, exact `true` parsing, and an atomic upsert preserving `value_type`, description, and `updated_by`. Assert every uncertain read returns `{ enabled: false, reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE' }` rather than enabling execution.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-sandbox-config-service.test.ts`

Expected: FAIL because `agent-sandbox-config-service.ts` does not exist.

- [ ] **Step 3: Implement the focused configuration service**

Define `AgentSandboxConfigService` with injected executor support for tests:

```ts
export interface AgentSandboxConfigState {
  enabled: boolean;
  reasonCode: 'SANDBOX_ENABLED' | 'SANDBOX_DISABLED' | 'SANDBOX_CONFIG_UNAVAILABLE';
}

export class AgentSandboxConfigService {
  async get(): Promise<AgentSandboxConfigState>;
  async set(enabled: boolean, actorId: number): Promise<AgentSandboxConfigState>;
}
```

`get()` accepts only the literal stored strings `true` and `false`; absence resolves to disabled, while malformed values and database failures resolve to unavailable and disabled. `set()` requires a real database executor and uses `INSERT ... ON DUPLICATE KEY UPDATE` with `value_type='boolean'`, the fixed description, actor ID, and new value.

- [ ] **Step 4: Add migration and schema seed**

Add an idempotent insert for `agent_sandbox_enabled=false` which never overwrites an existing value. Mirror the row in `schema.sql`, and extend migration invariants so clean installs and upgrades both prove the setting exists and defaults false.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-sandbox-config-service.test.ts src/migrations/invariants.test.ts && npm run typecheck`

Expected: PASS.

### Task 2: Administrator configuration API and mutation audit

**Files:**
- Modify: `apps/db-ops-api/src/security/agent-security-routes.ts`
- Modify: `apps/db-ops-api/src/security/agent-security-routes.test.ts`
- Modify: `apps/db-ops-api/src/security/security-event-service.ts`
- Modify: `apps/db-ops-api/src/audit/audit-log.ts`

- [ ] **Step 1: Write failing route tests**

Cover `GET /api/agent/security/sandbox/config` and `PUT /api/agent/security/sandbox/config`: `admin:*` is required, bodies other than `{ enabled: boolean }` are rejected, enabling rejects unconfigured/unreachable/non-rootless/no-runtime controllers, disabling works while the controller is down, and successful changes include the authoritative state.

- [ ] **Step 2: Verify route tests fail**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-security-routes.test.ts`

Expected: FAIL with missing config routes.

- [ ] **Step 3: Add strict controller readiness parsing**

Use a local type guard for the existing controller response. Enabling succeeds only when `status === 'ok'`, `daemon.reachable === true`, `daemon.rootless === true`, and `policy.runtimes` contains at least one recognized Shell/Python/Node runtime. Use `AbortSignal.timeout(4000)` and normalize all errors to stable reason codes.

- [ ] **Step 4: Implement administrator routes and audit**

Read and mutate through `agentSandboxConfigService`. After a successful mutation call `auditLogManager.logConfigChange()` with key `agent_sandbox_enabled`, old/new boolean values, and the authenticated actor. Record rejected readiness changes as a typed `agent_sandbox_config_denied` security event without persisting controller error bodies or secrets.

- [ ] **Step 5: Run route, audit, and type tests**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-security-routes.test.ts src/security/security-event-service.test.ts src/audit/audit-log.test.ts && npm run typecheck`

Expected: PASS.

### Task 3: Fail-closed Agent code execution service

**Files:**
- Create: `apps/db-ops-api/src/security/agent-code-execution-service.ts`
- Create: `apps/db-ops-api/src/security/agent-code-execution-service.test.ts`
- Modify: `apps/db-ops-api/src/security/sandbox-client.ts`
- Modify: `apps/db-ops-api/src/security/sandbox-client.test.ts`

- [ ] **Step 1: Write failing service tests**

Use injected config and sandbox clients. Assert disabled, unavailable config, unsupported runtime, oversized source/file input, controller rejection, malformed result, and timeout all return stable failed `ToolResult`s. Assert `SandboxClient.execute()` is never called before all checks pass and is called exactly once for enabled valid requests.

- [ ] **Step 2: Verify execution tests fail**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-code-execution-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement runtime mapping and request bounds**

Accept public runtimes `shell`, `python`, and `node`; map them to configured controller identifiers returned by readiness status. Materialize source as `/workspace/main.sh`, `/workspace/main.py`, or `/workspace/main.mjs` and use fixed command arrays. Do not accept caller environment variables, image names, mounts, Docker flags, network settings, or credentials. Limit source/supporting file bytes and timeout at or below controller limits.

- [ ] **Step 4: Implement the exclusive execution boundary**

`AgentCodeExecutionService.execute()` reads config on every call, validates the request, builds the fixed sandbox request, and invokes only `sandboxClient.execute(request, AbortSignal.timeout(...))`. It must not import `child_process`, `worker_threads`, `vm`, SSH services, SQL executors, or host runtime APIs. Normalize controller results to bounded `ToolResult` data and stable sandbox error codes.

- [ ] **Step 5: Harden SandboxClient response parsing**

Handle non-JSON and error responses without leaking response bodies. Preserve abort semantics and stable client error codes. Add tests for invalid JSON, non-2xx responses, and aborted requests.

- [ ] **Step 6: Run execution tests and static no-fallback check**

Run: `cd apps/db-ops-api && npx vitest run src/security/agent-code-execution-service.test.ts src/security/sandbox-client.test.ts && ! rg "child_process|\bspawn\b|execFile|SqlExecutor|ssh" src/security/agent-code-execution-service.ts`

Expected: PASS and no forbidden imports/matches.

### Task 4: Register `execute_code` with policy, approval, and audit

**Files:**
- Create: `apps/db-ops-api/src/tools/code-execution-tool.ts`
- Create: `apps/db-ops-api/src/tools/code-execution-tool.test.ts`
- Modify: `apps/db-ops-api/src/adapter/get-agent-engine.ts`
- Modify: `apps/db-ops-api/src/tools/security-catalog.ts`
- Modify: `apps/db-ops-api/src/tools/security-catalog.test.ts`
- Modify: `apps/db-ops-api/src/tools/policy.test.ts`
- Modify: `apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts`

- [ ] **Step 1: Write failing tool and policy tests**

Assert the tool schema exposes only runtime, code, bounded supporting files, timeout, and approval ID. Assert metadata is actor-facing, effect `execute`, resource `none`, permission `ai:execute`, approval `always`, network `none`, credentials `none`. Assert execution without a consumed approval is denied and audited before the handler, and approved execution reaches the service once.

- [ ] **Step 2: Verify focused tests fail**

Run: `cd apps/db-ops-api && npx vitest run src/tools/code-execution-tool.test.ts src/tools/security-catalog.test.ts src/tools/policy.test.ts`

Expected: FAIL because `execute_code` is absent.

- [ ] **Step 3: Define and register the tool**

Export one `AnyAgentTool` named `execute_code`, with `requiresApproval: true`, danger level 5, required permission `ai:execute`, and a handler delegating directly to `agentCodeExecutionService.execute()`. Import and register it during `loadPlatformTools()` before catalog coverage is asserted.

- [ ] **Step 4: Add immutable operator security metadata**

Add:

```ts
execute_code: definition('actor', 'execute', 'none', ['ai:execute'], 'always', 'none', 'none')
```

Ensure the Cron registry excludes it and actor discovery still respects both actor permission and the Agent policy `allowedEffects`/tool allowlist.

- [ ] **Step 5: Run policy, adapter, and tool tests**

Run: `cd apps/db-ops-api && npx vitest run src/tools/code-execution-tool.test.ts src/tools/security-catalog.test.ts src/tools/policy.test.ts src/adapter/__tests__/direct-adapter.test.ts && npm run typecheck`

Expected: PASS.

### Task 5: Add the global toggle to the existing Sandbox security page

**Files:**
- Modify: `frontend/src/app/ui/views/agent-sandbox-status.ts`
- Create: `frontend/src/app/ui/views/agent-sandbox-status.test.ts`
- Modify: `frontend/src/app/i18n/locales/en.ts`
- Modify: `frontend/src/app/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Write failing component tests**

Mock the API client and cover: admin config loading, enabled/disabled state, non-admin read failure, strict boolean state, confirmation before enabling, disabling without readiness, saving state, successful refresh, and error toast. Assert the control uses `.checked=${...}` and `.disabled=${...}` property bindings through rendered behavior.

- [ ] **Step 2: Verify component tests fail**

Run: `cd frontend && npx vitest run src/app/ui/views/agent-sandbox-status.test.ts`

Expected: FAIL because the page has no configuration control.

- [ ] **Step 3: Implement the system-global toggle**

Load status and config independently. Render the administrative control in `<app-card>` with existing design tokens, shared buttons, badges, `<app-dialog>`, and `showToast()`. Enabling opens a confirmation dialog; disabling submits immediately. Only update visible enabled state after a successful `PUT /agent/security/sandbox/config` response.

- [ ] **Step 4: Run frontend tests, typecheck, and build**

Run: `cd frontend && npx vitest run src/app/ui/views/agent-sandbox-status.test.ts src/app/ui/views/settings-shell-security.test.ts && npm run typecheck && npm run build`

Expected: PASS.

### Task 6: End-to-end security qualification and regression proof

**Files:**
- Modify: `tests/qualification/sandbox-security.ts`
- Modify: `scripts/qualification/run-sandbox-security.sh`
- Modify: `compose.production.yaml` if the current runtime image names do not expose the required Shell/Python/Node identifiers

- [ ] **Step 1: Extend qualification assertions**

Verify a disabled request is denied without creating a controller job; an enabled approved request produces a real sandbox job; the runtime has no network, read-only root, dropped capabilities, non-root UID, bounded resources, and cleaned workspace; and stopping/unrouting the controller causes `SANDBOX_UNAVAILABLE` rather than host execution.

- [ ] **Step 2: Run backend and frontend focused suites**

Run: `cd apps/db-ops-api && npm test -- --run src/security/agent-sandbox-config-service.test.ts src/security/agent-security-routes.test.ts src/security/agent-code-execution-service.test.ts src/security/sandbox-client.test.ts src/tools/code-execution-tool.test.ts src/tools/security-catalog.test.ts src/tools/policy.test.ts`

Run: `cd frontend && npm test -- --run src/app/ui/views/agent-sandbox-status.test.ts src/app/ui/views/settings-shell-security.test.ts`

Expected: PASS.

- [ ] **Step 3: Run full static verification**

Run: `cd apps/db-ops-api && npm run typecheck && npm test`

Run: `cd frontend && npm run typecheck && npm test && npm run build`

Expected: PASS, or any unrelated pre-existing failures are documented with direct evidence while all changed-area tests pass.

- [ ] **Step 4: Run sandbox qualification where rootless Docker is available**

Run: `bash scripts/qualification/run-sandbox-security.sh`

Expected: PASS for controller authentication, rootless status, runtime execution, network isolation, filesystem/capability/resource constraints, cleanup, and fail-closed outage behavior. If the local daemon is unavailable or not rootless, record that environmental limitation and retain passing unit/integration evidence; do not weaken checks.

- [ ] **Step 5: Audit requirement coverage**

Inspect current source and test output to prove: global/default-disabled state, administrator-only mutation, exclusive `SandboxClient.execute()` production caller, no fallback, approval/audit, existing SQL path unchanged, UI behavior, and controller qualification. Do not mark the Goal complete until every acceptance criterion in the design has authoritative evidence.
