/** MAX-328 / #282: real policy -> MySQL approval -> rootless execution.
 * Invoked only by run-rootless-sandbox.sh; no application database or models.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import type { AnyAgentTool } from '../../src/tools/types.js';
import type { AgentCodeExecutionInput } from '../../src/security/agent-code-execution-service.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.platform, 'linux');
assert(process.env.SANDBOX_WORKSPACE_ROOT);
assert(process.env.SANDBOX_APPROVAL_QUALIFICATION_OUTPUT);
assert(Number(process.env.SANDBOX_NONCE_DB_PORT) > 0);
process.env.AGENT_APPROVAL_HMAC_KEY = randomBytes(32).toString('hex');
const { dbConnection } = await import('../../src/db-connection.js');
const { executeToolWithPolicy } = await import('../../src/tools/policy.js');
const { agentCodeExecutionService } = await import('../../src/security/agent-code-execution-service.js');
const { getAgentToolApprovalService } = await import('../../src/security/agent-tool-approval-service.js');
const { redactSensitiveData } = await import('../../src/security/sensitive-data.js');
const { sandboxClient } = await import('../../src/security/sandbox-client.js');
const options = { host: '127.0.0.1', port: Number(process.env.SANDBOX_NONCE_DB_PORT), user: 'root', password: '' };
const database = `max328_${randomUUID().replaceAll('-', '')}`;
const admin = await mysql.createConnection(options);
const app = Fastify();
const observations: unknown[] = [];
let created = false;
let dispatches = 0;
let passed = false;
let databaseDropped = false;
let failure: string | undefined;
const workspace = () => readdir(process.env.SANDBOX_WORKSPACE_ROOT!);
async function assertWorkspaceClean(): Promise<void> {
  // The HTTP response can arrive before the controller's finally cleanup ends.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await workspace()).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(await workspace(), []);
}
try {
  const status = await sandboxClient.status() as any;
  assert.equal(status.daemon.reachable, true);
  assert.equal(status.daemon.rootless, true);
  assert.deepEqual(await workspace(), []);
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  assert.equal(await dbConnection.initialize({ ...options, database }), true);
  const pool = dbConnection.getPool()!;
  await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
  await pool.query('INSERT INTO users VALUES (7)');
  for (const name of ['054_agent_tool_approvals', '055_agent_tool_audit', '068_agent_tool_approval_scopes', '094_agent_tool_execution_intents']) {
    await pool.query(await readFile(new URL(`../../sql/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  await pool.query("ALTER TABLE agent_tool_audit ADD agent_id VARCHAR(128) NOT NULL DEFAULT 'slide-db-ops'");
  await pool.query('CREATE TABLE system_config (config_key VARCHAR(128) PRIMARY KEY, config_value TEXT)');
  await pool.query("INSERT INTO system_config VALUES ('agent_tool_approval_enabled','true'),('agent_sandbox_network_enabled','false'),('agent_sandbox_enabled','true')");
  const actor = { userId: 7, username: 'fixture', roles: ['admin'], permissions: ['ai:execute'], instanceScopes: {}, sessionVersion: 1, requestId: randomUUID() };
  const tool: AnyAgentTool = {
    name: 'execute_code', description: 'Qualification real execution', parameters: { type: 'object', properties: {} },
    handler: async (args) => {
      dispatches++;
      return agentCodeExecutionService.execute(args as unknown as AgentCodeExecutionInput);
    },
  };
  // Trusted actor fixture, real HTTP transport and all production policy/storage
  // dependencies. This deliberately makes no JWT/production-route coverage claim.
  app.post('/fixture/execute', async (request) => executeToolWithPolicy(actor, tool, request.body as Record<string, unknown>));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (args: Record<string, unknown>) => {
    const response = await fetch(`${address}/fixture/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'shell', ...args }) });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  const cases = [
    // MAX-352 / #582: these stay pending and never read outside /workspace.
    { code: 'cat ./../etc/passwd' }, { code: 'cat foo/../etc/passwd' },
    { code: 'ls ./../' }, { code: 'head ./../../etc/passwd' },
    { code: 'cat foo/../../etc/passwd' }, { code: 'ls ./..' },
    { code: 'cat ../etc/passwd' }, { code: 'cat /etc/passwd' },
    { code: 'cat ~/report.txt' },
    { code: 'grep -f../etc/passwd report.txt' },
    { code: 'grep -f/etc/passwd report.txt' },
    { code: 'pwd\nmv secret back' }, { code: 'ls\ncp a b' },
    { code: 'find . -delete' }, { code: 'find . -fprint output' },
    { code: 'cat foo > bar' }, { code: 'pwd', files: [{ path: 'input.txt', content: 'fixture' }] },
  ];
  const pendingIds: string[] = [];
  for (const input of cases) {
    const result = await call(input);
    assert.equal(result.decision.reasonCode, 'APPROVAL_REQUIRED');
    const id = String(result.decision.approvalId);
    const [rows] = await pool.query<any[]>('SELECT status, used_count FROM agent_tool_approvals WHERE id=?', [id]);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].used_count, 0);
    assert.equal(dispatches, 0);
    assert.deepEqual(await workspace(), []);
    pendingIds.push(id);
    observations.push({ input, approvalId: id, persisted: rows[0], dispatches, workspace: [] });
  }
  assert.equal((await getAgentToolApprovalService().pending()).length, cases.length);
  assert.deepEqual((await sandboxClient.status() as any).recentJobs, status.recentJobs);
  const pwd = await call({ code: 'pwd' });
  assert.equal(pwd.decision.riskLevel, 'low');
  assert.equal(pwd.result.success, true);
  assert.equal(pwd.result.data.exitCode, 0);
  assert.equal((await getAgentToolApprovalService().pending()).length, cases.length);
  await assertWorkspaceClean();
  observations.push({ readonly: pwd });

  // Only execute safe, disposable probes after approval. Original destructive
  // examples above stay pending and are never executed.
  for (const input of [
    { code: 'pwd\nprintf approved > marker\ncat marker' },
    // BusyBox find (the pinned Alpine image) has no -fprint. Exercise its
    // supported write-capable -exec action; keep -fprint in denial cases above.
    { code: "find . -maxdepth 0 -exec sh -c 'printf approved-find > output' \\;\ncat output" },
    { code: 'cat fixture.txt', files: [{ path: 'fixture.txt', content: 'approved-support' }] },
  ]) {
    const before = dispatches;
    const pending = await call(input);
    assert.equal(pending.decision.reasonCode, 'APPROVAL_REQUIRED');
    assert.equal(dispatches, before);
    assert.deepEqual(await workspace(), []);
    const id = String(pending.decision.approvalId);
    assert.equal(await getAgentToolApprovalService().review(id, 7, 'approve'), true);
    const executed = await call({ ...input, approvalId: id });
    observations.push({ phase: 'approved-execution', input, approvalId: id, result: redactSensitiveData(executed) });
    assert.equal(executed.result.success, true);
    assert.equal(executed.result.data.exitCode, 0);
    assert.equal(executed.result.data.timedOut, false);
    assert.equal(dispatches, before + 1);
    assert.match(executed.result.data.stdout, input.files ? /approved-support/ : input.code.startsWith('find') ? /approved-find/ : /approved/);
    await assertWorkspaceClean();
    const [rows] = await pool.query<any[]>('SELECT status FROM agent_tool_approvals WHERE id=?', [id]);
    assert.equal(rows[0].status, 'consumed');
    observations.push({ approved: input, approvalId: id, result: executed, persisted: rows[0], workspaceAfter: [] });
  }
  const [audit] = await pool.query<any[]>('SELECT phase, allowed, reason_code, approval_id FROM agent_tool_audit ORDER BY id');
  observations.push({ audit, originalPendingIds: pendingIds });
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  try {
    await app.close();
    await dbConnection.close();
    if (created) {
      await admin.query(`DROP DATABASE ${database}`);
      databaseDropped = true;
    }
    await admin.end();
  } finally {
    await writeFile(process.env.SANDBOX_APPROVAL_QUALIFICATION_OUTPUT!, JSON.stringify({
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      passed: passed && databaseDropped, failure, trustedActorFixture: true, mocks: false, databaseDropped, observations,
    }, null, 2));
  }
}
console.log('MAX-328 real HTTP/MySQL/rootless approval qualification passed');
