import { describe, expect, it, vi } from 'vitest';
import { AgentCodeExecutionService } from './agent-code-execution-service.js';

function config(enabled: boolean, reasonCode = enabled ? 'SANDBOX_ENABLED' : 'SANDBOX_DISABLED') {
  return { get: vi.fn().mockResolvedValue({ enabled, reasonCode }) };
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    configured: vi.fn().mockReturnValue(true),
    status: vi.fn().mockResolvedValue({
      status: 'ok',
      daemon: { reachable: true, rootless: true },
      policy: { runtimes: ['shell', 'python', 'node'] },
    }),
    execute: vi.fn().mockResolvedValue({
      jobId: 'job-1', exitCode: 0, signal: null, timedOut: false,
      stdout: 'ok\n', stderr: '', outputTruncated: false,
    }),
    ...overrides,
  };
}

function executionConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue({
      approvalEnabled: true,
      restrictedNetworkEnabled: false,
      reasonCode: 'EXECUTION_CONFIG_READY',
      ...overrides,
    }),
  };
}

describe('AgentCodeExecutionService', () => {
  it.each([
    [false, 'SANDBOX_DISABLED'],
    [false, 'SANDBOX_CONFIG_UNAVAILABLE'],
  ])('fails closed before contacting the controller when enabled=%s reason=%s', async (enabled, reasonCode) => {
    const sandbox = controller();
    const service = new AgentCodeExecutionService(config(enabled, reasonCode) as any, sandbox as any);

    const result = await service.execute({ runtime: 'node', code: 'console.log("no")' });

    expect(result).toEqual(expect.objectContaining({ success: false, errorCode: reasonCode }));
    expect(sandbox.status).not.toHaveBeenCalled();
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid inputs before sandbox execution', async () => {
    const sandbox = controller();
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any);

    await expect(service.execute({ runtime: 'ruby', code: 'puts 1' })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_RUNTIME_UNAVAILABLE' }),
    );
    await expect(service.execute({ runtime: 'node', code: 'x'.repeat(1024 * 1024 + 1) })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_INPUT_INVALID' }),
    );
    await expect(service.execute({ runtime: 'node', code: 'ok', files: [{ path: '../secret', content: 'x' }] })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_INPUT_INVALID' }),
    );
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it('checks current rootless readiness and runtime before every execution', async () => {
    const sandbox = controller({
      status: vi.fn().mockResolvedValue({
        status: 'ok', daemon: { reachable: true, rootless: false }, policy: { runtimes: ['node'] },
      }),
    });
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any);

    await expect(service.execute({ runtime: 'node', code: 'console.log(1)' })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_UNAVAILABLE' }),
    );
    expect(sandbox.execute).not.toHaveBeenCalled();
  });

  it('denies network code while the restricted network switch is disabled', async () => {
    const sandbox = controller();
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any, executionConfig() as any);

    await expect(service.execute({ runtime: 'shell', code: 'nmap -p 3306 10.17.12.0/24' })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_NETWORK_DISABLED' }),
    );
    expect(sandbox.status).not.toHaveBeenCalled();
  });

  it('requests the restricted network only when enabled and reported by the controller', async () => {
    const sandbox = controller({
      status: vi.fn().mockResolvedValue({
        status: 'ok', daemon: { reachable: true, rootless: true }, policy: { runtimes: ['shell'], network: 'restricted' },
      }),
    });
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any, executionConfig({ restrictedNetworkEnabled: true }) as any);

    await expect(service.execute({ runtime: 'shell', code: 'nmap -p 3306 10.17.12.0/24' })).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(sandbox.execute.mock.calls[0][0]).toMatchObject({ networkMode: 'restricted' });
  });

  it('executes valid code exactly once with fixed command and no environment', async () => {
    const sandbox = controller();
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any);

    const result = await service.execute({
      runtime: 'node',
      code: 'console.log("ok")',
      files: [{ path: 'data/input.txt', content: 'input' }],
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ jobId: 'job-1', exitCode: 0, stdout: 'ok\n' }),
    });
    expect(sandbox.execute).toHaveBeenCalledTimes(1);
    expect(sandbox.execute).toHaveBeenCalledWith({
      runtime: 'node',
      command: ['node', 'main.mjs'],
      files: [
        { path: 'main.mjs', contentBase64: Buffer.from('console.log("ok")').toString('base64') },
        { path: 'data/input.txt', contentBase64: Buffer.from('input').toString('base64') },
      ],
      timeoutMs: 5000,
    }, expect.any(AbortSignal));
    expect(sandbox.execute.mock.calls[0][0]).not.toHaveProperty('env');
  });

  it.each([
    new Error('SANDBOX_CLIENT_NOT_CONFIGURED'),
    new DOMException('timed out', 'TimeoutError'),
  ])('normalizes controller failure without fallback or detail leakage', async (error) => {
    const sandbox = controller({ execute: vi.fn().mockRejectedValue(error) });
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any);

    const result = await service.execute({ runtime: 'node', code: 'console.log(1)' });

    expect(result.success).toBe(false);
    expect(['SANDBOX_UNAVAILABLE', 'SANDBOX_TIMEOUT']).toContain(result.errorCode);
    expect(JSON.stringify(result)).not.toContain(error.message);
    expect(sandbox.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed controller results', async () => {
    const sandbox = controller({ execute: vi.fn().mockResolvedValue({ stdout: 'missing fields' }) });
    const service = new AgentCodeExecutionService(config(true) as any, sandbox as any);

    await expect(service.execute({ runtime: 'node', code: 'console.log(1)' })).resolves.toEqual(
      expect.objectContaining({ success: false, errorCode: 'SANDBOX_EXECUTION_FAILED' }),
    );
  });
});
