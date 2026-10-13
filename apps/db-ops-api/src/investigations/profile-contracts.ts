import { Type, type Static } from '@sinclair/typebox';
import { InvestigationProfileSchema } from './contracts.js';

export const InvestigationProfilesResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  source: Type.Literal('repository'),
  allowlistSemantics: Type.Literal('authority_ceiling'),
  items: Type.Array(Type.Object({
    profile: InvestigationProfileSchema,
    profileHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    configurationStatus: Type.Literal('preset'),
    toolAvailability: Type.Literal('not_evaluated'),
    outputSchemaId: Type.Literal('InvestigationResult'),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 2 }),
}, { $id: 'InvestigationProfilesResponse', additionalProperties: false });

export type InvestigationProfilesResponse = Static<typeof InvestigationProfilesResponseSchema>;
export const InvestigationProfileSchemas = { InvestigationProfilesResponse: InvestigationProfilesResponseSchema };
