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

export const NetworkDeviceStatusSchema = Type.Union([
  Type.Literal('unknown'), Type.Literal('online'), Type.Literal('offline'), Type.Literal('error'), Type.Literal('unreachable'),
], { $id: 'NetworkDeviceStatus' });

export const NetworkDeviceSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.Union([Type.String(), Type.Null()]),
  host: Type.String({ minLength: 1 }),
  site: Type.Union([Type.String(), Type.Null()]),
  vendor: Type.Union([Type.Literal('huawei'), Type.Literal('cisco')]),
  model: Type.Union([Type.String(), Type.Null()]),
  os_version: Type.Union([Type.String(), Type.Null()]),
  serial_number: Type.Union([Type.String(), Type.Null()]),
  snmp_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  ssh_port: Type.Integer({ minimum: 1, maximum: 65535 }),
  status: NetworkDeviceStatusSchema,
  last_check_at: Type.Union([Type.String(), Type.Null()]),
  collection_enabled: Type.Boolean(),
  created_at: Type.String(),
  updated_at: Type.String(),
  hasSnmpCredential: Type.Boolean(),
  hasSshCredential: Type.Boolean(),
}, { $id: 'NetworkDevice', additionalProperties: false });

export const NetworkDevicesResponseSchema = Type.Array(NetworkDeviceSchema, { $id: 'NetworkDevicesResponse' });

export const NetworkDeviceMetricSchema = Type.Object({
  metricId: Type.String(), value: Type.Union([Type.Number(), Type.Null()]),
  observedAt: Type.Union([Type.String(), Type.Null()]), quality: Type.String(), source: Type.String(),
  dimensions: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
}, { $id: 'NetworkDeviceMetric', additionalProperties: false });
export const NetworkDeviceMetricsResponseSchema = Type.Object({
  deviceId: Type.Integer({ minimum: 1 }), metrics: Type.Array(NetworkDeviceMetricSchema),
}, { $id: 'NetworkDeviceMetricsResponse', additionalProperties: false });

export const NetworkDeviceInterfaceSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }), deviceId: Type.Integer({ minimum: 1 }), ifIndex: Type.Integer({ minimum: 0 }),
  ifName: Type.String(), ifAlias: Type.Union([Type.String(), Type.Null()]), speedBps: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  adminStatus: Type.String(), operStatus: Type.String(), lastSeenAt: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'NetworkDeviceInterface', additionalProperties: false });
export const NetworkDeviceInterfacesResponseSchema = Type.Object({ interfaces: Type.Array(NetworkDeviceInterfaceSchema) }, { $id: 'NetworkDeviceInterfacesResponse', additionalProperties: false });

export const NetworkDeviceSnmpSecurityLevelSchema = Type.Union([
  Type.Literal('noAuthNoPriv'), Type.Literal('authNoPriv'), Type.Literal('authPriv'),
], { $id: 'NetworkDeviceSnmpSecurityLevel' });
export const NetworkDeviceSnmpCredentialSchema = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 64 }),
  securityLevel: NetworkDeviceSnmpSecurityLevelSchema,
  authProtocol: Type.Optional(Type.Union([Type.Literal('MD5'), Type.Literal('SHA')])),
  authSecret: Type.Optional(Type.String({ minLength: 8 })),
  privacyProtocol: Type.Optional(Type.Union([Type.Literal('DES'), Type.Literal('AES')])),
  privacySecret: Type.Optional(Type.String({ minLength: 8 })),
}, { $id: 'NetworkDeviceSnmpCredential', additionalProperties: false });
export const NetworkDeviceSnmpV2CredentialSchema = Type.Object({
  version: Type.Optional(Type.Literal(2)),
  community: Type.String({ minLength: 1, maxLength: 512 }),
}, { $id: 'NetworkDeviceSnmpV2Credential', additionalProperties: false });
export const NetworkDeviceSnmpCredentialUnionSchema = Type.Union([NetworkDeviceSnmpCredentialSchema, NetworkDeviceSnmpV2CredentialSchema], { $id: 'NetworkDeviceSnmpCredentialUnion' });
export const NetworkDeviceSshCredentialSchema = Type.Object({
  credentialType: Type.Union([Type.Literal('password'), Type.Literal('key')]),
  username: Type.String({ minLength: 1, maxLength: 255 }),
  credentialValue: Type.String({ minLength: 1, maxLength: 512 }),
  hostKeyFingerprint: Type.String({ pattern: '^SHA256:[A-Za-z0-9+/]{43}$' }),
}, { $id: 'NetworkDeviceSshCredential', additionalProperties: false });
export const NetworkDeviceTestConnectionRequestSchema = Type.Object({
  host: Type.String({ minLength: 1 }),
  version: Type.Optional(Type.Union([Type.Literal(2), Type.Literal(3)])),
  snmpPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  snmp_port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  sshPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  ssh_port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  snmpv3: Type.Optional(NetworkDeviceSnmpCredentialSchema),
  snmpv2c: Type.Optional(NetworkDeviceSnmpV2CredentialSchema),
  snmpv2: Type.Optional(NetworkDeviceSnmpV2CredentialSchema),
  snmp: Type.Optional(NetworkDeviceSnmpCredentialUnionSchema),
  ssh: Type.Optional(NetworkDeviceSshCredentialSchema),
  vendor: Type.Optional(Type.Union([Type.Literal('huawei'), Type.Literal('cisco')])),
}, { $id: 'NetworkDeviceTestConnectionRequest', additionalProperties: false });
export const NetworkDeviceProbeResultSchema = Type.Object({
  reachable: Type.Boolean(),
  quality: Type.String(),
  reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  observedAt: Type.String(),
  sysName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  uptimeSeconds: Type.Optional(Type.Number({ minimum: 0 })),
}, { $id: 'NetworkDeviceProbeResult', additionalProperties: false });
export const NetworkDeviceTestConnectionResponseSchema = Type.Object({
  success: Type.Boolean(),
  probe: Type.Optional(NetworkDeviceProbeResultSchema),
  ssh: Type.Optional(Type.Object({ verified: Type.Boolean() }, { additionalProperties: false })),
  error: Type.Optional(Type.String()),
}, { $id: 'NetworkDeviceTestConnectionResponse', additionalProperties: false });
export const NetworkDeviceProbeResponseSchema = Type.Object({
  success: Type.Boolean(),
  observations: Type.Optional(Type.Integer({ minimum: 0 })),
  interfaces: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
}, { $id: 'NetworkDeviceProbeResponse', additionalProperties: false });
export const NetworkDeviceCapabilitySchema = Type.Object({
  key: Type.String(),
  state: CapabilityStateSchema,
  evidence: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  checkedAt: Type.Union([Type.String(), Type.Null()]),
  validUntil: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'NetworkDeviceCapability', additionalProperties: false });
export const NetworkDeviceCapabilitiesResponseSchema = Type.Object({
  deviceId: Type.Integer({ minimum: 1 }), capabilities: Type.Array(NetworkDeviceCapabilitySchema),
}, { $id: 'NetworkDeviceCapabilitiesResponse', additionalProperties: false });

export const ConfigBackupSummarySchema = Type.Object({
  id: Type.Integer({ minimum: 1 }), deviceId: Type.Integer({ minimum: 1 }), versionNo: Type.Integer({ minimum: 1 }),
  contentSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), sourceProtocol: Type.Literal('ssh'),
  collectedAt: Type.String(), sizeBytes: Type.Integer({ minimum: 0, maximum: 2097152 }),
  redactionStatus: Type.Union([Type.Literal('redacted'), Type.Literal('unredacted'), Type.Literal('failed')]),
}, { $id: 'ConfigBackupSummary', additionalProperties: false });
export const ConfigBackupSummariesResponseSchema = Type.Object({ backups: Type.Array(ConfigBackupSummarySchema) }, { $id: 'ConfigBackupSummariesResponse', additionalProperties: false });
export const ConfigBackupDetailSchema = Type.Composite([
  ConfigBackupSummarySchema,
  Type.Object({ preview: Type.String() }),
], { $id: 'ConfigBackupDetail', additionalProperties: false });
export const ConfigBackupRawSchema = Type.Composite([
  ConfigBackupSummarySchema,
  Type.Object({ content: Type.String() }),
], { $id: 'ConfigBackupRaw', additionalProperties: false });
export const ConfigBackupResponseSchema = Type.Union([
  ConfigBackupDetailSchema, ConfigBackupRawSchema,
], { $id: 'ConfigBackupResponse' });
export const ConfigBackupDiffResponseSchema = Type.Object({
  fromId: Type.Integer({ minimum: 1 }), toId: Type.Integer({ minimum: 1 }), diff: Type.String(),
}, { $id: 'ConfigBackupDiffResponse', additionalProperties: false });

export const NetworkResourceRefSchema = Type.Object({
  type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]),
  id: Type.Integer({ minimum: 1 }),
}, { $id: 'NetworkResourceRef', additionalProperties: false });
export const NetworkDeviceRelationTypeSchema = Type.Union([
  Type.Literal('runs_on'), Type.Literal('hosts'), Type.Literal('replicates_to'),
  Type.Literal('depends_on'), Type.Literal('connected_to'), Type.Literal('serves'),
], { $id: 'NetworkDeviceRelationType' });
export const NetworkDeviceRelationSchema = Type.Object({
  source: NetworkResourceRefSchema,
  target: NetworkResourceRefSchema,
  relationType: NetworkDeviceRelationTypeSchema,
  provenance: Type.String({ minLength: 1, maxLength: 64 }),
  metadata: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  validFrom: Type.String(),
  validUntil: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'NetworkDeviceRelation', additionalProperties: false });
export const NetworkDeviceRelationInputSchema = Type.Object({
  target: Type.Object({
    type: Type.Union([Type.Literal('server'), Type.Literal('network_device')]),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  relationType: Type.Union([Type.Literal('connected_to'), Type.Literal('serves')]),
  provenance: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  metadata: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
  validFrom: Type.Optional(Type.String()),
  validUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { $id: 'NetworkDeviceRelationInput', additionalProperties: false });
export const NetworkDeviceRelationsRequestSchema = Type.Object({
  relations: Type.Array(NetworkDeviceRelationInputSchema, { maxItems: 32 }),
}, { $id: 'NetworkDeviceRelationsRequest', additionalProperties: false });
export const NetworkDeviceRelationsResponseSchema = Type.Object({
  relations: Type.Array(NetworkDeviceRelationSchema),
}, { $id: 'NetworkDeviceRelationsResponse', additionalProperties: false });

const ResourceTypeSchema = Type.Union([
  Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device'),
], { $id: 'ResourceType' });
const ResourceRefSchema = Type.Object({ type: ResourceTypeSchema, id: Type.Integer({ minimum: 1 }) }, { $id: 'ResourceRef' });
export const ResourceListResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    resource: ResourceRefSchema, label: Type.String(), status: Type.String(),
    attributes: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
  }, { additionalProperties: false }), { maxItems: 500 }),
  collectedAt: Type.String(),
  dataQuality: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('empty')]),
}, { $id: 'ResourceListResponse', additionalProperties: false });
export const ResourceOverviewItemSchema = Type.Object({
  resource: ResourceRefSchema,
  label: Type.String(),
  status: Type.String(),
  quality: Type.Union([Type.Literal('good'), Type.Literal('degraded'), Type.Literal('invalid'), Type.Literal('unknown'), Type.Literal('partial')]),
  freshness: Type.Union([Type.Literal('fresh'), Type.Literal('stale'), Type.Literal('missing')]),
  observedAt: Type.Union([Type.String(), Type.Null()]),
  unresolvedAlerts: Type.Integer({ minimum: 0 }),
  relationCount: Type.Integer({ minimum: 0 }),
  impactScope: Type.Array(ResourceRefSchema, { maxItems: 64 }),
  gaps: Type.Array(Type.String(), { maxItems: 32 }),
}, { $id: 'ResourceOverviewItem', additionalProperties: false });
export const ResourceOverviewResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), collectedAt: Type.String(),
  dataQuality: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('empty')]),
  summary: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    byType: Type.Object({ instance: Type.Integer({ minimum: 0 }), server: Type.Integer({ minimum: 0 }), network_device: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
    byStatus: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    fresh: Type.Integer({ minimum: 0 }), stale: Type.Integer({ minimum: 0 }), missing: Type.Integer({ minimum: 0 }),
    unresolvedAlerts: Type.Integer({ minimum: 0 }), impactedResources: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  items: Type.Array(ResourceOverviewItemSchema, { maxItems: 500 }),
}, { $id: 'ResourceOverviewResponse', additionalProperties: false });
export const ResourceMetricAggregateSchema = Type.Object({
  value: Type.Union([Type.Number(), Type.Null()]),
  resourceCount: Type.Integer({ minimum: 0 }),
  observedAt: Type.Union([Type.String(), Type.Null()]),
}, { $id: 'ResourceMetricAggregate', additionalProperties: false });
export const ResourceMetricsSummaryResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), collectedAt: Type.String(),
  dataQuality: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('empty')]),
  scopes: Type.Object({
    instance: Type.Object({ metrics: Type.Record(Type.String(), ResourceMetricAggregateSchema) }, { additionalProperties: false }),
    server: Type.Object({ metrics: Type.Record(Type.String(), ResourceMetricAggregateSchema) }, { additionalProperties: false }),
    network_device: Type.Object({ metrics: Type.Record(Type.String(), ResourceMetricAggregateSchema) }, { additionalProperties: false }),
  }, { additionalProperties: false }),
}, { $id: 'ResourceMetricsSummaryResponse', additionalProperties: false });
export const ResourceAgentDiagnosisResponseSchema = Type.Object({
  success: Type.Boolean(), analysisId: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Optional(Type.Union([Type.Literal('queued'), Type.Literal('cached')])),
  error: Type.Optional(Type.String()),
}, { $id: 'ResourceAgentDiagnosisResponse', additionalProperties: false });

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
    Type.Literal('healthy'), Type.Literal('warning'), Type.Literal('critical'), Type.Literal('unknown'), Type.Literal('error'),
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

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

// Fixed-profile server diagnostics. These schemas deliberately model only
// backend-produced fields; callers cannot extend a diagnostic section with
// command/path data or arbitrary credential-bearing properties.
const ServerDiagnosticSectionProperties = {
  source: Type.Array(Type.String(), { maxItems: 8 }),
  collectedAt: Type.String(),
  expiresAt: Type.String(),
  validForMs: Type.Integer({ minimum: 1 }),
  quality: Type.Union([
    Type.Literal('good'), Type.Literal('partial'), Type.Literal('unknown'), Type.Literal('unsupported'),
  ]),
  reason: Type.Optional(Type.String()),
  truncated: Type.Boolean(),
};

const ServerServiceStatusSchema = Type.Object({
  name: Type.String(), loadState: Type.String(), activeState: Type.String(), subState: Type.String(),
  description: NullableStringSchema,
}, { additionalProperties: false });

const ServerListeningPortSchema = Type.Object({
  protocol: Type.Union([Type.Literal('tcp'), Type.Literal('udp'), Type.Literal('unknown')]),
  address: Type.String(), port: Type.Integer({ minimum: 1, maximum: 65535 }), process: NullableStringSchema,
}, { additionalProperties: false });

const ServerProcessSampleSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }), command: Type.String(), cpuPercent: Type.Number({ minimum: 0 }),
  memoryPercent: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

const ServerDiagnosticLogEntrySchema = Type.Object({
  timestamp: NullableStringSchema, severity: Type.String(), unit: NullableStringSchema,
  identifier: NullableStringSchema, message: Type.String(),
}, { additionalProperties: false });

const ServerInterfaceErrorSummarySchema = Type.Object({
  interface: Type.String(), rxBytes: Type.Number({ minimum: 0 }), txBytes: Type.Number({ minimum: 0 }),
  rxErrors: Type.Number({ minimum: 0 }), txErrors: Type.Number({ minimum: 0 }),
  rxDrops: Type.Number({ minimum: 0 }), txDrops: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

function ServerDiagnosticSectionSchema<T extends TSchema>(itemSchema: T) {
  return Type.Object({
    ...ServerDiagnosticSectionProperties,
    items: Type.Array(itemSchema),
  }, { additionalProperties: false });
}

export const ServerDiagnosticsSchema = Type.Object({
  schemaVersion: Type.Literal(1), serverId: Type.Integer({ minimum: 1 }), osType: Type.String(),
  collectedAt: Type.String(), expiresAt: Type.String(), validForMs: Type.Integer({ minimum: 1 }),
  quality: Type.Union([
    Type.Literal('good'), Type.Literal('partial'), Type.Literal('unknown'), Type.Literal('unsupported'),
  ]),
  truncated: Type.Boolean(),
  sections: Type.Object({
    services: ServerDiagnosticSectionSchema(ServerServiceStatusSchema),
    listeningPorts: ServerDiagnosticSectionSchema(ServerListeningPortSchema),
    topProcesses: ServerDiagnosticSectionSchema(ServerProcessSampleSchema),
    systemLogs: ServerDiagnosticSectionSchema(ServerDiagnosticLogEntrySchema),
    interfaceErrors: ServerDiagnosticSectionSchema(ServerInterfaceErrorSummarySchema),
  }, { additionalProperties: false }),
  serviceStatus: ServerDiagnosticSectionSchema(ServerServiceStatusSchema),
  listeningPorts: ServerDiagnosticSectionSchema(ServerListeningPortSchema),
  topProcesses: ServerDiagnosticSectionSchema(ServerProcessSampleSchema),
  recentSystemLogs: ServerDiagnosticSectionSchema(ServerDiagnosticLogEntrySchema),
  interfaceErrors: ServerDiagnosticSectionSchema(ServerInterfaceErrorSummarySchema),
  gaps: Type.Array(Type.Object({ section: Type.String(), reason: Type.String() }, { additionalProperties: false })),
}, { $id: 'ServerDiagnostics', additionalProperties: false });

export const CollectServerDiagnosticsResponseSchema = Type.Object({
  success: Type.Literal(true), diagnostics: ServerDiagnosticsSchema,
}, { $id: 'CollectServerDiagnosticsResponse', additionalProperties: false });

const EvidenceQualityValueSchema = Type.Union([
  Type.Literal('good'),
  Type.Literal('partial'),
  Type.Literal('unknown'),
  Type.Literal('unsupported'),
]);
export const EvidenceQualitySchema = Type.Union([
  Type.Literal('good'),
  Type.Literal('partial'),
  Type.Literal('unknown'),
  Type.Literal('unsupported'),
], { $id: 'EvidenceQuality' });

const FilesystemEvidenceProperties = {
  mount: Type.String(),
  device: Type.String(),
  fsType: NullableStringSchema,
  sizeBytes: Type.Number({ minimum: 0 }),
  usedBytes: Type.Number({ minimum: 0 }),
  availableBytes: Type.Number({ minimum: 0 }),
  usagePercent: Type.Number({ minimum: 0 }),
  inodeTotal: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  inodeUsed: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  inodeAvailable: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  inodeUsagePercent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
};
const FilesystemEvidenceValueSchema = Type.Object(FilesystemEvidenceProperties, { additionalProperties: false });
export const FilesystemEvidenceSchema = Type.Object(FilesystemEvidenceProperties, {
  $id: 'FilesystemEvidence', additionalProperties: false,
});

export const JournalEvidenceSchema = Type.Object({
  timestamp: NullableStringSchema,
  severity: Type.String(),
  unit: NullableStringSchema,
  identifier: NullableStringSchema,
  pid: NullableStringSchema,
  message: Type.String(),
}, { $id: 'JournalEvidence', additionalProperties: false });

export const PhysicalFileEvidenceSchema = Type.Object({
  path: Type.String(),
  quality: EvidenceQualityValueSchema,
  reason: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  sizeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  allocatedBytes: Type.Optional(Type.Number({ minimum: 0 })),
  modifiedAt: Type.Optional(Type.String()),
  mode: Type.Optional(Type.String()),
  owner: Type.Optional(Type.String()),
  group: Type.Optional(Type.String()),
  filesystem: Type.Optional(FilesystemEvidenceValueSchema),
}, { $id: 'PhysicalFileEvidence', additionalProperties: false });

export const HostEvidenceGapSchema = Type.Object({
  section: Type.Union([
    Type.Literal('metrics'), Type.Literal('filesystems'),
    Type.Literal('systemLogs'), Type.Literal('physicalFiles'),
  ]),
  reason: Type.String(),
}, { $id: 'HostEvidenceGap', additionalProperties: false });

export const LinuxHostEvidenceSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  serverId: Type.Integer({ minimum: 1 }),
  collectedAt: Type.String(),
  expiresAt: Type.String(),
  quality: EvidenceQualityValueSchema,
  truncated: Type.Boolean(),
  metrics: Type.Object({
    source: Type.Array(Type.String()),
    collectedAt: Type.String(),
    quality: EvidenceQualityValueSchema,
    reason: Type.Optional(Type.String()),
    values: Type.Record(Type.String(), Type.Number()),
  }, { additionalProperties: false }),
  filesystems: Type.Object({
    source: Type.Array(Type.String()),
    collectedAt: Type.String(),
    quality: EvidenceQualityValueSchema,
    reason: Type.Optional(Type.String()),
    items: Type.Array(FilesystemEvidenceValueSchema),
  }, { additionalProperties: false }),
  systemLogs: Type.Object({
    source: Type.Array(Type.String()),
    collectedAt: Type.String(),
    quality: EvidenceQualityValueSchema,
    reason: Type.Optional(Type.String()),
    entries: Type.Array(JournalEvidenceSchema),
  }, { additionalProperties: false }),
  physicalFiles: Type.Object({
    source: Type.Array(Type.String()),
    collectedAt: Type.String(),
    quality: EvidenceQualityValueSchema,
    reason: Type.Optional(Type.String()),
    items: Type.Array(PhysicalFileEvidenceSchema),
  }, { additionalProperties: false }),
  gaps: Type.Array(HostEvidenceGapSchema),
}, { $id: 'LinuxHostEvidence', additionalProperties: false });

export const StorageDescriptorSchema = Type.Object({
  path: Type.String(),
  kind: Type.String(),
  source: Type.String(),
  hostInspectable: Type.Boolean(),
  tablespace: Type.Optional(Type.String()),
  objectName: Type.Optional(Type.String()),
  logicalBytes: Type.Optional(Type.Number({ minimum: 0 })),
}, { $id: 'StorageDescriptor', additionalProperties: false });

export const DiagnosticGapSchema = Type.Object({
  scope: Type.Union([Type.Literal('instance'), Type.Literal('host'), Type.Literal('storage')]),
  section: Type.Optional(Type.Union([
    Type.Literal('instance'), Type.Literal('realtime'), Type.Literal('history'),
    Type.Literal('alerts'), Type.Literal('logs'), Type.Literal('slowQueries'),
    Type.Literal('storage'), Type.Literal('relations'), Type.Literal('hostEvidence'),
    Type.Literal('evidencePack'),
  ])),
  code: Type.String(),
  resource: Type.Optional(Type.Object({
    type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false })),
  source: Type.Optional(Type.String()),
}, { $id: 'DiagnosticGap', additionalProperties: false });

export const InstanceHostEvidenceResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  subject: Type.Object({
    type: Type.Literal('instance'),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  collectedAt: Type.String(),
  database: Type.Object({
    instance: Type.Union([UnknownRecordSchema, Type.Null()]),
    realtimeMetrics: Type.Union([UnknownRecordSchema, Type.Null()]),
    metricHistory: Type.Array(UnknownRecordSchema),
    alerts: Type.Array(UnknownRecordSchema),
    logs: Type.Array(UnknownRecordSchema),
    slowQueries: Type.Array(UnknownRecordSchema),
  }, { additionalProperties: false }),
  storage: Type.Array(StorageDescriptorSchema),
  hosts: Type.Array(Type.Object({
    server: InstanceHostSchema,
    evidence: Type.Union([LinuxHostEvidenceSchema, Type.Null()]),
  }, { additionalProperties: false })),
  gaps: Type.Array(DiagnosticGapSchema),
}, { $id: 'InstanceHostEvidenceResponse', additionalProperties: false });

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
  NetworkDeviceStatus: NetworkDeviceStatusSchema,
  NetworkDevice: NetworkDeviceSchema,
  NetworkDevicesResponse: NetworkDevicesResponseSchema,
  NetworkDeviceMetric: NetworkDeviceMetricSchema,
  NetworkDeviceMetricsResponse: NetworkDeviceMetricsResponseSchema,
  NetworkDeviceInterface: NetworkDeviceInterfaceSchema,
  NetworkDeviceInterfacesResponse: NetworkDeviceInterfacesResponseSchema,
  NetworkDeviceSnmpSecurityLevel: NetworkDeviceSnmpSecurityLevelSchema,
  NetworkDeviceSnmpCredential: NetworkDeviceSnmpCredentialSchema,
  NetworkDeviceSnmpV2Credential: NetworkDeviceSnmpV2CredentialSchema,
  NetworkDeviceSnmpCredentialUnion: NetworkDeviceSnmpCredentialUnionSchema,
  NetworkDeviceSshCredential: NetworkDeviceSshCredentialSchema,
  NetworkDeviceTestConnectionRequest: NetworkDeviceTestConnectionRequestSchema,
  NetworkDeviceProbeResult: NetworkDeviceProbeResultSchema,
  NetworkDeviceTestConnectionResponse: NetworkDeviceTestConnectionResponseSchema,
  NetworkDeviceProbeResponse: NetworkDeviceProbeResponseSchema,
  NetworkDeviceCapability: NetworkDeviceCapabilitySchema,
  NetworkDeviceCapabilitiesResponse: NetworkDeviceCapabilitiesResponseSchema,
  ConfigBackupSummary: ConfigBackupSummarySchema,
  ConfigBackupSummariesResponse: ConfigBackupSummariesResponseSchema,
  ConfigBackupDetail: ConfigBackupDetailSchema,
  ConfigBackupRaw: ConfigBackupRawSchema,
  ConfigBackupResponse: ConfigBackupResponseSchema,
  ConfigBackupDiffResponse: ConfigBackupDiffResponseSchema,
  NetworkResourceRef: NetworkResourceRefSchema,
  NetworkDeviceRelationType: NetworkDeviceRelationTypeSchema,
  NetworkDeviceRelation: NetworkDeviceRelationSchema,
  NetworkDeviceRelationInput: NetworkDeviceRelationInputSchema,
  NetworkDeviceRelationsRequest: NetworkDeviceRelationsRequestSchema,
  NetworkDeviceRelationsResponse: NetworkDeviceRelationsResponseSchema,
  ResourceOverviewItem: ResourceOverviewItemSchema,
  ResourceListResponse: ResourceListResponseSchema,
  ResourceOverviewResponse: ResourceOverviewResponseSchema,
  ResourceMetricAggregate: ResourceMetricAggregateSchema,
  ResourceMetricsSummaryResponse: ResourceMetricsSummaryResponseSchema,
  ResourceAgentDiagnosisResponse: ResourceAgentDiagnosisResponseSchema,
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
  ServerDiagnostics: ServerDiagnosticsSchema,
  CollectServerDiagnosticsResponse: CollectServerDiagnosticsResponseSchema,
  EvidenceQuality: EvidenceQualitySchema,
  FilesystemEvidence: FilesystemEvidenceSchema,
  JournalEvidence: JournalEvidenceSchema,
  PhysicalFileEvidence: PhysicalFileEvidenceSchema,
  HostEvidenceGap: HostEvidenceGapSchema,
  LinuxHostEvidence: LinuxHostEvidenceSchema,
  StorageDescriptor: StorageDescriptorSchema,
  DiagnosticGap: DiagnosticGapSchema,
  InstanceHostEvidenceResponse: InstanceHostEvidenceResponseSchema,
  OkResponse: OkResponseSchema,
} as const satisfies Record<string, TSchema>;

export type HealthResponse = Static<typeof HealthResponseSchema>;
export type AdapterCapabilitiesResponse = Static<typeof AdapterCapabilitiesResponseSchema>;
export type NetworkDevice = Static<typeof NetworkDeviceSchema>;
export type NetworkDevicesResponse = Static<typeof NetworkDevicesResponseSchema>;
export type NetworkDeviceMetric = Static<typeof NetworkDeviceMetricSchema>;
export type NetworkDeviceMetricsResponse = Static<typeof NetworkDeviceMetricsResponseSchema>;
export type NetworkDeviceInterface = Static<typeof NetworkDeviceInterfaceSchema>;
export type NetworkDeviceInterfacesResponse = Static<typeof NetworkDeviceInterfacesResponseSchema>;
export type NetworkDeviceSnmpSecurityLevel = Static<typeof NetworkDeviceSnmpSecurityLevelSchema>;
export type NetworkDeviceSnmpCredential = Static<typeof NetworkDeviceSnmpCredentialSchema>;
export type NetworkDeviceSshCredential = Static<typeof NetworkDeviceSshCredentialSchema>;
export type NetworkDeviceTestConnectionRequest = Static<typeof NetworkDeviceTestConnectionRequestSchema>;
export type NetworkDeviceProbeResult = Static<typeof NetworkDeviceProbeResultSchema>;
export type NetworkDeviceTestConnectionResponse = Static<typeof NetworkDeviceTestConnectionResponseSchema>;
export type NetworkDeviceProbeResponse = Static<typeof NetworkDeviceProbeResponseSchema>;
export type NetworkDeviceCapability = Static<typeof NetworkDeviceCapabilitySchema>;
export type NetworkDeviceCapabilitiesResponse = Static<typeof NetworkDeviceCapabilitiesResponseSchema>;
export type ConfigBackupSummary = Static<typeof ConfigBackupSummarySchema>;
export type ConfigBackupSummariesResponse = Static<typeof ConfigBackupSummariesResponseSchema>;
export type ConfigBackupDetail = Static<typeof ConfigBackupDetailSchema>;
export type ConfigBackupRaw = Static<typeof ConfigBackupRawSchema>;
export type ConfigBackupResponse = Static<typeof ConfigBackupResponseSchema>;
export type ConfigBackupDiffResponse = Static<typeof ConfigBackupDiffResponseSchema>;
export type NetworkResourceRef = Static<typeof NetworkResourceRefSchema>;
export type NetworkDeviceRelationType = Static<typeof NetworkDeviceRelationTypeSchema>;
export type NetworkDeviceRelation = Static<typeof NetworkDeviceRelationSchema>;
export type NetworkDeviceRelationInput = Static<typeof NetworkDeviceRelationInputSchema>;
export type NetworkDeviceRelationsRequest = Static<typeof NetworkDeviceRelationsRequestSchema>;
export type NetworkDeviceRelationsResponse = Static<typeof NetworkDeviceRelationsResponseSchema>;
export type ResourceOverviewItem = Static<typeof ResourceOverviewItemSchema>;
export type ResourceOverviewResponse = Static<typeof ResourceOverviewResponseSchema>;
export type ResourceMetricAggregate = Static<typeof ResourceMetricAggregateSchema>;
export type ResourceMetricsSummaryResponse = Static<typeof ResourceMetricsSummaryResponseSchema>;
export type ResourceAgentDiagnosisResponse = Static<typeof ResourceAgentDiagnosisResponseSchema>;
export type DatabaseInstance = Static<typeof DatabaseInstanceSchema>;
export type InstanceHostRole = Static<typeof InstanceHostRoleSchema>;
export type InstanceHostMapping = Static<typeof InstanceHostMappingSchema>;
export type InstanceHost = Static<typeof InstanceHostSchema>;
export type HostedInstance = Static<typeof HostedInstanceSchema>;
export type ReplaceInstanceHostsBody = Static<typeof ReplaceInstanceHostsBodySchema>;
export type InstanceHostsResponse = Static<typeof InstanceHostsResponseSchema>;
export type ReplaceInstanceHostsResponse = Static<typeof ReplaceInstanceHostsResponseSchema>;
export type HostedInstancesResponse = Static<typeof HostedInstancesResponseSchema>;
export type ServerDiagnostics = Static<typeof ServerDiagnosticsSchema>;
export type CollectServerDiagnosticsResponse = Static<typeof CollectServerDiagnosticsResponseSchema>;
export type EvidenceQuality = Static<typeof EvidenceQualitySchema>;
export type FilesystemEvidence = Static<typeof FilesystemEvidenceSchema>;
export type JournalEvidence = Static<typeof JournalEvidenceSchema>;
export type PhysicalFileEvidence = Static<typeof PhysicalFileEvidenceSchema>;
export type HostEvidenceGap = Static<typeof HostEvidenceGapSchema>;
export type LinuxHostEvidence = Static<typeof LinuxHostEvidenceSchema>;
export type StorageDescriptor = Static<typeof StorageDescriptorSchema>;
export type DiagnosticGap = Static<typeof DiagnosticGapSchema>;
export type InstanceHostEvidenceResponse = Static<typeof InstanceHostEvidenceResponseSchema>;
