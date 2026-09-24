import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(import.meta.dirname, 'instance-detail.ts'), 'utf8');

describe('instance detail formal metric source', () => {
  it('tracks the backend source contract and clears incompatible legacy caches', () => {
    expect(source).toContain('metricSource');
    expect(source).toContain('m.source_contract');
    expect(source).toContain('h.source_contract');
    expect(source).toContain('this.metricsHistory = {}');
    expect(source).toContain('this.overviewHistory = null');
  });

  it('renders canonical semantic metrics for V2 overview and hides legacy charts', () => {
    expect(source).toContain('this.metricSource === "legacy"');
    expect(source).toContain('<semantic-metrics resourceType="instance"');
    expect(source).toContain('this._renderLegacyOverview()');
    expect(source).toContain('this._renderLegacyTrend()');
  });
});
