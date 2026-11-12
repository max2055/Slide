import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseLog } from './database-log-service.js';

vi.mock('./db-connection.js', () => ({ dbConnection: {} }));
vi.mock('./database-service.js', () => ({ databaseService: {} }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: {} }));
vi.mock('./llm-service.js', () => ({ llmService: { chatWithTracking: vi.fn() } }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {
  createAnalysis: vi.fn(), updateStatus: vi.fn(), completeAnalysis: vi.fn(), failAnalysis: vi.fn(),
} }));

import { databaseLogService } from './database-log-service.js';
import { llmService } from './llm-service.js';
import { aiAnalysisDatabaseService as analysis } from './ai-analysis-database-service.js';

const secrets = ['canaryPassword425', 'canaryToken425', 'canaryUser425', 'canaryHost425',
  'canarySql425', '998877665544', 'canaryPattern425'];
const log = (): DatabaseLog => ({
  id: 1, instance_id: 2, log_level: 'error', source: 'mysql_error',
  message: 'MY-010584 connection refused password=canaryPassword425\nAuthorization: Bearer canaryToken425',
  raw_content: 'ORA-00060 deadlock\nmysql://canaryUser425:canaryPassword425@canaryHost425/db\nSELECT * FROM users WHERE email=\'canarySql425\' AND phone=998877665544',
  detected_patterns: [{ pattern: 'canaryPattern425', severity: 'critical', message: 'canaryPattern425' }],
  collected_at: new Date(), created_at: new Date(),
});

describe('MAX-425 log analysis egress', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(analysis.createAnalysis).mockResolvedValue({ success: true, analysisId: 7 });
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ success: true, content: 'diagnosis' });
  });

  it.each([undefined, 12])('sanitizes both log fields before automatic/manual model calls (%s)', async (existingId) => {
    const input = log();
    const original = structuredClone(input);
    await databaseLogService.triggerLogAnalysis([input], 2, existingId);
    const calls = vi.mocked(llmService.chatWithTracking).mock.calls;
    expect(calls).toHaveLength(1);
    const wire = JSON.stringify(calls[0]);
    for (const secret of secrets) expect(wire).not.toContain(secret);
    for (const diagnostic of ['MY-010584', 'ORA-00060', 'deadlock', 'connection refused', 'SELECT', 'WHERE']) {
      expect(wire).toContain(diagnostic);
    }
    expect(calls[0][1]).toMatchObject({ purpose: 'log_analysis', instanceId: 2 });
    expect(input).toEqual(original);
    expect(analysis.completeAnalysis).toHaveBeenCalledOnce();
    expect(analysis.createAnalysis).toHaveBeenCalledTimes(existingId ? 0 : 1);
  });

  it('keeps failure handling and sends no second request after a provider failure', async () => {
    vi.mocked(llmService.chatWithTracking).mockResolvedValue({ success: false, error: 'unavailable' });
    await databaseLogService.triggerLogAnalysis([log()], 2);
    expect(llmService.chatWithTracking).toHaveBeenCalledOnce();
    expect(analysis.failAnalysis).toHaveBeenCalledWith(7, 'unavailable');
    expect(analysis.completeAnalysis).not.toHaveBeenCalled();
  });

  it.each([undefined, 12])('#323 review: masks Oracle and Bearer contexts in both fields (%s)', async (existingId) => {
    const input = { ...log(), message: "SELECT q'[can' connection refused ]' FROM dual\nBearer deadlock",
      raw_content: "SELECT q'!can' connection refused !' FROM dual\nbEaReR\tdeadlock" };
    await databaseLogService.triggerLogAnalysis([input], 2, existingId);
    expect(llmService.chatWithTracking).toHaveBeenCalledOnce();
    const wire = JSON.stringify(vi.mocked(llmService.chatWithTracking).mock.calls[0]);
    expect(wire).not.toMatch(/connection|refused|deadlock/i);
    expect(wire).toContain('SELECT');
    expect(wire).toContain('FROM');
    expect(analysis.completeAnalysis).toHaveBeenCalledOnce();
  });

  it('does not call the model without errors or when record creation fails', async () => {
    await databaseLogService.triggerLogAnalysis([{ ...log(), log_level: 'info' }], 2);
    vi.mocked(analysis.createAnalysis).mockResolvedValue({ success: false });
    await databaseLogService.triggerLogAnalysis([log()], 2);
    expect(llmService.chatWithTracking).not.toHaveBeenCalled();
  });

  it('fails closed for a malformed stored message instead of falling back to raw logs', async () => {
    const malformed = { ...log(), message: null } as unknown as DatabaseLog;
    await databaseLogService.triggerLogAnalysis([malformed], 2, 12);
    expect(llmService.chatWithTracking).not.toHaveBeenCalled();
    expect(analysis.failAnalysis).toHaveBeenCalledWith(12, expect.any(String));
    expect(analysis.completeAnalysis).not.toHaveBeenCalled();
  });
});
