/** MAX-329 / GitHub #292: actual server.ts, JWT login and isolated migrated MySQL.
 * Run: CONFIG_READ_TEST_MYSQL_URL=<admin URL> pnpm --filter slide-api exec tsx tests/config-read-http.acceptance.ts
 * No authentication/service stubs and no model calls. Drops only its generated schema.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { llmDatabaseService } from '../src/llm-database-service.js';
import { MigrationRunner } from '../src/migrations/runner.js';

assert(process.env.CONFIG_READ_TEST_MYSQL_URL, 'CONFIG_READ_TEST_MYSQL_URL required');
const url = new URL(process.env.CONFIG_READ_TEST_MYSQL_URL);
const schema = `max329_${randomBytes(6).toString('hex')}`;
const admin = mysql.createPool(url.toString());
await admin.query(`CREATE DATABASE ${schema}`);
url.pathname = `/${schema}`;
const pool = mysql.createPool(url.toString());
const password = randomBytes(24).toString('hex');
const secret = 'MAX329_SYNTHETIC_SECRET_SENTINEL';
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<unknown> | undefined;
let logs = '';
let checks = 0;
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
try {
  await new MigrationRunner(pool as any).run();
  await pool.execute('UPDATE llm_providers SET enabled=FALSE, is_default=FALSE');
  const [providers] = await pool.query<any[]>('SELECT id FROM llm_providers ORDER BY id LIMIT 1');
  assert(providers.length, 'seeded provider required');
  const id = providers[0].id;
  await pool.execute('UPDATE llm_providers SET api_key_encrypted=?, models_supported=? WHERE id=?',
    [secret, JSON.stringify([{ id: 'fixture-model', maxTokens: 512, apiKey: secret, futureSecret: secret,
      cost: { input: 1, output: 2, secret } }]), id]);
  const actors: Record<string, number> = {};
  for (const name of ['none', 'llm', 'alert', 'both', 'wildcard']) {
    const [user] = await pool.execute<any>('INSERT INTO users (username,password_hash,status) VALUES (?,?,?)',
      [`max329_${name}`, await bcrypt.hash(password, 10), 'active']);
    actors[name] = user.insertId;
    const [role] = await pool.execute<any>('INSERT INTO roles (name,description) VALUES (?,?)', [`max329_${name}`, name]);
    await pool.execute('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [user.insertId, role.insertId]);
    const codes = name === 'both' ? ['llm:view', 'alert:view'] : name === 'wildcard' ? ['*'] : name === 'none' ? [] : [`${name}:view`];
    for (const code of codes) {
      // Existing '*' permission, if absent, is created only inside this disposable schema.
      await pool.execute('INSERT IGNORE INTO permissions (code,name,resource,action) VALUES (?,?,?,?)', [code, code, code.split(':')[0], code.split(':')[1] || '*']);
      await pool.execute('INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?', [role.insertId, code]);
    }
  }
  const port = await freePort();
  const wsPort = await freePort();
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', DB_HOST: url.hostname, DB_PORT: url.port || '3306',
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password), DB_NAME: schema,
      JWT_SECRET_KEY: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PORT: String(port), AGENT_WS_PORT: String(wsPort), PROMPT_HOT_RELOAD: 'false' },
  });
  child.stdout!.on('data', chunk => { logs += chunk; });
  child.stderr!.on('data', chunk => { logs += chunk; });
  exited = once(child, 'exit');
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, 'server exited before readiness');
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'full server readiness timeout');
  const request = async (path: string, token?: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const paths = ['/api/llm/configs', `/api/llm/configs/${id}`, '/api/alerts/escalation/rules'];
  for (const path of paths) {
    assert.equal((await request(path)).status, 401); checks++;
    assert.equal((await request(path, 'invalid-jwt')).status, 401); checks++;
  }
  const tokens: Record<string, string> = {};
  for (const name of Object.keys(actors)) {
    const login = await request('/api/auth/login', undefined, { username: `max329_${name}`, password });
    assert.equal(login.status, 200, `login ${name}`);
    const token = tokens[name] = login.body.token;
    assert(token);
    for (const [index, path] of paths.entries()) {
      const allowed = name === 'both' || name === 'wildcard' || (index < 2 ? name === 'llm' : name === 'alert');
      const result = await request(path, token);
      assert.equal(result.status, allowed ? 200 : 403, `${name} ${path}`); checks++;
      assert(!JSON.stringify(result.body).includes(secret), 'secret sentinel absent');
      if (allowed && index === 2) {
        assert(Array.isArray(result.body) && result.body.length > 0, 'authorized reader receives seeded escalation rules');
      }
      if (allowed && index < 2) {
        const provider = index === 0 ? result.body.find((p: any) => p.id === id) : result.body;
        assert(provider);
        assert.equal(provider.hasApiKey, true);
        assert.equal(provider.models_supported[0].id, 'fixture-model');
        assert.equal(provider.models_supported[0].maxTokens, 512);
        assert(!JSON.stringify(provider).includes('api_key_encrypted'));
        assert(!JSON.stringify(provider).includes('apiKey'));
      }
    }
  }
  // Review blockers: public URL values and typed metadata, through the real HTTP/JWT boundary.
  const reviewCases = [
    ['URL userinfo', `https://user:${secret}@example.invalid/v1`, { id: 'm' }],
    ['URL x-api-key', `https://example.invalid/v1?x-api-key=${secret}`, { id: 'm' }],
    ['URL clientSecret', `https://example.invalid/v1?clientSecret=${secret}`, { id: 'm' }],
    ['model name object', 'https://example.invalid/v1', { id: 'm', name: { clientSecret: secret } }],
    ['model desc object', 'https://example.invalid/v1', { id: 'm', desc: { API_KEY: secret } }],
    ['cost input object', 'https://example.invalid/v1', { id: 'm', cost: { input: { 'subscription-key': secret } } }],
    ['unknown URL query and fragment', `https://example.invalid/v1?unknown-new-field=${secret}&client%53ecret=${secret}&api-version=2024-06-01-preview#${secret}`, { id: 'm' }],
    ['ordinary legacy metadata', 'https://example.invalid/v1?api-version=2024-06-01', {
      id: 'm', name: 'Model', desc: 'Legacy', contextWindow: 32000, maxTokens: 1024,
      recommended: true, supportsFunctionCall: false, supportsVision: true,
      parameterProvider: 'legacy', parameterSource: 'manual', cost: { input: 0, output: 2.5 },
    }],
  ] as const;
  const storedConfig = async () => (await pool.query<any[]>(
    'SELECT api_base_url, models_supported, api_key_encrypted FROM llm_providers WHERE id=?', [id]))[0][0];
  const originalConfig = await storedConfig();
  for (const [name, baseURL, model] of reviewCases) {
    await pool.execute('UPDATE llm_providers SET api_base_url=?, models_supported=? WHERE id=?', [baseURL, JSON.stringify([model]), id]);
    const before = await storedConfig();
    for (const path of paths.slice(0, 2)) {
      assert.equal((await request(path, tokens.none)).status, 403); checks++;
      const result = await request(path, tokens.llm);
      assert.equal(result.status, 200); checks++;
      assert(!JSON.stringify(result.body).includes(secret), `${name}: public payload has no sentinel`);
      const config = Array.isArray(result.body) ? result.body.find((p: any) => p.id === id) : result.body;
      assert.equal(config.hasApiKey, true);
      assert.equal(config.models_supported[0].id, 'm');
      const expectedURL = name === 'unknown URL query and fragment'
        ? 'https://example.invalid/v1?api-version=2024-06-01-preview'
        : name === 'ordinary legacy metadata' ? baseURL : 'https://example.invalid/v1';
      assert.equal(config.api_base_url, expectedURL);
      if (name === 'ordinary legacy metadata') assert.deepEqual(config.models_supported, [model]);
    }
    assert.deepEqual(await storedConfig(), before, `${name}: HTTP reads leave stored URL/JSON/key unchanged`); checks++;
    const internal = (await llmDatabaseService.getAllProviders(pool)).find(provider => provider.id === id)!;
    assert.equal(internal.api_base_url, baseURL, `${name}: runtime URL remains intact`);
    assert.deepEqual(internal.models_supported, [model], `${name}: runtime JSON remains intact`);
    assert.equal(internal.api_key_encrypted, secret); checks++;
    console.log(`PASS review regression: ${name}; HTTP 403/200; public metadata filtered; DB/runtime originals preserved`);
  }
  await pool.execute('UPDATE llm_providers SET api_base_url=?, models_supported=? WHERE id=?',
    [originalConfig.api_base_url, typeof originalConfig.models_supported === 'string'
      ? originalConfig.models_supported : JSON.stringify(originalConfig.models_supported), id]);
  assert.equal((await request('/api/llm/configs/2147483647', tokens.llm)).status, 404); checks++;
  // Same signed JWT must observe a permission revocation on its next request.
  await pool.execute('DELETE rp FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?', [actors.both]);
  for (const path of paths) { assert.equal((await request(path, tokens.both)).status, 403); checks++; }
  const [credentialRows] = await pool.query<any[]>('SELECT api_key_encrypted FROM llm_providers WHERE id=?', [id]);
  assert.equal(credentialRows[0].api_key_encrypted, secret, 'HTTP reads preserve stored credential'); checks++;
  await pool.execute('UPDATE llm_providers SET api_key_encrypted=NULL WHERE id=?', [id]);
  const noKey = await request(`/api/llm/configs/${id}`, tokens.llm);
  assert.equal(noKey.status, 200);
  assert.equal(noKey.body.hasApiKey, false); checks++;
  const [stored] = await pool.query<any[]>('SELECT models_supported FROM llm_providers WHERE id=?', [id]);
  assert(JSON.stringify(stored).includes(secret), 'serialization preserves stored values'); checks++;
  assert(!logs.includes(password) && !logs.includes(secret), 'logs exclude synthetic credentials');
  for (const token of Object.values(tokens)) assert(!logs.includes(token), 'logs exclude JWTs');
  console.log(`PASS ${checks} HTTP/DB assertions: actual server.ts; real login/JWT; 401/403/200/404; module isolation; wildcard; live revocation; nested allowlist; hasApiKey; DB preservation`);
} finally {
  if (child && exited) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL'); }, 15000);
    await exited;
    clearTimeout(timeout);
  }
  await pool.end();
  await admin.query(`DROP DATABASE ${schema}`);
  await admin.end();
  console.log('CLEANUP: isolated schema dropped; owned server stopped; no model requests');
}
