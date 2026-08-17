import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCodeExecutionService } from '../security/agent-code-execution-service.js';
import { executeCodeTool } from './code-execution-tool.js';

describe('execute_code tool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exposes only bounded code execution inputs and mandatory approval metadata', () => {
    expect(executeCodeTool).toMatchObject({
      name: 'execute_code',
      requiresApproval: true,
      dangerLevel: 5,
      requiredPermissions: ['ai:execute'],
    });
    expect(Object.keys(executeCodeTool.parameters.properties).sort()).toEqual([
      'approvalId', 'code', 'files', 'runtime', 'timeoutMs',
    ]);
    expect(executeCodeTool.parameters.properties.runtime.enum).toEqual(['shell', 'python', 'node']);
  });

  it('delegates directly to the exclusive code execution service', async () => {
    const execute = vi.spyOn(agentCodeExecutionService, 'execute').mockResolvedValue({
      success: true,
      data: { jobId: 'job-1' },
    });
    const args = { runtime: 'node', code: 'console.log(1)', timeoutMs: 2000, approvalId: '42' };

    await expect(executeCodeTool.handler(args)).resolves.toEqual({ success: true, data: { jobId: 'job-1' } });
    expect(execute).toHaveBeenCalledWith({ runtime: 'node', code: 'console.log(1)', timeoutMs: 2000 });
  });
});
