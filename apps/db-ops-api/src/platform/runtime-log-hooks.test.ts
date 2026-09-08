import { describe, expect, it, vi } from 'vitest';
import { platformLogs } from './structured-log-evidence-adapter.js';
import { AgentRunService } from '../adapter/agent-run-service.js';
import { MysqlCollectionScheduleStore } from '../collection-scheduler.js';

describe('runtime structured log producers', () => {
  it('reports an agent terminal result without result or error body', async () => {
    const record = vi.spyOn(platformLogs, 'record');
    const service = new AgentRunService(() => ({ query: vi.fn(async () => [{ affectedRows: 1 }]) } as any));
    await service.finish('run-1', 'failed', { secret: 'private' }, 'password=private');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'agent', status: 'failed', correlationId: 'run-1' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('private'); record.mockRestore();
  });
  it('reports real collection outcomes after persistence', async () => {
    const record = vi.spyOn(platformLogs, 'record');
    const store = new MysqlCollectionScheduleStore(() => ({ execute: vi.fn(async () => [{ affectedRows: 1 }]) } as any));
    await store.record('server', 1, 'linux', { id: 'cpu_usage', default_interval: 60 }, Date.now(), false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'collector', status: 'failed' })); record.mockRestore();
  });
});
