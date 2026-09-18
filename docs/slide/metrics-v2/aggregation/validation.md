# MAX-68 validation

Branch `agent/13sol-high/max-68` started from main `bf64502` (MAX-64 #76, MAX-66 #78, MAX-65 #79 merged). Synthetic inputs and expected hand calculations: `fixtures.json`; executable assertions: `apps/db-ops-api/src/metrics-v2/query.test.ts` and `query.mysql.test.ts`.

| Command (repository root) | Result |
|---|---|
| `METRICS_V2_TEST_MYSQL_PORT=13368 corepack pnpm --filter slide-api exec vitest run src/metrics-v2/query.test.ts src/metrics-v2/query.mysql.test.ts` | 13/13 passed; disposable MySQL `mysql:latest` (26.7.0). |
| `METRICS_V2_TEST_MYSQL_PORT=13369 corepack pnpm --filter slide-api exec vitest run src/metrics-v2/storage.mysql.test.ts src/metrics-v2/query.mysql.test.ts src/metrics-v2/query.test.ts src/contracts/metrics-v2/contracts.test.ts` | 84/84 passed, including after the final query parameter validation edit; separate disposable MySQL 8.4.11 database, real migrations and EXPLAIN index check. |
| `corepack pnpm --filter slide-api typecheck` | Passed. |
| `corepack pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts` | 11/11 passed (rerun after this report). |
| `METRICS_V2_TEST_MYSQL_PORT=13369 corepack pnpm --filter slide-api exec vitest run --maxWorkers=4` | Integration candidate: 268 files passed, 4 skipped; 2408 tests passed, 55 skipped. One later validation-only code edit was followed by the affected 84 tests and typecheck, not another full gate. |

First unbounded parallel run of `METRICS_V2_TEST_MYSQL_PORT=13368 corepack pnpm --filter slide-api test` had 5 failures (2403 passed): the old storage index assertion expected `EXPLAIN.key` but `mysql:latest` 26.7 returns a tree by default; four unrelated WebSocket/release-manifest tests hit their 5/10-second timeouts. The affected storage suite passed in MySQL 8.4, and those three unrelated files passed 95/95 in isolation. With a supported MySQL 8.x and bounded workers, the full integration run passed without modifying unrelated tests. This distinguishes environment/parallelism failures from the query implementation; no gate is reported as passing when it failed.

`query.mysql.test.ts` creates/drops a PID-specific disposable database and never loads application `.env`. Only test containers were used, not production data. No live collector/HTTP route or historical API was switched; CI status belongs to the eventual PR and is not inferred from local tests. Rollback is to remove callers of the optional V2 service; the existing legacy AVG endpoints and historical data remain intact.
