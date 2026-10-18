/** Invoked in a fresh Vitest process by runtime.mysql.test.ts after production
 * collection/event admission. Only model HTTP uses synthetic replies; the
 * batch journal is a separate synthetic test ledger, never the canonical one. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dbConnection, encryptData } from '../../db-connection.js';
import { OperationsBudgetJournal } from '../product-budget.js';
import { initializeSourceRuntime, investigateSource, sourceActor } from './runtime.js';
import { SourceControl } from './control.js';
import { sourcePackageSchema } from './config.js';
import { createActorBoundToolRegistry } from '../../adapter/get-agent-engine.js';
import { agentSecurityPolicyService } from '../../security/agent-security-policy-service.js';

const input = process.env.V23_SOURCE_CHILD_CONFIG;
vi.mock('../product-budget.js', async original => {
  const actual = await original<typeof import('../product-budget.js')>();
  return { ...actual, operationsProductBudget: () => new actual.OperationsBudgetJournal(join(process.env.V23_SOURCE_CHILD_DIRECTORY!, 'synthetic-budget.jsonl')) };
});
describe.skipIf(!input)('fresh standalone investigation with SQL policy and real executor', () => {
  afterAll(async () => { vi.unstubAllGlobals(); await dbConnection.close(); });
  it('enforces stored deny/failure, captures real tool evidence and returns an exact source', async () => {
    const config = sourcePackageSchema.parse(JSON.parse(await readFile(input!, 'utf8')));
    expect(await dbConnection.initialize()).toBe(true);
    const pool = dbConnection.getPool()!;
    const query = async (sql: string, args: any[] = []) => (await pool.execute<any>(sql, args))[0];
    await query(`INSERT INTO agent_security_policies(agent_id,tool_allowlist,skill_allowlist,allowed_effects,resource_scope,version)
      VALUES('slide-db-ops','[]','[]','[]',?,7) ON DUPLICATE KEY UPDATE tool_allowlist='[]',allowed_effects='[]',version=7`,
      [JSON.stringify({ instanceIds: [], serverIds: [3], networkDeviceIds: [] })]);
    const control = new SourceControl(pool, config);
    await initializeSourceRuntime();
    const actor = await sourceActor(control);
    expect(createActorBoundToolRegistry(actor).toolNames).not.toContain('get_server_metrics');
    expect(agentSecurityPolicyService.get('slide-db-ops').version).toBe(7);
    await query('RENAME TABLE agent_security_policies TO source_test_policy_unavailable');
    try { await expect(initializeSourceRuntime()).rejects.toThrow(); }
    finally { await query('RENAME TABLE source_test_policy_unavailable TO agent_security_policies'); }
    await query(`UPDATE agent_security_policies SET tool_allowlist='["get_server_metrics"]',allowed_effects='["read"]',
      resource_scope='{"instanceIds":[],"serverIds":[],"networkDeviceIds":[]}',version=8`);
    await initializeSourceRuntime();
    const refused = await createActorBoundToolRegistry(actor).get('get_server_metrics')!.execute({ serverId: 3 });
    expect(refused).toMatchObject({ success: false, errorCode: 'AGENT_RESOURCE_DENIED' });
    await query(`UPDATE agent_security_policies SET resource_scope='{"instanceIds":[],"serverIds":[3],"networkDeviceIds":[]}',version=9`);
    await query(`UPDATE llm_providers SET enabled=0,is_default=0`);
    await query(`INSERT INTO llm_providers(name,display_name,deployment_type,api_format,api_base_url,default_model,api_key_encrypted,
      enabled,is_default,supports_function_call,context_window,max_tokens) VALUES('source-synthetic','synthetic HTTP only','api','openai-completions',
      'https://api.deepseek.com/v1','deepseek-flash',?,1,1,1,64000,1024)`, [encryptData('synthetic-no-key')]);
    const [provider] = await query("SELECT id FROM llm_providers WHERE name='source-synthetic'");
    await query("INSERT INTO llm_scene_bindings(scene,provider_id,model) VALUES('fault_diagnosis',?,'deepseek-flash') ON DUPLICATE KEY UPDATE provider_id=VALUES(provider_id),model=VALUES(model)", [provider.id]);
    const journal = new OperationsBudgetJournal(join(process.env.V23_SOURCE_CHILD_DIRECTORY!, 'synthetic-budget.jsonl')); journal.initialize();
    let sends = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/v1/chat/completions');
      const body = JSON.parse(init.body as string);
      expect(body.stream).toBeFalsy(); expect(journal.read().pending).not.toBeNull();
      expect(body.tools.some((t: any) => t.function.name === 'get_server_metrics')).toBe(true);
      sends++;
      const message = sends === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'source-read-1', type: 'function',
        function: { name: 'get_server_metrics', arguments: '{"serverId":3}' } }] }
        : { role: 'assistant', content: '已读取服务器指标；根因与恢复未验证。' };
      return Response.json({ id: `synthetic-${sends}`, model: 'deepseek-flash', choices: [{ index: 0,
        finish_reason: sends === 1 ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    });
    let result;
    try {
      await control.open(); result = await investigateSource(control);
      expect(result.evidence).toHaveLength(1); expect(result.resultVersion).toBeGreaterThan(1);
      expect(sends).toBe(2);
      const [audit] = await query("SELECT allowed,policy_snapshot FROM agent_tool_audit WHERE tool_name='get_server_metrics' AND phase='result' ORDER BY id DESC LIMIT 1");
      expect(Number(audit.allowed)).toBe(1);
      expect(typeof audit.policy_snapshot === 'string' ? JSON.parse(audit.policy_snapshot).version : audit.policy_snapshot.version).toBe(9);
      expect(await query('SELECT id FROM action_executions')).toHaveLength(0);
      expect(await query('SELECT id FROM agent_tool_approvals')).toHaveLength(0);
      expect(await query("SELECT id FROM workflow_jobs WHERE job_type LIKE 'action.%'")).toHaveLength(0);
      await writeFile(join(process.env.V23_SOURCE_CHILD_DIRECTORY!, 'investigate-result.json'), JSON.stringify({ synthetic: true, sends, result, budget: journal.read() }, null, 2));
      await control.close(true);
    } finally { await control.close(); }
  }, 60_000);
});
