import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const query = vi.fn();

vi.mock('../db-connection.js', () => ({
  dbConnection: {
    getPool: () => ({ execute, query }),
    isConnected: () => true,
  },
}));

import { alertDatabaseService } from '../alert-database-service.js';

describe('network-device alert persistence contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists target type and network device id without changing legacy target values', async () => {
    execute.mockResolvedValueOnce([{ insertId: 21 }]);
    await expect(alertDatabaseService.createAlert({
      target_type: 'network_device', network_device_id: 7, alert_type: 'performance', level: 'warning',
      title: 'CPU', message: 'high', metric_name: 'device_cpu_percent', metric_value: '92', threshold_value: '80',
    })).resolves.toMatchObject({ success: true, alertId: 21 });
    expect(execute.mock.calls[0][0]).toContain('target_type');
    expect(execute.mock.calls[0][0]).toContain('network_device_id');
    expect(execute.mock.calls[0][1]).toContain('network_device');
    expect(execute.mock.calls[0][1]).toContain(7);
  });

  it('supports dimension-aware network-device deduplication', async () => {
    query.mockResolvedValueOnce([[{ id: 21, network_device_id: 7, target_type: 'network_device', metric_name: 'interface_oper_status', tags: JSON.stringify({ dimensions: { if_index: '3' } }), status: 'unread' }]]);
    await expect(alertDatabaseService.findActiveNetworkDeviceAlert(7, 'interface_oper_status', 12, { if_index: '3' })).resolves.toMatchObject({ id: 21 });
    expect(query.mock.calls[0][0]).toContain('network_device_id');
    expect(query.mock.calls[0][0]).toContain('JSON_EXTRACT');
  });

  it('builds a target-aware alert scope instead of treating every null instance as visible', async () => {
    query.mockResolvedValueOnce([[]]);

    await alertDatabaseService.getAlerts({
      allowed_instance_ids: [3],
      allowed_server_ids: [11],
      allowed_network_device_ids: [7],
    } as any);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("a.target_type = 'instance'");
    expect(sql).toContain("a.target_type = 'server'");
    expect(sql).toContain("a.target_type = 'network_device'");
    expect(sql).toContain("(a.target_type = 'instance'");
    expect(params).toEqual(expect.arrayContaining([3, 11, 7]));
  });

  it('returns network-device target fields in the list DTO', async () => {
    query.mockResolvedValueOnce([[
      {
        id: 22,
        instance_id: null,
        instance_name: '',
        server_id: null,
        server_name: '',
        target_type: 'network_device',
        network_device_id: 7,
        network_device_name: 'edge-huawei',
        alert_type: 'performance',
        level: 'warning',
        title: 'CPU high',
        message: '92%',
        description: null,
        status: 'unread',
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null,
        assigned_to: null,
        source: 'network-device-alert-evaluator',
        metric_name: 'device_cpu_percent',
        metric_value: '92',
        threshold_value: '80',
        tags: null,
        created_at: '2026-08-26T00:00:00.000Z',
        updated_at: '2026-08-26T00:00:00.000Z',
      },
    ]]);

    const result = await alertDatabaseService.getAlerts();
    expect(result.items[0]).toMatchObject({
      target_type: 'network_device',
      network_device_id: 7,
      network_device_name: 'edge-huawei',
    });
  });
});
