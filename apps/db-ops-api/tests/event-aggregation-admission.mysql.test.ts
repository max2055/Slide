import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { bridgeTestFixture } from '../src/investigations/bridge-test-fixture.js';
import { dbConnection } from '../src/db-connection.js';
import { alertDatabaseService } from '../src/alert-database-service.js';
import { eventAggregator } from '../src/event-aggregator.js';

describe.skipIf(!process.env.T08_TEST_MYSQL_PORT)('MAX-566 production admission integration', () => {
let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
const original = dbConnection.getPool;
const keys = ['INVESTIGATION_OPS_AUTO_ENABLED','INVESTIGATION_OPS_SERVICE_USER_ID','INVESTIGATION_OPS_INSTANCE_IDS'];
const saved = keys.map(key => process.env[key]);
beforeAll(async () => {
  f = await bridgeTestFixture();
  dbConnection.getPool = () => f.pool;
  keys.forEach((key,i) => process.env[key] = i === 0 ? 'true' : i === 1 ? String(f.serviceId) : '101');
},120_000);
afterAll(async () => {
  keys.forEach((key,i) => { if(saved[i] === undefined) delete process.env[key]; else process.env[key]=saved[i]; });
  dbConnection.getPool = original;
  await f?.close();
},30_000);
it('MAX-566 production admission recovers committed alerts after group rollback and reuses durable owners', async () => {
  const c = await f.pool.getConnection();
  const data = {instance_id:101,alert_type:'performance',level:'critical',title:'aggregate-admission',message:'fixture',metric_name:'cpu'};
  const ids: number[] = [];
  let rolledBack: number | undefined;
  try {
    await c.beginTransaction();
    for (let i=0;i<2;i++) ids.push((await alertDatabaseService.createAlert(data,c)).alertId!);
    await c.commit();
    await c.beginTransaction();
    rolledBack=(await alertDatabaseService.createAlert(data,c)).alertId;
    await c.rollback();
  } finally { c.release(); }
  expect(await f.count('investigation_alert_owners')).toBe(0);
  await f.pool.query("CREATE TRIGGER fail_aggregation BEFORE INSERT ON alert_event_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'");
  expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:0});
  expect(await f.count('alert_events')).toBe(0);
  // Aggregation rollback does not roll back independently committed alert facts.
  const [owners] = await f.pool.query<any[]>('SELECT alert_id,investigation_id FROM investigation_alert_owners ORDER BY alert_id');
  expect(owners.map(r=>Number(r.alert_id))).toEqual(ids);
  expect(owners.every(r=>r.investigation_id)).toBe(true);
  const jobs = await f.count('workflow_jobs');
  expect(jobs).toBe(1);
  expect(new Set(owners.map(r=>r.investigation_id)).size).toBe(1);
  await f.pool.query('DROP TRIGGER fail_aggregation');
  expect(await eventAggregator.aggregate()).toEqual({eventsCreated:1,alertsAggregated:2});
  expect(await eventAggregator.aggregate()).toEqual({eventsCreated:0,alertsAggregated:0});
  const [again] = await f.pool.query<any[]>('SELECT alert_id,investigation_id FROM investigation_alert_owners ORDER BY alert_id');
  expect(again).toEqual(owners);
  expect(await f.count('workflow_jobs')).toBe(jobs);
  expect((await f.pool.query<any[]>('SELECT id FROM alerts WHERE id=?',[rolledBack]))[0]).toHaveLength(0);
  // Workers are never started: no provider sends or model budget consumption.
},60_000);

});
