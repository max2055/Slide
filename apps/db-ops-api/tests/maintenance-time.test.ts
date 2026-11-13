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

// MAX-409/MAX-410: MySQL DAYOFWEEK numbering, configured zone and half-open bounds.
describe('weekly matching acceptance matrix', () => {
  it.each(['*', '1', '1,3,7'])('matches Sunday wildcard/single/list %s', day_of_week => {
    expect(matchesMaintenanceTime({ ...window, day_of_week }, new Date('2026-11-01T15:00:00Z'))).toBe(true);
  });
  it.each([
    ['2026-11-01T14:59:59Z', false], ['2026-11-01T15:00:00Z', true],
    ['2026-11-01T15:59:59Z', true], ['2026-11-01T16:00:00Z', true],
    ['2026-11-01T17:59:59Z', true], ['2026-11-01T18:00:00Z', false],
  ])('Sunday overnight at %s is %s', (at, expected) => {
    expect(matchesMaintenanceTime({ ...window, day_of_week: '1' }, new Date(at))).toBe(expected);
  });
  it('wraps Saturday to Sunday using the start weekday', () => {
    expect(matchesMaintenanceTime({ ...window, day_of_week: '7' }, new Date('2026-10-31T17:00:00Z'))).toBe(true);
  });
  it('evaluates each window in its own timezone with normal boundaries', () => {
    const normal = { ...window, day_of_week: '2', start_time: '09:00', end_time: '10:00' };
    for (const [at, expected] of [['00:59:59', false], ['01:00:00', true], ['01:59:59', true], ['02:00:00', false]] as const) {
      expect(matchesMaintenanceTime(normal, new Date(`2026-11-02T${at}Z`))).toBe(expected);
    }
    expect(matchesMaintenanceTime({ ...normal, timezone: 'UTC' }, new Date('2026-11-02T01:00:00Z'))).toBe(false);
  });
});
