import { describe, expect, it, vi } from 'vitest';
import { discoverDatabaseEndpointsTool } from './discover_database_endpoints.js';

describe('discover_database_endpoints tool', () => {
  it('exposes only the fixed scan profile and delegates typed input', async () => {
    expect(discoverDatabaseEndpointsTool.requiredPermissions).toEqual(['network:discover']);
    expect(discoverDatabaseEndpointsTool.requiresApproval).toBe(true);
    expect(discoverDatabaseEndpointsTool.parameters.properties.profile.enum).toEqual(['common_databases']);
    expect(discoverDatabaseEndpointsTool.parameters.properties).not.toHaveProperty('command');
    expect(discoverDatabaseEndpointsTool.parameters.properties).not.toHaveProperty('image');
  });

  it('accepts the approval id returned by the first call so an approved retry can execute', () => {
    expect(discoverDatabaseEndpointsTool.parameters.properties).toHaveProperty('approvalId');
    expect(discoverDatabaseEndpointsTool.parameters.required).not.toContain('approvalId');
  });

  it('does not allow a caller to inject command or image fields', async () => {
    const service = await import('../../security/database-network-scan-service.js');
    const scan = vi.spyOn(service.databaseNetworkScanService, 'scan').mockResolvedValue({ success: true, data: {} });
    await discoverDatabaseEndpointsTool.handler({ cidr: '10.17.12.0/24', profile: 'common_databases', command: 'rm -rf /', image: 'evil' });
    expect(scan).toHaveBeenCalledWith({ cidr: '10.17.12.0/24', profile: 'common_databases' });
    scan.mockRestore();
  });
});
