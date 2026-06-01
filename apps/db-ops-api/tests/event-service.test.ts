import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/alert-rca-service', () => ({
  alertRCAService: { analyzeAlert: vi.fn().mockResolvedValue({ success: true }) },
}));

const mockPool = { execute: vi.fn().mockResolvedValue([[]]) };

describe('alert-event-service.ts', () => {
  beforeEach(() => { vi.resetModules(); vi.mocked(mockPool.execute).mockReset(); });

  it('getEvents returns empty when no events', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEvents();
    expect(Array.isArray(result)).toBe(true);
  });

  it('getEvents with options adds WHERE clauses', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    await alertEventService.getEvents({ status: 'open', severity: 'critical' });
    const callSql = vi.mocked(mockPool.execute).mock.calls[0][0] as string;
    expect(callSql).toContain("e.status = ?");
    expect(callSql).toContain("e.severity = ?");
  });

  it('getEventById returns null when event not found', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEventById(999);
    expect(result).toBeNull();
  });

  it('getEventById returns event with alerts and logs', async () => {
    vi.mocked(mockPool.execute)
      .mockResolvedValueOnce([[{ id: 1, title: 'Test Event', status: 'open' }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEventById(1);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Event');
    expect(Array.isArray(result!.alerts)).toBe(true);
    expect(Array.isArray(result!.logs)).toBe(true);
  });

  it('createEvent succeeds', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([{ insertId: 1 }]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.createEvent({
      event_id: 'test-uuid', title: 'Test', instance_id: 1, severity: 'warning',
    });
    expect(result.success).toBe(true);
    expect(result.eventId).toBe(1);
  });

  it('assignEvent logs assignment', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.assignEvent(1, 42);
    expect(result.success).toBe(true);
  });

  it('startInvestigation transitions status', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{ status: 'open' }]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.startInvestigation(1, 1);
    expect(result.success).toBe(true);
  });

  it('startInvestigation fails from closed', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{ status: 'closed' }]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.startInvestigation(1, 1);
    expect(result.success).toBe(false);
  });

  it('closeEvent works from any non-closed state', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{ status: 'open' }]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.closeEvent(1);
    expect(result.success).toBe(true);
  });

  it('closeEvent fails when already closed', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{ status: 'closed' }]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.closeEvent(1);
    expect(result.success).toBe(false);
  });

  it('getEventStats returns counters', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{
      total: 5, open: 1, investigating: 2, handled: 0, resolved: 1, closed: 1,
    }]]);
    const { alertEventService } = await import('../src/alert-event-service');
    const stats = await alertEventService.getEventStats();
    expect(stats.total).toBe(5);
    expect(stats.open).toBe(1);
  });
});
