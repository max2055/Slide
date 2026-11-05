import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: () => ({ execute }) } }));
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';

const actor: ActorContext = {
  userId: 1, username: 'limited', roles: [], permissions: ['ai:view'],
  sessionVersion: 1, instanceScopes: {}, requestId: 'max331',
};

describe('MAX-331 analysis list resource authorization', () => {
  beforeEach(() => execute.mockReset());

  it.each(['server', 'network_device'])('hides private %s results with NULL instance_id', async target => {
    execute.mockResolvedValue([[{
      id: 1, target_type: target, instance_id: null,
      server_id: target === 'server' ? 99 : null,
      network_device_id: target === 'network_device' ? 99 : null,
      status: 'completed', result: 'private evidence',
    }]]);
    const records = await (aiAnalysisDatabaseService.getAnalysisList as any)({ limit: 1 }, actor);
    expect(records).toEqual([]);
  });
});
