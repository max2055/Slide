import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { transpileModule } from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from './migrations/runner.js';
import type { MigrationPool } from './migrations/types.js';
import { strictBody } from './utils/strict-body.js';

const connection = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => connection.pool } }));
vi.mock('./alert-rca-service', () => ({ alertRCAService: {} }));
import { alertEventService as service } from './alert-event-service.js';

// Explicit disposable localhost port only; never application .env or production data.
const port = Number(process.env.ALERT_EVENT_TEST_MYSQL_PORT);
describe.skipIf(!port)('event transitions / isolated MySQL', () => {
  let admin: Pool, pool: Pool;
  let eventId: number, alertId: number;
  const database = `max118_events_${process.pid}`;

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    connection.pool = pool;
  }, 120_000);

  afterAll(async () => {
    connection.pool = null;
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await pool.query('DROP TRIGGER IF EXISTS fail_log');
    await pool.query('DROP TRIGGER IF EXISTS fail_alert');
    for (const table of ['alert_event_logs', 'alert_event_members', 'alert_events', 'alerts']) await pool.query(`DELETE FROM ${table}`);
    const [event] = await pool.execute<any>("INSERT INTO alert_events (event_id, title, severity) VALUES (UUID(), 'fixture', 'warning')");
    eventId = event.insertId;
    const [alert] = await pool.execute<any>("INSERT INTO alerts (alert_type, level, title, message) VALUES ('performance', 'warning', 'fixture', 'fixture')");
    alertId = alert.insertId;
    await pool.execute('INSERT INTO alert_event_members (event_id, alert_id) VALUES (?, ?)', [eventId, alertId]);
  });

  async function snapshot() {
    const [events] = await pool.query<any[]>('SELECT * FROM alert_events WHERE id = ?', [eventId]);
    const [alerts] = await pool.query<any[]>('SELECT * FROM alerts WHERE id = ?', [alertId]);
    const [logs] = await pool.query<any[]>('SELECT * FROM alert_event_logs WHERE event_id = ? ORDER BY id', [eventId]);
    return { event: events[0], alert: alerts[0], logs };
  }

  async function resolved(verified = false) {
    expect(await service.resolveEvent(eventId, 'fixed', 41)).toMatchObject({ success: true });
    if (verified) expect(await service.verifyRecovery(eventId, 'operator checked the dashboard', 42)).toMatchObject({ success: true });
  }

  async function routeApp() {
    const app = Fastify();
    // Execute the actual server route registrations without booting unrelated jobs or user services.
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const routes = source.slice(source.indexOf("  fastify.post('/api/alerts/events/:id/investigate'"), source.indexOf("  fastify.post('/api/alerts/events/:id/postmortem'"));
    expect(routes).toContain('/verify-recovery');
    const register = new Function('fastify', 'verifyToken', 'requirePermission', 'requireAlertEventAccess', 'alertEventService', 'strictBody', transpileModule(routes, {}).outputText);
    register(app, async (request: any) => { request.user = { userId: 77 }; }, () => async () => {}, async () => true, service, strictBody);
    return app;
  }

  it('HTTP routes preserve authenticated actor for investigate, resolve, verify and close; retries return 409', async () => {
    const app = await routeApp();
    try {
      for (const [action, payload] of [['investigate', undefined], ['resolve', { resolution_notes: 'fixed' }], ['verify-recovery', { reason: 'manual check' }], ['close', undefined]] as const) {
        const response = await app.inject({ method: 'POST', url: `/api/alerts/events/${eventId}/${action}`, payload });
        expect(response.statusCode).toBe(200);
        expect(response.json().success).toBe(true);
        expect((await app.inject({ method: 'POST', url: `/api/alerts/events/${eventId}/${action}`, payload })).statusCode).toBe(409);
      }
      expect((await snapshot()).logs.map(log => log.actor_id)).toEqual([77, 77, 77, 77]);
    } finally { await app.close(); }
  });

  it.each([null, 1, {}, '', ' ', 'x'.repeat(1025)])('HTTP rejects invalid manual basis before mutating', async reason => {
    await resolved();
    const before = await snapshot();
    const app = await routeApp();
    try {
      expect((await app.inject({ method: 'POST', url: `/api/alerts/events/${eventId}/verify-recovery`, payload: { reason } })).statusCode).toBe(400);
      expect(await snapshot()).toEqual(before);
    } finally { await app.close(); }
  });

  const actions = {
    investigate: () => service.startInvestigation(eventId, 41),
    resolve: () => service.resolveEvent(eventId, 'fixed', 41),
    verify: () => service.verifyRecovery(eventId, 'operator checked the dashboard', 42),
    close: () => service.closeEvent(eventId, 43),
  };

  it.each(['investigate', 'resolve', 'verify', 'close'] as const)('%s rolls back event changes when its log fails', async action => {
    if (action === 'verify' || action === 'close') await resolved(action === 'close');
    const before = await snapshot();
    await pool.query("CREATE TRIGGER fail_log BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected log failure'");
    const result = await actions[action]();
    expect(result.success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back event and log when the associated alert update fails', async () => {
    const before = await snapshot();
    await pool.query("CREATE TRIGGER fail_alert BEFORE UPDATE ON alerts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected alert failure'");
    expect((await actions.resolve()).success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['investigate', 'resolve', 'verify', 'close'] as const)('two concurrent %s requests accept exactly one; retry conflicts without extra log', async action => {
    if (action === 'verify' || action === 'close') await resolved(action === 'close');
    const before = await snapshot();
    const results = await Promise.all([actions[action](), actions[action]()]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    expect((await actions[action]()).success).toBe(false);
    expect((await snapshot()).logs).toHaveLength(before.logs.length + 1);
  });

  it('concurrent resolutions with different actors/bases preserve only the accepted result', async () => {
    const results = await Promise.all([service.resolveEvent(eventId, 'operator A', 41), service.resolveEvent(eventId, 'operator B', 42)]);
    expect(results.filter(r => r.success)).toHaveLength(1);
    const winner = results[0].success ? { actor: 41, notes: 'operator A' } : { actor: 42, notes: 'operator B' };
    const state = await snapshot();
    expect(state.event).toMatchObject({ resolved_by: winner.actor, resolution_notes: winner.notes });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({ actor_id: winner.actor, details: { resolution_notes: winner.notes } });
  });

  it('automatic resolution commits atomically, keeps system actor null and still requires manual confirmation', async () => {
    await pool.execute("UPDATE alerts SET status = 'resolved' WHERE id = ?", [alertId]);
    const before = await snapshot();
    await pool.query("CREATE TRIGGER fail_log BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected log failure'");
    await service.autoResolveByAlert(alertId);
    expect(await snapshot()).toEqual(before);
    await pool.query('DROP TRIGGER fail_log');
    await service.autoResolveByAlert(alertId);
    const after = await snapshot();
    expect(after.event.status).toBe('resolved');
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0]).toMatchObject({ actor_id: null, details: { action: 'auto_resolved' } });
    expect(after.event.verification_passed_at).toBeNull();
    expect((await actions.close()).success).toBe(false);
  });

  it('legacy confirmation fields remain readable and can satisfy the existing close gate without inventing an actor', async () => {
    await pool.execute("UPDATE alert_events SET status = 'resolved', verification_passed_at = NOW(), verification_reason = 'legacy' WHERE id = ?", [eventId]);
    expect(await actions.close()).toMatchObject({ success: true });
    expect((await snapshot()).event).toMatchObject({ status: 'closed', verification_actor_id: null, verification_reason: 'legacy' });
    expect((await snapshot()).logs[0].actor_id).toBe(43);
  });

  it('requires resolution then manual confirmation; preserves actor, reason and timestamp after close', async () => {
    expect((await actions.close()).success).toBe(false);
    expect((await actions.verify()).success).toBe(false);
    await resolved();
    expect((await actions.close()).success).toBe(false);
    expect(await actions.verify()).toMatchObject({ success: true });
    expect(await actions.close()).toMatchObject({ success: true });
    const state = await snapshot();
    expect(state.event).toMatchObject({ status: 'closed', resolved_by: 41, verification_actor_id: 42, verification_reason: 'operator checked the dashboard' });
    expect(state.event.verification_passed_at).toBeInstanceOf(Date);
    expect(state.alert.status).toBe('resolved');
    expect(state.logs.map(l => l.actor_id)).toEqual([41, 42, 43]);
    expect(state.logs[1].details).toMatchObject({ action: 'manual_recovery_confirmed', confirmation_type: 'manual', reason: state.event.verification_reason });
    expect((await actions.verify()).success).toBe(false);
    expect((await actions.resolve()).success).toBe(false);
    expect(await snapshot()).toEqual(state);
  });

  it('does not overwrite an earlier manual confirmation, even with another actor/reason', async () => {
    await resolved(true);
    const before = await snapshot();
    expect((await service.verifyRecovery(eventId, 'different', 43)).success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['', '   ', 'x'.repeat(1025)])('rejects missing/oversized confirmation basis instead of silently truncating it', async reason => {
    await resolved();
    const before = await snapshot();
    expect((await service.verifyRecovery(eventId, reason, 42)).success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('requires a real actor for manual confirmation', async () => {
    await resolved();
    const before = await snapshot();
    expect((await service.verifyRecovery(eventId, 'checked')).success).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('a delayed automatic resolution cannot reopen an event manually closed in the meantime', async () => {
    await pool.execute("UPDATE alerts SET status = 'resolved' WHERE id = ?", [alertId]);
    let selected!: () => void, release!: () => void;
    const selectedSignal = new Promise<void>(resolve => { selected = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const execute = pool.execute.bind(pool);
    vi.spyOn(pool, 'execute').mockImplementation((async (...args: any[]) => {
      const result = await (execute as any)(...args);
      if (String(args[0]).includes('SELECT DISTINCT m.event_id')) { selected(); await barrier; }
      return result;
    }) as any);
    const automatic = service.autoResolveByAlert(alertId);
    await selectedSignal;
    try {
      await resolved(true);
      expect(await actions.close()).toMatchObject({ success: true });
    } finally { release(); }
    await automatic;
    expect((await snapshot()).event.status).toBe('closed');
    expect((await snapshot()).logs).toHaveLength(3);
  });

  it('startup history inspection is dry-run and cannot infer historical resolution from current alert status', async () => {
    await pool.execute("UPDATE alerts SET status = 'resolved' WHERE id = ?", [alertId]);
    const before = await snapshot();
    expect(await service.retroactiveResolve()).toMatchObject({ resolved: 0, candidates: [eventId] });
    expect(await snapshot()).toEqual(before);
  });
});
