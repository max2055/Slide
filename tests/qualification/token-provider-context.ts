import fs from 'node:fs';
import { createRequire } from 'node:module';
import { conservativePromptEstimate, estimateWithProvider, resolveContextConfig } from '../../packages/agent-core/src/index.js';
import { createConfiguredAgentProvider } from '../../apps/db-ops-api/src/adapter/llm-provider-factory.js';
import { selectSceneModel } from '../../apps/db-ops-api/src/llm/scene-routing.js';
import type { LLMProvider } from '../../apps/db-ops-api/src/llm-database-service.js';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

// Explicit local DB config only, read-only metadata. Never decrypt keys or call an LLM.
const envFile = process.argv[2];
if (!envFile) throw new Error('Pass an explicitly authorized local environment file');
const env = dotenv.parse(fs.readFileSync(envFile));
const connection = await mysql.createConnection({ host: env.DB_HOST ?? 'localhost', port: Number(env.DB_PORT ?? 3306),
  user: env.DB_USER ?? 'root', password: env.DB_PASSWORD, database: env.DB_NAME ?? 'db_ops_ai' });
try {
  const [rows] = await connection.query(`SELECT id, name, display_name, enabled, is_default, deployment_type,
    api_format, api_base_url, default_model, models_supported, context_window, supports_function_call, supports_vision, max_tokens FROM llm_providers`);
  const [bindings] = await connection.query('SELECT scene, provider_id, model FROM llm_scene_bindings');
  const providers = rows.map(row => ({ ...row, models_supported: typeof row.models_supported === 'string' ? JSON.parse(row.models_supported) : row.models_supported })) as LLMProvider[];
  const store = { getAllProviders: async () => providers, getSceneBindings: async () => bindings as any,
    getProviderApiKey: async () => 'qualification-no-dispatch' };
  const selected = selectSceneModel(providers, bindings as any, 'chat', { requiresFunctionCall: true });
  const provider = await createConfiguredAgentProvider(store);
  const config = resolveContextConfig({ model: provider.getDefaultModel() }, provider);
  const prompt = [{ role: 'user' as const, content: 'Read-only database connectivity check: SELECT 1; 中文说明。' }];
  const estimate = estimateWithProvider(prompt, [], provider.getDefaultModel(), provider);
  const inputBudget = config.contextWindowTokens - config.maxTokens - 1024;
  const report = { schemaVersion: 1, status: 'configuration-and-admission-only;live-provider-unverified',
    source: selected.source, model: selected.model, configuredWindow: selected.provider.context_window,
    configuredOutput: selected.provider.max_tokens, capabilities: provider.getModelCapabilities?.(), resolved: config,
    inputBudget, estimate, sampleFits: estimate.tokens <= inputBudget,
    giantSchemaRejected: conservativePromptEstimate(prompt, [{ description: 'x'.repeat(config.contextWindowTokens + 1) }]).tokens > inputBudget,
    providerCredentialsFetched: false, databaseAccess: 'read-only-provider-metadata', providerRequests: 0 };
  if (!report.sampleFits || !report.giantSchemaRejected) throw new Error('CONFIGURED_ADMISSION_FAILED');
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await connection.end(); }
