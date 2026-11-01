import { afterEach, expect, it, vi } from 'vitest';
import { configurationInventory } from './inventory.js';
import { dbConnection } from '../../db-connection.js';
import { MysqlMetricStorage } from '../storage.js';

afterEach(() => vi.restoreAllMocks());
it.each([['snmpv2c', '2'], ['snmpv3', '3'], ['ssh', undefined], [undefined, undefined]])(
  'resolves current %s protocol and discards stale observed version', async (protocol, version) => {
    vi.spyOn(MysqlMetricStorage.prototype, 'inventory').mockResolvedValue({ attributes: {
      'snmp.version': { value: 'stale', observed_at: new Date().toISOString(), source: 'old-observation' },
    } } as never);
    const execute = vi.fn().mockResolvedValue([protocol ? [{ protocol }] : []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    const result = await configurationInventory({ type: 'network_device', id: 7 });
    expect(result.attributes['snmp.version']?.value).toBe(version);
    expect(execute).toHaveBeenCalledWith(
      'SELECT protocol FROM network_device_credentials WHERE device_id = ? ORDER BY protocol LIMIT 1', [7]);
    expect(execute.mock.calls[0][0]).not.toMatch(/secret|encrypted|community/);
  });
