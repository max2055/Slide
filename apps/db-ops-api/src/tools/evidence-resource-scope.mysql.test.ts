import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { splitSqlStatements } from '../migrations/runner.js';
import { AgentSecurityPolicyService, agentSecurityPolicyService } from '../security/agent-security-policy-service.js';
import { agentExecutionConfigService } from '../security/agent-execution-config-service.js';
import { evidenceStore } from '../evidence/evidence-store.js';
import { evidenceId } from '../evidence/evidence-contract.js';
import { executeToolWithPolicy } from './policy.js';
import { getEvidenceBundleTool, getEvidenceItemTool } from './generated/slide-self-mgmt/resource_tools.js';
import type { ActorContext } from '../auth/actor-context.js';

const port = Number(process.env.EVIDENCE_TEST_MYSQL_PORT);
// #623: real resolver -> policy -> handler -> evidence service/store/MySQL.
describe.skipIf(!port)('evidence resource scope with isolated MySQL', () => {
  const database = `evidence_scope_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  let policy: AgentSecurityPolicyService;
  const actor: ActorContext = { userId: 7, username: 'reader', roles: ['admin'], permissions: ['*'], instanceScopes: {}, sessionVersion: 1, requestId: 'scope-test' };
  const from = '2026-10-01T00:00:00.000Z', to = '2026-10-01T01:00:00.000Z';
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.EVIDENCE_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    // Minimal FK prerequisite; policy and evidence tables use repository migrations verbatim.
    await pool.query('CREATE TABLE users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES (7)');
    for (const name of ['057_agent_security_governance.sql', '087_agent_evidence.sql']) {
      const sql = readFileSync(new URL(`../../sql/migrations/${name}`, import.meta.url), 'utf8');
      for (const statement of splitSqlStatements(sql)) {
        if (statement.includes('CREATE TABLE IF NOT EXISTS agent_security_policies') || name === '087_agent_evidence.sql') await pool.query(statement);
      }
    }
    await pool.execute(`INSERT INTO agent_security_policies (agent_id, allowed_effects, resource_scope) VALUES (?, ?, ?)`,
      ['restricted', '["read"]', JSON.stringify({ instanceIds: [12], serverIds: [12], networkDeviceIds: [12] })]);
    policy = new AgentSecurityPolicyService(() => pool as any);
    await policy.initialize();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE ${database}`); await admin.end(); }
  });
  it.each(['instance', 'server', 'network_device'] as const)('enforces both tools on %s and retains user checks', async (type) => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool as any);
    vi.spyOn(agentSecurityPolicyService, 'get').mockImplementation(id => policy.get(id));
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: false, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
    const content = { schemaVersion: 1 as const, kind: 'observation', status: 'fact' as const, subject: { resource: { type, id: 12 } }, quality: 'good' as const,
      observedAt: from, validUntil: to, source: 'scope-fixture', provenance: 'scope-fixture', correlationId: 'scope-test', payload: { metricId: 'cpu_usage', value: 1 } };
    const item = { ...content, id: evidenceId(content) };
    await evidenceStore.put(actor, item);
    for (const tool of [getEvidenceBundleTool, getEvidenceItemTool]) {
      const read = vi.spyOn(evidenceStore, tool === getEvidenceBundleTool ? 'query' : 'getById');
      const call = (resourceId: number, caller = actor) => executeToolWithPolicy(caller, tool,
        { resourceType: type, resourceId, evidenceId: item.id, from, to }, undefined, undefined,
        { record: async () => {} }, 'restricted'); // Audit sink isolated; authorization and storage are real.
      const denied = await call(13);
      expect(denied.decision.reasonCode).toBe('AGENT_RESOURCE_DENIED');
      expect(read).not.toHaveBeenCalled();
      const allowed = await call(12);
      expect(allowed.result.success).toBe(true);
      if (tool === getEvidenceItemTool) expect(allowed.result.data).toEqual(item);
      else expect(allowed.result.data).toMatchObject({ facts: [item] });
      const userDenied = await call(12, { ...actor, roles: [], permissions: [], instanceScopes: {} });
      expect(userDenied.result.success).toBe(false);
      read.mockRestore();
    }
  });
});
