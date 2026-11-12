import { createServer } from 'node:http';
import { once } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from './llm-database-service.js';
import type { DatabaseLog } from './database-log-service.js';

vi.mock('./db-connection.js', () => ({ dbConnection: {} }));
vi.mock('./database-service.js', () => ({ databaseService: {} }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: {} }));
vi.mock('./llm-database-service.js', () => ({ llmDatabaseService: {
  getAllProviders: vi.fn(), getSceneBindings: vi.fn(), getProviderApiKey: vi.fn(), recordUsage: vi.fn(),
} }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {
  createAnalysis: vi.fn(), updateStatus: vi.fn(), completeAnalysis: vi.fn(), failAnalysis: vi.fn(),
} }));

import { databaseLogService } from './database-log-service.js';
import { llmDatabaseService as store } from './llm-database-service.js';
import { aiAnalysisDatabaseService as analysis } from './ai-analysis-database-service.js';

// Storage is isolated; routing, LLMService, client construction, SDK serialization
// and loopback HTTP are real. No developer credentials or external model calls.
describe('MAX-425 serialized model egress', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(store.getSceneBindings).mockResolvedValue([]);
    vi.mocked(store.getProviderApiKey).mockResolvedValue('synthetic-test-key');
    vi.mocked(analysis.createAnalysis).mockResolvedValue({ success: true, analysisId: 9 });
  });

  it.each(['openai-completions', 'anthropic-messages', 'ollama', 'rejected-request'])(
    'sends only diagnostic projections over %s', async (protocol) => {
      const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ path: req.url!, body: JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        if (protocol === 'rejected-request') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'synthetic rejection', type: 'invalid_request_error' } }));
        } else if (protocol === 'anthropic-messages') {
          res.end(JSON.stringify({ id: 'test', type: 'message', role: 'assistant', model: 'test-model',
            content: [{ type: 'text', text: 'diagnosis' }], stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 2 } }));
        } else if (protocol === 'ollama') {
          res.end(JSON.stringify({ model: 'test-model', message: { role: 'assistant', content: 'diagnosis' },
            done: true, prompt_eval_count: 10, eval_count: 2 }));
        } else {
          res.end(JSON.stringify({ id: 'test', model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'diagnosis' }, finish_reason: 'stop', index: 0 }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test listener');
        const provider: LLMProvider = {
          id: 425, name: 'loopback-test', display_name: 'loopback-test', deployment_type: 'local',
          api_base_url: `http://127.0.0.1:${address.port}`, api_key_encrypted: null,
          api_format: protocol === 'rejected-request' ? 'openai-completions' : protocol,
          default_model: 'test-model', models_supported: null, context_window: 8192,
          supports_function_call: false, supports_vision: false, input_cost_per_1k: 0,
          output_cost_per_1k: 0, enabled: true, is_default: true, temperature: 0, max_tokens: 100,
          timeout_ms: 5000, rate_limit_per_minute: 60, daily_quota: null,
          daily_quota_alert_threshold: 80, created_at: new Date(), updated_at: new Date(),
        };
        vi.mocked(store.getAllProviders).mockResolvedValue([provider]);
        const log: DatabaseLog = {
          id: 1, instance_id: 2, log_level: 'error', source: 'mysql_error',
          message: "MY-010584 connection refused password=wirePassword425\nx-api-key: wireToken425\nSELECT q'[can' authentication denied ]' FROM dual\nBearer rollback",
          raw_content: "ORA-00060 deadlock\nmysql://wireUser425:wirePassword425@wireHost425/db\nSELECT * FROM users WHERE phone=998877665544 AND name='wireSql425'\nSELECT Q'!can' authentication denied !' FROM dual\nbEaReR\trollback",
          detected_patterns: [{ pattern: 'DEADLOCK', severity: 'error', message: 'wirePattern425' }],
          collected_at: new Date(), created_at: new Date(),
        };
        // Exercise paired/same-character and unterminated Oracle quotes, plus
        // bearer whitespace variants in both fields of real request messages.
        const privateContexts = [
          "SELECT q'(can' authentication denied )' FROM dual",
          "SELECT q'{can' authentication denied }' FROM dual",
          "SELECT nq'<can' authentication denied >' FROM dual",
          "SELECT q'#can' authentication denied #' FROM dual",
          "SELECT q'[can' authentication denied", "SELECT q'!can' authentication denied",
          'bearer \t rollback', 'Bearer\nrollback', 'Bearer\u00a0rollback',
        ];
        await databaseLogService.triggerLogAnalysis([log, ...privateContexts.map((sample) => ({
          ...log, message: sample, raw_content: sample, detected_patterns: null,
        }))], 2);
        expect(requests).toHaveLength(1);
        const wire = JSON.stringify(requests);
        // Independent canary scan does not import the projector's vocabulary.
        expect(wire).not.toMatch(/wire(?:Password|Token|User|Host|Sql|Pattern)425|998877665544/);
        // #323 independent review: these valid diagnostic words occur only in
        // private Oracle/Bearer contexts. Scan the actual SDK request bytes.
        expect(wire).not.toMatch(/authentication|denied|rollback/i);
        for (const diagnostic of ['MY-010584', 'ORA-00060', 'deadlock', 'connection refused', 'SELECT', 'WHERE']) {
          expect(wire).toContain(diagnostic);
        }
        expect(requests[0].path).toBe(protocol === 'ollama' ? '/api/chat'
          : protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions');
        expect(store.recordUsage).toHaveBeenCalledOnce();
        expect(analysis.completeAnalysis).toHaveBeenCalledTimes(protocol === 'rejected-request' ? 0 : 1);
        expect(analysis.failAnalysis).toHaveBeenCalledTimes(protocol === 'rejected-request' ? 1 : 0);
      } finally {
        // Calls are awaited before shutting down the task-owned listener.
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
});
