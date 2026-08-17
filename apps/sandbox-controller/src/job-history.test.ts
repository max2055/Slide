import { describe, expect, it } from 'vitest';
import { SandboxJobHistory } from './job-history.js';

describe('SandboxJobHistory', () => {
  it('keeps a bounded newest-first metadata-only history', () => {
    const history = new SandboxJobHistory(2);
    const make = (jobId: string) => ({
      jobId, runtime: 'node', status: 'succeeded' as const, exitCode: 0, timedOut: false,
      outputTruncated: false, createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000,
    });
    history.add(make('one'));
    history.add(make('two'));
    history.add(make('three'));
    expect(history.list().map((entry) => entry.jobId)).toEqual(['three', 'two']);
    expect(JSON.stringify(history.list())).not.toContain('command');
    expect(JSON.stringify(history.list())).not.toContain('stdout');
  });
});
