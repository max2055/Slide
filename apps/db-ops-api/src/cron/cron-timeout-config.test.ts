import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { AgentRunner, MAX_TIMEOUT_MS, NoopHook, ToolRegistry } from '@slide/agent-core';
import type { AgentRunSpec, LLMProvider } from '@slide/agent-core';
import { resolveRuntimePolicy, runtimeSpec } from '../adapter/runtime-policy.js';
import { dbConnection } from '../db-connection.js';
import { CronJobDatabaseService, cronJobService } from './cron-job-service.js';
import { CronExecutor } from './cron-executor.js';
import { registerCronRoutes } from './cron-routes.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const job = { name: 'timeout-fixture', task_description: 'Inspect.', cron_expr: '0 * * * *' };

it.each([3_000_000, 0, -1, 'abc', '300', null])('returns HTTP 400 for invalid Cron create/update timeout %j before persistence', async timeout_seconds => {
  const app = Fastify();
  registerCronRoutes(app, async request => { (request as any).user = { userId: 7, roles: ['admin'], permissions: ['*'] }; }, () => undefined);
  vi.spyOn(cronJobService, 'getJobById').mockResolvedValue({ id: 1, owner_user_id: 7, target_instance_id: null } as any);
  const create = vi.spyOn(cronJobService, 'createJob');
  const update = vi.spyOn(cronJobService, 'updateJob');
  try {
    for (const method of ['POST', 'PUT'] as const) {
      const result = await app.inject({ method, url: `/api/cron/jobs${method === 'PUT' ? '/1' : ''}`, payload: { ...job, timeout_seconds } });
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toContain('Invalid cron timeout');
    }
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

// GitHub #453: reject at persistence AND at dispatch of historical configuration.
it.each([3_000_000, MAX_TIMEOUT_MS / 1000 + 0.001, Infinity, NaN, 0, -1, 0.0001, '300' as any, null as any])('rejects unsafe Cron timeout %s without SQL or runner dispatch', async seconds => {
  const execute = vi.fn(); vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const service = new CronJobDatabaseService();
  await expect(service.createJob({ ...job, timeout_seconds: seconds })).rejects.toThrow('Invalid cron timeout');
  await expect(service.updateJob(1, { timeout_seconds: seconds })).rejects.toThrow('Invalid cron timeout');
  expect(execute).not.toHaveBeenCalled();
  expect(() => resolveRuntimePolicy('cron', { env: {}, cronTimeoutSeconds: seconds })).toThrow('Invalid cron timeout');
  const run = vi.fn();
  await expect(new CronExecutor({ run } as any, new ToolRegistry(), {} as any).execute(1, 'Inspect.', seconds)).rejects.toThrow('Invalid cron timeout');
  expect(run).not.toHaveBeenCalled();
});
it('persists omitted defaults, updates safe limits, and preserves unrelated historical edits', async () => {
  const execute = vi.fn(async (_sql: string, _values?: any[]) => [{ insertId: 1, affectedRows: 1 }]);
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  const service = new CronJobDatabaseService();
  expect(await service.createJob(job)).toBe(1);
  expect(execute.mock.calls[0]?.[1]?.[9]).toBe(300);
  expect(await service.updateJob(1, { timeout_seconds: 2_147_483 })).toBe(true);
  expect(await service.updateJob(1, { description: 'unchanged timeout' })).toBe(true);
});
it('admits the exact safe boundary through Cron policy and AgentRunner', async () => {
  vi.useFakeTimers();
  const policy = resolveRuntimePolicy('cron', { env: {}, cronTimeoutSeconds: MAX_TIMEOUT_MS / 1000 });
  const chat = vi.fn<LLMProvider['chat']>(async () => ({ content: 'Done.', finishReason: 'stop', toolCalls: [], usage: {}, hasToolCalls: false, shouldExecuteTools: false }));
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat, chatStream: (m, t, _c, o) => chat(m, t, o) };
  const result = await new AgentRunner(provider).run({ ...runtimeSpec(policy), initialMessages: [], model: 'fixture',
    tools: new ToolRegistry(), maxToolResultChars: 100, hook: new NoopHook() });
  expect(result.stopReason).toBe('completed');
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps ordinary chat protected by the default model timer, while caller options take priority', async () => {
  vi.useFakeTimers(); vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', undefined);
  const chat = vi.fn<LLMProvider['chat']>(() => new Promise(() => {}));
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat, chatStream: (m, t, _c, o) => chat(m, t, o) };
  const spec: AgentRunSpec = { ...runtimeSpec(resolveRuntimePolicy('chat', { env: {} })), initialMessages: [],
    model: 'fixture', tools: new ToolRegistry(), maxToolResultChars: 100, hook: new NoopHook() };
  expect(spec.llmTimeoutS).toBeUndefined();
  const pending = new AgentRunner(provider).run(spec);
  await vi.advanceTimersByTimeAsync(300_000);
  expect((await pending).resolution?.reasonCode).toBe('MODEL_REQUEST_TIMEOUT');
  expect(chat).toHaveBeenCalledTimes(1);
  vi.stubEnv('NANOBOT_LLM_TIMEOUT_S', 'abc');
  const invalid = await new AgentRunner(provider).run(spec);
  expect(invalid.resolution?.reasonCode).toBe('INVALID_POLICY');
  expect(chat).toHaveBeenCalledTimes(1);
  const override = new AgentRunner(provider).run({ ...spec, llmTimeoutS: 0.1 });
  await vi.advanceTimersByTimeAsync(100);
  expect((await override).resolution?.reasonCode).toBe('MODEL_REQUEST_TIMEOUT');
  expect(chat).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
