import { describe, it, expect } from 'vitest';
import { matchesMaintenanceTime } from '../src/maintenance-window-service';
const window = { day_of_week: '*', start_time: '23:00:00', end_time: '02:00:00', timezone: 'Asia/Shanghai' };
describe('MAX244 maintenance time boundaries', () => {
  it('uses the configured zone and excludes the end instant', () => {
    expect(matchesMaintenanceTime(window, new Date('2026-11-01T15:00:00Z'))).toBe(true);
    expect(matchesMaintenanceTime(window, new Date('2026-11-01T18:00:00Z'))).toBe(false);
  });
  it('attributes the overnight tail to the start weekday', () => {
    const sunday = { ...window, day_of_week: '1' };
    expect(matchesMaintenanceTime(sunday, new Date('2026-11-01T17:00:00Z'))).toBe(true);
    expect(matchesMaintenanceTime(sunday, new Date('2026-11-02T17:00:00Z'))).toBe(false);
  });
  it('rejects an invalid timezone rather than treating it as no maintenance', () => {
    expect(() => matchesMaintenanceTime({ ...window, timezone: 'invalid' }, new Date())).toThrow();
  });
});
