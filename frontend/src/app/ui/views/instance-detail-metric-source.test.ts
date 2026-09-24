import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(import.meta.dirname, 'instance-detail.ts'), 'utf8');

describe('instance detail Metrics V2 source', () => {
  it('renders semantic metrics without a legacy metric fallback', () => {
    expect(source).toContain('<semantic-metrics resourceType="instance"');
    expect(source).not.toContain('metricSource');
    expect(source).not.toContain('source_contract');
    expect(source).not.toContain('_renderLegacyOverview');
    expect(source).not.toContain('_renderLegacyTrend');
    expect(source).not.toContain('旧版趋势');
    expect(source).not.toMatch(/\/api\/database\/instances\/\$\{[^}]+\}\/metrics(?:\/history)?/);
  });
});
