import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { llmDatabaseService } from '../llm-database-service.js';
import { LLM_SCENES, LLMConfigurationError, selectSceneModel, type LLMScene } from './scene-routing.js';

export async function registerLLMSceneRoutes(
  app: FastifyInstance, verifyToken: preHandlerHookHandler, manage: preHandlerHookHandler,
  store = llmDatabaseService,
) {
  app.get('/api/llm/scenes', { preHandler: [verifyToken] }, async (_request, reply) => {
    try {
      const [providers, bindings] = await Promise.all([store.getAllProviders(), store.getSceneBindings()]);
      return ['default', ...LLM_SCENES].map(scene => {
        const binding = bindings.find(b => b.scene === scene) || null;
        try {
          const resolved = selectSceneModel(providers, bindings, scene,
            { requiresFunctionCall: scene === 'chat' || scene === 'sql_analysis' || scene === 'fault_diagnosis' });
          return { scene, binding, effective: { provider_id: resolved.provider.id,
            provider_name: resolved.provider.display_name || resolved.provider.name,
            model: resolved.model, source: resolved.source }, error: null };
        } catch (error) {
          if (!(error instanceof LLMConfigurationError)) throw error;
          return { scene, binding, effective: null, error: error.message };
        }
      });
    } catch {
      return reply.code(503).send({ error: 'LLM_CONFIGURATION_UNAVAILABLE' });
    }
  });

  app.put('/api/llm/scenes/:scene', { preHandler: [verifyToken, manage] }, async (request, reply) => {
    const { scene } = request.params as { scene: LLMScene };
    const body = request.body as { provider_id?: number | null; model?: string } | null;
    if (!LLM_SCENES.includes(scene) || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['provider_id', 'model'].includes(key))) {
      return reply.code(400).send({ error: '无效的场景配置' });
    }
    const clear = body.provider_id === null && body.model === undefined;
    if (!clear && (!Number.isSafeInteger(body.provider_id) || Number(body.provider_id) <= 0
      || typeof body.model !== 'string' || !body.model.trim() || body.model.trim().length > 255)) {
      return reply.code(400).send({ error: '请选择提供商和模型，或跟随全局默认' });
    }
    try {
      const binding = clear ? null : { scene, provider_id: body.provider_id as number, model: body.model!.trim() };
      if (binding) selectSceneModel(await store.getAllProviders(), [binding], scene,
        { requiresFunctionCall: scene !== 'health_check' });
      await store.saveSceneBinding(scene, binding);
      return { success: true };
    } catch (error) {
      return reply.code(error instanceof LLMConfigurationError ? 400 : 503).send({
        error: error instanceof LLMConfigurationError ? error.message : 'LLM_CONFIGURATION_UNAVAILABLE',
      });
    }
  });
}
