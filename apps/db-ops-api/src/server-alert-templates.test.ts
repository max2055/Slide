import { describe, expect, it } from 'vitest';
import { SERVER_ALERT_TEMPLATES } from './alert-rule-template-service.js';

describe('server alert template presets', () => {
  it('covers fixed-profile reachability, network, disk I/O, and process evidence', () => {
    const metrics = new Set(SERVER_ALERT_TEMPLATES.map((template) => template.metric_name));
    expect(metrics).toEqual(new Set([
      'reachability',
      'network_rx_errors', 'network_tx_errors', 'network_rx_drops', 'network_tx_drops',
      'disk_io_time_ms', 'process_count',
    ]));
    expect(SERVER_ALERT_TEMPLATES.every((template) => template.target_type === 'server')).toBe(true);
    expect(SERVER_ALERT_TEMPLATES.every((template) => template.threshold_template
      && template.threshold_template.warning <= template.threshold_template.error
      && template.threshold_template.error <= template.threshold_template.critical)).toBe(true);
  });
});
