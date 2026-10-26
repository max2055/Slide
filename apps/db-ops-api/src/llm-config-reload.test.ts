import { describe, expect, it, vi } from 'vitest';
import { reloadOutcome } from './llm-config-reload.js';

function logger() { return { warn: vi.fn() }; }

describe('reloadOutcome', () => {
  it('reports a persisted configuration that reached the runtime as applied', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    await expect(reloadOutcome(logger(), reload)).resolves.toEqual({ applied: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reports an unapplied configuration with a fixed code and no failure text', async () => {
    const log = logger();
    const reload = vi.fn().mockRejectedValue(new Error('HTTP 401 for key sk-ant-secret'));
    const outcome = await reloadOutcome(log, reload);
    expect(outcome).toEqual({ applied: false, reloadError: 'LLM_CONFIGURATION_UNAVAILABLE' });
    expect(JSON.stringify(outcome)).not.toContain('sk-ant-secret');
    expect(log.warn).toHaveBeenCalledWith({ code: 'LLM_CONFIGURATION_UNAVAILABLE' }, expect.any(String));
  });

  it('does not reject when the runtime reload throws a non-Error value', async () => {
    await expect(reloadOutcome(logger(), () => Promise.reject('boom'))).resolves.toMatchObject({ applied: false });
  });
});
