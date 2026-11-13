import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseNetworkScanService, databaseNetworkScanService } from './database-network-scan-service.js';

import { agentSandboxConfigService } from './agent-sandbox-config-service.js';
import { agentExecutionConfigService } from './agent-execution-config-service.js';
import { sandboxClient } from './sandbox-client.js';

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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  // #280 review: the production singleton has no fourth constructor argument.
  it.each(['ready', 'sandbox_disabled', 'network_disabled', 'unavailable', 'not_ready'] as const)(
    'preserves the production singleton sandbox constraints: %s', async (state) => {
      vi.stubEnv('NODE_ENV', 'production');
      const config = vi.spyOn(agentSandboxConfigService, 'get').mockResolvedValue({
        enabled: state !== 'sandbox_disabled', reasonCode: 'SANDBOX_DISABLED',
      } as Awaited<ReturnType<typeof agentSandboxConfigService.get>>);
      const execution = vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
        restrictedNetworkEnabled: state !== 'network_disabled', reasonCode: 'EXECUTION_CONFIG_READY',
      } as Awaited<ReturnType<typeof agentExecutionConfigService.get>>);
      vi.spyOn(sandboxClient, 'configured').mockReturnValue(state !== 'unavailable');
      const status = vi.spyOn(sandboxClient, 'status').mockResolvedValue({
        status: 'ok', daemon: { reachable: true, rootless: state !== 'not_ready' }, policy: { network: 'restricted' },
      });
      const scan = vi.spyOn(sandboxClient, 'scanDatabaseEndpoints').mockResolvedValue({
        jobId: 'production-fixture', exitCode: 0, timedOut: false, outputTruncated: false, stdout: '', stderr: '',
      });
      const result = await databaseNetworkScanService.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' });
      expect(config).toHaveBeenCalledOnce();
      if (state === 'ready') {
        expect(result).toMatchObject({ success: true, data: { scanId: 'production-fixture' } });
        expect(execution).toHaveBeenCalledOnce();
        expect(status).toHaveBeenCalledOnce();
        expect(scan).toHaveBeenCalledWith({ cidr: '10.17.12.0/24', profile: 'common_databases' }, expect.any(AbortSignal));
      } else {
        const reasons = { sandbox_disabled: 'SANDBOX_DISABLED', network_disabled: 'SANDBOX_NETWORK_DISABLED',
          unavailable: 'SANDBOX_UNAVAILABLE', not_ready: 'SANDBOX_NETWORK_NOT_READY' };
        expect(result).toMatchObject({ success: false, errorCode: reasons[state] });
        expect(scan).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects explicit strict mode without an allowlist in production before reading configuration', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const config = enabled();
    const controller = sandbox();
    const service = new DatabaseNetworkScanService(config, controller, networkEnabled(), { production: true });
    await expect(service.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' }))
      .resolves.toMatchObject({ success: false, errorCode: 'SCAN_POLICY_NOT_CONFIGURED' });
    expect(config.get).not.toHaveBeenCalled();
    expect(controller.scanDatabaseEndpoints).not.toHaveBeenCalled();
  });

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

  it.each([
    { allowedCidrs: ['10.17.12.0/25'], production: true, reason: 'SCAN_CIDR_DENIED' },
    { allowedCidrs: ['192.0.2.0/24'], production: false, reason: 'SCAN_CIDR_DENIED' },
    { allowedCidrs: [], production: true, reason: 'SCAN_CIDR_DENIED' },
    { production: true, reason: 'SCAN_POLICY_NOT_CONFIGURED' },
    { allowedCidrs: ['invalid'], production: false, reason: 'SCAN_POLICY_NOT_CONFIGURED' },
  ])('rejects policy before configuration reads or controller calls: $reason', async ({ reason, ...policy }) => {
    const controller = sandbox();
    const config = enabled();
    const execution = networkEnabled();
    const service = new DatabaseNetworkScanService(config, controller, execution, policy);
    await expect(service.scan({ cidr: '10.17.12.0/24', profile: 'common_databases' }))
      .resolves.toMatchObject({ success: false, errorCode: reason });
    expect(config.get).not.toHaveBeenCalled();
    expect(execution.get).not.toHaveBeenCalled();
    expect(controller.configured).not.toHaveBeenCalled();
    expect(controller.status).not.toHaveBeenCalled();
    expect(controller.scanDatabaseEndpoints).not.toHaveBeenCalled();
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
