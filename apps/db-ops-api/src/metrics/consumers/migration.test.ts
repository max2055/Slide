import { describe, expect, it } from 'vitest';
import { migrateReference } from './migration.js';

describe('OCR-0187 legacy metric mapping', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects inherited metric and engine key %s', key => {
      for (const type of ['instance', 'server', 'network_device'] as const) {
        expect(migrateReference({ type, id: 1 }, 'mysql', key)).toMatchObject({
          status: 'review_required', metric_id: null,
        });
      }
      expect(migrateReference({ type: 'instance', id: 1 }, key, 'connections')).toMatchObject({
        status: 'review_required', metric_id: null,
      });
    });
  it('rejects inherited string mappings and inherited engine tables', () => {
    Object.defineProperty(Object.prototype, 'ocr0187', {
      value: 'mysql.processlist.count', configurable: true,
    });
    Object.defineProperty(Object.prototype, 'ocr0187engine', {
      value: { connections: 'mysql.processlist.count' }, configurable: true,
    });
    try {
      expect(migrateReference({ type: 'instance', id: 1 }, 'mysql', 'ocr0187').metric_id).toBeNull();
      expect(migrateReference({ type: 'instance', id: 1 }, 'ocr0187engine', 'connections').metric_id).toBeNull();
    } finally {
      Reflect.deleteProperty(Object.prototype, 'ocr0187');
      Reflect.deleteProperty(Object.prototype, 'ocr0187engine');
    }
  });
  it.each([
    ['instance', 'mysql', 'connections', 'mysql.processlist.count'],
    ['instance', 'postgresql', 'connections', 'postgresql.activity.count'],
    ['instance', 'oracle', 'connections', 'oracle.sessions.count'],
    ['instance', 'dameng', 'connections', 'dameng.sessions.count'],
    ['server', 'unknown', 'cpu_usage', 'linux.cpu.user_system_percent'],
    ['network_device', 'unknown', 'device_uptime_seconds', 'snmp.agent.uptime_seconds'],
  ] as const)('preserves %s/%s/%s', (type, engine, oldId, metricId) => {
    const resource = { type, id: 1 };
    expect(migrateReference(resource, engine, oldId)).toMatchObject({
      resource, old_id: oldId, metric_id: metricId, status: 'mapped', threshold_conversion: 'none',
    });
  });
  it('preserves standard IDs and keeps unknown or ambiguous legacy IDs unmapped', () => {
    const resource = { type: 'instance', id: 1 } as const;
    expect(migrateReference(resource, 'unknown', 'mysql.processlist.count').metric_id).toBe('mysql.processlist.count');
    for (const id of ['', ' ', 'unknown', 'qps']) {
      expect(migrateReference(resource, 'mysql', id)).toMatchObject({ status: 'review_required', metric_id: null });
    }
  });
});
