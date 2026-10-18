import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { INVESTIGATION_SERVICE_PASSWORD } from '../auth/investigation-service-identity.js';
import { InvestigationProfileSchema } from './contracts.js';
import { INVESTIGATION_PROFILES, INVESTIGATION_PROMPTS, investigationProfileHash, resolveInvestigationProfile } from './profiles.js';
import { InvestigationAuthorization } from './authorization.js';
import type { AdmissionInvestigation } from './store.js';

describe('repository Profile and service identity authority', () => {
  it('rejects unknown deployment tool ceilings without selecting a broader mode', () => {
    const previous = process.env.INVESTIGATION_SOURCE_TOOL_CEILING;
    try {
      process.env.INVESTIGATION_SOURCE_TOOL_CEILING = 'unknown';
      expect(() => new InvestigationAuthorization()).toThrow('INVESTIGATION_SOURCE_TOOL_CEILING_INVALID');
    } finally {
      if (previous === undefined) delete process.env.INVESTIGATION_SOURCE_TOOL_CEILING;
      else process.env.INVESTIGATION_SOURCE_TOOL_CEILING = previous;
    }
  });

  it('both immutable profiles follow the public schema and deterministic content hash', () => {
    for (const profile of Object.values(INVESTIGATION_PROFILES)) {
      expect(Value.Check(InvestigationProfileSchema, profile)).toBe(true);
      expect(investigationProfileHash(profile)).toMatch(/^[a-f0-9]{64}$/);
      expect(investigationProfileHash(profile)).toBe(investigationProfileHash(JSON.parse(JSON.stringify(profile))));
      expect(Object.isFrozen(profile.toolAllowlist)).toBe(true);
      expect(INVESTIGATION_PROMPTS[profile.id]).toContain('不可信证据');
      for (const unsafe of ['execute_code', 'spawn_subagent', 'get_instance_connection', 'slide_update_db_config', 'discover_database_endpoints']) {
        expect(profile.toolAllowlist).not.toContain(unsafe);
      }
    }
    expect(() => resolveInvestigationProfile('ops', 2)).toThrow('PROFILE_SUBJECT_UNSUPPORTED');
    expect(() => resolveInvestigationProfile('model-selected', 1)).toThrow('PROFILE_SUBJECT_UNSUPPORTED');
  });

  const serviceRow = { id: 7, username: 'slide-investigation-ops', password_hash: INVESTIGATION_SERVICE_PASSWORD,
    status: 'active', session_version: 1, role_name: 'diagnostic', permission_code: 'chat:view', instance_id: null, access_level: null };
  const actor = (): ActorContext => ({ principalKind: 'service', userId: 7, username: serviceRow.username,
    sessionVersion: 1, roles: [], permissions: ['chat:view'], instanceScopes: {}, requestId: randomUUID() });

  it('service identity cannot load interactively, sign access tokens or issue refresh tokens', async () => {
    const pool = { execute: async () => [[serviceRow]] };
    const contexts = new ActorContextService(() => pool);
    expect(() => signAccessToken(actor(), 'test-only')).toThrow('Authentication failed');
    await expect(contexts.loadActiveActor(7)).rejects.toThrow('Authentication failed');
    await expect(contexts.issueRefreshToken(actor())).rejects.toThrow('Authentication failed');
    await expect(contexts.loadInvestigationActorFrom(pool, 7, 'service', 1)).resolves.toMatchObject({ principalKind: 'service', permissions: ['chat:view'] });
  });

  it.each([{ role_name: 'admin' }, { permission_code: '*' }, { permission_code: 'instance:*' }, { permission_code: 'instance:update' }, { status: 'inactive' }, { password_hash: 'changed' }])(
    'service identity fails closed on unsafe live state %j', async change => {
      const executor = { execute: async () => [[{ ...serviceRow, ...change }]] };
      await expect(new ActorContextService().loadInvestigationActorFrom(executor, 7, 'service', 1)).rejects.toThrow('Authentication failed');
    });

  it('store authority binds numeric kind/id and snapshots the caller before mutation', async () => {
    const caller = { ...actor(), principalKind: 'user' as const, permissions: ['chat:view'] };
    const authorizer = new InvestigationAuthorization().forActor(caller);
    caller.userId = 8;
    await expect(authorizer({} as never, { kind: 'user', id: 8 }, {} as AdmissionInvestigation, 'read'))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
