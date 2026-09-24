import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = (file: string) => readFileSync(resolve(import.meta.dirname, file), 'utf8');

describe('resource pages use the formal Metrics V2 source', () => {
  it('does not render database list values from compatibility columns', () => {
    const text = source('instances-db.ts');
    expect(text).toContain('<resource-metrics-table resourceType="instance"');
    expect(text).not.toContain('已用空间（兼容数据）');
    expect(text).not.toContain('旧版数据，采集时间未知');
    expect(text).not.toContain('inst.data_size_gb');
    expect(text).not.toMatch(/\/api\/database\/instances\/\$\{[^}]+\}\/metrics/);
    expect(text).not.toContain('指标采集正常');
  });

  it('does not request or render legacy server metric summaries', () => {
    const text = source('servers-page.ts');
    expect(text).toContain('<resource-metrics-table resourceType="server"');
    expect(text).not.toContain('/api/servers/metrics/summary');
    expect(text).not.toContain('兼容数据');
    expect(text).not.toContain('_metricSummary');
  });

  it('uses semantic metrics exclusively on the server detail page', () => {
    const text = source('server-detail.ts');
    expect(text).toContain('<semantic-metrics resourceType="server"');
    expect(text).not.toContain('/metrics/history');
    expect(text).not.toMatch(/\/api\/servers\/\$\{[^}]+\}\/metrics/);
    expect(text).not.toContain('兼容采集');
    expect(text).not.toContain('旧版趋势');
  });

  it('uses semantic metrics for network overview and interface metrics', () => {
    const text = source('network-device-detail.ts');
    expect(text).toContain('<semantic-metrics resourceType="network_device"');
    expect(text).not.toContain('概览来自兼容采集');
    expect(text).not.toContain('`/api/network-devices/${id}/metrics`');
    expect(text).not.toContain('`/api/network-devices/${id}/interfaces`');
  });
});
