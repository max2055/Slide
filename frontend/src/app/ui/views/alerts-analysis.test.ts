import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const views = resolve(import.meta.dirname, '.');
const components = resolve(views, '../components');
const alertsPage = readFileSync(resolve(views, 'alerts.ts'), 'utf8');
const alertList = readFileSync(resolve(components, 'alert-list.ts'), 'utf8');
const viewer = readFileSync(resolve(components, 'alert-analysis-viewer.ts'), 'utf8');

describe('Alert analysis UI contract', () => {
  it('wires the page to the dedicated list and result viewer components', () => {
    expect(alertsPage).toContain('alert-list.js');
    expect(alertsPage).toContain('alert-analysis-viewer.js');
    expect(alertsPage).toContain('<alert-analysis-viewer');
  });

  it('renders all persisted and in-flight analysis states in the alert list', () => {
    expect(alertList).toContain('analysis-badge--completed');
    expect(alertList).toContain('analysis-badge--running');
    expect(alertList).toContain('analysis-badge--failed');
    expect(alertList).toContain('已分析');
    expect(alertList).toContain('分析中');
    expect(alertList).toContain('分析失败');
  });

  it('renders completed results with the sanitized analysis component', () => {
    expect(viewer).toContain('<app-dialog');
    expect(viewer).toContain('<ai-analysis-result');
    expect(viewer).toContain('.result=${record.result}');
    expect(viewer).toContain('analysisType="alert_rca"');
    expect(viewer).toContain('triggerType=${record.trigger_type}');
  });
});
