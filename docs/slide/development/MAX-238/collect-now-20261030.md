# MAX238-NATIVE-COLLECT-NOW — immediate collection task and its exact samples

Run date: 2026-10-30. Task branch `agent/15coder1/max-238`, implementation
commit `f1042bc82a6352fd318363c549f5a43457740ced` (base `f4f7d3cb0`).

## Scope delivered

The native configuration page now has the original-scope public entry
**立即采集**: the user action creates one durable, idempotent task, the existing
workflow queue and `JobRegistry` execute the binding's exact pending plan, and
the existing formal writer commits the samples. The task row records the exact
sample identities that task committed, so a task result is never read from
another (periodic) collection's latest observation.

- `POST /api/metrics/template-bindings/{type}/{id}/collect` — admission.
- `GET /api/metrics/template-bindings/{type}/{id}/collect/{key}` — authoritative
  task query; `absent` means no task for this principal and key.
- `metric_collect_requests` (migration 137, additive) — one row per
  `(resource_key, caller_key)` with the signed principal/session, published
  revision, resolution identity, intent digest, job id, lifecycle,
  outcome, samples and attempts.
- `metrics.collect_now` — a distinct job type in the same queue, collection
  lane and worker. It never writes `metric_schedule.job_id`, `last_end_ms`,
  `next_due_ms` or an applied claim; it updates only the schedule's counter
  state so the next cadence keeps counter continuity.
- The periodic and manual paths share one formal writer
  (`writeTemplateResults`): normalized observations, raw lineage, attempts and
  the revision sample-id snapshot. The manual commit records the task's own
  sample identities in the same transaction.

### Idempotency and fences

- The unique insert `(resource_key, caller_key)` is the admission fence inside
  the same transaction and policy lock that enqueues the job: replaying one key
  under the same principal and intent returns that task and no second job is
  created. A different principal, revision, target/credential identity or plan
  digest is `409 COLLECT_INTENT_CONFLICT` / `COLLECT_REVISION_CONFLICT`.
- The worker re-reads the persisted principal live (session version, permission,
  resource relation) before the first read, before every request, after every
  request and inside the commit transaction. The job lease, exact binding
  revision, resource lifecycle and collection switch are re-checked at the same
  boundaries; a stale job writes nothing.
- The collection uses the same per-resource MySQL lock (`reserve`) as the
  cadence job, so a manual and a periodic run never read one resource at once.

### UI

The native configuration card shows the accepted/running/completed/failed task,
its outcome (`sampled` / `no_samples` / failed) and only this task's samples
(metric, value, unit, observed_at, quality, immutable id). A completed task with
zero samples is never rendered as success. The caller key is written to
`sessionStorage` before the request; a refresh queries that key instead of
sending a second request, and a failed storage write refuses to send at all.

## Evidence (all at `f1042bc82`)

Isolated real MySQL 8.4 container on a non-3306 loopback port, disposable
platform schema and disposable read-only target schema/user created by the
run's own nonce. No shared 3306 write, no production worker and no deployment.

| Command | Result |
| --- | --- |
| `vitest run src/metrics/templates/collect-now.mysql.test.ts` with the container | 7 passed |
| `vitest run src/metrics/scheduler` with the same container (periodic template fence, request fence, scheduler MySQL) | 60 passed / 3 files skipped (suites not enabled in this environment) |
| `pnpm exec playwright test --config playwright.MAX-238-COLLECT.config.ts` | 1 passed (real Chromium → Vite → Fastify → disposable MySQL → real read-only target → real worker → formal row) |
| `pnpm exec vitest run src/metrics` | 914 passed / 220 skipped |
| affected API set (`scheduler`, `templates`, contracts, worker/bounded-worker) | 172 passed / 82 skipped |
| `pnpm --filter slide-frontend exec vitest run` | 1360 passed (150 files) |
| API and frontend `tsc --noEmit` | clean |
| `pnpm contracts:check` | 0 |
| `pnpm --filter slide-frontend build` | built; CSP check passed |

The browser case compares the same task sample id, value, unit and
`observed_at` across the task row, the formal `metric_observations` row and the
rendered page, and confirms `state=completed`, `outcome=sampled`,
`revision=1`.

### MySQL cases

1. One admission returns an `accepted` task; the real worker completes it and
   the returned sample ids are exactly the formal rows and the revision
   sample-id snapshot. No operation/audit row is added.
2. The same key replays with no second job, request or observation.
3. A stale revision, an unbound resource and a key reused by another principal
   are refused with no job or request created.
4. Two concurrent same-key admissions produce one task and one job.
5. A session revoked after admission makes the worker refuse before any read;
   the task is `failed`, has no samples and the observation count is unchanged.
6. A revoked session makes the task query return 401 rather than stale facts.
7. A job payload whose revision does not match its persisted task is refused
   (`COLLECT_TASK_IDENTITY`).

## Contract fix included

Two contract cases were already red at `f4f7d3cb0` (introduced by the R2
probe change): the expected registered-route list omitted the documented
`probe` and `operations` paths, and the status response schema used a
`z.record`, which Fastify's strict serializer rejects with a 500. The route list
now includes the real paths (plus the two new collect paths), the override
container is an explicit loose object, and the status fixture carries the
required pending fields. `public-api.test.ts` is 12/12.

## Remaining

- The target in this evidence is an isolated real MySQL read-only account, not
  the production instance; no production deployment or worker was started.
- Delayed HTTP acceptance recovery is proven at the component and API layers;
  the browser case covers the successful same-task sample comparison.
- Original MAX238 items outside this package (unbind preview/history retention,
  production collection SLO, capacity/migration drills, trigger recovery)
  remain tracked on the issue.
