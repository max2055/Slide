import { describe, expect, it, vi } from 'vitest';
import { DatabaseNetworkScanService } from './database-network-scan-service.js';

function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    configured: vi.fn().mockReturnValue(true),
    status: vi.fn().mockResolvedValue({ status: 'ok', daemon: { reachable: true, rootless: true }, policy: { network: 'restricted' } }),
    scanDatabaseEndpoints: vi.fn().mockResolvedValue({
      jobId: 'scan-1', exitCode: 0, timedOut: false, outputTruncated: false,
      stdout: 'Starting Nmap\nHost: 10.17.12.21 ()\tPorts: 3306/open/tcp//mysql///\n', stderr: '',
    }),
    ...overrides,
  };
}

function enabled() { return { get: vi.fn().mockResolvedValue({ enabled: true, reasonCode: 'SANDBOX_ENABLED' }) }; }
function networkEnabled() { return { get: vi.fn().mockResolvedValue({ restrictedNetworkEnabled: true, reasonCode: 'EXECUTION_CONFIG_READY' }) }; }

describe('DatabaseNetworkScanService', () => {
  it('validates input, checks restricted sandbox readiness, and returns structured endpoints', async () => {
    const controller = sandbox();
    const service = new DatabaseNetworkScanService(enabled(), controller as any, networkEnabled(), {
      allowedCidrs: ['10.17.12.0/24'], production: true,
    });

    await expect(service.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' })).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        scanId: 'scan-1', status: 'completed',
        results: [{ host: '10.17.12.21', port: 3306, databaseType: 'mysql', state: 'open' }],
      }),
    });
    expect(controller.scanDatabaseEndpoints).toHaveBeenCalledWith({ cidr: '10.17.12.0/24', profile: 'common_databases' }, expect.any(AbortSignal));
  });

  it('does not contact the controller when the sandbox or restricted network is disabled', async () => {
    const controller = sandbox();
    const disabled = new DatabaseNetworkScanService(enabled(), controller as any, { get: vi.fn().mockResolvedValue({ restrictedNetworkEnabled: false }) }, {
      allowedCidrs: ['10.17.12.0/24'], production: true,
    });
    await expect(disabled.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' })).resolves.toMatchObject({ success: false, errorCode: 'SANDBOX_NETWORK_DISABLED' });
    expect(controller.status).not.toHaveBeenCalled();
  });

  it('rejects controller output that is incomplete or unsuccessful', async () => {
    const controller = sandbox({ scanDatabaseEndpoints: vi.fn().mockResolvedValue({ jobId: 'scan-1', exitCode: 1, timedOut: false, outputTruncated: false, stdout: '', stderr: 'failed' }) });
    const service = new DatabaseNetworkScanService(enabled(), controller as any, networkEnabled(), {
      allowedCidrs: ['10.17.12.0/24'], production: true,
    });
    await expect(service.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' })).resolves.toMatchObject({ success: false, errorCode: 'NETWORK_SCAN_FAILED' });
  });
});
