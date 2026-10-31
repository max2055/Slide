/**
 * MAX-237 / T1 — internal template domain.
 *
 * Deliberately unmounted: `server.ts`, `contracts/metrics/index.ts`,
 * `public-api.ts` and every runtime consumer ignore this directory (grep has no
 * hits). Importing it registers no route, opens no connection and schedules no
 * work. The only storage implementation is `InMemoryTemplateRepository`, which
 * exists for tests and is not a production adapter.
 */
export * from './errors.js';
export * from './model.js';
export * from './catalog.js';
export * from './repository.js';
export * from './service.js';
