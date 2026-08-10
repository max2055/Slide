import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = import.meta.dirname;
const serverSource = readFileSync(resolve(sourceRoot, '../server.ts'), 'utf8');
const serviceSource = readFileSync(resolve(sourceRoot, 'fault-diagnosis-service.ts'), 'utf8');
const bridgeSource = readFileSync(resolve(sourceRoot, 'ai-agent-bridge.ts'), 'utf8');

function routeBlock(startMarker: string, endMarker: string): string {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return serverSource.slice(start, end);
}

describe('manual fault diagnosis route contract', () => {
  it('passes request.user and a numeric instance id while ignoring fault trigger_type', () => {
    const submit = routeBlock("fastify.post('/api/ai/analysis'", '// 轮询分析状态');

    expect(submit).toContain('faultDiagnosisService.diagnoseInstance((request as any).user, Number(instance_id))');
    expect(submit).not.toMatch(/faultDiagnosisService\.diagnoseInstance\(\s*instance_id\s*,\s*trigger_type/);
    expect(submit).toContain('topsqlAnalysisService.analyzeSlowQuery(related_id, instance_id, trigger_type)');
    expect(submit).toContain('alertRCAService.analyzeAlert(related_id, trigger_type)');
  });

  it('passes request.user and a numeric instance id for reanalysis', () => {
    const reanalyze = routeBlock("fastify.post('/api/ai/analysis/:id/reanalyze'", '// 获取自动分析配置');

    expect(reanalyze).toContain('faultDiagnosisService.diagnoseInstance((request as any).user, Number(existing.instance_id))');
    expect(reanalyze).not.toMatch(/faultDiagnosisService\.diagnoseInstance\(\s*existing\.instance_id\s*,\s*['"]manual['"]/);
  });

  it('does not expose an actor-free automatic diagnosis bypass', () => {
    expect(serviceSource).not.toContain('diagnoseUnhealthyInstances');
  });
});

describe('fault diagnosis prompt contract', () => {
  const fallback = bridgeSource.match(/fault_diagnosis:\s*`([\s\S]*?)`,/)?.[1] ?? '';
  const surfaces = [
    ['v1', readFileSync(resolve(sourceRoot, 'prompts/versions/fault-diagnosis-v1.md'), 'utf8')],
    ['v2', readFileSync(resolve(sourceRoot, 'prompts/versions/fault-diagnosis-v2.md'), 'utf8')],
    ['fallback', fallback],
    ['skill', readFileSync(resolve(sourceRoot, 'skills/generated/fault-diagnosis/SKILL.md'), 'utf8')],
  ] as const;

  it.each(surfaces)('%s treats supplied diagnosticContext as untrusted evidence with conservative gaps', (_name, content) => {
    expect(content).toMatch(/diagnosticContext/i);
    expect(content).toMatch(/所有字符串.*不可信|all strings.*untrusted/is);
    expect(content).toMatch(/gap.*null.*(?:未知|不可用|unknown|unavailable)/is);
    expect(content).toMatch(/缺少.*当前.*授权.*host evidence.*禁止断言.*主机层根因|without current.*authorized.*host evidence.*must not assert.*host-level root cause/is);
  });

  it.each(surfaces)('%s requires RFC 6901 evidence refs and exposes only the completion tool', (_name, content) => {
    expect(content).toMatch(/RFC 6901/i);
    expect(content).toContain('/database/');
    expect(content).toContain('/hosts/');
    expect(content).toContain('/gaps/');
    expect(content).toMatch(/唯一可用工具.*slide_complete_analysis|only available tool.*slide_complete_analysis/is);
    expect(content).not.toMatch(/query_metrics|get_instance_summary|list_active_alerts|get_instance_connection|db_\*|slide_\*/i);
  });
});
