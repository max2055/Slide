import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { listAdapterCapabilities } from '../adapters/capability-matrix.js';
import { publicInstanceDto } from '../security/public-dto.js';
import {
  AdapterCapabilitiesResponseSchema,
  DatabaseInstanceSchema,
  DatabaseInstancesResponseSchema,
  HealthResponseSchema,
  HostedInstancesResponseSchema,
  InstanceHostEvidenceResponseSchema,
  InstanceHostsResponseSchema,
  OkResponseSchema,
  ReplaceInstanceHostsBodySchema,
  ReplaceInstanceHostsResponseSchema,
  ServerDiagnosticsSchema,
  CollectServerDiagnosticsResponseSchema,
  NetworkDeviceRelationInputSchema,
  NetworkDeviceTestConnectionRequestSchema,
  NetworkDeviceTestConnectionResponseSchema,
  LLMConnectionTestRequestSchema,
  LLMModelDiscoveryRequestSchema,
} from './public-api.js';
import { buildClientTypes, buildOpenApiDocument } from './generate-public-api.js';
import { registerMetricTemplateRoutes } from '../metrics/templates/routes.js';

describe('generated public API contract', () => {
  it('documents protected observations with durable gauges and process-local timings', () => {
    const document = buildOpenApiDocument() as any;
    const operation = document.paths['/api/platform/observations']?.get;
    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.responses['403']).toBeDefined();
    expect(operation?.description).toContain('process-local');
    expect(document.components.schemas.QueueObservation.properties.quality).toBeDefined();
    expect(buildClientTypes()).toContain('export interface QueueObservation');
  });
  it('documents manual event confirmation, conflict retries and the closing prerequisite', () => {
    const document = buildOpenApiDocument() as any;
    for (const action of ['investigate', 'resolve', 'verify-recovery', 'close']) {
      expect(document.paths[`/api/alerts/events/{id}/${action}`]?.post.responses).toHaveProperty('409');
    }
    expect(document.paths['/api/alerts/events/{id}/verify-recovery'].post.description).toContain('manual');
    expect(document.paths['/api/alerts/events/{id}/close'].post.description).toContain('confirmation');
    expect(document.components.schemas.EventRecoveryConfirmationRequest.properties.reason).toMatchObject({ type: 'string', minLength: 1, maxLength: 1024, pattern: '\\S' });
  });
  it('accepts actual health and adapter capability responses', () => {
    expect(Value.Check(HealthResponseSchema, { status: 'ok', timestamp: new Date().toISOString() })).toBe(true);
    expect(Value.Check(AdapterCapabilitiesResponseSchema, { adapters: listAdapterCapabilities() })).toBe(true);
  });

  it('accepts redacted instance DTOs and rejects missing credential metadata', () => {
    const dto = publicInstanceDto({
      id: 1, name: 'primary', db_type: 'mysql', host: '127.0.0.1', port: 3306,
      database_name: 'slide', health_status: 'healthy', health_score: 100, status: 'active',
      created_at: '2026-07-23T00:00:00.000Z', password_encrypted: 'ciphertext',
    });
    expect(Value.Check(DatabaseInstanceSchema, dto)).toBe(true);
    expect(Value.Check(DatabaseInstanceSchema, { ...dto, hasCredential: undefined })).toBe(false);
    expect(dto).not.toHaveProperty('password_encrypted');
  });

  it('accepts persisted error health status in the Fastify instance response contract', async () => {
    const dto = publicInstanceDto({
      id: 2, name: 'broken', db_type: 'mysql', host: '127.0.0.1', port: 3306,
      database_name: 'slide', health_status: 'error', health_score: 0, status: 'error',
      created_at: '2026-07-23T00:00:00.000Z', password_encrypted: 'ciphertext',
    });
    expect(Value.Check(DatabaseInstanceSchema, dto)).toBe(true);

    const app = Fastify();
    app.get('/', { schema: { response: { 200: DatabaseInstanceSchema } } }, async () => dto);
    const response = await app.inject({ method: 'GET', url: '/' });
    await app.close();
    expect(response.statusCode).toBe(200);
  });

  it('generates deterministic documented operations and frontend types', () => {
    const document = buildOpenApiDocument() as any;
    expect(Object.keys(document.paths)).toEqual([
      '/api/adapters/capabilities',
      '/api/ai/analysis/{id}/evidence',
      '/api/ai/analysis/{id}/investigation',
      '/api/alerts/{id}/investigation',
      '/api/alerts/events/{id}/close',
      '/api/alerts/events/{id}/investigate',
      '/api/alerts/events/{id}/resolve',
      '/api/alerts/events/{id}/verify-recovery',
      '/api/cron/jobs/{id}',
      '/api/cron/jobs/{id}/run',
      '/api/cron/jobs/{id}/runs',
      '/api/cron/jobs/{id}/runs/{runId}',
      '/api/database/instances',
      '/api/database/instances/{id}',
      '/api/database/instances/{id}/host-evidence',
      '/api/database/instances/{id}/hosts',
      '/api/database/instances/{id}/hosts/{serverId}',
      '/api/health',
      '/api/health/ready',
      '/api/investigation-budget',
      '/api/investigation-policies',
      '/api/investigation-profiles',
      '/api/investigation-usage',
      '/api/investigations',
      '/api/investigations/{id}',
      '/api/investigations/{id}/events',
      '/api/investigations/{id}/evidence/{eid}',
      '/api/investigations/{id}/facts',
      '/api/investigations/{id}/feedback',
      '/api/investigations/{id}/messages',
      '/api/investigations/{id}/requests/{requestId}/cancel',
      '/api/investigations/{id}/results',
      '/api/investigations/{id}/runs',
      '/api/llm/models',
      '/api/llm/test',
      '/api/metrics/config/bulk',
      '/api/metrics/config/bulk/{id}',
      '/api/metrics/config/bulk/{id}/cancel',
      '/api/metrics/config/bulk/{id}/confirm',
      '/api/metrics/config/bulk/{id}/retry',
      '/api/metrics/config/bulk/preview',
      '/api/metrics/config/resources/{type}/{id}/activate',
      '/api/metrics/config/resources/{type}/{id}/migration',
      '/api/metrics/config/resources/{type}/{id}/operations/{key}',
      '/api/metrics/config/resources/{type}/{id}/recommendations',
      '/api/metrics/config/resources/{type}/{id}/status',
      '/api/metrics/policy/groups',
      '/api/metrics/template-bindings/{type}/{id}',
      '/api/metrics/template-bindings/{type}/{id}/apply',
      '/api/metrics/template-bindings/{type}/{id}/preview',
      '/api/metrics/template-bindings/{type}/{id}/trial',
      '/api/metrics/templates',
      '/api/metrics/templates/{templateId}/repin',
      '/api/metrics/templates/{templateId}/versions/{version}',
      '/api/network-devices',
      '/api/network-devices/{id}',
      '/api/network-devices/{id}/backup-schedule',
      '/api/network-devices/{id}/capabilities',
      '/api/network-devices/{id}/config-backups',
      '/api/network-devices/{id}/config-backups/{backupId}',
      '/api/network-devices/{id}/config-backups/{backupId}/diff',
      '/api/network-devices/{id}/interfaces',
      '/api/network-devices/{id}/metrics',
      '/api/network-devices/{id}/probe',
      '/api/network-devices/{id}/relations',
      '/api/network-devices/test-connection',
      '/api/operations/action-executions/{id}',
      '/api/operations/action-executions/{id}/cancel',
      '/api/operations/action-executions/{id}/reconcile',
      '/api/operations/action-executions/{id}/verification',
      '/api/operations/action-executions/{id}/verification/versions/{version}',
      '/api/operations/action-plans/{id}/versions/{version}/execute',
      '/api/operations/actions/drafts',
      '/api/operations/actions/plans',
      '/api/operations/actions/plans/{id}',
      '/api/operations/actions/plans/{id}/review',
      '/api/operations/actions/plans/{id}/submit',
      '/api/operations/actions/plans/{id}/versions',
      '/api/operations/attention',
      '/api/operations/attention/{id}',
      '/api/operations/attention/{id}/overrides',
      '/api/operations/baselines',
      '/api/operations/baselines/{id}',
      '/api/operations/knowledge',
      '/api/operations/knowledge/{id}',
      '/api/operations/knowledge/{id}/bind',
      '/api/operations/knowledge/{id}/review',
      '/api/operations/knowledge/{id}/submit',
      '/api/operations/knowledge/{id}/watch',
      '/api/operations/knowledge/{id}/withdraw',
      '/api/operations/relations',
      '/api/operations/relations/{id}/review',
      '/api/operations/relations/{id}/revisions',
      '/api/operations/resources/{type}/{id}/relations',
      '/api/platform/observations',
      '/api/platform/system-events',
      '/api/platform/system-events/{id}',
      '/api/resources',
      '/api/resources/{type}/{id}/diagnose',
      '/api/resources/{type}/{id}/diagnose-agent',
      '/api/resources/{type}/{id}/observations',
      '/api/resources/metrics/summary',
      '/api/resources/overview',
      '/api/servers/{id}/collect-diagnostics',
      '/api/servers/{id}/diagnostics',
      '/api/servers/{id}/instances',
    ]);
    const operationLookup = document.paths['/api/metrics/config/resources/{type}/{id}/operations/{key}'].get;
    expect(operationLookup.operationId).toBe('getMetricConfigurationOperation');
    expect(operationLookup.security).toEqual([{ bearerAuth: [] }]);
    expect(operationLookup.parameters.map((parameter: any) => [parameter.name, parameter.in, parameter.required]))
      .toEqual([['type', 'path', true], ['id', 'path', true], ['key', 'path', true]]);
    expect(operationLookup.parameters[2].schema.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(operationLookup.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/MetricOperationState');
    expect(Object.keys(operationLookup.responses)).toEqual(['200', '400', '401', '403', '404', '503']);
    expect(document.paths['/api/operations/knowledge'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/operations/knowledge'].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/OperationsCaseCandidate');
    expect(document.paths['/api/operations/actions/execute']).toBeUndefined();
    expect(buildClientTypes()).toContain('export type OperationsCaseCandidate');
    expect(document.paths['/api/health/ready'].get.security).toEqual([]);
    expect(document.paths['/api/health/ready'].get.responses['503']).toBeDefined();
    expect(buildClientTypes()).toContain('export interface InfrastructureReadiness { ready: boolean; }');
    expect(buildClientTypes()).toContain('export interface DatabaseInstance');
    expect(buildClientTypes()).toContain("health_status: 'healthy' | 'warning' | 'critical' | 'unknown' | 'error';");
    expect(buildClientTypes()).toContain('export interface InstanceHostEvidenceResponse');
    expect(buildClientTypes()).toContain('export interface FilesystemEvidence');
    expect(buildClientTypes()).toContain('export interface JournalEvidence');
    expect(buildClientTypes()).toContain('export interface PhysicalFileEvidence');
    expect(buildClientTypes()).toContain('export interface DiagnosticGap');
    expect(buildClientTypes()).toContain('export interface ServerDiagnostics');
    expect(buildClientTypes()).toContain('export interface CollectServerDiagnosticsResponse');
    expect(buildClientTypes()).toContain('export interface LLMConnectionTestRequest');
    expect(buildClientTypes()).toContain('export interface LLMModelDiscoveryRequest');
    expect(buildClientTypes()).toBe(buildClientTypes());
  });

  it('documents every registered native-template route and loses none', async () => {
    const document = buildOpenApiDocument() as any;
    // Derive the surface from the real registration, not from a second list: a
    // route that exists but is undocumented (or the reverse) fails here.
    const app = Fastify();
    // Fastify also exposes an implicit HEAD route for every GET; only the
    // documented methods count.
    const registered = new Set<string>();
    app.addHook('onRoute', route => {
      if (route.method === 'GET' || route.method === 'POST') registered.add(route.url.replace(/:(\w+)/g, '{$1}'));
    });
    await registerMetricTemplateRoutes(app, async () => undefined);
    await app.ready();
    await app.close();
    expect([...registered].sort()).toEqual([
      '/api/metrics/template-bindings/{type}/{id}',
      '/api/metrics/template-bindings/{type}/{id}/apply',
      '/api/metrics/template-bindings/{type}/{id}/preview',
      '/api/metrics/template-bindings/{type}/{id}/trial',
      '/api/metrics/templates',
      '/api/metrics/templates/{templateId}/repin',
      '/api/metrics/templates/{templateId}/versions/{version}',
    ]);
    const documented = Object.keys(document.paths).filter(path => path.startsWith('/api/metrics/template')).sort();
    expect(documented).toEqual([...registered].sort());

    const operation = (path: string, method: 'get' | 'post') => document.paths[path][method];
    const resourceParameters = ['type', 'id'].map(name => [name, 'path', true]);
    const catalog = operation('/api/metrics/templates', 'get');
    expect(catalog.operationId).toBe('listMetricTemplates');
    expect(catalog.security).toEqual([{ bearerAuth: [] }]);
    expect(catalog.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateCatalog');
    expect(catalog.responses).toHaveProperty('403');

    const version = operation('/api/metrics/templates/{templateId}/versions/{version}', 'get');
    expect(version.operationId).toBe('getMetricTemplateVersion');
    expect(version.parameters.map((parameter: any) => [parameter.name, parameter.in, parameter.required]))
      .toEqual([['templateId', 'path', true], ['version', 'path', true]]);
    expect(version.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateVersionDetail');
    expect(version.responses).toHaveProperty('404');

    const repin = operation('/api/metrics/templates/{templateId}/repin', 'post');
    expect(repin.operationId).toBe('repinMetricTemplateVersion');
    expect(repin.security).toEqual([{ bearerAuth: [] }]);
    expect(repin.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateRepinBody');
    expect(repin.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateRepinResponse');
    expect(repin.responses).toHaveProperty('422');

    const status = operation('/api/metrics/template-bindings/{type}/{id}', 'get');
    expect(status.operationId).toBe('getMetricTemplateBinding');
    expect(status.parameters.map((parameter: any) => [parameter.name, parameter.in, parameter.required]))
      .toEqual(resourceParameters);
    expect(status.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateBindingStatus');

    const flow: Array<[string, string, string]> = [
      ['preview', 'previewMetricTemplateBinding', 'TemplateBindingRequest'],
      ['trial', 'trialMetricTemplateBinding', 'TemplateTrialRequest'],
      ['apply', 'applyMetricTemplateBinding', 'TemplateBindingApplyRequest'],
    ];
    for (const [suffix, operationId, request] of flow) {
      const route = operation(`/api/metrics/template-bindings/{type}/{id}/${suffix}`, 'post');
      expect(route.operationId).toBe(operationId);
      expect(route.security).toEqual([{ bearerAuth: [] }]);
      expect(route.parameters.map((parameter: any) => [parameter.name, parameter.in, parameter.required]))
        .toEqual(resourceParameters);
      expect(route.requestBody.content['application/json'].schema.$ref).toBe(`#/components/schemas/${request}`);
      expect(route.responses).toHaveProperty('403');
      expect(route.responses).toHaveProperty('422');
      // Preview takes no resource lock, so it has no busy collision.
      expect(route.responses['409'] !== undefined, suffix).toBe(suffix !== 'preview');
    }
    expect(operation('/api/metrics/template-bindings/{type}/{id}/preview', 'post')
      .responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateBindingPreview');
    expect(operation('/api/metrics/template-bindings/{type}/{id}/trial', 'post')
      .responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateTrialResponse');
    expect(operation('/api/metrics/template-bindings/{type}/{id}/apply', 'post')
      .responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/TemplateBindingApplyResponse');

    // The generated client carries the same shapes a UI would import.
    const client = buildClientTypes();
    for (const name of ['TemplateCatalog', 'TemplateVersionDetail', 'TemplateRepinResponse', 'TemplateBindingStatus',
      'TemplateBindingPreview', 'TemplateTrialResponse', 'TemplateBindingApplyResponse',
      'TemplateBindingRequest', 'TemplateTrialRequest', 'TemplateBindingApplyRequest']) {
      expect(client, name).toContain(`export type ${name} = `);
    }
  });

  it('documents LLM management permission, saved destination binding and probe limits', () => {
    const document = buildOpenApiDocument() as any;
    for (const path of ['/api/llm/test', '/api/llm/models']) {
      expect(document.paths[path].post.description).toContain('llm:manage');
      expect(document.paths[path].post.responses).toHaveProperty('403');
      expect(document.paths[path].post.responses).toHaveProperty('409');
      expect(document.paths[path].post.responses).toHaveProperty('429');
    }
    expect(Value.Check(LLMConnectionTestRequestSchema, { providerName: 'private' })).toBe(true);
    expect(Value.Check(LLMModelDiscoveryRequestSchema, { providerName: 'private', baseURL: 'http://localhost:11434/v1' })).toBe(true);
    expect(Value.Check(LLMConnectionTestRequestSchema, { providerName: 'private', apiKey: 'x'.repeat(4097) })).toBe(false);
    expect(Value.Check(LLMModelDiscoveryRequestSchema, { providerName: 'private' })).toBe(false);
  });

  it('documents optional SSH host-key probing and the server-only relation boundary', () => {
    expect(Value.Check(NetworkDeviceTestConnectionRequestSchema, {
      host: '192.0.2.10', version: 3, snmpPort: 161, sshPort: 22,
      snmpv3: { username: 'monitor', securityLevel: 'authPriv', authProtocol: 'SHA', authSecret: '12345678', privacyProtocol: 'AES', privacySecret: '12345678' },
      ssh: { credentialType: 'password', username: 'readonly', credentialValue: 'secret', hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` },
    })).toBe(true);
    expect(Value.Check(NetworkDeviceTestConnectionRequestSchema, {
      mode: 'ssh', host: '192.0.2.10', sshPort: 22,
      ssh: { credentialType: 'password', username: 'readonly', credentialValue: 'secret' },
    })).toBe(true);
    expect(Value.Check(NetworkDeviceTestConnectionResponseSchema, { success: true, ssh: { verified: true } })).toBe(true);
    expect(Value.Check(NetworkDeviceRelationInputSchema, { target: { type: 'server', id: 3 }, relationType: 'connected_to' })).toBe(true);
    expect(Value.Check(NetworkDeviceRelationInputSchema, { target: { type: 'instance', id: 11 }, relationType: 'serves' })).toBe(false);
  });

  it('types complete host freshness, filesystems, journals, physical files, roles, and gaps', () => {
    const collectedAt = '2026-08-10T00:00:00.000Z';
    const response = {
      schemaVersion: 1,
      subject: { type: 'instance', id: 10 },
      collectedAt,
      database: {
        instance: { id: 10, name: 'orders', db_type: 'mysql' },
        realtimeMetrics: null,
        metricHistory: [], alerts: [], logs: [], slowQueries: [],
      },
      storage: [{ path: '/data/orders.db', kind: 'data-file', source: 'mysql', hostInspectable: true }],
      hosts: [{
        server: {
          serverId: 20, role: 'primary', host: 'db-a', port: 22, label: 'DB A', osType: 'RHEL 8',
          status: 'online', collectionEnabled: true, validFrom: collectedAt,
        },
        evidence: {
          schemaVersion: 1, serverId: 20, collectedAt, expiresAt: '2026-08-10T00:05:00.000Z',
          quality: 'partial', truncated: false,
          metrics: { source: ['procfs'], collectedAt, quality: 'good', values: { cpu: 12 } },
          filesystems: {
            source: ['df'], collectedAt, quality: 'good', items: [{
              mount: '/data', device: '/dev/mapper/data', fsType: 'xfs', sizeBytes: 1000,
              usedBytes: 750, availableBytes: 250, usagePercent: 75,
              inodeTotal: 100, inodeUsed: 20, inodeAvailable: 80, inodeUsagePercent: 20,
            }],
          },
          systemLogs: {
            source: ['journald'], collectedAt, quality: 'partial', reason: 'SYSTEM_LOG_SOURCE_PARTIAL',
            entries: [{ timestamp: collectedAt, severity: 'warning', unit: 'mysqld.service', identifier: 'mysqld', pid: '10', message: 'I/O warning' }],
          },
          physicalFiles: {
            source: ['stat'], collectedAt, quality: 'good', items: [{
              path: '/data/orders.db', quality: 'good', sizeBytes: 100,
            }],
          },
          gaps: [{ section: 'systemLogs', reason: 'SYSTEM_LOG_SOURCE_PARTIAL' }],
        },
      }],
      gaps: [{
        scope: 'host', section: 'hostEvidence', code: 'SSH_COMMAND_TIMEOUT',
        resource: { type: 'server', id: 20 },
      }],
    };

    expect(Value.Check(InstanceHostEvidenceResponseSchema, response)).toBe(true);
    const missingFreshness = structuredClone(response);
    delete (missingFreshness.hosts[0].evidence.systemLogs as any).collectedAt;
    expect(Value.Check(InstanceHostEvidenceResponseSchema, missingFreshness)).toBe(false);
  });

  it('serializes the template flow responses without dropping a documented field', async () => {
    // A response schema that strips fields would silently break the page; a real
    // registration plus one representative payload proves the round trip.
    const status = {
      source: 'template', revision: 5,
      application: { status: 'pending', applied_revision: 4, reported_at: '2026-10-29T15:00:00.000Z', error_code: null },
      template_pins: [{ template_id: 'tpl', version: 2, content_hash: `sha256:${'a'.repeat(64)}` }],
      pending: { base_revision: 4, target_revision: 5, plan: { kind: 'template_collection_plan', releases: [{ nested: [1, 2] }] } },
      effective: { revision: 4, resolution_identity: `sha256:${'b'.repeat(64)}` },
      published_at: '2026-10-29T15:00:00.000Z',
    };
    const preview = {
      template: true, resource: { type: 'instance', id: 1 }, revision: 4,
      resolution_identity: `sha256:${'a'.repeat(64)}`, executable: true,
      settings: { enabled: true, interval_ms: 300000, timeout_ms: 5000, stale_after_ms: 900000,
        max_counter_gap_ms: 900000, max_rows: 1000, max_concurrency: 1, max_series_per_resource: 100 },
      parameters: [{ pin: { template_id: 'tpl', version: 1, content_hash: `sha256:${'a'.repeat(64)}` },
        parameters: [{ name: 'interval_ms', type: 'integer', default: 300000, override: null, effective: 300000, source: 'default' }] }],
      releases: [{ release: { id: 'mysql-basic', version: '2.0.0', digest: `sha256:${'c'.repeat(64)}` },
        release_ref: 'mysql-basic@2.0.0', interval_ms: 300000, timeout_ms: 5000, collector_ids: ['status'],
        metric_keys: ['db.uptime_seconds@1.0.0'], requests_per_hour_estimate: 12,
        applicability: [{ attribute: 'db.version', value: '9.6.0', supported_values: ['9.6.0'], status: 'supported' }] }],
      items: [{ template_id: 'tpl', item_id: 'uptime', item_version: 1,
        canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', dimensions: {},
        release: { id: 'mysql-basic', version: '2.0.0', digest: `sha256:${'c'.repeat(64)}` },
        release_ref: 'mysql-basic@2.0.0', collector_id: 'status', implementation_id: 'mysql-status',
        enabled: true, decision: 'collect', capability: 'supported' }],
      excluded: [], budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 1,
        max_series_per_resource: 100, requests_per_hour_estimate: 12 },
      plan: { kind: 'template_collection_plan', internal: true, persisted: false, applied: false, executable: true,
        identity: `sha256:${'a'.repeat(64)}`, resource: { type: 'instance', id: '1' }, revision: 4,
        settings: { enabled: true, interval_ms: 300000, timeout_ms: 5000, stale_after_ms: 900000,
          max_counter_gap_ms: 900000, max_rows: 1000, max_concurrency: 1, max_series_per_resource: 100 },
        parameters: [], releases: [{ steps: [{ items: [{ nested: 'kept' }] }] }], excluded: [],
        budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 1,
          max_series_per_resource: 100, requests_per_hour_estimate: 12 } },
    };
    const stubs = { status: async () => status, preview: async () => preview, trial: async () => ({}), apply: async () => ({}) };
    const app = Fastify();
    await registerMetricTemplateRoutes(app, async request => {
      // The pre-handler is the only place the platform attaches the authenticated actor.
      (request as unknown as { user?: unknown }).user = {
        userId: 1, username: 'contract', roles: ['admin'], permissions: ['*'], sessionVersion: 1,
        instanceScopes: {}, requestId: 'contract-test',
      };
    }, stubs as never);
    try {
      const response = await app.inject({ method: 'GET', url: '/api/metrics/template-bindings/instance/1' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(status);
      const body = { expected_revision: 4, template_pins: [{ template_id: 'tpl', version: 1, content_hash: `sha256:${'a'.repeat(64)}` }] };
      const previewed = await app.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/preview', payload: body });
      expect(previewed.statusCode).toBe(200);
      expect(previewed.json()).toEqual(preview);
    } finally { await app.close(); }
  });

  it('compiles all response schemas in Fastify', async () => {
    const app = Fastify();
    app.get('/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
    app.get('/capabilities', { schema: { response: { 200: AdapterCapabilitiesResponseSchema } } }, async () => ({ adapters: listAdapterCapabilities() }));
    app.get('/instances', { schema: { response: { 200: DatabaseInstancesResponseSchema } } }, async () => []);
    app.get('/instance-hosts', { schema: { response: { 200: InstanceHostsResponseSchema } } }, async () => ({ hosts: [] }));
    app.get('/instance-host-evidence', { schema: { response: { 200: InstanceHostEvidenceResponseSchema } } }, async () => ({
      schemaVersion: 1,
      subject: { type: 'instance', id: 1 },
      collectedAt: new Date().toISOString(),
      database: { instance: null, realtimeMetrics: null, metricHistory: [], alerts: [], logs: [], slowQueries: [] },
      storage: [], hosts: [], gaps: [],
    }));
    app.put('/instance-hosts', { schema: { body: ReplaceInstanceHostsBodySchema, response: { 200: ReplaceInstanceHostsResponseSchema } } }, async () => ({ ok: true, hosts: [] }));
    app.delete('/instance-hosts', { schema: { response: { 200: OkResponseSchema } } }, async () => ({ ok: true }));
    app.get('/hosted-instances', { schema: { response: { 200: HostedInstancesResponseSchema } } }, async () => ({ instances: [] }));
    app.get('/server-diagnostics', { schema: { response: { 200: ServerDiagnosticsSchema } } }, async () => ({}));
    app.post('/server-diagnostics/collect', { schema: { response: { 200: CollectServerDiagnosticsResponseSchema } } }, async () => ({}));
    await expect(app.ready()).resolves.toBe(app);
    await app.close();
  });
});
