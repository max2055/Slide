import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db-connection', () => ({
  dbConnection: { getPool: () => mockPool, isConnected: () => true },
}));

const mockPool = { execute: vi.fn().mockResolvedValue([[{ insertId: 1 }]]) };

describe('maintenance-window-service.ts', () => {
  beforeEach(() => { vi.resetModules(); vi.mocked(mockPool.execute).mockReset(); });

  it('isActiveMaintenanceWindow returns false when no active window', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.isActiveMaintenanceWindow(1);
    expect(result.active).toBe(false);
  });

  it('isActiveMaintenanceWindow returns active with window details', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([[{
      id: 1, name: 'DB Maintenance', description: null, instance_id: 1,
      day_of_week: '1,2,3,4,5', start_time: '02:00:00', end_time: '06:00:00',
      timezone: 'Asia/Shanghai', suppress_evaluation: 1, enabled: 1,
    }]]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.isActiveMaintenanceWindow(1);
    expect(result.active).toBe(true);
    expect(result.window?.suppress_evaluation).toBe(true);
  });

  it('createMaintenanceWindow rejects invalid day_of_week', async () => {
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.createMaintenanceWindow({
      name: 'Test', day_of_week: '8', start_time: '02:00', end_time: '06:00',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效的星期值');
  });

  it('createMaintenanceWindow accepts valid day_of_week', async () => {
    vi.mocked(mockPool.execute).mockResolvedValueOnce([{ insertId: 1 }]);
    const { maintenanceWindowService } = await import('../src/maintenance-window-service');
    const result = await maintenanceWindowService.createMaintenanceWindow({
      name: 'Weekend', day_of_week: '1,7', start_time: '00:00', end_time: '08:00',
    });
    expect(result.success).toBe(true);
  });

  it('getMaintenanceWindows returns all windows', async () => {
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
