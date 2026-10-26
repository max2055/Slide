import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MetricRegistry } from './metric-registry.js';
import { findAlertMetric } from './metrics/alert-metric-catalog.js';
import { validateAlertThresholdUnits } from './alerts/threshold-units.js';

// Execute the actual route handlers with the real, target-keyed registry.
// Only authorization and persistence are replaced in this focused regression.
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const routes = source.slice(source.indexOf('  // 创建告警规则'), source.indexOf('  // 删除告警规则'));

async function request(method: 'POST' | 'PUT', body: Record<string, unknown>, storedTarget = 'server',
  stored: Record<string, unknown> = {}) {
  const app = Fastify();
  const registry = new MetricRegistry();
  const service = { createAlertRule: vi.fn(async () => ({ success: true, ruleId: 99 })),
    updateAlertRule: vi.fn(async () => ({ success: true })) };
  const existing = { id: 99, target_type: storedTarget, metric_name: 'filesystem_size_bytes', threshold: 1,
    threshold_template: null, severity: 'warning', ...stored };
  const code = ts.transpileModule(routes, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('fastify', 'verifyToken', 'requirePermission', 'validateAlertRuleInstanceIds',
    'metricRegistry', 'findAlertMetric', 'validateAlertThresholdUnits', 'alertDatabaseService', 'requireAlertRuleAccess', code)(app,
    async () => {}, () => async () => {}, () => null, registry, findAlertMetric, validateAlertThresholdUnits, service,
    async () => existing);
  try {
    const response = await app.inject({ method, url: method === 'POST' ? '/api/alert-rules' : '/api/alert-rules/99', payload: body });
    return { status: response.statusCode, body: response.json(), service };
  } finally { await app.close(); }
}

describe('alert rule metric validation follows the resource target', () => {
  it.each([['server', 'filesystem_size_bytes'], ['network_device', 'device_cpu_percent'], ['instance', 'connections']])(
    'creates a %s rule with its collected metric', async (target_type, metric_name) => {
      const result = await request('POST', { target_type, metric_name, threshold: 1 });
      expect(result.status).toBe(200);
      expect(result.service.createAlertRule).toHaveBeenCalledWith(expect.objectContaining({ target_type, metric_name }));
    });
  it('keeps the instance default', async () => {
    expect((await request('POST', { metric_name: 'connections' })).status).toBe(200);
  });
  it('rejects a metric belonging to a different target', async () => {
    const result = await request('POST', { target_type: 'server', metric_name: 'connections' });
    expect(result.status).toBe(400);
    expect(result.service.createAlertRule).not.toHaveBeenCalled();
  });
  it('uses the persisted target when an update omits it', async () => {
    expect((await request('PUT', { metric_name: 'filesystem_used_bytes' })).status).toBe(200);
  });
  it('validates an explicitly changed target', async () => {
    expect((await request('PUT', { target_type: 'network_device', metric_name: 'device_cpu_percent' })).status).toBe(200);
  });
  it('rejects moving an existing metric to an incompatible target', async () => {
    const result = await request('PUT', { target_type: 'instance' });
    expect(result.status).toBe(400);
    expect(result.service.updateAlertRule).not.toHaveBeenCalled();
  });
});

describe('alert rule save checks threshold units (#256)', () => {
  const ratioRule = {
    metric_name: 'linux.filesystem.used_ratio', target_type: 'server',
    threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
  };

  it('rejects copying 80/90/95 onto the ratio metric on create', async () => {
    const result = await request('POST', {
      target_type: 'server', metric_name: 'linux.filesystem.used_ratio',
      threshold_template: { warning: 80, error: 90, critical: 95 },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('ALERT_THRESHOLD_RATIO_RANGE');
    expect(result.body.error).toContain('0.80/0.90/0.95');
    expect(result.service.createAlertRule).not.toHaveBeenCalled();
  });

  it('accepts 0.80/0.90/0.95 on the ratio metric', async () => {
    const result = await request('POST', {
      target_type: 'server', metric_name: 'linux.filesystem.used_ratio',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    });
    expect(result.status).toBe(200);
    expect(result.service.createAlertRule).toHaveBeenCalled();
  });

  it('rejects the ratio on a byte metric', async () => {
    const result = await request('POST', {
      metric_name: 'mysql.tables.estimated_allocated_bytes',
      threshold_template: { warning: 0.8, error: 0.9, critical: 0.95 },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('ALERT_THRESHOLD_BYTES_ABSOLUTE');
    expect(result.service.createAlertRule).not.toHaveBeenCalled();
  });

  it('rejects a bad template on update and leaves untouched rule fields alone', async () => {
    const stored = { ...ratioRule, threshold: 0.8 };
    const rejected = await request('PUT', { threshold_template: { warning: 80, error: 90, critical: 95 } },
      'server', stored);
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('ALERT_THRESHOLD_RATIO_RANGE');
    expect(rejected.service.updateAlertRule).not.toHaveBeenCalled();

    const toggled = await request('PUT', { enabled: false }, 'server', stored);
    expect(toggled.status).toBe(200);
    expect(toggled.service.updateAlertRule).toHaveBeenCalledWith(99, { enabled: false });
  });

  it('rejects a percent static threshold on an update that clears the template', async () => {
    const result = await request('PUT', { threshold: 80 },
      'server', { ...ratioRule, threshold: 0.8, threshold_template: null });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('ALERT_THRESHOLD_RATIO_RANGE');
  });
});
