import { describe, expect, it } from 'vitest';
import { NETWORK_DEVICE_ALERT_TEMPLATES } from '../alert-rule-template-service.js';

describe('network-device alert templates', () => {
  it('provides readonly Huawei templates for reachability, system, and interface evidence', () => {
    const byMetric = new Map<string, (typeof NETWORK_DEVICE_ALERT_TEMPLATES)[number]>(NETWORK_DEVICE_ALERT_TEMPLATES.map((template) => [template.metric_name, template]));
    const metrics: readonly string[] = [
      'device_reachability',
      'device_cpu_percent',
      'device_memory_percent',
      'device_temperature_celsius',
      'interface_oper_status',
      'interface_error_rate',
      'interface_drop_rate',
    ];
    for (const metric of metrics) {
      expect(byMetric.get(metric)).toMatchObject({ target_type: 'network_device', enabled: true });
    }
  });

  it('uses conservative durations and severity for interface and reachability failures', () => {
    expect(NETWORK_DEVICE_ALERT_TEMPLATES.find((template) => template.metric_name === 'device_reachability')).toMatchObject({
      operator: '=', threshold_template: { warning: 0, error: 0, critical: 0 }, severity: 'error', duration_seconds: 600,
    });
    expect(NETWORK_DEVICE_ALERT_TEMPLATES.find((template) => template.metric_name === 'interface_oper_status')).toMatchObject({
      operator: '=', threshold_template: { warning: 0, error: 0, critical: 0 },
    });
  });
});
