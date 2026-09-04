import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { registerFeedbackRoutes } from './feedback-routes.js';

const testActor: ActorContext = {
  userId: 7,
  username: 'alice',
  roles: [],
  permissions: [],
  sessionVersion: 1,
  instanceScopes: {},
  requestId: 'feedback-route-test',
};

const item = {
  id: 3,
  title: '连接页报错',
  description: '用户在连接页保存配置时看到错误提示。',
  source: 'manual' as const,
  createdBy: 7,
  createdByUsername: 'alice',
  createdAt: new Date('2026-09-04T00:00:00Z'),
  updatedAt: new Date('2026-09-04T01:00:00Z'),
};

async function appWith(service: any) {
  const app = Fastify();
  await registerFeedbackRoutes(app, async (request) => { (request as any).user = testActor; }, service);
  return app;
}

describe('feedback routes', () => {
  it('lists feedback and serializes timestamps', async () => {
    const service = { list: vi.fn().mockResolvedValue([item]), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
    const app = await appWith(service);
    const response = await app.inject({ method: 'GET', url: '/api/feedback' });
    expect(response.statusCode).toBe(200);
    expect(response.json().feedback[0]).toMatchObject({ id: 3, createdAt: '2026-09-04T00:00:00.000Z' });
    expect(service.list).toHaveBeenCalledWith(testActor);
    await app.close();
  });

  it('creates, updates, and deletes feedback with strict payloads', async () => {
    const service = {
      list: vi.fn(),
      create: vi.fn().mockResolvedValue(item),
      update: vi.fn().mockResolvedValue({ ...item, title: '更新后的标题' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const app = await appWith(service);

    const created = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { title: '连接页报错', description: '用户在连接页保存配置时看到错误提示。' },
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(testActor, expect.objectContaining({ source: 'manual' }));

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/feedback/3',
      payload: { title: '更新后的标题', description: '用户仍然看到错误提示。' },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.update).toHaveBeenCalledWith(testActor, 3, expect.objectContaining({ title: '更新后的标题' }));

    const deleted = await app.inject({ method: 'DELETE', url: '/api/feedback/3' });
    expect(deleted.statusCode).toBe(200);
    expect(service.delete).toHaveBeenCalledWith(testActor, 3);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { title: '标题', description: '描述', source: 'agent' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('maps invisible feedback to not found without exposing ownership', async () => {
    const service = {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error('FEEDBACK_NOT_FOUND')),
      delete: vi.fn(),
    };
    const app = await appWith(service);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/feedback/99',
      payload: { title: '标题', description: '描述' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'FEEDBACK_NOT_FOUND' });
    await app.close();
  });
});
