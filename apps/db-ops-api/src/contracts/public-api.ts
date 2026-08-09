import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' }),
}, { $id: 'HealthResponse', additionalProperties: false });

export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
}, { $id: 'ErrorResponse', additionalProperties: false });

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

export const InstanceHostRoleSchema = Type.Union([
  Type.Literal('standalone'),
  Type.Literal('primary'),
  Type.Literal('replica'),
  Type.Literal('shard'),
  Type.Literal('arbiter'),
  Type.Literal('unknown'),
], { $id: 'InstanceHostRole' });

export const InstanceHostMappingSchema = Type.Object({
  serverId: Type.Integer({ minimum: 1 }),
  role: InstanceHostRoleSchema,
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
}, { $id: 'InstanceHostMapping', additionalProperties: false });

export const InstanceHostSchema = Type.Object({
  serverId: Type.Integer({ minimum: 1 }),
  role: InstanceHostRoleSchema,
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  host: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  label: Type.Union([Type.String(), Type.Null()]),
  osType: Type.String(),
  status: Type.String(),
  collectionEnabled: Type.Boolean(),
  validFrom: Type.String(),
}, { $id: 'InstanceHost', additionalProperties: false });

export const HostedInstanceSchema = Type.Object({
  serverId: Type.Integer({ minimum: 1 }),
  role: InstanceHostRoleSchema,
  notes: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  instanceId: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  dbType: DatabaseTypeSchema,
  environment: Type.String(),
  status: Type.String(),
  healthStatus: Type.String(),
  validFrom: Type.String(),
}, { $id: 'HostedInstance', additionalProperties: false });

export const ReplaceInstanceHostsBodySchema = Type.Object({
  hosts: Type.Array(InstanceHostMappingSchema, { maxItems: 32 }),
}, { $id: 'ReplaceInstanceHostsBody', additionalProperties: false });

export const InstanceHostsResponseSchema = Type.Object({
  hosts: Type.Array(InstanceHostSchema),
}, { $id: 'InstanceHostsResponse', additionalProperties: false });

export const ReplaceInstanceHostsResponseSchema = Type.Object({
  ok: Type.Literal(true),
  hosts: Type.Array(InstanceHostSchema),
}, { $id: 'ReplaceInstanceHostsResponse', additionalProperties: false });

export const HostedInstancesResponseSchema = Type.Object({
  instances: Type.Array(HostedInstanceSchema),
}, { $id: 'HostedInstancesResponse', additionalProperties: false });

export const OkResponseSchema = Type.Object({
  ok: Type.Literal(true),
}, { $id: 'OkResponse', additionalProperties: false });

export const PublicApiSchemas = {
  HealthResponse: HealthResponseSchema,
  ErrorResponse: ErrorResponseSchema,
  DatabaseType: DatabaseTypeSchema,
  CapabilityState: CapabilityStateSchema,
  AdapterCapability: AdapterCapabilitySchema,
  AdapterCapabilitiesResponse: AdapterCapabilitiesResponseSchema,
  DatabaseInstance: DatabaseInstanceSchema,
  DatabaseInstancesResponse: DatabaseInstancesResponseSchema,
  InstanceHostRole: InstanceHostRoleSchema,
  InstanceHostMapping: InstanceHostMappingSchema,
  InstanceHost: InstanceHostSchema,
  HostedInstance: HostedInstanceSchema,
  ReplaceInstanceHostsBody: ReplaceInstanceHostsBodySchema,
  InstanceHostsResponse: InstanceHostsResponseSchema,
  ReplaceInstanceHostsResponse: ReplaceInstanceHostsResponseSchema,
  HostedInstancesResponse: HostedInstancesResponseSchema,
  OkResponse: OkResponseSchema,
} as const satisfies Record<string, TSchema>;

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type AdapterCapabilitiesResponse = Static<typeof AdapterCapabilitiesResponseSchema>;
export type DatabaseInstance = Static<typeof DatabaseInstanceSchema>;
export type InstanceHostRole = Static<typeof InstanceHostRoleSchema>;
export type InstanceHostMapping = Static<typeof InstanceHostMappingSchema>;
export type InstanceHost = Static<typeof InstanceHostSchema>;
export type HostedInstance = Static<typeof HostedInstanceSchema>;
export type ReplaceInstanceHostsBody = Static<typeof ReplaceInstanceHostsBodySchema>;
export type InstanceHostsResponse = Static<typeof InstanceHostsResponseSchema>;
export type ReplaceInstanceHostsResponse = Static<typeof ReplaceInstanceHostsResponseSchema>;
export type HostedInstancesResponse = Static<typeof HostedInstancesResponseSchema>;
