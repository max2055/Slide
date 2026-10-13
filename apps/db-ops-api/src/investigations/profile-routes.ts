import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { requirePermission } from '../auth/require-permission.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from './profiles.js';
import { InvestigationProfilesResponseSchema, type InvestigationProfilesResponse } from './profile-contracts.js';
import { Type } from '@sinclair/typebox';

/** Preset configuration facts only. Authentication loads live grants on every
 * read; this endpoint neither admits work nor grants tool/resource authority. */
export async function registerInvestigationProfileRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler): Promise<void> {
  app.get('/api/investigation-profiles', {
    onRequest: async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); },
    preHandler: [verifyToken, requirePermission('ai:view')],
    schema: { response: { 200: InvestigationProfilesResponseSchema,
      400: Type.Object({ error: Type.String() }, { additionalProperties: false }) } },
  }, async (request, reply): Promise<InvestigationProfilesResponse | FastifyReply> => {
    if (Object.keys(request.query as Record<string, unknown>).length) {
      return reply.code(400).send({ error: 'INVESTIGATION_INPUT_INVALID' });
    }
    return {
      schemaVersion: 1, source: 'repository', allowlistSemantics: 'authority_ceiling',
      items: Object.values(INVESTIGATION_PROFILES).map(profile => {
        const identity = profile.id === 'ops'
          ? { id: profile.id, supportedSubjectKinds: profile.supportedSubjectKinds }
          : { id: profile.id, supportedSubjectKinds: profile.supportedSubjectKinds };
        return {
        // Explicit projection keeps future internal Profile fields off the wire.
        profile: { ...identity, version: profile.version, responsibility: profile.responsibility,
          modelScene: profile.modelScene,
          prompt: { version: profile.prompt.version, hash: profile.prompt.hash },
          skills: profile.skills.map(skill => ({ id: skill.id, version: skill.version, hash: skill.hash })),
          toolAllowlist: [...profile.toolAllowlist], outputSchemaVersion: profile.outputSchemaVersion,
          resourceBoundary: profile.resourceBoundary, readonly: profile.readonly, outputLanguage: profile.outputLanguage,
          budget: { deadlineMs: profile.budget.deadlineMs, maxToolCalls: profile.budget.maxToolCalls,
            maxProviderAttempts: profile.budget.maxProviderAttempts, maxTokens: profile.budget.maxTokens,
            maxRows: profile.budget.maxRows, maxBytes: profile.budget.maxBytes, maxWindowMs: profile.budget.maxWindowMs } },
        profileHash: investigationProfileHash(profile), configurationStatus: 'preset',
        toolAvailability: 'not_evaluated', outputSchemaId: 'InvestigationResult',
        };
      }),
    };
  });
}
