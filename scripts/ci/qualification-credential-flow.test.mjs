import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const helper = readFileSync(new URL('frontend/e2e/qualification-credentials.ts', root), 'utf8');
const targetNames = ['QUALIFICATION_MYSQL_HOST', 'QUALIFICATION_MYSQL_PORT', 'QUALIFICATION_MYSQL_USER',
  'QUALIFICATION_MYSQL_DATABASE', 'QUALIFICATION_MYSQL_PASSWORD'];
const input = {
  QUALIFICATION_ADMIN_PASSWORD: 'synthetic-platform-only',
  QUALIFICATION_MYSQL_HOST: 'owned-target.invalid',
  QUALIFICATION_MYSQL_PORT: '13307',
  QUALIFICATION_MYSQL_USER: 'owned-test-user',
  QUALIFICATION_MYSQL_DATABASE: 'owned_test_schema',
  QUALIFICATION_MYSQL_PASSWORD: 'synthetic-database-only',
};

function callbacks(file, env) {
  const cases = [];
  const register = (name, fn) => cases.push({ name, fn });
  register.setTimeout = () => {};
  const context = vm.createContext({ process: { env }, test: register,
    expect: value => ({ toBe: expected => assert.equal(value, expected) }) });
  const spec = readFileSync(new URL(`frontend/e2e/${file}`, root), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(stripTypeScriptTypes(helper.replace(/export function/g, 'function') + '\n' + spec), context);
  return cases.filter(({ name }) => /direct SQL execution|concurrent approval reviews|approval cancellation and retry|browser renders live MySQL|fresh native MySQL/.test(name));
}

for (const file of ['release-security.spec.ts', 'release-critical-paths.spec.ts']) {
  assert.equal(callbacks(file, {}).length, file === 'release-security.spec.ts' ? 3 : 2);
  for (const { name } of callbacks(file, {})) {
    test(`MAX-681 R4 ${name}: separate login and complete database target before network`, async () => {
      for (const password of [input.QUALIFICATION_MYSQL_PASSWORD, '']) {
        const env = { ...input, QUALIFICATION_MYSQL_PASSWORD: password,
          // Generic platform DB settings must not silently replace the target.
          DB_HOST: 'wrong.invalid', DB_PASSWORD: input.QUALIFICATION_ADMIN_PASSWORD };
        const calls = [];
        const stop = new Error('captured before network');
        const page = { request: { post: async (url, options) => {
          calls.push({ url, data: JSON.parse(JSON.stringify(options.data)) });
          if (url === '/api/auth/login') return { status: () => 200, json: async () => ({ token: 'fixture' }) };
          if (url === '/api/database/instances') throw stop;
          assert.fail(`unexpected request: ${url}`);
        } } };
        await assert.rejects(callbacks(file, env).find(item => item.name === name).fn({ page }), error => error === stop);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], { url: '/api/auth/login', data: { username: 'admin', password: input.QUALIFICATION_ADMIN_PASSWORD } });
        const { name: instanceName, ...configuration } = calls[1].data;
        assert.ok(instanceName.startsWith('qualification-'));
        assert.deepEqual(configuration, { environment: 'testing', db_type: 'mysql', host: input.QUALIFICATION_MYSQL_HOST,
          port: 13307, username: input.QUALIFICATION_MYSQL_USER, database_name: input.QUALIFICATION_MYSQL_DATABASE, password });
      }
    });

    test(`MAX-681 R4 ${name}: each missing target field refuses before instance writes`, async () => {
      for (const field of targetNames) {
        for (const value of field.endsWith('_PASSWORD') ? [undefined] : [undefined, '']) {
          const env = { ...input };
          if (value === undefined) delete env[field];
          else env[field] = value;
          let requests = 0;
          const page = { request: { post: async () => { requests++; assert.fail('configuration must fail before requests'); } } };
          await assert.rejects(callbacks(file, env).find(item => item.name === name).fn({ page }),
            error => error.message === `${field} must be explicitly injected`);
          assert.equal(requests, 0);
        }
      }
    });
  }
}

test('MAX-681 R4 target port rejects malformed or out of range inputs before requests', async () => {
  for (const port of ['', '0', '-1', '65536', '3306junk', '3.5']) {
    const [item] = callbacks('release-security.spec.ts', { ...input, QUALIFICATION_MYSQL_PORT: port });
    await assert.rejects(item.fn({ page: {} }), /QUALIFICATION_MYSQL_PORT/);
  }
});
