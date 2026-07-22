import { beforeEach, describe, expect, it, vi } from 'vitest';

const { databaseService, invoke } = vi.hoisted(() => ({
  databaseService: {
    findRecentCompleted: vi.fn(),
    createAnalysis: vi.fn(),
    getAnalysisById: vi.fn(),
    failAnalysis: vi.fn(),
    waitForCompletion: vi.fn(),
  },
  invoke: vi.fn(),
}));

vi.mock('./ai-analysis-database-service.js', () => ({
  aiAnalysisDatabaseService: databaseService,
}));

vi.mock('./adapter/get-agent-engine.js', () => ({
  getAgentEngine: vi.fn(async () => ({ invoke })),
}));

vi.mock('./prompts/prompt-manager.js', () => ({
  promptManager: { getPrompt: vi.fn(() => null) },
}));

import { dispatchOrReuse } from './ai-agent-bridge.js';

describe('dispatchOrReuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseService.findRecentCompleted.mockResolvedValue(null);
    databaseService.getAnalysisById.mockResolvedValue({ status: 'running' });
    databaseService.failAnalysis.mockResolvedValue({ success: true });
    databaseService.waitForCompletion.mockResolvedValue(null);
  });

  it('persists the concrete provider error for a failed Agent run', async () => {
    invoke.mockResolvedValue({
      content: 'DeepSeek request failed',
      stopReason: 'error',
      error: '401 Authentication Fails',
    });

    await dispatchOrReuse({
      type: 'alert_rca',
      cacheKey: 'alert:42',
      instanceId: 7,
      sessionKey: 'analysis:test',
      userMessage: 'Analyze alert 42',
      existingAnalysisId: 42,
    });

    await vi.waitFor(() => {
      expect(databaseService.failAnalysis).toHaveBeenCalledWith(
        42,
        '401 Authentication Fails',
      );
    });
  });
});
