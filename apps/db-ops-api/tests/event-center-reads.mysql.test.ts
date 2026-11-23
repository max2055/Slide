import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEventReadRoutes } from '../src/alert-event-access.js';
import { alertEventService } from '../src/alert-event-service.js';
import { registerAlertListRoute } from '../src/alert-list-route.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { signAccessToken } from '../src/auth/actor-context.js';
import { dbConnection } from '../src/db-connection.js';
import { bridgeTestFixture } from '../src/investigations/bridge-test-fixture.js';
import { registerTemplateTriggerRoutes } from '../src/metrics/triggers/routes.js';

// MAX-722. Opt in to the migrated fixture's disposable MySQL or inject a
// dedicated test endpoint using the fixture's T08_TEST_MYSQL_* variables.
describe.skipIf(process.env.MAX722_EVENT_READS !== '1')('event center reads / MySQL and authenticated HTTP', () => {
  const alerts = '/api/alerts';
  const events = alerts + '/events';
  const stats = events + '/stats';
  const other = events + '?status=other&limit=1';
  const detail = (id: number) => '/api/metrics/template-events/' + id;
  const empty = { items: [], total: 0 };
  const emptyStats = { total: 0, open: 0, investigating: 0, handled: 0, resolved: 0, closed: 0 };
  const unavailable = { error: 'EVENT_READ_UNAVAILABLE' };
  const window = events + '?resource=instance:101&from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z&status=other';
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  let poolRef: ReturnType<typeof vi.spyOn<typeof dbConnection, 'getPool'>>;
  let base: string;
  let owner: string;
  let otherActor: string;

  async function get(path: string, status = 200, token: string | null = owner) {
    const response = await fetch(base + path, {
      headers: token ? { authorization: 'Bearer ' + token } : {},
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    expect(response.status, path).toBe(status);
    return result;
  }

  beforeAll(async () => {
    f = await bridgeTestFixture();
    poolRef = vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    await f.pool.query('DELETE FROM instance_permissions WHERE user_id IN (101,102) AND user_id <> instance_id');
    const secret = randomBytes(32).toString('hex');
    const verify = createVerifyToken(secret);
    owner = signAccessToken(f.owner, secret);
    otherActor = signAccessToken(f.other, secret);
    await registerEventReadRoutes(f.app, verify);
    await registerAlertListRoute(f.app, verify);
    await registerTemplateTriggerRoutes(f.app, verify);
    base = await f.app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await f?.close();
  }, 30_000);

  beforeEach(async () => {
    await f.pool.query('DELETE FROM metric_trigger_episodes');
    await f.pool.query('DELETE FROM alert_events');
    await f.pool.query('DELETE FROM alerts');
  });

  it('returns the established structures on a genuinely empty store', async () => {
    expect(await get(other)).toEqual(empty);
    expect(await get(stats)).toEqual(emptyStats);
  });

  it('reconciles historical pages with all-time scoped statistics and preserves exact status filters', async () => {
    await f.pool.query(`INSERT INTO alert_events(id,event_id,title,severity,status,instance_id,created_at) VALUES
      (8101,'open','same','warning','open',101,'2026-10-10 00:00:00'),
      (8102,'investigating','same','warning','investigating',101,'2026-10-10 00:00:00'),
      (8103,'handled','same','warning','handled',101,'2026-10-10 00:00:00'),
      (8104,'resolved','same','warning','resolved',101,'2026-10-10 00:00:00'),
      (8105,'closed','same','warning','closed',101,'2026-10-10 00:00:00'),
      (8106,'reviewed','same','warning','reviewed',101,'2026-10-10 00:00:00'),
      (8108,'outside-window','same','warning','reviewed',101,'2026-10-30 00:00:00'),
      (8201,'hidden','same','warning','reviewed',102,'2026-10-10 00:00:00')`);
    // A permissive historical writer could persist ENUM index 0.
    await f.pool.query(`INSERT IGNORE INTO alert_events(id,event_id,title,severity,status,instance_id,created_at)
      VALUES (8107,'empty','same','warning','',101,'2026-10-10 00:00:00')`);
    const counts = await get(stats + '?from=2026-10-01&to=2026-10-20');
    expect(counts).toEqual({ total: 8, open: 1, investigating: 1, handled: 1, resolved: 1, closed: 1 });
    const difference = counts.total - counts.open - counts.investigating - counts.handled - counts.resolved - counts.closed;
    for (const [offset, id, status] of [[0, 8108, 'reviewed'], [1, 8107, ''], [2, 8106, 'reviewed']]) {
      expect(await get(other + '&offset=' + offset)).toMatchObject({ items: [{ id, status }], total: difference });
    }
    expect(await get(other + '&offset=3')).toEqual({ items: [], total: difference });
    expect(await get(events + '?status=reviewed')).toMatchObject({ items: [{ id: 8108 }, { id: 8106 }], total: 2 });
    expect(await get(events + '?status=open,%20closed')).toMatchObject({ items: [{ id: 8105 }, { id: 8101 }], total: 2 });
    expect(await get(events + '?status=open,other')).toMatchObject({ total: 4 });
    expect(await get(events + '?status=open&keyword=absent-fixture-title')).toEqual(empty);
    expect(await get(window)).toMatchObject({ items: [{ id: 8107 }, { id: 8106 }], total: 2 });
    expect(await get(events + '?resource=instance:101', 400)).toEqual({ error: 'INVALID_RESOURCE_WINDOW' });
    expect(await get(window, 403, otherActor)).toEqual({ error: 'FORBIDDEN' });
    expect(await get(other, 200, otherActor)).toMatchObject({ items: [{ id: 8201 }], total: 1 });
    expect(await get(stats, 200, otherActor)).toEqual({ ...emptyStats, total: 1 });
    await get(events, 401, null);
    await get(stats, 401, null);
  });

  it('matches an exact alert association and rechecks both reads with the same JWT after revocation', async () => {
    await f.pool.query(`INSERT INTO alerts(id,instance_id,alert_type,level,title,message)
      VALUES (7001,101,'performance','warning','same','same'), (7002,101,'performance','warning','same','same'),
        (7003,101,'performance','warning','same','same'), (7004,101,'performance','warning','same','same'),
        (7005,102,'performance','warning','same','same'), (7006,101,'performance','warning','same','same')`);
    await f.pool.query(`INSERT INTO alert_events(id,event_id,title,severity,status,instance_id) VALUES
      (7301,'episode-first','same','warning','open',101), (7001,'episode-decoy','same','warning','open',101),
      (7304,'episode-hidden','same','warning','reviewed',102), (7305,'episode-other','same','warning','open',102),
      (7306,'episode-missing-resource','same','warning','open',NULL)`);
    for (const [alertId, eventId, resourceId] of [[7001, 7301, 101], [7002, 7001, 101], [7004, 7304, 102], [7005, 7305, 102], [7006, 7306, 199]]) {
      const metric = { id: 'fixture', semantic_version: '1.0.0' };
      const payload = { resource: { type: 'instance', id: String(resourceId) }, opened: { metric }, last: { dimensions: {} } };
      const snapshot = { configuration: { rules: [] }, opening: { marker: 'opening-' + alertId } };
      await f.pool.execute(`INSERT INTO metric_trigger_episodes
        (episode_id,identity_hash,resource_key,config_revision,event_id,alert_id,payload,snapshot)
        VALUES (?,?,?,1,?,?,?,?)`, ['episode-' + eventId, 'identity-' + eventId, 'instance:' + resourceId,
        eventId, alertId, JSON.stringify(payload), JSON.stringify(snapshot)]);
    }
    const links = (items: { id: number; template_event_id?: number }[]) => Object.fromEntries(
      items.map(item => [item.id, item.template_event_id ?? null]),
    );
    const list = await get(alerts + '?limit=20');
    expect(links(list.items)).toEqual({ 7001: 7301, 7002: 7001, 7003: null, 7004: null, 7006: null });
    for (const id of [7003, 7004, 7006]) {
      expect(list.items.find((row: {id: number}) => row.id === id)).not.toHaveProperty('template_event_id');
    }
    expect(links((await get(alerts, 200, otherActor)).items)).toEqual({ 7005: 7305 });
    expect(await get(detail(7301))).toMatchObject({ event_id: 7301, alert_id: 7001, snapshot: { opening: { marker: 'opening-7001' } } });
    expect(await get(detail(7001))).toMatchObject({ event_id: 7001, alert_id: 7002 });
    expect(await get(detail(7003), 404)).toEqual({ error: 'TRIGGER_EVENT_NOT_FOUND' });
    expect(await get(detail(7304), 403)).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
    expect(await get(other, 200, otherActor)).toMatchObject({ items: [{ id: 7304 }], total: 1 });

    // Withdraw the scope after the list has read a visible associated resource.
    const execute = f.pool.execute.bind(f.pool);
    const revokeOnLinkRead = vi.spyOn(f.pool, 'execute').mockImplementation(async (sql, params) => {
      const result = await execute(sql, params);
      if (sql === 'SELECT id FROM database_instances WHERE id = ? LIMIT 1' && params?.[0] === 101) {
        await f.pool.query('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=101');
      }
      return result;
    });
    try {
      expect(await get(alerts, 403)).toEqual({ error: 'AUTHORITY_CHANGED' });
      expect((await get(alerts)).items).toEqual([]);
      expect(await get(other)).toEqual(empty);
      expect(await get(stats)).toEqual(emptyStats);
      expect(await get(detail(7301), 403)).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
    } finally {
      revokeOnLinkRead.mockRestore();
      await f.pool.query("INSERT IGNORE INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'read-only')");
    }
    expect(links((await get(alerts)).items)[7001]).toBe(7301);
  });

  it('reports store, scope, page, count and stats failures and recovers the same requested data', async () => {
    await f.pool.query(`INSERT INTO alert_events(event_id,title,severity,status,instance_id,created_at)
      VALUES ('outage-fixture','recoverable','warning','reviewed',101,'2026-10-10 00:00:00')`);
    const initialPage = await get(other);
    const initialStats = await get(stats);
    expect(initialPage.total).toBeGreaterThan(0);
    poolRef.mockReturnValue(null);
    try {
      expect(await get(other, 503)).toMatchObject({ error: 'PLATFORM_UNAVAILABLE' });
      expect(await get(stats, 503)).toMatchObject({ error: 'PLATFORM_UNAVAILABLE' });
      expect(await alertEventService.getEvents()).toEqual(empty);
      expect(await alertEventService.getEventStats()).toEqual(emptyStats);
      await expect(alertEventService.getEvents({ strict: true })).rejects.toThrow('EVENT_STORE_UNAVAILABLE');
      await expect(alertEventService.getEventStats(null, undefined, { strict: true })).rejects.toThrow('EVENT_STORE_UNAVAILABLE');
    } finally {
      poolRef.mockReturnValue(f.pool);
    }
    for (const [table, paths] of [
      ['metric_trigger_episodes', [other, stats]],
      ['alert_event_members', [other, window]],
      ['alert_events', [stats]],
    ] as const) {
      await f.pool.query(`RENAME TABLE ${table} TO ${table}_outage`);
      try {
        for (const path of paths) expect(await get(path, 503)).toEqual(unavailable);
      } finally {
        await f.pool.query(`RENAME TABLE ${table}_outage TO ${table}`);
      }
    }
    // Leave page and authority reads on their real tables. Make the actual
    // pagination COUNT encounter a missing table only after the page succeeds.
    const sqlQuery = f.pool.query.bind(f.pool);
    let counted = false;
    const countFault = vi.spyOn(f.pool, 'query').mockImplementation(async (sql, params) => {
      if (typeof sql !== 'string' || !sql.startsWith('SELECT COUNT(DISTINCT e.id)')) return sqlQuery(sql, params);
      await sqlQuery('RENAME TABLE alert_events TO alert_events_outage');
      counted = true;
      try {
        return await sqlQuery(sql, params);
      } finally {
        await sqlQuery('RENAME TABLE alert_events_outage TO alert_events');
      }
    });
    try {
      expect(await get(other, 503)).toEqual(unavailable);
      expect(counted).toBe(true);
    } finally {
      countFault.mockRestore();
    }
    expect(await get(other)).toEqual(initialPage);
    expect(await get(stats)).toEqual(initialStats);
  });
});
