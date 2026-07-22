import { describe, expect, it } from 'vitest';
import './dashboard.js';

describe('dashboard capacity formatting', () => {
  it('preserves database capacity precision so the total matches instance management', () => {
    const dashboard = document.createElement('dashboard-page') as any;

    expect(dashboard._formatBytes(2.71)).toBe('2.71 GB');
  });
});
