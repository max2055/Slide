import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));

it('MAX-681 deep smoke rejects missing credentials before fetch and forwards explicit credentials', () => {
  for (const configured of [false, true]) {
    const env: NodeJS.ProcessEnv = { ...process.env, SMOKE_BASE_URL: 'http://isolated.invalid:3210', SMOKE_USER: 'fixture-user' };
    delete env.SMOKE_PASS;
    if (configured) env.SMOKE_PASS = 'explicit-fixture-value';
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const entry = './tests/deep-smoke.ts';
      process.argv[1] = entry;
      globalThis.fetch = async (url, options) => {
        if (!process.env.SMOKE_PASS) throw new Error('FETCH_BEFORE_CREDENTIAL_GUARD');
        const body = JSON.parse(options.body);
        if (url !== process.env.SMOKE_BASE_URL + '/api/auth/login'
          || body.username !== process.env.SMOKE_USER || body.password !== process.env.SMOKE_PASS) process.exit(93);
        process.exit(0);
      };
      await import(entry);
    `], { cwd, env, encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(configured ? 0 : 1);
    if (!configured) {
      expect(result.stdout + result.stderr).toContain('SMOKE_PASS must be explicitly injected');
      expect(result.stdout + result.stderr).not.toContain('FETCH_BEFORE_CREDENTIAL_GUARD');
    }
  }
});

type FixtureResponse = { status: number; body: string; contentType?: string };

async function runShapeChecks(responses: Record<string, FixtureResponse> = {}) {
  const report = { id: 17, status: 'completed' };
  const jsonResponses: Record<string, unknown> = {
    '/api/auth/login': { token: 'fixture-token' },
    '/api/reports/generate': report,
    '/api/reports/17': report,
    '/api/metrics/1': { cpu_usage: 1, memory_usage: 2, disk_usage: 3, connections: 4, instance_id: 1 },
    '/api/users': [{ id: 1, username: 'fixture-user', status: 'active' }],
  };
  let reportsReads = 0;
  const server = createServer((req, res) => {
    const endpoint = req.url!;
    if (endpoint === '/api/reports' && ++reportsReads <= 2) {
      // The lifecycle must find its report. The later shape check has its own response.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([report]));
      return;
    }
    const response = responses[endpoint] ?? { status: 200, body: JSON.stringify(jsonResponses[endpoint] ?? []) };
    res.writeHead(response.status, { 'Content-Type': response.contentType ?? 'application/json' }).end(response.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP port');
    return await new Promise<{ status: number; output: string }>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', 'tests/deep-smoke.ts'], {
        cwd, timeout: 15000,
        env: { ...process.env, SMOKE_BASE_URL: `http://127.0.0.1:${address.port}`,
          SMOKE_USER: 'fixture-user', SMOKE_PASS: 'fixture-value' },
      }, (error, stdout, stderr) => {
        if (!error) resolve({ status: 0, output: stdout + stderr });
        else if (typeof error.code === 'number') resolve({ status: error.code, output: stdout + stderr });
        else reject(error);
      });
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

it('#1026 counts successful JSON shapes and empty lists in the final summary', async () => {
  const { status, output } = await runShapeChecks();
  expect(status, output).toBe(0);
  for (const endpoint of ['/api/reports', '/api/alerts', '/api/database/instances']) {
    expect(output).toContain(`✅ ${endpoint} — empty list`);
  }
  expect(output).toContain('DEEP SMOKE: 13 passed, 0 failed');
});

it('#1026 keeps HTTP status and safe diagnostics for every failed shape check', async () => {
  const { status, output } = await runShapeChecks({
    '/api/metrics/1': { status: 503, contentType: 'text/plain', body: 'fixture-plain-secret\n\x1b[31m' },
    '/api/reports': { status: 502, contentType: 'text/html; charset=utf-8', body: '<html>fixture-html-secret</html>' },
    '/api/alerts': { status: 200, body: ' \t\n' },
    '/api/database/instances': { status: 403, body: '[]' },
    '/api/users': { status: 200, body: '{"error":"fixture-json-secret"}' },
  });
  expect(status, output).toBe(1);
  expect(output).toContain('/api/metrics/1 — HTTP 503: non-JSON text response');
  expect(output).toContain('/api/reports — HTTP 502: HTML response');
  expect(output).toContain('/api/alerts — HTTP 200: empty response body');
  expect(output).toContain('/api/database/instances — HTTP 403: JSON response');
  expect(output).toContain('/api/users — HTTP 200: expected a JSON array');
  expect(output).toContain('DEEP SMOKE: 8 passed, 5 failed');
  expect(output).not.toMatch(/fixture-(plain|html|json)-secret|Body is unusable/);
  expect(output).not.toContain('\x1b');
});

it('#1026 distinguishes a bodyless response from an empty list and still checks JSON item fields', async () => {
  const { status, output } = await runShapeChecks({
    '/api/alerts': { status: 204, body: '' },
    '/api/users': { status: 200, body: '[{"id":"1","username":"fixture-user","status":1}]' },
  });
  expect(status, output).toBe(1);
  expect(output).toContain('/api/alerts — HTTP 204: empty response body');
  expect(output).toContain('[user-item] id: expected number, got string');
  expect(output).toContain('[user-item] status: expected string, got number');
  expect(output).toContain('DEEP SMOKE: 11 passed, 3 failed');
});
