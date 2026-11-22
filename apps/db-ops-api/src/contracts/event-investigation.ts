import { Type, type Static } from '@sinclair/typebox';

export const MAX_EVENT_INVESTIGATION_IDS = 20;

const textOrNull = Type.Union([Type.String(), Type.Null()]);
const projection = Type.Union([Type.Null(), Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String(),
  state: Type.Union([
    Type.Literal('not_started'), Type.Literal('running'), Type.Literal('completed'),
    Type.Literal('insufficient'), Type.Literal('failed'),
  ]),
  conclusion: textOrNull,
  recommendation: textOrNull,
  updatedAt: Type.String({ format: 'date-time' }),
  version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: 'Saved result version for the latest request, when readable.' }),
}, { additionalProperties: false })]);

export type LinkedEventInvestigation = Static<typeof projection>;

export const EventInvestigationResponse = Type.Object({ investigation: projection },
  { $id: 'EventInvestigationResponse', additionalProperties: false });
export const EventInvestigationsResponse = Type.Object({
  items: Type.Array(Type.Object({
    eventId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    investigation: projection,
  }, { additionalProperties: false }), { maxItems: MAX_EVENT_INVESTIGATION_IDS }),
}, { $id: 'EventInvestigationsResponse', additionalProperties: false });

export type EventInvestigationItem = Static<typeof EventInvestigationsResponse>['items'][number];
