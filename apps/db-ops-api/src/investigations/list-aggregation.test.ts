import { describe, expect, it } from 'vitest';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { MysqlInvestigationStore, InvestigationStoreError, type InvestigationActor } from './store.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 0, 0, n));
type Resource = { type: 'instance' | 'server' | 'network_device'; id: number; role: 'primary' | 'related' };
type Investigation = {
  id: string; title: string; goal: string; profile_id: 'ops' | 'system'; profile_version: number;
  session_id: string; owner_kind: 'user' | 'service'; owner_id: number; scope_version: string;
  lifecycle: 'open'; problem_status: 'unconfirmed'; version: number; active_request_id: null;
  created_at: Date; updated_at: Date; resources: Resource[];
};

function actor(userId: number, permissions: string[], scopes: number[], boundary?: ActorContext['resourceBoundary']): ActorContext {
  return { userId, username: `user-${userId}`, roles: ['reader'], permissions, sessionVersion: 1,
    instanceScopes: Object.fromEntries(scopes.map(scope => [scope, 'read-only' as const])), requestId: 'list-aggregation',
    ...(boundary ? { resourceBoundary: boundary } : {}) };
}
function row(userId: number, permission: string | null, instance: number | null) {
  return { id: userId, username: `user-${userId}`, status: 'active', password_hash: 'not-a-service', session_version: 1,
    role_name: 'reader', permission_code: permission, instance_id: instance, access_level: instance === null ? null : 'read-only' };
}

describe('investigation list authority aggregation', () => {
  const expired = new Date(Date.now() - 86_400_000);
  const investigations: Investigation[] = [
    { id: id(3), title: 'alpha hidden', goal: 'secret', profile_id: 'ops', profile_version: 1, session_id: 's3', owner_kind: 'user', owner_id: 200, scope_version: 'a'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(1000), resources: [{ type: 'instance', id: 101, role: 'primary' }] },
    { id: id(10), title: 'beta server', goal: 'capacity', profile_id: 'ops', profile_version: 1, session_id: 's10', owner_kind: 'user', owner_id: 101, scope_version: 'b'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(900), resources: [{ type: 'server', id: 7, role: 'primary' }] },
    { id: id(4), title: 'alpha missing instance', goal: 'secret', profile_id: 'ops', profile_version: 1, session_id: 's4', owner_kind: 'user', owner_id: 101, scope_version: 'c'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(800), resources: [{ type: 'instance', id: 999, role: 'primary' }] },
    { id: id(6), title: 'alpha system', goal: 'platform', profile_id: 'system', profile_version: 1, session_id: 's6', owner_kind: 'user', owner_id: 101, scope_version: 'd'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(700), resources: [] },
    { id: id(2), title: 'beta member', goal: 'shared', profile_id: 'ops', profile_version: 1, session_id: 's2', owner_kind: 'user', owner_id: 200, scope_version: 'e'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(600), resources: [{ type: 'instance', id: 101, role: 'primary' }] },
    { id: id(8), title: 'beta expired', goal: 'old', profile_id: 'ops', profile_version: 1, session_id: 's8', owner_kind: 'user', owner_id: 200, scope_version: 'f'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(500), resources: [{ type: 'instance', id: 101, role: 'primary' }] },
    { id: id(1), title: 'alpha one', goal: 'owned', profile_id: 'ops', profile_version: 1, session_id: 's1', owner_kind: 'user', owner_id: 101, scope_version: 'g'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(400), resources: [{ type: 'instance', id: 101, role: 'related' }] },
    { id: id(9), title: 'beta outside scope', goal: 'other instance', profile_id: 'ops', profile_version: 1, session_id: 's9', owner_kind: 'user', owner_id: 101, scope_version: 'h'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(300), resources: [{ type: 'instance', id: 102, role: 'primary' }] },
    { id: id(5), title: 'beta missing server', goal: 'gone', profile_id: 'ops', profile_version: 1, session_id: 's5', owner_kind: 'user', owner_id: 101, scope_version: 'i'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(200), resources: [{ type: 'server', id: 5, role: 'primary' }] },
    { id: id(7), title: 'beta retired', goal: 'unavailable', profile_id: 'ops', profile_version: 1, session_id: 's7', owner_kind: 'user', owner_id: 101, scope_version: 'j'.repeat(64), lifecycle: 'open', problem_status: 'unconfirmed', version: 1, active_request_id: null, created_at: at(1), updated_at: at(100), resources: [{ type: 'instance', id: 50, role: 'primary' }] },
  ];
  const members = [
    { investigation_id: id(2), user_id: 101, role: 'viewer', expires_at: null as Date | null },
    { investigation_id: id(8), user_id: 101, role: 'viewer', expires_at: expired },
    { investigation_id: id(1), user_id: 104, role: 'viewer', expires_at: null as Date | null },
  ];
  const instances = [{ id: 101, lifecycle_state: 'available' }, { id: 102, lifecycle_state: 'available' }, { id: 50, lifecycle_state: 'retired' }];
  const servers = [{ id: 7 }];
  const snapshots = new Map<string, { context: { subject: { kind: 'platform'; component: string } } }>([
    [id(6), { context: { subject: { kind: 'platform', component: 'api' } } }],
    [id(3), { context: { subject: { kind: 'platform', component: 'hidden' } } }],
  ]);
  const permissions = new Map<number, string[]>([
    [101, ['chat:view', 'instance:view', 'servers:view', 'network_devices:view', 'config:view']],
    [102, ['chat:view', 'instance:view', 'servers:view', 'network_devices:view']],
    [104, ['instance:view']],
  ]);
  const scopes = new Map<number, number[]>([[101, [101, 50]], [102, [101, 50]], [104, [101, 50]]]);

  function database(failActor = false) {
    const sql: { sql: string; values: unknown[] }[] = [];
    const active = (expiresAt: Date | null) => !expiresAt || expiresAt.getTime() > Date.now();
    const execute = async (statement: string, values: unknown[] = []) => {
      sql.push({ sql: statement, values });
      if (statement.includes('FROM users u')) {
        if (failActor) throw new Error('ACTOR_SQL_DOWN');
        const userId = Number(values[0]);
        const perms = permissions.get(userId) ?? [];
        const scopeIds = scopes.get(userId) ?? [];
        const rows = perms.flatMap(permission => (scopeIds.length ? scopeIds : [null]).map(instance => row(userId, permission, instance)));
        return [rows.length ? rows : []];
      }
      if (statement.includes('investigation_members')) {
        if (statement.includes('investigation_id = ?') && statement.includes('user_id = ?')) {
          const found = members.filter(member => member.investigation_id === values[0] && member.user_id === values[1] && active(member.expires_at));
          return [found.map(member => ({ role: member.role }))];
        }
        const found = members.filter(member => member.user_id === values[0] && active(member.expires_at));
        return [found.map(member => ({ investigation_id: member.investigation_id, role: member.role }))];
      }
      if (statement.includes('investigation_create_keys')) {
        const ids = statement.includes('IN (') ? values.map(String) : [String(values[0])];
        const found = ids.filter(item => snapshots.has(item)).map(item => ({ investigation_id: item, command_snapshot: snapshots.get(item) }));
        return [statement.includes('investigation_id, command_snapshot') ? found : found.slice(0, 1).map(item => ({ command_snapshot: item.command_snapshot }))];
      }
      if (statement.includes('investigation_resources')) {
        const source = statement.includes('WHERE i.lifecycle = ?')
          ? investigations.filter(item => item.lifecycle === values[0])
          : statement.includes('investigation_id = ?')
            ? investigations.filter(item => item.id === values[0])
            : investigations;
        const resources = source.flatMap(item => item.resources.map(resource => ({ investigation_id: item.id, resource_type: resource.type, resource_id: resource.id, role: resource.role })))
          .sort((a, b) => a.investigation_id.localeCompare(b.investigation_id) || a.resource_type.localeCompare(b.resource_type) || a.resource_id - b.resource_id);
        return [statement.includes('investigation_id = ?') ? resources.map(({ resource_type, resource_id, role }) => ({ resource_type, resource_id, role })) : resources];
      }
      if (statement.includes('FROM investigations')) {
        const source = statement.includes('WHERE lifecycle = ?') ? investigations.filter(item => item.lifecycle === values[0]) : investigations;
        return [[...source].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.id.localeCompare(a.id))];
      }
      if (statement.includes('database_instances')) {
        const ids = statement.includes('IN (') ? values.map(Number) : [Number(values[0])];
        return [instances.filter(item => ids.includes(item.id) && item.lifecycle_state === 'available').map(item => ({ id: item.id }))];
      }
      if (statement.includes('network_devices')) return [[]];
      if (statement.includes('servers')) {
        const ids = statement.includes('IN (') ? values.map(Number) : [Number(values[0])];
        return [servers.filter(item => ids.includes(item.id)).map(item => ({ id: item.id }))];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    };
    const connection = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    const pool = { getConnection: async () => connection };
    return { sql, pool };
  }

  const caller = actor(101, permissions.get(101)!, scopes.get(101)!);
  const principal: InvestigationActor = { kind: 'user', id: 101 };

  async function listed(limit = 50, offset = 0, extra: Record<string, unknown> = {}) {
    const db = database();
    const store = new MysqlInvestigationStore(() => db.pool as never, new InvestigationAuthorization(new ActorContextService()).forActor(caller));
    const page = await store.list(principal, { limit, offset, ...extra });
    return { ...db, page };
  }

  it('keeps the same visible rows and count while issuing one authority read per predicate', async () => {
    const aggregated = await listed();
    const oracleDb = database();
    const oracle = new InvestigationAuthorization(new ActorContextService()).forActor(caller);
    const oracleConnection = await oracleDb.pool.getConnection();
    const oracleIds: string[] = [];
    for (const item of [...investigations].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime() || b.id.localeCompare(a.id))) {
      try {
        await oracle(oracleConnection as never, principal, { id: item.id, sessionId: item.session_id, profileId: item.profile_id,
          profileVersion: item.profile_version, scopeVersion: item.scope_version, lifecycle: item.lifecycle, version: item.version,
          owner: { kind: item.owner_kind, id: item.owner_id }, resources: item.resources }, 'read');
        oracleIds.push(item.id);
      } catch (error) {
        if (!(error instanceof InvestigationStoreError) || error.code !== 'INVESTIGATION_NOT_FOUND') throw error;
      }
    }
    expect(oracleIds).toEqual([id(10), id(6), id(2), id(1)]);
    expect(aggregated.page.total).toBe(oracleIds.length);
    expect(aggregated.page.items.map(item => item.id)).toEqual(oracleIds);
    expect(aggregated.page.items.find(item => item.id === id(6))?.context).toEqual({ subject: { kind: 'platform', component: 'api' } });
    expect(aggregated.page.items.some(item => item.id === id(3) || JSON.stringify(item).includes('hidden'))).toBe(false);
    const count = (fragment: string) => aggregated.sql.filter(entry => entry.sql.includes(fragment)).length;
    expect(count('FROM users u')).toBe(1);
    expect(count('investigation_members')).toBe(1);
    expect(count('database_instances')).toBe(1);
    expect(count('investigation_resources')).toBe(1);
    expect(count('investigation_id = ?')).toBe(0);
    const snapshots = aggregated.sql.filter(entry => entry.sql.includes('investigation_create_keys'));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].values).toEqual(oracleIds);
    expect(snapshots[0].values).not.toContain(id(3));
  });

  it('paginates only authorized rows and still applies filters after authority', async () => {
    const first = await listed(2, 0);
    const second = await listed(2, 2);
    expect(first.page.total).toBe(4);
    expect(first.page.items.map(item => item.id)).toEqual([id(10), id(6)]);
    expect(second.page.items.map(item => item.id)).toEqual([id(2), id(1)]);
    const queried = await listed(50, 0, { query: 'alpha' });
    expect(queried.page.items.map(item => item.id)).toEqual([id(6), id(1)]);
    const resource = await listed(50, 0, { resource: { type: 'instance', id: 101 } });
    expect(resource.page.items.map(item => item.id)).toEqual([id(2), id(1)]);
    const bounded = actor(101, permissions.get(101)!, scopes.get(101)!, { instanceIds: [101], serverIds: [], networkDeviceIds: [] });
    const db = database();
    const page = await new MysqlInvestigationStore(() => db.pool as never, new InvestigationAuthorization(new ActorContextService()).forActor(bounded))
      .list(principal, { limit: 50 });
    expect(page.items.map(item => item.id)).toEqual([id(6), id(2), id(1)]);
    const noConfig = database();
    const withoutConfig = await new MysqlInvestigationStore(() => noConfig.pool as never,
      new InvestigationAuthorization(new ActorContextService()).forActor(actor(101, permissions.get(101)!.filter(code => code !== 'config:view'), scopes.get(101)!)))
      .list(principal, { limit: 50 });
    expect(withoutConfig.items.map(item => item.id)).toEqual([id(10), id(2), id(1)]);
    const noChat = database();
    const denied = await new MysqlInvestigationStore(() => noChat.pool as never,
      new InvestigationAuthorization(new ActorContextService()).forActor(actor(104, permissions.get(104)!, scopes.get(104)!)))
      .list({ kind: 'user', id: 104 }, { limit: 50 });
    expect(denied).toEqual({ items: [], total: 0 });
    expect(JSON.stringify(denied)).not.toContain(id(3));
  });

  it('reports authority infrastructure failure instead of an empty authorized count', async () => {
    const db = database(true);
    const store = new MysqlInvestigationStore(() => db.pool as never, new InvestigationAuthorization(new ActorContextService()).forActor(caller));
    await expect(store.list(principal, { limit: 20 })).rejects.toMatchObject({ statusCode: 503, code: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
  });

  it('keeps the per-row authority path when the test-only legacy switch is set', async () => {
    const previous = process.env.INVESTIGATION_LIST_AGGREGATION;
    process.env.INVESTIGATION_LIST_AGGREGATION = '0';
    try {
      const legacy = await listed();
      expect(legacy.page.items.map(item => item.id)).toEqual([id(10), id(6), id(2), id(1)]);
      expect(legacy.page.total).toBe(4);
      expect(legacy.sql.filter(entry => entry.sql.includes('FROM users u'))).toHaveLength(investigations.length);
      expect(legacy.sql.filter(entry => entry.sql.includes('investigation_id = ?'))).not.toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.INVESTIGATION_LIST_AGGREGATION;
      else process.env.INVESTIGATION_LIST_AGGREGATION = previous;
    }
  });
});
