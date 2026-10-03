import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { llmDatabaseService, ModelInfo } from '../llm-database-service.js';
import { modelParameterCatalog, modelProviderId } from './model-parameters.js';
import { CredentialDestinationError, resolveTestCredential } from './credential-destination-policy.js';
import { expensiveOperationRateLimitConfig } from '../security/http-security.js';

interface DiscoveryInput { providerName: string; baseURL: string; apiKey?: string; apiFormat?: string; deploymentType?: string; providerType?: string }
type Fetcher = typeof fetch;
class DiscoveryError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
const positive = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;

export async function discoverModels(input: DiscoveryInput, fetcher: Fetcher = fetch): Promise<{ models: ModelInfo[]; source: 'api' | 'catalog'; warning?: string }> {
  let url: URL;
  try {
    url = new URL(input.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new DiscoveryError('MODEL_DISCOVERY_INVALID_URL：请填写不含凭证或查询参数的 HTTP(S) Base URL', 400); }
  if (!input.apiKey && input.deploymentType !== 'local') throw new DiscoveryError('LLM_CREDENTIAL_NOT_CONFIGURED：请填写 API Key', 400);
  const providerId = modelProviderId(input.providerName, input.baseURL, input.providerType);
  const catalog = modelParameterCatalog(providerId);
  url.pathname = (url.pathname.replace(/\/+$/, '') || '/v1') + '/models';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.apiKey) {
    if (input.apiFormat === 'anthropic-messages') { headers['x-api-key'] = input.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (providerId === 'mimo') headers['api-key'] = input.apiKey;
    else headers.Authorization = `Bearer ${input.apiKey}`;
  }
  let response: Response;
  try { response = await fetcher(url.href, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
  catch { throw new DiscoveryError('MODEL_DISCOVERY_CONNECTION_FAILED：模型列表请求失败或超时，请检查 Base URL 和网络'); }
  if ([404, 405].includes(response.status) && catalog.length) return { models: catalog, source: 'catalog', warning: '供应商未提供模型列表接口，已加载内置参数目录；模型是否可用请使用测试连接确认。' };
  // Never return upstream bodies: they may contain credentials, HTML or proxies' diagnostics.
  if (!response.ok) throw new DiscoveryError(`MODEL_DISCOVERY_HTTP_${response.status}：加载模型失败，请检查认证、权限或供应商服务`);
  let payload: any;
  try { payload = await response.json(); } catch { throw new DiscoveryError('MODEL_DISCOVERY_INVALID_RESPONSE：供应商未返回有效 JSON 模型列表'); }
  const rows = Array.isArray(payload?.data) ? payload.data : payload?.models;
  if (!Array.isArray(rows)) throw new DiscoveryError('MODEL_DISCOVERY_INVALID_RESPONSE：供应商未返回模型数组');
  const models = new Map<string, ModelInfo>();
  for (const row of rows.slice(0, 2000)) {
    const id = typeof row === 'string' ? row : row?.id ?? row?.slug;
    if (typeof id !== 'string' || !id.trim() || id.length > 255) continue;
    const known = catalog.find(m => m.id === id);
    const contextWindow = positive(row.contextWindow ?? row.context_window ?? row.context_length ?? row.limit?.context);
    const maxTokens = positive(row.maxTokens ?? row.max_tokens ?? row.max_output_tokens ?? row.limit?.output);
    const tools = row.supportsFunctionCall ?? row.supports_function_call ?? row.tool_call;
    const vision = row.supportsVision ?? row.supports_vision;
    models.set(id, { ...known, id, name: typeof row.name === 'string' ? row.name : known?.name ?? id,
      ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
      ...(typeof tools === 'boolean' ? { supportsFunctionCall: tools } : {}),
      ...(typeof vision === 'boolean' ? { supportsVision: vision } : {}),
      parameterProvider: providerId,
      parameterSource: contextWindow || maxTokens || typeof tools === 'boolean' ? 'api' : known ? 'catalog' : 'unknown',
    });
  }
  return { models: [...models.values()], source: 'api', ...(!models.size ? { warning: '供应商返回空模型列表，请检查账户权限或手动填写模型。' } : {}) };
}

export async function registerModelDiscoveryRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler, manage: preHandlerHookHandler,
  store: Pick<typeof llmDatabaseService, 'getProviderApiKey' | 'getProviderByName'>, fetcher: Fetcher = fetch) {
  app.post('/api/llm/models', { bodyLimit: 16_384, config: { rateLimit: expensiveOperationRateLimitConfig }, preHandler: [verifyToken, manage] }, async (request, reply) => {
    const body = request.body as DiscoveryInput;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['providerName', 'baseURL', 'apiKey', 'apiFormat', 'deploymentType', 'providerType'].includes(key))
      || typeof body.providerName !== 'string' || !body.providerName.trim()
      || typeof body.baseURL !== 'string' || !body.baseURL.trim()
      || ['apiKey', 'apiFormat', 'deploymentType', 'providerType'].some(key => (body as any)[key] !== undefined && typeof (body as any)[key] !== 'string')
      || Object.entries(body).some(([key, value]) => typeof value === 'string' && value.length > (key === 'apiKey' ? 4096 : key === 'baseURL' ? 2048 : 255))
      || (body.providerType && !['deepseek', 'stepfun', 'mimo'].includes(body.providerType))) return reply.code(400).send({ error: 'MODEL_DISCOVERY_INVALID_INPUT' });
    try {
      const saved = await store.getProviderByName(body.providerName);
      const credential = await resolveTestCredential(saved, body, name => store.getProviderApiKey(name, saved || undefined));
      return await discoverModels({ ...body, ...credential }, fetcher);
    } catch (error) {
      return reply.code(error instanceof DiscoveryError || error instanceof CredentialDestinationError ? error.status : 503).send({ error: error instanceof DiscoveryError || error instanceof CredentialDestinationError ? error.message : 'MODEL_DISCOVERY_CONFIGURATION_UNAVAILABLE' });
    }
  });
}
