import { describe, expect, it } from 'vitest';
import { investigationToolContract } from './tool-contract.js';
import { getServerMetricsTool } from '../tools/generated/slide-self-mgmt/server_tools.js';
import { queryMetricsTool } from '../tools/ops/query_metrics.js';
import { listActiveAlertsTool } from '../tools/ops/list_active_alerts.js';
const resources = [{ type: 'server' as const, id: 3 }];
const budget = { maxWindowMs: 3600000, maxRows: 200 };
describe('model-visible investigation contract', () => {
  it('removes database-only alerts from a server-only investigation', () => {
    expect(investigationToolContract(listActiveAlertsTool, resources, budget)).toBeNull();
    expect(investigationToolContract(queryMetricsTool, resources, budget)).toBeNull();
  });
  it('advertises only the authorized server and one-hour history', () => {
    const contract = investigationToolContract(getServerMetricsTool, resources, budget)!;
    expect(contract.parameters.properties.range).toMatchObject({ enum: ['1h'] });
    expect(contract.parameters.properties.serverId).toMatchObject({ enum: [3] });
    expect(contract.parameters.properties.maxRows).toMatchObject({ maximum: 100 });
    expect(getServerMetricsTool.parameters.properties.range.enum).toContain('24h');
  });
});
