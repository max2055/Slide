import { describe, expect, it, vi } from 'vitest';
import { createFatalProcessHandler } from './fatal-process.js';

describe('fatal process boundary', () => {
  it('records and logs only the stable reason code before bounded shutdown', async () => {
    const log = vi.fn();
    const record = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn(() => { throw new Error('EXIT'); }) as unknown as (code: number) => never;
    const handler = createFatalProcessHandler('FATAL_UNCAUGHT_EXCEPTION', exit, log, record);
    await expect(handler()).rejects.toThrow('EXIT');
    expect(log).toHaveBeenCalledWith('FATAL_UNCAUGHT_EXCEPTION');
    expect(record).toHaveBeenCalledWith('FATAL_UNCAUGHT_EXCEPTION');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
