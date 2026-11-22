import type { Pool } from 'mysql2/promise';
import { expect, it, vi } from 'vitest';
import { evaluateTemplateClock } from './runtime.js';

it('rolls back a failed clock evaluation and continues the remaining bindings', async () => {
  const connection = () => ({
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn().mockResolvedValue([[]]),
  });
  const failed = connection(), next = connection();
  failed.execute.mockRejectedValueOnce(new Error('query failure'));
  const pool = {
    execute: vi.fn().mockResolvedValue([[{ resource_key: 'instance:1' }, { resource_key: 'instance:2' }]]),
    getConnection: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(next),
  };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await evaluateTemplateClock(pool as unknown as Pool);
    expect(failed.rollback).toHaveBeenCalledOnce();
    expect(failed.commit).not.toHaveBeenCalled();
    expect(failed.release).toHaveBeenCalledOnce();
    expect(next.execute).toHaveBeenCalledWith(expect.stringContaining('WHERE resource_key=?'), ['instance:2']);
    expect(next.commit).toHaveBeenCalledOnce();
    expect(next.release).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[TemplateTriggers] Clock evaluation failed:', { resource: 'instance:1' });
  } finally {
    log.mockRestore();
  }
});
