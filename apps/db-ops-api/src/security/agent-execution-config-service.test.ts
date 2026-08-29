import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionConfigService } from './agent-execution-config-service.js';

describe('AgentExecutionConfigService', () => {
  it('reads both execution controls and fails closed when a value is missing', async () => {
    const execute = vi.fn().mockResolvedValue([[{ config_key: 'agent_tool_approval_enabled', config_value: 'false' }]]);
    const service = new AgentExecutionConfigService(() => ({ execute }));

    await expect(service.get()).resolves.toEqual({
      approvalEnabled: false,
      restrictedNetworkEnabled: false,
      reasonCode: 'EXECUTION_CONFIG_UNAVAILABLE',
    });
  });

  it('updates only the requested controls while preserving the other value', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        config_key: 'agent_tool_approval_enabled', config_value: 'true',
      }, {
        config_key: 'agent_sandbox_network_enabled', config_value: 'false',
      }]])
      .mockResolvedValueOnce([{}]);
    const service = new AgentExecutionConfigService(() => ({ execute }));

    await expect(service.set({ restrictedNetworkEnabled: true }, 7)).resolves.toEqual({
      approvalEnabled: true,
      restrictedNetworkEnabled: true,
      reasonCode: 'EXECUTION_CONFIG_UPDATED',
    });
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), expect.arrayContaining([
      'agent_sandbox_network_enabled', 'true', 7,
    ]));
  });
});
