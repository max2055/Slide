import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bridgeTestFixture } from '../investigations/bridge-test-fixture.js';
import { dbConnection } from '../db-connection.js';
import { NetworkDeviceAlertEvaluator } from './network-device-alert-evaluator.js';

describe('network reachability / formal MySQL evaluator', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>;
  beforeAll(async () => {
    f = await bridgeTestFixture();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(f.pool);
    await f.pool.query('UPDATE alert_rules SET enabled=0');
    await f.pool.query("INSERT INTO network_devices (id,name,host,collection_enabled) VALUES (901,'reachability fixture','fixture.invalid',1)");
    await f.pool.query(`INSERT INTO alert_rules (id,name,target_type,network_device_id,metric_name,operator,threshold,duration_seconds,severity,enabled)
      VALUES (901,'reachability fixture','network_device',901,'device_reachability','=',0,0,'error',1)`);
    await f.pool.query(`INSERT INTO alerts (network_device_id,target_type,alert_type,level,title,message,metric_name,metric_value,tags)
      VALUES (901,'network_device','availability','error','persisted unreachable','previous check','device_reachability','0','{"rule_id":901}')`);
  }, 120_000);
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  it('historical device checks never trigger or recover a formal metric alert without an accepted metric reference', async () => {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const evaluator = new NetworkDeviceAlertEvaluator();
    const state = async (status: string, at: Date | null) => {
      await f.pool.execute('UPDATE network_devices SET status=?,last_check_at=? WHERE id=901', [status,at]);
      return evaluator.evaluate();
    };
    for (const [status, at] of [
      ['error',now], ['offline',now], ['unknown',now], ['unreachable',null], ['online',null],
      ['unreachable',new Date(now.getTime()-300_000)], ['online',new Date(now.getTime()-300_000)],
      ['unreachable',new Date(now.getTime()+60_000)],
    ] as const) {
      expect(await state(status,at), status).toMatchObject({ triggered:0, evaluated:0 });
      const [rows] = await f.pool.query<any[]>('SELECT status FROM alerts WHERE network_device_id=901');
      expect(rows, status).toHaveLength(1); expect(rows[0].status, status).toBe('unread');
    }
    for (const status of ['online','unreachable']) expect(await state(status,now)).toMatchObject({evaluated:0,triggered:0});
    const [active]=await f.pool.query<any[]>("SELECT status FROM alerts WHERE network_device_id=901");
    expect(active).toHaveLength(1);expect(active[0].status).toBe('unread');
  });
});
