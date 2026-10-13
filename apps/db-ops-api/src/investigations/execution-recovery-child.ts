/** Test-only OS crash harness. Uses production executor/SQL, fixture provider/tool. */
import mysql from 'mysql2/promise';
import { ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { ActorContextService } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationExecutor } from './executor.js';

const pool = mysql.createPool({
  host: '127.0.0.1',
  port: Number(process.env.AGENT_RUN_TEST_MYSQL_PORT),
  user: 'root',
  password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '',
  database: process.env.T04_CHILD_DATABASE,
  timezone: 'Z',
  connectionLimit: 12,
});
const command = JSON.parse(process.env.T04_CHILD_COMMAND!);
const mode = process.env.T04_CHILD_CRASH;
const pause = async (point: string) => {
  if (mode !== point) return;
  process.send?.({ point });
  await new Promise<void>(() => {}); // parent SIGKILL is the intentional exit
};
// Pause AFTER real COMMIT: no mock persistence/ACL or in-memory surrogate.
const acquire = pool.getConnection.bind(pool);
(pool as any).getConnection = async () => {
  const c = await acquire();
  let checkpoint: string | undefined;
  const mark = (point: string) => {
    if (mode === point) checkpoint = point;
  };
  const query = c.query.bind(c);
  (c as any).query = async (sql: string, values?: unknown[]) => {
    const result = await query(sql, values);
    if (sql.startsWith("UPDATE agent_runs SET state = 'completed'")) mark('completion-after');
    if (sql.startsWith('UPDATE agent_runs SET result_json =') && typeof values?.[0] === 'string') {
      const data = JSON.parse(values[0]);
      if (data.completionPending === true) mark('staging-after');
      else if (data.investigationExecution?.provider?.status === 'sent') mark('provider-intent');
      else if (data.investigationExecution?.provider?.status === 'received') mark('provider-received');
      else if (Object.values(data.investigationExecution?.tools ?? {}).some((t: any) => t.status === 'returned'))
        mark('tool-after');
    }
    if (
      sql.startsWith('UPDATE chat_sessions SET metadata =') &&
      sql.includes('CAST(? AS JSON)') &&
      typeof values?.[0] === 'string'
    ) {
      const data = JSON.parse(values[0]);
      if (data?.phase === 'final_response') mark(data.terminal_resolution ? 'response-ready' : 'final-candidate');
    }
    return result;
  };
  const execute = c.execute.bind(c);
  (c as any).execute = async (sql: string, values?: unknown[]) => {
    const result = await execute(sql, values);
    if (sql.startsWith('INSERT INTO investigation_stream_events') && typeof values?.[3] === 'string'
      && JSON.parse(values[3]).type === 'run.terminal') await pause('completion-before');
    return result;
  };
  const commit = c.commit.bind(c);
  (c as any).commit = async () => {
    await commit();
    if (checkpoint) await pause(checkpoint);
  };
  return c;
};
const provider: LLMProvider = {
  getDefaultModel: () => 'crash-fixture',
  getModelCapabilities: () => ({
    model: 'crash-fixture',
    contextWindowTokens: 16000,
    preferredOutputTokens: 4096,
    source: 'configuration',
    version: 'fixture/v1',
  }),
  chat: async (messages) => {
    process.send?.({ providerCall: true });
    await pause('provider-after');
    const hasTool = messages.some((m) => m.role === 'tool');
    return {
      content: hasTool ? '已读取事实，根因待验证' : null,
      finishReason: hasTool ? 'stop' : 'tool_calls',
      toolCalls: hasTool
        ? []
        : [{ id: 'crash-summary-call', name: 'get_instance_summary', arguments: { instance_id: 101 } }],
      hasToolCalls: !hasTool,
      shouldExecuteTools: !hasTool,
      usage: { prompt_tokens: 20, completion_tokens: 10, cached_tokens: 5 },
    };
  },
  chatStream: async () => {
    throw Error('STREAM_NOT_EXPECTED');
  },
};
const tools = new ToolRegistry();
tools.register({
  name: 'get_instance_summary',
  description: 'Read fixture',
  parameters: { type: 'object', properties: { instance_id: { type: 'number' } } },
  readOnly: true,
  concurrencySafe: true,
  exclusive: false,
  execute: async () => {
    process.send?.({ toolCall: true });
    await pause('tool-before');
    return { success: true, rows: [{ health: 'unknown' }] };
  },
});
const executor = new InvestigationExecutor({
  pool: () => pool,
  authorization: new InvestigationAuthorization(new ActorContextService(() => pool as never)),
  providerForPurpose: async () => {
    await pause('provider-before');
    return provider;
  },
  toolsForActor: () => tools,
  budget: {
    domain: 'test-investigation',
    reserveCostMicros: 1000000,
    prices: { input: 100, cachedInput: 50, output: 200 },
    policy: {
      currency: 'USD',
      maxConcurrent: 4,
      manualReserved: 1,
      maxPerResourceConcurrent: 4,
      maxAutomaticRequestsPerHour: 20,
      maxAutomaticTokensPerDay: 256000,
      maxTotalTokensPerDay: 1000000,
      maxCostMicrosPerDay: 10000000,
    },
  },
});
try {
  const result = await executor.execute({
    ...command,
    context: { ...command.context, signal: new AbortController().signal },
  });
  process.send?.({ terminal: result.state, error: result.error });
} catch (error) {
  process.send?.({ failure: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await pool.end();
  process.disconnect?.();
}
