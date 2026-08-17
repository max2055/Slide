import { describe, expect, it, vi } from 'vitest';
import { AgentSandboxConfigService } from './agent-sandbox-config-service.js';

describe('AgentSandboxConfigService', () => {
  it('defaults an absent setting to disabled', async () => {
    const execute = vi.fn().mockResolvedValue([[]]);
    const service = new AgentSandboxConfigService(() => ({ execute }));

    await expect(service.get()).resolves.toEqual({
      enabled: false,
      reasonCode: 'SANDBOX_DISABLED',
    });
  });

  it.each(['TRUE', '1', 'yes', '', null, { enabled: true }])(
    'fails closed for malformed stored value %j',
    async (configValue) => {
      const execute = vi.fn().mockResolvedValue([[{ config_value: configValue }]]);
      const service = new AgentSandboxConfigService(() => ({ execute }));

      await expect(service.get()).resolves.toEqual({
        enabled: false,
        reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE',
      });
    },
  );

  it('returns enabled only for the exact true value', async () => {
    const execute = vi.fn().mockResolvedValue([[{ config_value: 'true' }]]);
    const service = new AgentSandboxConfigService(() => ({ execute }));

    await expect(service.get()).resolves.toEqual({
      enabled: true,
      reasonCode: 'SANDBOX_ENABLED',
    });
  });

  it('fails closed when storage is unavailable or throws', async () => {
    const unavailable = new AgentSandboxConfigService(() => null);
    const failing = new AgentSandboxConfigService(() => ({
      execute: vi.fn().mockRejectedValue(new Error('database details')),
    }));

    await expect(unavailable.get()).resolves.toEqual({
      enabled: false,
      reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE',
    });
    await expect(failing.get()).resolves.toEqual({
      enabled: false,
      reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE',
    });
  });

  it('persists a strict boolean with metadata and actor attribution', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const service = new AgentSandboxConfigService(() => ({ execute }));

    await expect(service.set(true, 7)).resolves.toEqual({
      enabled: true,
      reasonCode: 'SANDBOX_ENABLED',
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), [
      'agent_sandbox_enabled',
      'true',
      'boolean',
      expect.stringContaining('Agent'),
      7,
    ]);
  });

  it('rejects invalid writes and fails closed on write errors', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('database details'));
    const service = new AgentSandboxConfigService(() => ({ execute }));

    await expect(service.set(true, 0)).rejects.toThrow('SANDBOX_CONFIG_UPDATE_INVALID');
    await expect(service.set(true, 7)).rejects.toThrow('SANDBOX_CONFIG_UPDATE_FAILED');
  });
});
