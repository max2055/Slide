import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { llmDatabaseService } from '../llm-database-service.js';
import type { llmService } from '../llm-service.js';
import { expensiveOperationRateLimitConfig } from '../security/http-security.js';
import { CredentialDestinationError, resolveTestCredential } from './credential-destination-policy.js';

export async function registerConnectionTestRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  manage: preHandlerHookHandler, store: Pick<typeof llmDatabaseService, 'getProviderByName' | 'getProviderApiKey'>,
  service: Pick<typeof llmService, 'testConnectionWithConfig'>) {
  app.post('/api/llm/test', { bodyLimit: 16_384, config: { rateLimit: expensiveOperationRateLimitConfig }, preHandler: [verifyToken, manage] }, async (request, reply) => {
    const body = request.body as Record<string, string>;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['providerName', 'apiKey', 'baseURL', 'model', 'apiFormat', 'deploymentType'].includes(key))
      || typeof body.providerName !== 'string' || !body.providerName.trim()
      || Object.entries(body).some(([key, value]) => typeof value !== 'string' || value.length > (key === 'apiKey' ? 4096 : key === 'baseURL' ? 2048 : 255))) {
      return reply.code(400).send({ error: 'LLM_TEST_INVALID_INPUT' });
    }
    try {
      const provider = await store.getProviderByName(body.providerName);
      if (!provider) return reply.code(404).send({ error: '提供商不存在' });
      const credential = await resolveTestCredential(provider, body, name => store.getProviderApiKey(name, provider));
      // Use the same validated snapshot for the actual call; no second config read.
      const result = await service.testConnectionWithConfig(provider.name, credential.apiKey, credential.baseURL, body.model?.trim(),
        { apiFormat: credential.apiFormat, deploymentType: credential.deploymentType, providerConfig: provider });
      return { ...result, error: result.success ? undefined : 'LLM_TEST_CONNECTION_FAILED：连接测试失败，请检查配置与供应商服务',
        message: result.success ? `连接成功，模型: ${result.model || body.model || provider.default_model || 'unknown'}` : undefined };
    } catch (error) {
      return reply.code(error instanceof CredentialDestinationError ? error.status : 503).send({ success: false,
        error: error instanceof CredentialDestinationError ? error.message : 'LLM_TEST_CONFIGURATION_UNAVAILABLE' });
    }
  });
}
