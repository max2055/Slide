import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

const mockPool = { execute: vi.fn().mockResolvedValue([[{ insertId: 1 }]]) };

describe('maintenance-window-service.ts', () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => { vi.resetModules(); vi.mocked(mockPool.execute).mockReset(); });

  it('isActiveMaintenanceWindow returns false when no active window', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.isActiveMaintenanceWindow(1);
    expect(result.active).toBe(false);
  });

  it('isActiveMaintenanceWindow returns active with window details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T04:00:00Z'));
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{
      id: 1, name: 'DB Maintenance', description: null, instance_id: 1,
      day_of_week: '*', start_time: '00:00:00', end_time: '23:59:59',
      timezone: 'Asia/Shanghai', suppress_evaluation: 1, enabled: 1,
    }]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.isActiveMaintenanceWindow(1);
    expect(result.active).toBe(true);
    expect(result.window?.suppress_evaluation).toBe(true);
  });

  it('MAX244 database failure remains unknown instead of allowing notification', async () => {
    vi.mocked(mockPool.execute).mockRejectedValueOnce(new Error('unavailable'));
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    await expect(maintenanceWindowService.isActiveMaintenanceWindow(1))
      .rejects.toThrow('MAINTENANCE_STATE_UNAVAILABLE');
  });

  it('createMaintenanceWindow rejects invalid day_of_week', async () => {
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.createMaintenanceWindow({
      name: 'Test', day_of_week: '8', start_time: '02:00', end_time: '06:00',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的星期值');
  });

  // MAX-419 / GitHub #525: reject before SQL so an existing valid window survives.
  it.each([
    { day_of_week: 'abc' }, { day_of_week: '8' }, { day_of_week: '0' },
    { day_of_week: '1,,7' }, { day_of_week: '' }, { day_of_week: null },
    { day_of_week: 2 }, { day_of_week: '*,2' },
    { start_time: '24:00' }, { start_time: '1:00' }, { end_time: '02:60' },
    { end_time: '02:00:60' }, { end_time: null }, { timezone: '' }, { timezone: 'bad' },
  ])('rejects the same invalid schedule on create and update: %j', async changed => {
    const { maintenanceWindowService: service } = await import('../src/maintenance-window-service');
    const value = { name: 'Test', day_of_week: '*', start_time: '23:00', end_time: '02:00', ...changed };
    expect((await service.createMaintenanceWindow(value as any)).success).toBe(false);
    expect((await service.updateMaintenanceWindow(1, changed as any)).success).toBe(false);
    expect(mockPool.execute).not.toHaveBeenCalled();
  });

  it.each(['*', '1', '1,3,7', ' 2 , 4 '])('accepts and normalizes valid days on both writes: %s', async day_of_week => {
    mockPool.execute.mockResolvedValue([{ insertId: 1, affectedRows: 1 }]);
    const { maintenanceWindowService: service } = await import('../src/maintenance-window-service');
    expect((await service.createMaintenanceWindow({ name: 'valid', day_of_week, start_time: '23:00', end_time: '02:00:00' })).success).toBe(true);
    expect((await service.updateMaintenanceWindow(1, { day_of_week, start_time: '23:00', end_time: '02:00:00' })).success).toBe(true);
    expect(mockPool.execute.mock.calls[1][1]).toContain(day_of_week.split(',').map(d => d.trim()).join(','));
  });

  it('createMaintenanceWindow accepts valid day_of_week', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([{ insertId: 1 }]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.createMaintenanceWindow({
      name: 'Weekend', day_of_week: '1,7', start_time: '00:00', end_time: '08:00',
    });
    expect(result.success).toBe(true);
  });

  it('MAX244 failed list is unknown rather than an empty list', async () => {
    vi.mocked(mockPool.execute).mockRejectedValueOnce(new Error('unavailable'));
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    await expect(maintenanceWindowService.getMaintenanceWindows()).rejects.toThrow('MAINTENANCE_STATE_UNAVAILABLE');
  });

  it('getMaintenanceWindows returns all windows', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const windows = await maintenanceWindowService.getMaintenanceWindows();
    expect(Array.isArray(windows)).toBe(true);
  });

  it('deleteMaintenanceWindow executes DELETE', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.deleteMaintenanceWindow(1);
    expect(result.success).toBe(true);
  });

  it('startCacheRefresh and getCachedWindows work', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    maintenanceWindowService.startCacheRefresh(1);
    const cached = maintenanceWindowService.getCachedWindows();
    expect(Array.isArray(cached)).toBe(true);
    maintenanceWindowService.stopCacheRefresh();
  });
});
