import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { alertDatabaseService } from '../src/alert-database-service.js';
import { registerAlertListRoute } from '../src/alert-list-route.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { signAccessToken, type ActorContext } from '../src/auth/actor-context.js';
import { dbConnection } from '../src/db-connection.js';

vi.mock('../src/alert-database-service.js', () => ({ alertDatabaseService: { getAlerts: vi.fn() } }));

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

type FixtureResponse = { status: number; body: string; contentType?: string; location?: string };

const alertRedirectTarget = '/fixture/alerts-redirect';
const emptyAlertPage = { items: [], total: 0, unread: 0, critical: 0, warning: 0, resolved: 0, level_counts: {} };
const alertItem = {
  id: 1, instance_id: 1, instance_name: 'Fixture instance', server_id: null, target_type: 'instance',
  network_device_id: null, alert_type: 'performance', severity: 'warning', title: 'Fixture alert',
  message: 'Fixture threshold exceeded', description: null, status: 'unread', acknowledged: false,
  metric_name: 'cpu_usage', metric_value: '91', threshold_value: '90', created_at: '2026-01-01T00:00:00.000Z',
};
const alertPage = {
  ...emptyAlertPage, items: [alertItem], total: 1, warning: 1, level_counts: { warning: 1 },
};

async function runShapeChecks(
  responses: Record<string, FixtureResponse> = {},
  alerts: typeof emptyAlertPage | typeof alertPage | Error = emptyAlertPage,
) {
  const report = { id: 17, status: 'completed' };
  const actor: ActorContext = {
    userId: 1, username: 'fixture-user', roles: ['smoke-reader'], permissions: ['alert:view'],
    instanceScopes: { [alertItem.instance_id]: 'read-only' }, sessionVersion: 3, requestId: 'deep-smoke',
  };
  const secret = randomBytes(32).toString('hex');
  const jsonResponses: Record<string, unknown> = {
    '/api/auth/login': { token: signAccessToken(actor, secret) },
    '/api/reports/generate': report,
    '/api/reports/17': report,
    '/api/metrics/1': { cpu_usage: 1, memory_usage: 2, disk_usage: 3, connections: 4, instance_id: 1 },
    '/api/users': [{ id: 1, username: 'fixture-user', status: 'active' }],
  };
  const server = Fastify();
  const page = alerts instanceof Error ? alerts : structuredClone(alerts);
  const getAlerts = vi.mocked(alertDatabaseService.getAlerts);
  getAlerts.mockReset().mockImplementation(async () => {
    if (page instanceof Error) throw page;
    return page;
  });
  const readActor = vi.fn().mockResolvedValue([[{
    id: actor.userId, username: actor.username, status: 'active', session_version: actor.sessionVersion,
    role_name: actor.roles[0], permission_code: actor.permissions[0],
    instance_id: alertItem.instance_id, access_level: actor.instanceScopes[alertItem.instance_id],
  }]]);
  const templateEventId = 41;
  const readEpisodes = vi.fn().mockResolvedValue([[{
    alert_id: alertItem.id, event_id: templateEventId, resource: { type: 'instance', id: alertItem.instance_id },
  }]]);
  // Exercise the real actor reload and resource check against deterministic storage rows.
  const pool = {
    query: readEpisodes,
    async execute(sql: string, params: unknown[]) {
      if (sql.includes('FROM users u')) return readActor(params);
      if (sql === 'SELECT id FROM database_instances WHERE id = ? LIMIT 1') {
        expect(params).toEqual([alertItem.instance_id]);
        return [[{ id: alertItem.instance_id }]];
      }
      throw new Error('Unexpected SQL in deep smoke fixture');
    },
  } as unknown as NonNullable<ReturnType<typeof dbConnection.getPool>>;
  let alertReads = 0;
  let alertRedirectReads = 0;
  server.get(alertRedirectTarget, async () => {
    alertRedirectReads++;
    return emptyAlertPage;
  });
  server.addHook('onRequest', async (req, reply) => {
    if (req.url !== '/api/alerts') return;
    alertReads++;
    const override = responses[req.url];
    if (override) {
      if (override.location) reply.header('location', override.location);
      return reply.code(override.status).type(override.contentType ?? 'application/json').send(override.body);
    }
  });
  let reportsReads = 0;
  server.setNotFoundHandler((req, reply) => {
    const endpoint = req.url;
    if (endpoint === '/api/reports' && ++reportsReads <= 2) {
      // The lifecycle must find its report. The later shape check has its own response.
      return reply.send([report]);
    }
    const response = responses[endpoint] ?? { status: 200, body: JSON.stringify(jsonResponses[endpoint] ?? []) };
    return reply.code(response.status).type(response.contentType ?? 'application/json').send(response.body);
  });
  const getPool = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
  try {
    await registerAlertListRoute(server, createVerifyToken(secret));
    const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
    const result = await new Promise<{ status: number; output: string }>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', 'tests/deep-smoke.ts'], {
        cwd, timeout: 15000,
        env: { ...process.env, SMOKE_BASE_URL: baseUrl,
          SMOKE_USER: 'fixture-user', SMOKE_PASS: 'fixture-value' },
      }, (error, stdout, stderr) => {
        if (!error) resolve({ status: 0, output: stdout + stderr });
        else if (typeof error.code === 'number') resolve({ status: error.code, output: stdout + stderr });
        else reject(error);
      });
    });
    expect(alertReads).toBe(1);
    const overridden = Boolean(responses['/api/alerts']);
    expect(getAlerts).toHaveBeenCalledTimes(overridden ? 0 : 1);
    const identityReads = overridden ? 0 : alerts instanceof Error ? 1 : 2;
    expect(readActor.mock.calls).toEqual(Array.from({ length: identityReads }, () => [[actor.userId]]));
    if (!overridden && alerts === alertPage && !(page instanceof Error)) {
      expect(readEpisodes).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM metric_trigger_episodes'), [[alertItem.id]]);
      expect(page.items).toMatchObject([{ id: alertItem.id, template_event_id: templateEventId }]);
    } else {
      expect(readEpisodes).not.toHaveBeenCalled();
    }
    return { ...result, alertRedirectReads };
  } finally {
    try {
      await server.close();
    } finally {
      getPool.mockRestore();
    }
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

it('MAX-701 counts a valid nonempty page from the production alert route', async () => {
  const { status, output } = await runShapeChecks({}, alertPage);
  expect(status, output).toBe(0);
  expect(output).toContain('✅ /api/alerts — response shape correct');
  expect(output).toContain('DEEP SMOKE: 13 passed, 0 failed');
});

it.each([
  { name: 'a top-level array', body: [], diagnostic: 'expected a JSON object with an items array' },
  { name: 'missing items', body: { total: 0 }, diagnostic: 'expected a JSON object with an items array' },
  { name: 'non-array items', body: { ...emptyAlertPage, items: null }, diagnostic: 'expected a JSON object with an items array' },
  { name: 'an invalid item', body: { ...alertPage, items: [{ ...alertItem, id: '1' }] }, diagnostic: '[alert-item] id: expected number, got string' },
])('MAX-701 rejects an alert page with $name', async ({ body, diagnostic }) => {
  const { status, output } = await runShapeChecks({ '/api/alerts': { status: 200, body: JSON.stringify(body) } });
  expect(status, output).toBe(1);
  expect(output).toContain(`/api/alerts — HTTP 200: ${diagnostic}`);
  expect(output).toContain('DEEP SMOKE: 12 passed, 1 failed');
});

it('MAX-701 counts a failed production alert request without exposing its response body', async () => {
  const canary = 'fixture-alert-error';
  const { status, output } = await runShapeChecks({}, new Error(canary));
  expect(status, output).toBe(1);
  expect(output).toContain('/api/alerts — HTTP 500: JSON response');
  expect(output).toContain('DEEP SMOKE: 12 passed, 1 failed');
  expect(output).not.toContain(canary);
});

it('MAX-701 counts the original alert redirect as a failure without requesting its target', async () => {
  const { status, output, alertRedirectReads } = await runShapeChecks({
    '/api/alerts': { status: 302, body: JSON.stringify(emptyAlertPage), location: alertRedirectTarget },
  });
  expect(alertRedirectReads).toBe(0);
  expect(status, output).toBe(1);
  expect(output).toContain('/api/alerts — HTTP 302: JSON response');
  expect(output).toContain('DEEP SMOKE: 12 passed, 1 failed');
});

it('MAX-701 reports an alert field type mismatch without disclosing its value', async () => {
  const canary = 'fixture-alert-field-value';
  const invalidPage = { ...alertPage, items: [{ ...alertItem, message: { note: canary } }] };
  const { status, output } = await runShapeChecks({
    '/api/alerts': { status: 200, body: JSON.stringify(invalidPage) },
  });
  expect(status, output).toBe(1);
  expect(output).toContain('/api/alerts — HTTP 200: [alert-item] message: expected string, got object');
  expect(output).toContain('DEEP SMOKE: 12 passed, 1 failed');
  expect(output).not.toContain(canary);
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
