/** Shared admission answer shape; no IO or transport dependencies. */
import { Type, type Static } from '@sinclair/typebox';
const strict = { additionalProperties: false } as const;
export const InvestigationSupplementAnswerSchema = Type.Union([
  Type.Object({ gapIndex: Type.Integer({ minimum: 0, maximum: 49 }), kind: Type.Literal('unknown') }, strict),
  Type.Object({ gapIndex: Type.Integer({ minimum: 0, maximum: 49 }), kind: Type.Literal('choice'),
    value: Type.Union([Type.Literal('observed'), Type.Literal('not_observed')]), source: Type.Literal('user_observation') }, strict),
  Type.Object({ gapIndex: Type.Integer({ minimum: 0, maximum: 49 }), kind: Type.Literal('number'),
    value: Type.Number(), source: Type.Union([Type.Literal('user_measurement'), Type.Literal('monitoring_display')]) }, strict),
]);
export type InvestigationSupplementAnswer = Static<typeof InvestigationSupplementAnswerSchema>;
