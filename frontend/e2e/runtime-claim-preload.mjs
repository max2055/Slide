import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// NODE_OPTIONS is inherited by other managed commands. Only the actual managed
// API entry owns this server; migrations, Vite, Playwright and the model do not.
if (process.env.PLAYWRIGHT_MANAGED_ENV === '1' && process.env.QUALIFICATION_CANCELLATION_E2E === '1'
    && process.argv[1] && resolve(process.argv[1]) === resolve(root, 'apps/db-ops-api/server.ts')) {
  try {
    const require = createRequire(resolve(root, 'apps/db-ops-api/package.json'));
    await import(pathToFileURL(require.resolve('tsx')).href);
    const { runtimeClaimFixture } = await import('../../apps/db-ops-api/tests/runtime-claim-fixture.ts');
    const app = runtimeClaimFixture(process.env.RUNTIME_CLAIM_NONCE ?? '');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address();
    writeFileSync(process.env.RUNTIME_CLAIM_COORDINATE, JSON.stringify({ port }), { flag: 'wx', mode: 0o600 });
    app.server.unref();
  } catch { console.error('RUNTIME_CLAIM_FIXTURE_START_FAILED'); process.exit(2); }
}
