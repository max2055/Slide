import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actorContextService, type ActorContext } from '../auth/actor-context.js';
import { AuditLogManager, MemoryAuditLogStore } from '../audit/audit-log.js';
import { registerSystemAuditRoutes } from '../audit/system-audit-routes.js';
import { dbConnection } from '../db-connection.js';
import { cronJobService } from './cron-job-service.js';
import { registerCronRoutes } from './cron-routes.js';
import type { CronManager } from './cron-manager.js';

const owner: ActorContext = {
  userId: 7, username: 'operator', roles: ['operator'], permissions: ['cron:view', 'cron:manage'],
  instanceScopes: { 42: 'read-write' }, sessionVersion: 1, requestId: 'cron-job-update',
};

function fixture(requester = owner, currentOwner = owner) {
  const job = {
    id: 1, name: '原任务名称', cron_expr: '0 0 * * *', enabled: 1, task_type: 'agent',
    target_instance_id: 42, owner_user_id: owner.userId, principal_type: 'user', identity_status: 'bound',
    resource_scope: { version: 1, targetInstanceId: 42, instanceIds: [42], serverIds: [], networkDeviceIds: [] },
  };
  const duplicateName = '另一项任务';
  const update = vi.fn((fields: Record<string, unknown>) => {
    if (fields.name === duplicateName) {
      throw Object.assign(new Error("Duplicate entry '另一项任务' for key 'cron_jobs.uk_name'"), { code: 'ER_DUP_ENTRY' });
    }
    for (const field of ['resource_scope', 'identity_audit']) {
      if (typeof fields[field] === 'string') fields[field] = JSON.parse(fields[field]);
    }
    Object.assign(job, fields);
    return [{ affectedRows: 1 }, []];
  });
  const execute = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT') && sql.includes('FROM cron_jobs')) {
      expect(values).toEqual([job.id]);
      return [[{ ...job }], []];
    }
    const assignments = /^UPDATE cron_jobs SET (.+) WHERE id = \?$/.exec(sql)?.[1];
    if (!assignments) throw new Error(`Unexpected SQL: ${sql}`);
    expect(values.at(-1)).toBe(job.id);
    return update(Object.fromEntries(assignments.split(', ').map((assignment, index) => [assignment.slice(0, -4), values[index]])));
  });
  vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as any);
  vi.spyOn(actorContextService, 'loadActiveActor').mockResolvedValue(currentOwner);
  const reload = vi.fn(async () => {});
  const app = Fastify();
  app.addHook('onSend', async (_request, _reply, payload) => {
    if (payload !== undefined) await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  registerCronRoutes(app, async request => { (request as any).user = requester; }, () => ({ reload }) as unknown as CronManager);
  const url = '/api/cron/jobs/1';
  return { app, url, duplicateName, reload, update };
}

afterEach(() => vi.restoreAllMocks());

describe('T04 cron job update persistence', () => {
  it('reads back the edited name and schedule from the normal GET and preserves omitted fields', async () => {
    const { app, url, reload, update } = fixture();
    const cron_expr = '5 12 * * *';
    try {
      const edited = await app.inject({ method: 'PUT', url, payload: { name: '更新后的任务名称', cron_expr } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toEqual({ message: '更新成功' });
      expect((await app.inject({ url })).json()).toMatchObject({ name: '更新后的任务名称', cron_expr, enabled: true });

      const renamed = await app.inject({ method: 'PUT', url, payload: { name: '仅更新名称' } });
      expect(renamed.statusCode).toBe(200);
      expect((await app.inject({ url })).json()).toMatchObject({ name: '仅更新名称', cron_expr, enabled: true });

      const disabled = await app.inject({ method: 'PUT', url, payload: { enabled: false } });
      expect(disabled.statusCode).toBe(200);
      expect((await app.inject({ url })).json()).toMatchObject({ name: '仅更新名称', cron_expr, enabled: false });
      expect(update).toHaveBeenCalledTimes(3);
      expect(reload).toHaveBeenCalledTimes(3);
    } finally { await app.close(); }
  });

  it.each([null, 7, '', ' \t', '中'.repeat(101)])('rejects an invalid name without persisting other edits (%j)', async name => {
    const { app, url, reload, update } = fixture();
    try {
      const rejected = await app.inject({ method: 'PUT', url, payload: { name, cron_expr: '5 12 * * *' } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ error: 'CRON_INVALID_JOB_NAME' });
      expect(update).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('reports a sanitized name conflict and leaves the schedule unchanged', async () => {
    const { app, url, reload, duplicateName, update } = fixture();
    try {
      const result = await app.inject({ method: 'PUT', url, payload: { name: duplicateName, cron_expr: '5 12 * * *' } });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toEqual({ error: 'CRON_JOB_NAME_CONFLICT' });
      expect((await app.inject({ url })).json()).toMatchObject({ name: '原任务名称', cron_expr: '0 0 * * *' });
      expect(update).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([
    { reason: 'route permission', requester: { ...owner, permissions: ['cron:view'] }, currentOwner: owner, status: 403 },
    { reason: 'target access', requester: { ...owner, instanceScopes: { 42: 'read-only' as const } }, currentOwner: owner, status: 404 },
    { reason: 'revoked owner permission', requester: owner, currentOwner: { ...owner, permissions: ['cron:view'] }, status: 403 },
  ])('denies renaming on $reason', async ({ requester, currentOwner, status }) => {
    const { app, url, reload, update } = fixture(requester, currentOwner);
    try {
      const result = await app.inject({ method: 'PUT', url, payload: { name: '未授权更名' } });
      expect(result.statusCode).toBe(status);
      expect(update).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([
    { method: 'POST' as const, suffix: '/toggle', action: 'POST /api/cron/jobs/:id/toggle', message: '已停用' },
    { method: 'DELETE' as const, suffix: '', action: 'DELETE /api/cron/jobs/:id', message: '删除成功' },
  ])('returns the $method receipt with its successful audit', async ({ method, suffix, action, message }) => {
    const { app, url, reload } = fixture();
    const store = new MemoryAuditLogStore();
    await registerSystemAuditRoutes(app, async () => {}, new AuditLogManager(store));
    const toggle = vi.spyOn(cronJobService, 'toggleJob').mockResolvedValue(true);
    const remove = vi.spyOn(cronJobService, 'deleteJob').mockResolvedValue(true);
    try {
      const receipt = await app.inject({ method, url: url + suffix, payload: method === 'POST' ? { enabled: false } : undefined });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json()).toEqual({ message });
      expect(toggle).toHaveBeenCalledTimes(method === 'POST' ? 1 : 0);
      expect(remove).toHaveBeenCalledTimes(method === 'DELETE' ? 1 : 0);
      expect(reload).toHaveBeenCalledTimes(1);
      expect((await store.query({ resourceType: 'cron', resourceId: '1' })).entries).toEqual([
        expect.objectContaining({ userId: String(owner.userId), action, result: 'success', details: expect.objectContaining({ statusCode: 200 }) }),
      ]);
    } finally { await app.close(); }
  });
});
