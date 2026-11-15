import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

const state = vi.hoisted(() => ({ pool: null as mysql.Pool | null }));
vi.mock('../src/db-connection', () => ({ dbConnection: { getPool: () => state.pool } }));
// A transactional notification sink observes commit/rollback without external sends.
vi.mock('../src/notification-transition.js', () => ({
  enqueueNotificationTransition: async (c: mysql.PoolConnection, id: number) => {
    await c.execute('INSERT INTO notification_sink(alert_id) VALUES (?)', [id]);
  },
}));

const config = process.env.ESCALATION_MYSQL_CONFIG;
describe.skipIf(!config)('MAX-564 isolated real MySQL acceptance', () => {
  let admin: mysql.Connection;
  const schema = 'escalation_' + process.pid + '_' + Date.now();
  let service: typeof import('../src/alert-escalation-service')['alertEscalationService'];
  beforeAll(async () => {
    const options = JSON.parse(config!);
    delete options.database;
    admin = await mysql.createConnection(options);
    await admin.query('CREATE DATABASE ' + schema);
    state.pool = mysql.createPool({ ...options, database: schema, connectionLimit: 3 });
    await state.pool.query("CREATE TABLE alerts(id INT PRIMARY KEY, level VARCHAR(20), status VARCHAR(30), created_at DATETIME(6)) ENGINE=InnoDB");
    await state.pool.query("CREATE TABLE alert_event_logs(id INT AUTO_INCREMENT PRIMARY KEY,alert_id INT,action VARCHAR(30),actor_id INT,details JSON,created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB");
    await state.pool.query("CREATE TABLE escalation_rules(id INT AUTO_INCREMENT PRIMARY KEY,name VARCHAR(80),from_level VARCHAR(20),to_level VARCHAR(20),trigger_condition VARCHAR(80),trigger_value INT,enabled BOOLEAN) ENGINE=InnoDB");
    await state.pool.query('CREATE TABLE notification_sink(alert_id INT) ENGINE=InnoDB');
    service = (await import('../src/alert-escalation-service')).alertEscalationService;
  });
  afterAll(async () => {
    await state.pool?.end();
    if (admin) { await admin.query('DROP DATABASE IF EXISTS ' + schema); await admin.end(); }
  });
  beforeEach(async () => {
    for (const table of ['alerts', 'alert_event_logs', 'escalation_rules', 'notification_sink']) {
      await state.pool!.query('DELETE FROM ' + table);
    }
    await state.pool!.query("INSERT INTO alerts VALUES(1,'warning','unread',DATE_SUB(NOW(),INTERVAL 1 DAY))");
    await service.createDefaultRules();
  });
  async function counts() {
    const [a] = await state.pool!.query<any[]>('SELECT level FROM alerts WHERE id=1');
    const [l] = await state.pool!.query<any[]>('SELECT COUNT(*) n FROM alert_event_logs');
    const [n] = await state.pool!.query<any[]>('SELECT COUNT(*) n FROM notification_sink');
    return [a[0].level, l[0].n, n[0].n];
  }
  it.each([false, true])('old alert: concurrent and repeated scans, reverse rules=%s', async (reverse) => {
    if (reverse) await state.pool!.query('UPDATE escalation_rules SET id=100-id');
    const results = await Promise.all([service.checkEscalations(), service.checkEscalations()]);
    expect(results.reduce((n, r) => n + r.escalated, 0)).toBe(1);
    expect(await counts()).toEqual(['error', 1, 1]);
    expect(await service.checkEscalations()).toEqual({ escalated: 0 });
    await state.pool!.query('UPDATE alert_event_logs SET created_at=DATE_SUB(NOW(),INTERVAL 31 MINUTE)');
    expect(await service.checkEscalations()).toEqual({ escalated: 1 });
    expect(await counts()).toEqual(['critical', 2, 2]);
  });
  it('manual and scanner overlap only commit one change to error', async () => {
    await Promise.all([service.checkEscalations(), service.manualEscalation(1, 'error')]);
    expect(await counts()).toEqual(['error', 1, 1]);
  });
  it('log insertion failure rolls back level and prevents notification', async () => {
    await state.pool!.query("CREATE TRIGGER fail_log BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
    try {
      expect((await service.manualEscalation(1, 'error')).success).toBe(false);
      expect(await counts()).toEqual(['warning', 0, 0]);
      expect(await service.checkEscalations()).toEqual({ escalated: 0 });
      expect(await counts()).toEqual(['warning', 0, 0]);
    } finally { await state.pool!.query('DROP TRIGGER fail_log'); }
  });
  it('notification enqueue failure rolls back both level and log', async () => {
    await state.pool!.query("CREATE TRIGGER fail_notice BEFORE INSERT ON notification_sink FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
    try {
      expect((await service.manualEscalation(1, 'error')).success).toBe(false);
      expect(await counts()).toEqual(['warning', 0, 0]);
    } finally { await state.pool!.query('DROP TRIGGER fail_notice'); }
  });
  it('recovered alerts and unsupported historical conditions never escalate', async () => {
    await state.pool!.query("UPDATE alerts SET status='resolved'");
    expect(await service.checkEscalations()).toEqual({ escalated: 0 });
    await state.pool!.query("UPDATE alerts SET status='unread'");
    await state.pool!.query("UPDATE escalation_rules SET trigger_condition='unsupported_fixture'");
    expect(await service.checkEscalations()).toEqual({ escalated: 0 });
    expect(await counts()).toEqual(['warning', 0, 0]);
  });
});
