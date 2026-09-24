import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'report-service.ts'), 'utf8');

describe('report formal metric source contract', () => {
  it('routes metric-backed reports by formal source before legacy collection', () => {
    expect(source).toContain('operationalSource');
    expect(source).toContain("source === 'pending'");
    expect(source).toContain('METRIC_SOURCE_PENDING');
    expect(source).toContain("source === 'v2'");
    expect(source).toContain('generateSemanticMetricReport');
  });

  it('persists the complete semantic response and renders quality without legacy name mapping', () => {
    expect(source).toContain('metricConsumerService.query');
    expect(source).toContain("view: 'all'");
    expect(source).toContain('semantic_metrics: semantic');
    expect(source).toContain('bucket.quality.status');
    expect(source).toContain('bucket.unit');
    expect(source).not.toContain('semantic.cpu_usage');
  });
});
