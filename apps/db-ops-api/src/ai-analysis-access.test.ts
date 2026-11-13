import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: () => ({ execute }) } }));
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { analysisAccessSql, canReadAnalysis } from './analysis/analysis-access.js';

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
    const records = await aiAnalysisDatabaseService.getAnalysisList({ limit: 1 }, actor);
    expect(records).toEqual([]);
  });

  const rows = [
    { target_type: 'instance', instance_id: 10, server_id: null, network_device_id: null },
    { target_type: 'server', instance_id: null, server_id: 20, network_device_id: null },
    { target_type: 'network_device', instance_id: null, server_id: null, network_device_id: 30 },
  ];

  it.each([
    [{ ...actor, instanceScopes: { 10: 'read-only' } }, [true, false, false]],
    [{ ...actor, permissions: ['servers:view'] }, [false, true, false]],
    [{ ...actor, permissions: ['network_devices:*'] }, [false, false, true]],
    [{ ...actor, permissions: ['instance:*'] }, [true, false, false]],
    [{ ...actor, permissions: ['*'] }, [true, true, true]],
    [{ ...actor, permissions: ['*:view'] }, [false, false, false]],
    [{ ...actor, roles: ['admin'] }, [false, false, false]],
  ] as const)('matches existing resource read grants for %j', (current, expected) => {
    expect(rows.map(row => canReadAnalysis(current, row))).toEqual(expected);
  });

  it.each([null, '', 'global', 'SERVER', 'server ', 'network-device', 'unknown'])('rejects unsupported target %j even for wildcard users', target => {
    expect(canReadAnalysis({ ...actor, permissions: ['*'] }, { ...rows[1], target_type: target as any })).toBe(false);
  });

  it.each([null, 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '20', undefined])('rejects missing or invalid selected ID %j', id => {
    expect(canReadAnalysis({ ...actor, permissions: ['*'] }, { ...rows[1], server_id: id as any })).toBe(false);
  });

  it('denies NULL-only and conflicting subjects; never infers a global record', () => {
    const current = { ...actor, permissions: ['*'] };
    expect(canReadAnalysis(current, { ...rows[0], instance_id: null })).toBe(false);
    expect(canReadAnalysis(current, { ...rows[1], instance_id: 10 })).toBe(false);
    expect(canReadAnalysis(current, { ...rows[2], server_id: 20 })).toBe(false);
  });

  it('intersects wildcard permissions with the server-owned delegation ceiling', () => {
    const current = { ...actor, permissions: ['*'], resourceBoundary: { instanceIds: [10], serverIds: [], networkDeviceIds: [30] } };
    expect(rows.map(row => canReadAnalysis(current, row))).toEqual([true, false, true]);
    expect(analysisAccessSql(current).params).toEqual([10, 30]);
    expect(analysisAccessSql({ ...current, permissions: [] }).sql).toBe('1 = 0');
  });

  it('constrains the query before pagination and filters a malformed database result again', async () => {
    execute.mockResolvedValue([[{ id: 1, ...rows[0] }, { id: 2, ...rows[1] }]]);
    const current: ActorContext = { ...actor, instanceScopes: { 10: 'read-only', 11: 'read-only' }, resourceBoundary: { instanceIds: [10], serverIds: [], networkDeviceIds: [] } };
    const records = await aiAnalysisDatabaseService.getAnalysisList({ instance_id: 10, status: 'completed', limit: 1, offset: 1 }, current);
    expect(records.map(row => row.id)).toEqual([1]);
    const [sql, params] = execute.mock.calls[0];
    expect(sql.indexOf('instance_id IN (?)')).toBeLessThan(sql.indexOf('ORDER BY'));
    expect(sql).toContain('ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 1');
    expect(params).toEqual([10, 10, 'completed']);
  });
});
