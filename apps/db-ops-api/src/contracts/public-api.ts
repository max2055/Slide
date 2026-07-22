import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' }),
}, { $id: 'HealthResponse', additionalProperties: false });

export const DatabaseTypeSchema = Type.Union([
  Type.Literal('mysql'),
  Type.Literal('postgresql'),
  Type.Literal('oracle'),
  Type.Literal('dameng'),
  Type.Literal('mongodb'),
  Type.Literal('redis'),
  Type.Literal('elasticsearch'),
]);

export const CapabilityStateSchema = Type.Union([
  Type.Literal('declared'),
  Type.Literal('configured'),
  Type.Literal('verified'),
  Type.Literal('degraded'),
  Type.Literal('unsupported'),
]);

const AdapterCapabilitiesSchema = Type.Partial(Type.Object({
  connect: CapabilityStateSchema,
  query: CapabilityStateSchema,
  explain: CapabilityStateSchema,
  metrics: CapabilityStateSchema,
  health: CapabilityStateSchema,
  alerts: CapabilityStateSchema,
  reports: CapabilityStateSchema,
  writeApproval: CapabilityStateSchema,
}));

export const AdapterCapabilitySchema = Type.Object({
  dbType: DatabaseTypeSchema,
  driver: Type.Union([Type.String(), Type.Null()]),
  state: CapabilityStateSchema,
  creatable: Type.Boolean(),
  capabilities: AdapterCapabilitiesSchema,
  reason: Type.Optional(Type.String()),
}, { $id: 'AdapterCapability', additionalProperties: false });

export const AdapterCapabilitiesResponseSchema = Type.Object({
  adapters: Type.Array(AdapterCapabilitySchema),
}, { $id: 'AdapterCapabilitiesResponse', additionalProperties: false });

export const DatabaseInstanceSchema = Type.Object({
  id: Type.Number(),
  name: Type.String(),
  db_type: DatabaseTypeSchema,
  db_version: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  data_size_gb: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  host: Type.String(),
  port: Type.Number(),
  database_name: Type.String(),
  username: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  health_status: Type.Union([
    Type.Literal('healthy'), Type.Literal('warning'), Type.Literal('critical'), Type.Literal('unknown'),
  ]),
  health_score: Type.Number(),
  status: Type.String(),
  created_at: Type.String(),
  environment: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  hasCredential: Type.Boolean(),
  credentialVersion: Type.Number(),
}, { $id: 'DatabaseInstance', additionalProperties: true });

export const DatabaseInstancesResponseSchema = Type.Array(DatabaseInstanceSchema, {
  $id: 'DatabaseInstancesResponse',
});

export const PublicApiSchemas = {
  HealthResponse: HealthResponseSchema,
  DatabaseType: DatabaseTypeSchema,
  CapabilityState: CapabilityStateSchema,
  AdapterCapability: AdapterCapabilitySchema,
  AdapterCapabilitiesResponse: AdapterCapabilitiesResponseSchema,
  DatabaseInstance: DatabaseInstanceSchema,
  DatabaseInstancesResponse: DatabaseInstancesResponseSchema,
} as const satisfies Record<string, TSchema>;

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type AdapterCapabilitiesResponse = Static<typeof AdapterCapabilitiesResponseSchema>;
export type DatabaseInstance = Static<typeof DatabaseInstanceSchema>;
