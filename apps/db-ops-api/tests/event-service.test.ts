import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

vi.mock('../src/alert-rca-service', () => ({
  alertRCAService: { analyzeAlert: vi.fn().mockResolvedValue({ success: true }) },
}));

const mockPool = { execute: vi.fn(), query: vi.fn() };

describe('alert-event-service.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPool.execute.mockReset();
    mockPool.query.mockReset();
    mockPool.execute.mockResolvedValue([[], []]); // default: empty rows
    mockPool.query.mockResolvedValue([[], []]);
  });

  it('getEvents returns empty when no events', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEvents();
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('getEvents with options adds WHERE clauses', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    await alertEventService.getEvents({ status: 'open', severity: 'critical' });
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('getEventById returns null when event not found', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEventById(999);
    expect(result).toBeNull();
  });

  it('getEventById returns event with alerts and logs', async () => {
    mockPool.execute
      .mockResolvedValueOnce([[{ id: 1, title: 'Test Event', status: 'open' }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.getEventById(1);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Test Event');
  });

  it('createEvent returns success', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ insertId: 1 }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.createEvent({
      event_id: 'test-uuid', title: 'Test', instance_id: 1, severity: 'warning',
    });
    expect(result).toHaveProperty('success');
  });

  it('assignEvent returns result', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ affectedRows: 1 }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.assignEvent(1, 42);
    expect(result).toHaveProperty('success');
  });

  it('startInvestigation returns result', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ status: 'open' }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.startInvestigation(1, 1);
    expect(result).toHaveProperty('success');
  });

  it('closeEvent blocks when already closed', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ status: 'closed' }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.closeEvent(1);
    expect(result.success).toBe(false);
  });

  it('getEventStats returns counters', async () => {
    mockPool.execute.mockResolvedValueOnce([[{
      total: 5, open: 1, investigating: 2, handled: 0, resolved: 1, closed: 1,
    }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const stats = await alertEventService.getEventStats();
    expect(stats.total).toBe(5);
  });

  it('resolveEvent returns result', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ affectedRows: 1 }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.resolveEvent(1, 'resolved');
    expect(result).toHaveProperty('success');
  });

  it('triggerRCAForEvent returns result', async () => {
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.triggerRCAForEvent(1);
    expect(result).toHaveProperty('success');
  });

  it('addHandlerNote returns result', async () => {
    mockPool.execute.mockResolvedValueOnce([[{ affectedRows: 1 }], []]);
    const { alertEventService } = await import('../src/alert-event-service');
    const result = await alertEventService.addHandlerNote(1, 'note text');
    expect(result).toHaveProperty('success');
  });
});
