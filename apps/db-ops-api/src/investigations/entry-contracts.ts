import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { InvestigationStoreError } from './store.js';
const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const resource = Type.Object({ type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]),
  id: Type.Integer({ minimum: 1, maximum: 4_294_967_295 }), role: Type.Union([Type.Literal('primary'), Type.Literal('related')]) }, strict);
export const InvestigationEntryContextSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  resourceRefs: Type.Array(resource, { minItems: 1, maxItems: 20 }),
  from: text(32), to: text(32),
  metric: Type.Optional(Type.Object({ id: Type.String({ pattern: '^[a-z][a-z0-9_.]{0,127}$' }), semantic_version: text(64) }, strict)),
  dimensions: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 512 }), { maxProperties: 20 })),
  sourceEventIds: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { maxItems: 20, uniqueItems: true }),
  returnTo: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/' }),
}, { $id: 'InvestigationEntryContext', ...strict });
export type InvestigationEntryContext = Static<typeof InvestigationEntryContextSchema>;
/** Context is untrusted input, never a grant. Reject rather than infer/widen. */
export function parseEntryContext(value: unknown, now = Date.now()): InvestigationEntryContext {
  const invalid = () => { throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID'); };
  if (!Value.Check(InvestigationEntryContextSchema, value)) return invalid();
  const c = value;
  const instant = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (!instant(c.from) || !instant(c.to) || Date.parse(c.from) >= Date.parse(c.to)
    || Date.parse(c.to) > now || Date.parse(c.to) - Date.parse(c.from) > 31 * 86400000
    || new Set(c.resourceRefs.map(r => `${r.type}:${r.id}`)).size !== c.resourceRefs.length
    || c.resourceRefs.filter(r => r.role === 'primary').length !== 1
    || c.dimensions !== undefined && !c.metric || c.metric && c.resourceRefs.length !== 1) return invalid();
  // Strict same-origin application destination, including encoded redirect tricks.
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*(?:instances(?:-db)?|instance-detail|servers|server-detail|network-devices|network-device-detail|alerts|events|investigations)(?:[/?#]|$)/.test(c.returnTo)
    || /[\\\u0000-\u0020]/.test(c.returnTo) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f])/i.test(c.returnTo)) return invalid();
  return structuredClone(c);
}

export const InvestigationDraftResponseSchema = Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }), context: InvestigationEntryContextSchema, modelInvoked: Type.Literal(false) }, { $id: 'InvestigationDraftResponse', ...strict });
export const InvestigationEntryFactsSchema = Type.Object({ context: InvestigationEntryContextSchema, facts: Type.Array(Type.Unknown(), { maxItems: 20 }), modelInvoked: Type.Literal(false) }, { $id: 'InvestigationEntryFacts', ...strict });
