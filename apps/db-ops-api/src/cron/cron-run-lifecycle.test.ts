import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerChatRoutes } from '../chat-routes.js';
import { registerHttpSecurity } from '../security/http-security.js';
import { registerCronRoutes } from './cron-routes.js';
import { cronJobService } from './cron-job-service.js';
import { cronRunStore } from './cron-run-store.js';

const run = { runId: 'f8479ecf-2130-4c4b-bfa9-1e7369f397c2', jobId: 41, status: 'queued', triggeredBy: 7 };
const job = { id: 41, owner_user_id: 8, target_instance_id: 12 };
const endpoints = [
  { name: 'enqueue', method: 'POST', path: '/api/cron/jobs/41/run' },
  { name: 'runId', method: 'GET', path: `/api/cron/jobs/41/runs/${run.runId}` },
  { name: 'requestKey', method: 'GET', path: '/api/cron/jobs/41/runs?requestKey=socket-key' },
];
const scenarios = ['success', 'missing-job', 'scope-denied', 'permission-denied', 'lookup-error',
  'operation-error', 'invalid-input', 'missing-run', 'foreign-run'] as const;

for (const endpoint of endpoints) {
  for (const scenario of scenarios) {
    if (scenario === 'missing-run' && endpoint.name === 'enqueue') continue;
    if (scenario === 'invalid-input' && endpoint.name === 'runId') continue;
    if (scenario === 'foreign-run' && endpoint.name !== 'runId') continue;
    it(`MAX-684 socket ${endpoint.name} ${scenario} keeps JSON and single-enqueue/noReplay semantics`, async () => {
      const app = Fastify();
      const actor = { userId: 7, roles: [], permissions: scenario === 'permission-denied' ? [] : ['cron:manage', 'cron:view'],
        instanceScopes: scenario === 'scope-denied' ? {} : { 12: 'read-write' } };
      const lookup = vi.spyOn(cronJobService, 'getJobById').mockResolvedValue(scenario === 'missing-job' ? null : job as any);
      if (scenario === 'lookup-error') lookup.mockRejectedValue(new Error('CRON_STORAGE_UNAVAILABLE'));
      const triggerJob = vi.fn(async () => run);
      const get = vi.spyOn(cronRunStore, 'get').mockResolvedValue(scenario === 'missing-run' ? null : scenario === 'foreign-run' ? { ...run, jobId: 42 } as any : run as any);
      const find = vi.spyOn(cronRunStore, 'findRequest').mockResolvedValue(scenario === 'missing-run' ? null : run as any);
      if (scenario === 'operation-error') {
        triggerJob.mockRejectedValue(new Error('CRON_IDEMPOTENCY_CONFLICT'));
        get.mockRejectedValue(new Error('CRON_RUN_STORE_UNAVAILABLE'));
        find.mockRejectedValue(new Error('CRON_RUN_STORE_UNAVAILABLE'));
      }
      const verifyToken = async (request: any) => { request.user = actor; };
      try {
        app.addHook('onSend', async (_request, _reply, payload) => payload);
        await registerHttpSecurity(app);
        await registerChatRoutes(app, { verifyToken, service: {} as any, handleChatSend: vi.fn() });
        registerCronRoutes(app, verifyToken, () => ({ triggerJob } as any));
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const path = scenario === 'invalid-input' && endpoint.name === 'requestKey' ? '/api/cron/jobs/41/runs' : endpoint.path;
        const response = await fetch(address + path, { method: endpoint.method,
          headers: { 'content-type': 'application/json', 'idempotency-key': 'socket-key' },
          ...(endpoint.method === 'POST' ? { body: JSON.stringify(scenario === 'invalid-input' ? { unexpected: true } : {}) } : {}) });
        let expectedStatus = 200;
        let expected: unknown = run;
        if (scenario === 'success') {
          if (endpoint.name === 'enqueue') {
            expectedStatus = 202;
            expected = { runId: run.runId, jobId: 41, status: 'queued', message: '已接受执行，结果请按 runId 查询' };
          }
        } else if (scenario === 'missing-job' || scenario === 'scope-denied') {
          expectedStatus = 404; expected = { error: '定时任务不存在' };
        } else if (scenario === 'permission-denied') {
          expectedStatus = 403; expected = { error: '权限不足' };
        } else if (scenario === 'lookup-error') {
          expectedStatus = 503; expected = { error: 'CRON_STORAGE_UNAVAILABLE' };
        } else if (scenario === 'operation-error') {
          expectedStatus = endpoint.name === 'enqueue' ? 409 : 503;
          expected = { error: endpoint.name === 'enqueue' ? 'CRON_IDEMPOTENCY_CONFLICT' : 'CRON_RUN_STORE_UNAVAILABLE' };
        } else if (scenario === 'invalid-input') {
          expectedStatus = 400;
          expected = { error: endpoint.name === 'enqueue' ? 'CRON_RUN_PARAMS_UNSUPPORTED' : 'CRON_IDEMPOTENCY_KEY_INVALID' };
        } else if (scenario === 'missing-run' || scenario === 'foreign-run') {
          expectedStatus = 404; expected = { error: 'CRON_RUN_NOT_FOUND' };
        }
        // Production security hook masks these storage 5xx errors; preserve that contract.
        if (expectedStatus >= 500) expected = { error: 'INTERNAL_ERROR' };
        expect(response.status).toBe(expectedStatus);
        const operationReached = scenario === 'success' || scenario === 'operation-error' || scenario === 'missing-run'
          || scenario === 'foreign-run';
        expect(triggerJob).toHaveBeenCalledTimes(endpoint.name === 'enqueue' && operationReached ? 1 : 0);
        expect(get).toHaveBeenCalledTimes(endpoint.name === 'runId' && operationReached ? 1 : 0);
        expect(find).toHaveBeenCalledTimes(endpoint.name === 'requestKey' && operationReached ? 1 : 0);
        if (endpoint.name === 'enqueue' && operationReached) expect(triggerJob).toHaveBeenCalledWith(job, actor, 'socket-key', {});
        if (endpoint.name === 'requestKey' && operationReached) expect(find).toHaveBeenCalledWith(41, 7, 'socket-key');
        if (endpoint.name === 'runId' && operationReached) expect(get).toHaveBeenCalledWith(run.runId);
        const body = await response.text();
        expect(Buffer.byteLength(body)).toBeGreaterThan(0);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(JSON.parse(body)).toEqual(expected);
      } finally {
        await app.close();
        vi.restoreAllMocks();
      }
    });
  }
}
