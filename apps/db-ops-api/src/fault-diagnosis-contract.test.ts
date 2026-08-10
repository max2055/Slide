import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFaultDiagnosisInstanceId } from './fault-diagnosis-route-input.js';

const sourceRoot = import.meta.dirname;
const serverSource = readFileSync(resolve(sourceRoot, '../server.ts'), 'utf8');
const serviceSource = readFileSync(resolve(sourceRoot, 'fault-diagnosis-service.ts'), 'utf8');
const bridgeSource = readFileSync(resolve(sourceRoot, 'ai-agent-bridge.ts'), 'utf8');
const cronServiceSource = readFileSync(resolve(sourceRoot, 'cron/cron-job-service.ts'), 'utf8');
const typedWorkflowMigration = resolve(sourceRoot, '../sql/migrations/062_fault_diagnosis_typed_workflow.sql');

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function routeBlock(startMarker: string, endMarker: string): string {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return serverSource.slice(start, end);
}

describe('manual fault diagnosis route contract', () => {
  it.each([
    [7, 7],
    ['7', 7],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('accepts canonical positive instance id %j', (value, expected) => {
    expect(parseFaultDiagnosisInstanceId(value)).toBe(expected);
  });

  it.each([
    true,
    false,
    [7],
    ['7'],
    {},
    null,
    undefined,
    0,
    -1,
    1.5,
    '',
    '07',
    ' 7',
    '7 ',
    '+7',
    '1e1',
    String(Number.MAX_SAFE_INTEGER + 1),
  ])('rejects non-canonical instance id %j', (value) => {
    expect(parseFaultDiagnosisInstanceId(value)).toBeNull();
  });

  it('validates submit instance_id before authorization or diagnosis while ignoring fault trigger_type', () => {
    const submit = routeBlock("fastify.post('/api/ai/analysis'", '// 轮询分析状态');
    const invalidGuard = "if (analysis_type === 'fault_diagnosis' && faultInstanceId === null)";
    const accessCheck = 'hasInstanceAccess((request as any).user';
    const serviceCall = 'faultDiagnosisService.diagnoseInstance((request as any).user, faultInstanceId)';

    expect(submit).toContain('parseFaultDiagnosisInstanceId(instance_id)');
    expect(submit).toContain(invalidGuard);
    expect(submit).toContain(serviceCall);
    if (submit.includes(accessCheck)) {
      expect(submit.indexOf(invalidGuard)).toBeLessThan(submit.indexOf(accessCheck));
    }
    expect(submit.indexOf(invalidGuard)).toBeLessThan(submit.indexOf(serviceCall));
    expect(submit.slice(submit.indexOf(invalidGuard), submit.indexOf(serviceCall))).toContain('reply.code(400)');
    expect(submit).not.toMatch(/faultDiagnosisService\.diagnoseInstance\(\s*instance_id\s*,\s*trigger_type/);
    expect(submit).toContain('topsqlAnalysisService.analyzeSlowQuery(related_id, instance_id, trigger_type)');
    expect(submit).toContain('alertRCAService.analyzeAlert(related_id, trigger_type)');
  });

  it('validates persisted instance_id before fault reanalysis', () => {
    const reanalyze = routeBlock("fastify.post('/api/ai/analysis/:id/reanalyze'", '// 获取自动分析配置');
    const invalidGuard = "if (existing.analysis_type === 'fault_diagnosis' && faultInstanceId === null)";
    const accessCheck = 'hasInstanceAccess((request as any).user';
    const serviceCall = 'faultDiagnosisService.diagnoseInstance((request as any).user, faultInstanceId)';

    expect(reanalyze).toContain('parseFaultDiagnosisInstanceId(existing.instance_id)');
    expect(reanalyze).toContain(invalidGuard);
    expect(reanalyze).toContain(serviceCall);
    if (reanalyze.includes(accessCheck)) {
      expect(reanalyze.indexOf(invalidGuard)).toBeLessThan(reanalyze.indexOf(accessCheck));
    }
    expect(reanalyze.indexOf(invalidGuard)).toBeLessThan(reanalyze.indexOf(serviceCall));
    expect(reanalyze.slice(reanalyze.indexOf(invalidGuard), reanalyze.indexOf(serviceCall))).toContain('reply.code(400)');
    expect(reanalyze).not.toMatch(/faultDiagnosisService\.diagnoseInstance\(\s*existing\.instance_id\s*,\s*['"]manual['"]/);
  });

  it('keeps automatic diagnosis exclusively behind a typed workflow registered before the worker starts', () => {
    const registration = "workflowRegistry.register('fault.diagnose-unhealthy', async () => { await faultDiagnosisService.diagnoseUnhealthyInstances(); });";
    const registryConstruction = 'const workflowRegistry = new JobRegistry();';
    const workerConstruction = 'const workflowRuntime = new WorkerRuntime';
    const workerStart = 'workflowTimer = setInterval';

    expect(serverSource).toContain(registration);
    expect(serverSource.indexOf(registryConstruction)).toBeLessThan(serverSource.indexOf(registration));
    expect(serverSource.indexOf(registration)).toBeLessThan(serverSource.indexOf(workerConstruction));
    expect(serverSource.indexOf(registration)).toBeLessThan(serverSource.indexOf(workerStart));

    const productionSources = [resolve(sourceRoot, '../server.ts'), ...productionTypeScriptFiles(sourceRoot)];
    const references = productionSources.flatMap((path) => {
      if (path === resolve(sourceRoot, 'fault-diagnosis-service.ts')) return [];
      const matches = readFileSync(path, 'utf8').match(/\bdiagnoseUnhealthyInstances\b/g) ?? [];
      return matches.length > 0 ? [{ file: relative(sourceRoot, path), references: matches.length }] : [];
    });
    expect(references).toEqual([{ file: '../server.ts', references: 1 }]);
  });

  it('migrates and recovery-seeds only the legacy fault diagnosis row to the typed handler', () => {
    expect(existsSync(typedWorkflowMigration)).toBe(true);
    if (!existsSync(typedWorkflowMigration)) return;

    expect(readFileSync(typedWorkflowMigration, 'utf8')).toBe(
      "UPDATE cron_jobs SET handler_key = 'fault.diagnose-unhealthy' WHERE name = '故障自动诊断';\n",
    );
    expect(cronServiceSource.match(/handler_key:\s*'fault\.diagnose-unhealthy'/g)).toHaveLength(1);
    const faultDefault = cronServiceSource.match(/\{\s*name:\s*'故障自动诊断'[\s\S]*?\},/)?.[0] ?? '';
    expect(faultDefault).toContain("handler_key: 'fault.diagnose-unhealthy'");
    expect(cronServiceSource).toMatch(/INSERT INTO cron_jobs \(name, task_description, cron_expr, handler_key,/);
    expect(cronServiceSource).toMatch(/\[d\.name, d\.task_description, d\.cron_expr, d\.handler_key \?\? null,/);
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
