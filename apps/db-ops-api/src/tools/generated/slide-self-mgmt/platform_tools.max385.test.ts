import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { platformLogs, StructuredLogEvidenceAdapter } from '../../../platform/structured-log-evidence-adapter.js';
import { platformTools } from './platform_tools.js';

// MAX-385 / GitHub #614: production handlers and requireSourceReader, injected actor (no JWT).
const actor: ActorContext = {
  userId: 385, username: 'max385-reader', roles: [], permissions: [],
  instanceScopes: {}, requestId: 'max385', sessionVersion: 1,
};
const tool = platformTools.find(tool => tool.name === 'get_platform_observations')!;
const failure = (code: string) => ({ success: false, error: code, errorCode: code });
afterEach(() => vi.restoreAllMocks());

describe('MAX-385 platform observation authorization', () => {
  it.each([[], ['database:view'], ['config:edit'], ['CONFIG:VIEW'], ['config:view:extra'], ['config_view']].map(permissions => ({ permissions })))(
    'returns SOURCE_READ_FORBIDDEN before reading observations for $permissions', async ({ permissions }) => {
      const query = vi.spyOn(platformLogs, 'query');
      expect(await tool.handler({}, { actor: { ...actor, permissions } })).toEqual(failure('SOURCE_READ_FORBIDDEN'));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, { userId: 385, userRole: 'admin', sessionId: 'session' }])(
    'requires a server actor even if arguments or session fields claim permissions', async context => {
      const query = vi.spyOn(platformLogs, 'query');
      expect(await tool.handler({ actor: { ...actor, permissions: ['*'] }, permissions: ['*'] }, context))
        .toEqual(failure('MISSING_ACTOR'));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(['config:view', 'config:*', 'admin:*', '*'])('allows %s through the real query implementation', async permission => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const logs = new StructuredLogEvidenceAdapter(() => now);
    logs.record({ component: 'max385', eventType: 'request.completed', status: 'failed', errorCode: 'TEST_FAILURE' });
    const args = { from: new Date(now).toISOString(), to: new Date(now).toISOString(), component: 'max385' };
    const query = vi.spyOn(platformLogs, 'query').mockImplementation(options => logs.query(options));
    const result = await tool.handler(args, { actor: { ...actor, permissions: [permission] } });
    expect(result).toEqual({ success: true, data: logs.query(args) });
    expect(result.data).toMatchObject({ groups: [{ component: 'max385', count: 1, failures: 1 }] });
    expect(query).toHaveBeenCalledExactlyOnceWith(args);
  });

  it('rechecks permissions on each invocation after an actor grant changes', async () => {
    const query = vi.spyOn(platformLogs, 'query');
    expect((await tool.handler({}, { actor: { ...actor, permissions: ['config:view'] } })).success).toBe(true);
    query.mockClear();
    expect(await tool.handler({}, { actor })).toEqual(failure('SOURCE_READ_FORBIDDEN'));
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps a real query validation failure unavailable', async () => {
    expect(await tool.handler({ from: 'invalid-date' }, { actor: { ...actor, permissions: ['config:view'] } }))
      .toEqual(failure('PLATFORM_OBSERVATION_UNAVAILABLE'));
  });

  it.each([
    new Error('SELECT secret FROM private_table; /private/logs/runtime.log password=synthetic-secret'),
    new Error('SOURCE_STORAGE_UNAVAILABLE'), new Error('SOURCE_READ_FORBIDDEN'),
    new Error('SOURCE_READ_FORBIDDEN: synthetic-secret'), 'SOURCE_READ_FORBIDDEN',
    { message: 'SOURCE_READ_FORBIDDEN', sql: 'SELECT secret' }, null,
  ])('conceals query/storage failures without treating their text as authorization', async error => {
    const query = vi.spyOn(platformLogs, 'query').mockImplementation(() => { throw error; });
    const consoleError = vi.spyOn(console, 'error');
    const consoleWarn = vi.spyOn(console, 'warn');
    expect(await tool.handler({}, { actor: { ...actor, permissions: ['config:view'] } }))
      .toEqual(failure('PLATFORM_OBSERVATION_UNAVAILABLE'));
    expect(query).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it.each(['get_deployment_manifest', 'search_source', 'read_source_region', 'get_symbol_definition'])(
    'keeps %s permission rejection unchanged', async name => {
      const sourceTool = platformTools.find(tool => tool.name === name)!;
      expect(await sourceTool.handler({}, { actor })).toEqual(failure('SOURCE_READ_FORBIDDEN'));
    },
  );
});
