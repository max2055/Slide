import { operationsJsonSchemas, operationsPublicPaths } from '../operations/public-api.js';
import { InvestigationFeedbackSchemas } from '../investigations/feedback-contracts.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kind, type TSchema } from '@sinclair/typebox';
import { PublicApiSchemas } from './public-api.js';
import { InvestigationHttpSchemas } from '../investigations/http-contracts.js';
import { InvestigationSchemas } from '../investigations/contracts.js';
import { InvestigationObservationSchemas } from '../investigations/observation-contracts.js';
import { InvestigationProfileSchemas } from '../investigations/profile-contracts.js';
import { InvestigationGovernanceSchemas } from '../investigations/governance-contracts.js';
import { InvestigationBridgeSchemas } from '../investigations/bridge-contracts.js';
import { SystemHttpSchemas } from '../investigations/system-http-contracts.js';
import { metricJsonSchemas, metricPublicPaths } from './metrics/public-api.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const openApiPath = resolve(root, 'docs/slide/openapi.json');
const clientPath = resolve(root, 'frontend/src/api/generated/public-api.ts');

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function refSchema(schema: TSchema): Record<string, string> {
  return { $ref: `#/components/schemas/${schema.$id}` };
}

function investigationId() {
  return { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9-]{36}$' } };
}

function pathId(name: 'id' | 'serverId' | 'backupId') {
  return { name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
}

export function buildOpenApiDocument() {
  return stable({
    openapi: '3.1.0',
    info: { title: 'Slide Public API', version: '0.10' },
    paths: {
      ...metricPublicPaths,
      ...operationsPublicPaths,
      '/api/alerts/{id}/investigation': { post: {
        operationId: 'openAlertInvestigation', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
        description: 'Database pilot: source-scoped single execution owner, live ai:manage and resource authority. Empty body only. A new investigation survives flag rollback; existing legacy pending/running/unknown is not adopted. Server alerts retain legacy RCA. Source linking grants viewer only when the caller has the complete live scope. Private/no-store.',
        responses: { '202': { description: 'Accepted or linked investigation', content: { 'application/json': { schema: refSchema(InvestigationBridgeSchemas.AlertInvestigationResponse) } } },
          '200': { description: 'Legacy analysis response (numeric id)' }, '400': { description: 'Invalid input' }, '401': { description: 'JWT required' },
          '403': { description: 'AI management permission required' }, '404': { description: 'Source not visible' }, '409': { description: 'Legacy result unknown; no replay' },
          '422': { description: 'Source excluded or suppressed' }, '503': { description: 'Acceptance unavailable; never fallback to another owner' } },
      } },
      '/api/ai/analysis/{id}/investigation': { post: {
        operationId: 'linkLegacyAnalysis', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
        description: 'Explicit lazy readonly legacy link (INVESTIGATION_LEGACY_BRIDGE_ENABLED). Requires live ai:view/chat/resource authority and original principal for manual results. Unique per Analysis; does not enqueue, replay or invent a Run/result version. Archived view cannot be reopened or appended. Unknown stays unknown. Empty body only; private/no-store.',
        responses: { '200': { description: 'Unique archived historical link', content: { 'application/json': { schema: refSchema(InvestigationBridgeSchemas.LegacyAnalysisLink) } } },
          '400': { description: 'Invalid input' }, '401': { description: 'JWT required' }, '404': { description: 'Source or original actor not visible' },
          '409': { description: 'Historical analysis is still active' }, '503': { description: 'Bridge disabled or store unavailable' } },
      } },
      ...Object.fromEntries(['policies', 'budget', 'usage'].map(kind => {
        const name = kind === 'policies' ? 'InvestigationPoliciesResponse' : kind === 'budget' ? 'InvestigationBudgetResponse' : 'InvestigationUsageResponse';
        return [`/api/investigation-${kind}`, { get: {
          operationId: `getInvestigation${kind[0].toUpperCase()}${kind.slice(1)}`, security: [{ bearerAuth: [] }],
          description: `Readonly governance facts. Requires live ai:view${kind === 'policies' ? '' : ' AND config:manage (global configuration management, not resource-scoped access)'}. Same-connection live identity reload before count/page; bounded delegated and service identities denied. All responses private, no-store. ${kind === 'policies' ? 'Separates persisted total switch, investigation lane switch, dedicated service identity, per-type resource coverage, durable entry wiring, historical alert receipts, durable execution outcomes and admission budget readiness. Configuration completeness never implies live authority, wiring or a successful model run; alert tags are observations only and durable owners/requests/jobs carry execution results. No principal or resource identifiers. investigation_engine persists only.' : kind === 'budget' ? 'Effective admission policy from the durable effective-budget setting (falling back to investigationBudgetConfiguration) plus persisted domain-policy matching/conflict for the domain revision new admissions target; reading does not initialize domains. Profile ceilings are at /api/investigation-profiles; automatic trigger status requires both enabled switches plus durable automatic ownership for the currently configured resources, never configuration or alert tags alone.' : 'All-history persisted ledger AGGREGATES ONLY, grouped by currency/state/mode; no individual ledger or resource identifiers. Offset pagination of groups after authorization, total counts reservations and groupCount counts groups; concurrent writes can shift pages. Counts cover every state. Costs grouped by currency, rate estimates only, never provider invoices. Input includes cached input; unknown or missing rates retain allowance, not zero.'}`,
          ...(kind === 'usage' ? { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 200000, default: 0 } }] } : {}),
          responses: { '200': { description: 'Actual configuration or durable facts; no read-side writes', content: { 'application/json': { schema: refSchema(InvestigationGovernanceSchemas[name]) } } },
            '400': { description: 'Invalid or unsupported query' }, '401': { description: 'Invalid or revoked identity' },
            '403': { description: 'Missing live governance authorization' }, '503': { description: 'Facts unavailable; no fabricated zero usage' } },
        } }];
      })),
      '/api/investigation-profiles': { get: {
        operationId: 'listInvestigationProfiles', security: [{ bearerAuth: [] }],
        description: 'Repository-versioned System/Ops presets for AI settings. Requires live ai:view; private, no-store on success and rejection. Prompt version/hash only, no credentials or principal data. Allowlist is an authority ceiling, not tool availability or execution permission. No query parameters or editing. Output schema is InvestigationResult at the profile outputSchemaVersion.',
        responses: {
          '200': { description: 'Current preset facts; tool availability not evaluated', content: { 'application/json': { schema: refSchema(InvestigationProfileSchemas.InvestigationProfilesResponse) } } },
          '400': { description: 'Unsupported query parameters' },
          '401': { description: 'Missing, invalid, disabled or revoked identity' },
          '403': { description: 'Live AI settings read permission absent' },
        },
      } },
      '/api/investigations': {
        post: { operationId: 'createInvestigation', security: [{ bearerAuth: [] }],
          description: 'Atomic creation plus first admission/message/job/outbox. Server-owned actor and Profile version; all scopes revalidated even on retry. Same actor/key/command recovers the original investigation and Session. No executor registered by this API.',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.InvestigationCreateRequest) } } },
          responses: { '202': { description: 'Durably accepted', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InvestigationAccepted) } } },
            '400': { description: 'Invalid input or client authority field' }, '401': { description: 'Invalid JWT or service interactive token' },
            '404': { description: 'Not visible under all current scopes' }, '409': { description: 'Active Session or idempotency payload mismatch' },
            '422': { description: 'Profile subject unsupported' }, '503': { description: 'Rolled back; not accepted' } },
        },
        get: { operationId: 'listInvestigations', security: [{ bearerAuth: [] }],
          description: 'Items, nextCursor and authorizedCounts.total. Live authorization before count/limit. Cursor encodes an offset and filter hash; concurrent changes can shift pages. All responses private/no-store.',
          parameters: ['state','profile','resource','query','cursor','limit'].map(name => ({ name, in: 'query', schema: { type: 'string' }, description: name === 'resource' ? 'instance:id, server:id or network_device:id' : name === 'limit' ? '1 to 50; default 20' : undefined })),
          responses: { '200': { description: 'Authorized page' }, '400': { description: 'Invalid filters/cursor' }, '401': { description: 'JWT required' }, '503': { description: 'Store unavailable' } },
        },
      },
      '/api/investigations/{id}': {
        get: { operationId: 'getInvestigation', security: [{ bearerAuth: [] }], parameters: [investigationId()],
          description: 'Live all-scope metadata/context, persisted Run-derived state (queued/unknown distinct), latest V2 result and durable observation watermark. Admission is not a completed Run.',
          responses: { '200': { description: 'Authorized metadata' }, '404': { description: 'Absent or inaccessible' }, '401': { description: 'JWT required' }, '503': { description: 'Store unavailable' } } },
        patch: { operationId: 'patchInvestigation', security: [{ bearerAuth: [] }], parameters: [investigationId()],
          description: 'Operator, live all-scope authority and expectedVersion required. Active request prevents goal/lifecycle change. Immutable scopes/Profile/context; human recovery/verification fields belong to the feedback module.',
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.InvestigationPatchRequest) } } },
          responses: { '200': { description: 'Persisted updated metadata/version' }, '400': { description: 'Invalid patch' }, '403': { description: 'Visible viewer cannot operate' }, '404': { description: 'Absent or inaccessible' }, '409': { description: 'Version/active request conflict' }, '503': { description: 'Rolled back' } } },
      },
      '/api/investigations/{id}/runs': { post: { operationId: 'admitInvestigationRequest', security: [{ bearerAuth: [] }], parameters: [investigationId(), { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
        requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.InvestigationRequest) } } },
        responses: { '202': { description: 'Durable request; no fabricated Run', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InvestigationAccepted) } } }, '403': { description: 'Viewer cannot append' }, '404': { description: 'Absent or inaccessible' }, '409': { description: 'Version, payload or active request conflict' }, '503': { description: 'Rolled back; no message/job/outbox orphan' } } } },
      '/api/investigations/{id}/messages': { get: { operationId: 'getInvestigationMessages', security: [{ bearerAuth: [] }], parameters: [investigationId(), { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }],
        responses: { '200': { description: 'Authorized chronological messages from the existing Session' }, '404': { description: 'Absent or any required scope missing' } } } },
      '/api/investigations/{id}/events': { get: { operationId: 'replayInvestigationEvents', security: [{ bearerAuth: [] }], parameters: [investigationId(),
        { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }],
        description: 'Durable per-investigation sequence, no-store and current all-scope authorization. Expired/future cursor returns replay_required; reconnect with investigation.watch receives a snapshot watermark plus its live suffix. Disconnect never cancels Run.',
        responses: { '200': { description: 'Authorized replay or replay_required', content: { 'application/json': { schema: refSchema(InvestigationObservationSchemas.InvestigationReplay) } } }, '400': { description: 'Invalid cursor/limit' }, '404': { description: 'Absent or inaccessible' } } } },
      '/api/investigations/{id}/facts': { get: { operationId: 'getInvestigationCanonicalFacts', security: [{ bearerAuth: [] }], parameters: [investigationId(),
        { name: 'before', in: 'query', schema: { type: 'string', pattern: '^\\d+:\\d+:\\d+$' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }],
        description: 'Authorized canonical Parts page in original turn/ordinal order, including tool facts. documents/nextBefore reuse the existing CanonicalStore cursor. Display data excludes reasoning and exact legacy rollback payloads; text/tool previews are bounded. Watch snapshots may be truncated and refer to this paginated history for older details; evidence raw data uses its own authorized endpoint.',
        responses: { '200': { description: 'Authorized canonical Parts page' }, '400': { description: 'Invalid cursor/limit' }, '404': { description: 'Absent or inaccessible' } } } },
      '/api/investigations/{id}/evidence/{eid}': { get: { operationId: 'getInvestigationEvidence', security: [{ bearerAuth: [] }], parameters: [investigationId(),
        { name: 'eid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'raw', in: 'query', schema: { const: 'true' } }],
        description: 'Investigation/original request/Run bound redacted evidence. Missing observation windows are null. Default response retains metadata/hash/tombstone; raw=true reauthorizes all resource scopes and returns redacted raw data only before seven-day retention. Expired raw returns 410 after authorization; invisible evidence always 404.',
        responses: { '200': { description: 'Evidence or tombstone', content: { 'application/json': { schema: refSchema(InvestigationObservationSchemas.InvestigationEvidence) } } }, '404': { description: 'Absent or inaccessible' }, '410': { description: 'Authorized raw snapshot expired' } } } },
      '/api/investigations/{id}/feedback': {
        get: { operationId: 'listInvestigationFeedback', security: [{ bearerAuth: [] }], parameters: [investigationId(),
          { name: 'before', in: 'query', schema: { type: 'integer', minimum: 1 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }],
          responses: { '200': { description: 'Version-bound human feedback with expired reference tombstones', content: { 'application/json': { schema: refSchema(InvestigationFeedbackSchemas.InvestigationFeedbackPage) } } },
            '400': { description: 'Invalid query' }, '401': { description: 'JWT required' }, '404': { description: 'Absent or live authority withdrawn' }, '503': { description: 'Store unavailable' } } },
        post: { operationId: 'recordInvestigationFeedback', security: [{ bearerAuth: [] }], parameters: [investigationId(),
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }],
          description: 'Human operator only, live all-resource authorization and expected investigation/result versions. Root cause and business recovery are independent; resolved requires current bounded recovery evidence. Negative feedback never publishes trusted knowledge.',
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(InvestigationFeedbackSchemas.InvestigationFeedbackRequest) } } },
          responses: { '200': { description: 'Atomic audit/state/stream record, or authorized idempotent replay', content: { 'application/json': { schema: refSchema(InvestigationFeedbackSchemas.InvestigationFeedbackRecord) } } },
            '400': { description: 'Invalid command or missing evidence' }, '401': { description: 'JWT required' }, '403': { description: 'Operator required' }, '404': { description: 'Absent or inaccessible' },
            '409': { description: 'Stale result/version, active request or idempotency conflict' }, '410': { description: 'Evidence expired' }, '503': { description: 'Transaction rolled back' } } },
      },
      '/api/investigations/{id}/results': { get: { operationId: 'listInvestigationResults', security: [{ bearerAuth: [] }], parameters: [investigationId(),
        { name: 'before', in: 'query', schema: { type: 'integer', minimum: 1 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }],
        description: 'Immutable V2 result versions. Every supporting/contradicting reference is bound to the original investigation/request/Run and reauthorized. Expired references retain tombstones and never become new proof. Machine results cannot assert human/experimental verification or resolved. Execution summaries do not expose unbounded reasoning or confidence as accuracy.',
        responses: { '200': { description: 'Authorized version page', content: { 'application/json': { schema: refSchema(InvestigationObservationSchemas.InvestigationResultPage) } } }, '404': { description: 'Absent or evidence/derived conclusion inaccessible' } } } },
      '/api/investigations/{id}/requests/{requestId}/cancel': { post: { operationId: 'cancelInvestigationRequest', security: [{ bearerAuth: [] }], parameters: [investigationId(), { name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        description: 'Real-time operator/all-scope authorization. Atomically records cancellation intent. Unclaimed queued/retry job becomes cancelled and releases active admission. Running owner retains active admission; T04 consumes intent and owns Run termination.',
        responses: { '202': { description: 'Intent persisted, repeat safe' }, '403': { description: 'Viewer cannot cancel' }, '404': { description: 'Request or investigation inaccessible' }, '503': { description: 'Rolled back' } } } },
      '/api/platform/observations': { get: {
        operationId: 'getPlatformObservations', security: [{ bearerAuth: [] }],
        description: 'Requires config:view, config:* or *. Queue gauges are a current MySQL snapshot (not restricted by the log time window), capped at 100 job types. Logs are process-local, retained for one hour with at most 10000 events and 100 groups: queue lifecycle groups include jobType, count, durationMs (sum), durationSamples and maxDurationMs. job.wait is overdue time from max(created_at, available_at) at claim, including reclaimed jobs; job.executed is handler elapsed time and terminal events include settlement time. Retry scheduling delays are excluded. Missing logs, omitted groups and unavailable queue stores are explicit gaps, never zero backlog or a throughput SLA. Ready follows claim eligibility including ANALYSIS_DISPATCH_ENABLED; queued/retry include scheduled and disabled jobs. No payloads, handler error text or credentials.',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'component', in: 'query', schema: { type: 'string', maxLength: 128 } },
        ],
        responses: {
          '200': { description: 'Observation evidence; inspect quality and gaps', content: { 'application/json': { schema: refSchema(PublicApiSchemas.PlatformObservations) } } },
          '400': { description: 'Invalid log time window or component filter' },
          '401': { description: 'Authentication required' }, '403': { description: 'Observation permission denied' },
        },
      } },
      '/api/platform/system-events': { get: { operationId: 'listSystemEvents', security: [{ bearerAuth: [] }],
        description: 'Live chat:view and config:view required. At most 100 durable System events, including suppressed engine failures. Investigation links require the original ACL; no implicit service sharing.',
        responses: { '200': { description: 'Durable System event summaries', content: { 'application/json': { schema: refSchema(SystemHttpSchemas.SystemEventsPage) } } },
          '401': { description: 'Authentication required' }, '404': { description: 'No authorized System scope' }, '503': { description: 'Store unavailable' } } } },
      '/api/platform/system-events/{id}': { get: { operationId: 'getSystemEvent', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        description: 'Live System scope required. Returns immutable body-free original fact and hash; never request/job/model payloads.',
        responses: { '200': { description: 'Original System event fact', content: { 'application/json': { schema: refSchema(SystemHttpSchemas.SystemEventDetail) } } },
          '401': { description: 'Authentication required' }, '404': { description: 'Absent or unauthorized' }, '503': { description: 'Store unavailable' } } } },
      '/api/database/instances/{id}': { delete: {
        operationId: 'removeDatabaseInstance', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
        description: 'Requires instance:delete and instance admin access. Commits deletion intent before stopping tasks and closing connections. Retains an ID tombstone and historical data; never nulls task targets. Repeat DELETE retries incomplete cleanup. History endpoints retain their response shape and expose X-Instance-Lifecycle-State.',
        responses: {
          '200': { description: 'All cleanup settled; tombstone committed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceRemovalResponse) } } },
          '400': { description: 'Invalid instance ID' }, '401': { description: 'Authentication required' },
          '403': { description: 'Permission or instance admin access denied' }, '404': { description: 'Instance absent' },
          '409': { description: 'Access revoked; cleanup incomplete. Retry DELETE; never reconnect automatically.', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceRemovalResponse) } } },
          '503': { description: 'Cleanup runtime or durable intent store unavailable' },
        },
      } },
      '/api/ai/analysis/{id}/evidence': { get: { operationId: 'getAnalysisEvidenceSnapshot', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
        description: 'Returns the frozen, redacted snapshot used by this analysis, never live metrics. Requires ai:view, the original actor, unchanged current permission scope and current subject access. Snapshot retention follows the analysis record; no automatic TTL purge or historical backfill.',
        responses: { '200': { description: 'Frozen evidence snapshot', content: { 'application/json': { schema: refSchema(PublicApiSchemas.AnalysisEvidenceSnapshot) } } }, '404': { description: 'Snapshot absent, legacy, or outside the current authorization scope' } },
      } },
      '/api/health/ready': { get: { operationId: 'getInfrastructureReadiness', security: [],
        description: 'D1 infrastructure probe. Ready only after this instance owns the worker lease, completes initialization, and can access the control database and dispatch schema. A standby never auto-promotes. Detailed /api/health/readiness still requires JWT and config:view.',
        responses: {
          '200': { description: 'Declared worker role ready', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InfrastructureReadiness) } } },
          '503': { description: 'Starting, standby, dependency unavailable or lease lost', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InfrastructureReadiness) } } },
        },
      } },
      '/api/cron/jobs/{id}': {
        get: { operationId: 'getCronJob', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: {
          '200': { description: 'Job configuration including persisted identity and resource ceiling. owner-required tasks stay paused until admin rebinding.', content: { 'application/json': { schema: refSchema(PublicApiSchemas.CronJobIdentity) } } },
          '404': { description: 'Job absent or inaccessible' },
        } },
        put: { operationId: 'updateCronJob', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          description: 'Requires cron:manage and current target access. owner_user_id is admin-only; principal_type, handler_key, resource_scope and identity fields are server-owned. Maintenance handlers cannot be replaced by arbitrary descriptions or Agent tasks. Rebinding retains the paused state; enable explicitly after review.',
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.CronJobUpdateRequest) } } },
          responses: { '200': { description: 'Updated' }, '400': { description: 'Invalid binding or server-owned authority supplied' }, '403': { description: 'Current target or owner rebinding permission denied' }, '404': { description: 'Job absent or inaccessible' } },
        },
      },
      '/api/cron/jobs/{id}/run': {
        post: { operationId: 'runCronJob', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 } }],
          description: 'Accepts a durable asynchronous run, not business completion. Idempotency-Key binds actor, job and parameters; reuse after dropped response. Old clients must upgrade with this release. Execution revalidates trigger and owner. Executes with current owner permissions intersected with persisted resources; manual administrator triggers cannot elevate the task. Durable run/tool audit must succeed before execution.',
          responses: { '202': { description: 'Run accepted; poll its runId for business outcome', content: { 'application/json': { schema: refSchema(PublicApiSchemas.CronRunAccepted) } } }, '409': { description: 'Idempotency key reused with different parameters' }, '400': { description: 'Task unbound, target changed/deleted, or invalid capability' }, '403': { description: 'Current owner or trigger authorization denied' }, '404': { description: 'Job absent or inaccessible' }, '500': { description: 'Execution or database failure' }, '503': { description: 'Execution authority, durable audit or workflow runtime unavailable' } },
        },
      },
      '/api/cron/jobs/{id}/runs/{runId}': {
        get: { operationId: 'getCronRun', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          description: 'Requires current job and target access. runnerFinishedAt and completedAt are separate. unknown means no verified completion; never automatically retry.',
          responses: { '200': { description: 'Exact run business state', content: { 'application/json': { schema: refSchema(PublicApiSchemas.CronRun) } } }, '404': { description: 'Run/job absent or inaccessible' } },
        },
      },
      '/api/cron/jobs/{id}/runs': {
        get: { operationId: 'findCronRequest', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'requestKey', in: 'query', required: true, schema: { type: 'string', maxLength: 200 } }],
          description: 'Recovers the authenticated actor own request after a dropped POST response; no execution is triggered.',
          responses: { '200': { description: 'Original run', content: { 'application/json': { schema: refSchema(PublicApiSchemas.CronRun) } } }, '404': { description: 'Request absent or job inaccessible' } },
        },
      },
      '/api/health': { get: { operationId: 'getHealth', responses: { '200': { description: 'Service health', content: { 'application/json': { schema: refSchema(PublicApiSchemas.HealthResponse) } } } } } },
      ...Object.fromEntries([
        ['investigate', 'startEventInvestigation', undefined, 'Only open events can enter investigation.'],
        ['resolve', 'resolveEvent', PublicApiSchemas.EventResolveRequest, 'Only open/investigating/handled events can resolve. Event, log and currently associated active alerts commit together.'],
        ['verify-recovery', 'confirmEventRecovery', PublicApiSchemas.EventRecoveryConfirmationRequest, 'First manual recovery confirmation on a resolved event records authenticated actor, time and basis. It is not an automatic metric observation-window verification.'],
        ['close', 'closeEvent', undefined, 'Requires resolved state and recorded recovery confirmation; legacy verification_* records remain readable.'],
      ].map(([action, operationId, schema, description]) => [`/api/alerts/events/{id}/${action}`, { post: {
        operationId, security: [{ bearerAuth: [] }], parameters: [pathId('id')],
        description: `${description} Requires alert:manage and current instance read-write access. Duplicate/late/conflicting requests return 409 and cannot overwrite the first audit. Writes and audit use one locked transaction.`,
        ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: refSchema(schema as TSchema) } } } } : {}),
        responses: {
          '200': { description: 'Transition committed with authenticated actor audit', content: { 'application/json': { schema: refSchema(PublicApiSchemas.EventTransitionResult) } } },
          '400': { description: 'Invalid input or manual basis; reason must be a nonblank string of at most 1024 characters' },
          '401': { description: 'Authentication required' }, '403': { description: 'Permission or instance access denied' },
          '409': { description: 'Invalid state, repeat, conflict or uncommitted transition; refresh event/logs before retry', content: { 'application/json': { schema: refSchema(PublicApiSchemas.EventTransitionResult) } } },
          '500': { description: 'Unexpected route failure' },
        },
      } }])),
      ...Object.fromEntries([
        ['/api/llm/test', 'testLLMConnection', PublicApiSchemas.LLMConnectionTestRequest],
        ['/api/llm/models', 'discoverLLMModels', PublicApiSchemas.LLMModelDiscoveryRequest],
      ].map(([path, operationId, schema]) => [path, { post: {
        operationId, security: [{ bearerAuth: [] }],
        description: 'Requires llm:manage. Saved credentials are bound to the configured origin and exact proxy base path. Update the saved provider configuration or supply an explicit draft key to change destinations. Redirects are rejected. Limit: 10 requests/minute; connection probes use at most 50 output tokens and no SDK retries.',
        requestBody: { required: true, content: { 'application/json': { schema: refSchema(schema as TSchema) } } },
        responses: {
          '200': { description: 'Connection result or discovered model list' },
          '400': { description: 'Invalid input, URL, or missing credential' },
          '401': { description: 'Authentication required' },
          '403': { description: 'llm:manage required or saved credential destination mismatch' },
          '404': { description: 'Saved provider not found (connection test)' },
          '409': { description: 'Saved configuration changed during credential resolution; retry with current configuration' },
          '413': { description: 'Request body exceeds 16384 bytes' },
          '429': { description: 'Expensive operation rate limit exceeded' },
          '502': { description: 'Model discovery upstream failure; no upstream body returned' },
          '503': { description: 'Configuration unavailable' },
        },
      } } ])),
      '/api/resources': {
        get: { operationId: 'listResources', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Permission-filtered infrastructure resources', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceListResponse) } } } } },
      },
      '/api/resources/overview': {
        get: { operationId: 'getResourceOverview', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Cross-resource state, freshness, alerts and impact scope', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceOverviewResponse) } } } } },
      },
      '/api/resources/metrics/summary': {
        get: { operationId: 'getResourceMetricsSummary', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Permission-filtered latest metric aggregates by resource type', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceMetricsSummaryResponse) } } } } },
      },
      '/api/resources/{type}/{id}/observations': {
        get: { operationId: 'getResourceObservations', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['instance', 'server', 'network_device'] } }, { name: 'metricIds', in: 'query', required: false, schema: { type: 'string' } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { '200': { description: 'Latest resource observations', content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
      '/api/resources/{type}/{id}/diagnose': {
        post: { operationId: 'diagnoseResource', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['instance', 'server', 'network_device'] } }], responses: { '200': { description: 'Bounded cross-resource evidence pack', content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
      '/api/resources/{type}/{id}/diagnose-agent': {
        post: { operationId: 'diagnoseResourceWithAgent', requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { retryOf: { type: 'integer', minimum: 1 }, confirmUnknownRetry: { type: 'boolean' } }, dependentRequired: { retryOf: ['confirmUnknownRetry'] } } } } }, security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'type', in: 'path', required: true, schema: { type: 'string', enum: ['instance', 'server', 'network_device'] } }], responses: { '409': { description: 'Provider result unknown; explicit confirmation required before a potentially billable retry', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceAgentDiagnosisResponse) } } }, '202': { description: 'Read-only Agent diagnosis queued', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceAgentDiagnosisResponse) } } }, '200': { description: 'Cached diagnosis reused', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ResourceAgentDiagnosisResponse) } } }, '403': { description: 'AI diagnosis permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/adapters/capabilities': { get: { operationId: 'getAdapterCapabilities', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Database adapter capabilities', content: { 'application/json': { schema: refSchema(PublicApiSchemas.AdapterCapabilitiesResponse) } } } } } },
      '/api/database/instances': { get: { operationId: 'listDatabaseInstances', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Redacted managed database instances', content: { 'application/json': { schema: refSchema(PublicApiSchemas.DatabaseInstancesResponse) } } } } } },
      '/api/network-devices': {
        get: { operationId: 'listNetworkDevices', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Redacted managed network devices', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevicesResponse) } } } } },
        post: { operationId: 'createNetworkDevice', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Network device created', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
      },
      '/api/network-devices/test-connection': {
        post: {
          operationId: 'testNetworkDeviceConnection', security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceTestConnectionRequest) } } },
          responses: {
            '200': { description: 'Validated read-only SNMP probe or command-free SSH handshake result', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceTestConnectionResponse) } } },
            '400': { description: 'Invalid or unsupported SNMP payload', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device manage permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '502': { description: 'Probe failed or target was denied', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}': {
        get: { operationId: 'getNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Redacted network device', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
        put: { operationId: 'updateNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device updated', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDevice) } } } } },
        delete: { operationId: 'deleteNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device deleted', content: { 'application/json': { schema: refSchema(PublicApiSchemas.OkResponse) } } } } },
      },
      '/api/network-devices/{id}/backup-schedule': {
        get: { operationId: 'getConfigBackupSchedule', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: {
          '200': { description: 'Daily backup schedule in Beijing time; requires network_devices:view', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupSchedule) } } },
        } },
        put: { operationId: 'updateConfigBackupSchedule', security: [{ bearerAuth: [] }], parameters: [pathId('id')], requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupScheduleInput) } } }, responses: {
          '200': { description: 'Saved schedule; requires network_devices:backup', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupSchedule) } } },
          '400': { description: 'Invalid schedule', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          '403': { description: 'Backup permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
        } },
      },
      '/api/network-devices/{id}/probe': {
        post: {
          operationId: 'probeNetworkDevice', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Collected read-only device observations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceProbeResponse) } } },
            '400': { description: 'Invalid resource identifier or collection request', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Network device unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '502': { description: 'Collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}/capabilities': {
        get: {
          operationId: 'getNetworkDeviceCapabilities', security: [{ bearerAuth: [] }], parameters: [pathId('id'), { name: 'key', in: 'query', required: false, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Capability state and bounded evidence', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceCapabilitiesResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Capability lookup failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/network-devices/{id}/metrics': { get: { operationId: 'getNetworkDeviceMetrics', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device observations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceMetricsResponse) } } } } } },
      '/api/network-devices/{id}/interfaces': { get: { operationId: 'listNetworkDeviceInterfaces', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Network device interfaces', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceInterfacesResponse) } } } } } },
      '/api/network-devices/{id}/config-backups': {
        get: { operationId: 'listNetworkDeviceConfigBackups', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Configuration backup summaries without raw content', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupSummariesResponse) } } } } },
        post: { operationId: 'captureNetworkDeviceConfigBackup', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '201': { description: 'New immutable configuration backup summary and redacted preview', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupDetail) } } }, '400': { description: 'Invalid backup request', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device backup permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '502': { description: 'Backup collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/config-backups/{backupId}': {
        get: { operationId: 'getNetworkDeviceConfigBackup', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('backupId'), { name: 'raw', in: 'query', required: false, schema: { type: 'boolean', default: false } }], responses: { '200': { description: 'Redacted backup detail by default; raw content only with backup permission', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupResponse) } } }, '400': { description: 'Invalid backup identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Raw backup permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '404': { description: 'Backup unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/config-backups/{backupId}/diff': {
        get: { operationId: 'diffNetworkDeviceConfigBackups', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('backupId'), { name: 'from', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }], responses: { '200': { description: 'Bounded redacted configuration diff', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ConfigBackupDiffResponse) } } }, '400': { description: 'Invalid diff identifiers', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '404': { description: 'Backup unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/network-devices/{id}/relations': {
        get: { operationId: 'listNetworkDeviceRelations', security: [{ bearerAuth: [] }], parameters: [pathId('id')], responses: { '200': { description: 'Visible active resource relations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsResponse) } } }, '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
        put: { operationId: 'replaceNetworkDeviceRelations', security: [{ bearerAuth: [] }], parameters: [pathId('id')], requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsRequest) } } }, responses: { '200': { description: 'Created active network-device relations', content: { 'application/json': { schema: refSchema(PublicApiSchemas.NetworkDeviceRelationsResponse) } } }, '400': { description: 'Invalid relation payload', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } }, '403': { description: 'Network-device manage permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } } } },
      },
      '/api/database/instances/{id}/host-evidence': {
        get: {
          operationId: 'getInstanceHostEvidence', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Bounded and redacted database and Linux host evidence', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceHostEvidenceResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Instance view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Evidence collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/database/instances/{id}/hosts': {
        get: {
          operationId: 'listInstanceHosts', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Active Linux hosts related to the database instance', content: { 'application/json': { schema: refSchema(PublicApiSchemas.InstanceHostsResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
        put: {
          operationId: 'replaceInstanceHosts', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          requestBody: { required: true, content: { 'application/json': { schema: refSchema(PublicApiSchemas.ReplaceInstanceHostsBody) } } },
          responses: {
            '200': { description: 'Atomically replaced and enriched active host mappings', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ReplaceInstanceHostsResponse) } } },
            '400': { description: 'Invalid mapping payload or missing target server', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Instance unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/database/instances/{id}/hosts/{serverId}': {
        delete: {
          operationId: 'unlinkInstanceHost', security: [{ bearerAuth: [] }], parameters: [pathId('id'), pathId('serverId')],
          responses: {
            '200': { description: 'Expired active host mapping', content: { 'application/json': { schema: refSchema(PublicApiSchemas.OkResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Mapping unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/servers/{id}/instances': {
        get: {
          operationId: 'listServerInstances', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Database instances hosted by the server and visible to the actor', content: { 'application/json': { schema: refSchema(PublicApiSchemas.HostedInstancesResponse) } } },
            '400': { description: 'Invalid resource identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Server unavailable or unauthorized', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '500': { description: 'Relationship operation failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/servers/{id}/diagnostics': {
        get: {
          operationId: 'getServerDiagnostics', security: [{ bearerAuth: [] }], parameters: [
            pathId('id'),
            { name: 'refresh', in: 'query', required: false, schema: { type: 'boolean', default: false } },
          ],
          responses: {
            '200': { description: 'Fixed-profile read-only server diagnostics', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ServerDiagnostics) } } },
            '400': { description: 'Invalid server identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Server view permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Server unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '422': { description: 'Server operating-system profile unsupported', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '503': { description: 'Diagnostics unavailable or stale evidence returned by a later read', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
      '/api/servers/{id}/collect-diagnostics': {
        post: {
          operationId: 'collectServerDiagnostics', security: [{ bearerAuth: [] }], parameters: [pathId('id')],
          responses: {
            '200': { description: 'Collected fixed-profile server diagnostics', content: { 'application/json': { schema: refSchema(PublicApiSchemas.CollectServerDiagnosticsResponse) } } },
            '400': { description: 'Invalid server identifier', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '401': { description: 'Authentication required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '403': { description: 'Server manage permission required', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '404': { description: 'Server unavailable', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '422': { description: 'Server operating-system profile unsupported', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
            '503': { description: 'Diagnostics collection failed', content: { 'application/json': { schema: refSchema(PublicApiSchemas.ErrorResponse) } } },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { ...PublicApiSchemas, ...metricJsonSchemas, ...operationsJsonSchemas },
    },
  });
}

function buildLegacyClientTypes(): string {
  return `// Generated by pnpm contracts:generate. Do not edit.\n\nexport type DatabaseType = 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';\nexport type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';\nexport type AdapterCapabilityName = 'connect' | 'query' | 'explain' | 'metrics' | 'health' | 'alerts' | 'reports' | 'writeApproval';\nexport type InstanceHostRole = 'standalone' | 'primary' | 'replica' | 'shard' | 'arbiter' | 'unknown';\nexport type EvidenceQuality = 'good' | 'partial' | 'unknown' | 'unsupported';\nexport type HostEvidenceSection = 'metrics' | 'filesystems' | 'systemLogs' | 'physicalFiles';\nexport type DiagnosticGapScope = 'instance' | 'host' | 'storage';\nexport type DiagnosticGapSection = 'instance' | 'realtime' | 'history' | 'alerts' | 'logs' | 'slowQueries' | 'storage' | 'relations' | 'hostEvidence' | 'evidencePack';\n\nexport interface HealthResponse {\n  status: 'ok';\n  timestamp: string;\n}\n\nexport interface AdapterCapability {\n  dbType: DatabaseType;\n  driver: string | null;\n  state: CapabilityState;\n  creatable: boolean;\n  capabilities: Partial<Record<AdapterCapabilityName, CapabilityState>>;\n  reason?: string;\n}\n\nexport interface AdapterCapabilitiesResponse {\n  adapters: AdapterCapability[];\n}\n\nexport interface DatabaseInstance {\n  id: number;\n  name: string;\n  db_type: DatabaseType;\n  db_version?: string | null;\n  data_size_gb?: number | null;\n  host: string;\n  port: number;\n  database_name: string;\n  username?: string | null;\n  health_status: 'healthy' | 'warning' | 'critical' | 'unknown';\n  health_score: number;\n  status: string;\n  created_at: string;\n  environment?: string | null;\n  description?: string | null;\n  hasCredential: boolean;\n  credentialVersion: number;\n  lifecycle_state?: 'available' | 'deleting' | 'deleted';\n  removal_requested_at?: string | null;\n  removed_at?: string | null;\n  removal_reasons?: string[] | null;\n  [key: string]: unknown;\n}\n\nexport interface InstanceRemovalResponse {\n  message?: string;\n  error?: string;\n  lifecycle_state: 'deleting' | 'deleted';\n  reasons?: string[];\n}\n\nexport type DatabaseInstancesResponse = DatabaseInstance[];\n\nexport interface InstanceHostMapping {\n  serverId: number;\n  role: InstanceHostRole;\n  notes?: string | null;\n}\n\nexport interface InstanceHost extends InstanceHostMapping {\n  host: string;\n  port: number;\n  label: string | null;\n  osType: string;\n  status: string;\n  collectionEnabled: boolean;\n  validFrom: string;\n}\n\nexport interface HostedInstance extends InstanceHostMapping {\n  instanceId: number;\n  name: string;\n  dbType: DatabaseType;\n  environment: string;\n  status: string;\n  healthStatus: string;\n  validFrom: string;\n}\n\nexport interface ReplaceInstanceHostsRequest {\n  hosts: InstanceHostMapping[];\n}\n\nexport interface InstanceHostsResponse {\n  hosts: InstanceHost[];\n}\n\nexport interface ReplaceInstanceHostsResponse extends InstanceHostsResponse {\n  ok: true;\n}\n\nexport interface HostedInstancesResponse {\n  instances: HostedInstance[];\n}\n\nexport interface EvidenceSection {\n  source: string[];\n  collectedAt: string;\n  quality: EvidenceQuality;\n  reason?: string;\n}\n\nexport interface FilesystemEvidence {\n  mount: string;\n  device: string;\n  fsType: string | null;\n  sizeBytes: number;\n  usedBytes: number;\n  availableBytes: number;\n  usagePercent: number;\n  inodeTotal: number | null;\n  inodeUsed: number | null;\n  inodeAvailable: number | null;\n  inodeUsagePercent: number | null;\n}\n\nexport interface JournalEvidence {\n  timestamp: string | null;\n  severity: string;\n  unit: string | null;\n  identifier: string | null;\n  pid: string | null;\n  message: string;\n}\n\nexport interface PhysicalFileEvidence {\n  path: string;\n  quality: EvidenceQuality;\n  reason?: string;\n  type?: string;\n  sizeBytes?: number;\n  allocatedBytes?: number;\n  modifiedAt?: string;\n  mode?: string;\n  owner?: string;\n  group?: string;\n  filesystem?: FilesystemEvidence;\n}\n\nexport interface HostEvidenceGap {\n  section: HostEvidenceSection;\n  reason: string;\n}\n\nexport interface LinuxHostEvidence {\n  schemaVersion: 1;\n  serverId: number;\n  collectedAt: string;\n  expiresAt: string;\n  quality: EvidenceQuality;\n  truncated: boolean;\n  metrics: EvidenceSection & { values: Record<string, number> };\n  filesystems: EvidenceSection & { items: FilesystemEvidence[] };\n  systemLogs: EvidenceSection & { entries: JournalEvidence[] };\n  physicalFiles: EvidenceSection & { items: PhysicalFileEvidence[] };\n  gaps: HostEvidenceGap[];\n}\n\nexport interface StorageDescriptor {\n  path: string;\n  kind: string;\n  source: string;\n  hostInspectable: boolean;\n  tablespace?: string;\n  objectName?: string;\n  logicalBytes?: number;\n}\n\nexport interface DiagnosticGap {\n  scope: DiagnosticGapScope;\n  section?: DiagnosticGapSection;\n  code: string;\n  resource?: { type: 'instance' | 'server'; id: number };\n  source?: string;\n}\n\nexport interface InstanceHostEvidenceResponse {\n  schemaVersion: 1;\n  subject: { type: 'instance'; id: number };\n  collectedAt: string;\n  database: {\n    instance: Record<string, unknown> | null;\n    realtimeMetrics: Record<string, unknown> | null;\n    metricHistory: Array<Record<string, unknown>>;\n    alerts: Array<Record<string, unknown>>;\n    logs: Array<Record<string, unknown>>;\n    slowQueries: Array<Record<string, unknown>>;\n  };\n  storage: StorageDescriptor[];\n  hosts: Array<{ server: InstanceHost; evidence: LinuxHostEvidence | null }>;\n  gaps: DiagnosticGap[];\n}\n`;
}

const NETWORK_CLIENT_TYPES = `export type NetworkDeviceStatus = 'unknown' | 'online' | 'offline' | 'error' | 'unreachable';
export type NetworkDeviceVendor = 'huawei' | 'cisco';
export interface NetworkDevice { id: number; name: string; label: string | null; host: string; site: string | null; vendor: NetworkDeviceVendor; model: string | null; os_version: string | null; serial_number: string | null; snmp_port: number; ssh_port: number; status: NetworkDeviceStatus; last_check_at: string | null; collection_enabled: boolean; created_at: string; updated_at: string; hasSnmpCredential: boolean; hasSshCredential: boolean; }
export type NetworkDevicesResponse = NetworkDevice[];
export type NetworkDeviceSnmpSecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
export interface NetworkDeviceSnmpCredential { username: string; securityLevel: NetworkDeviceSnmpSecurityLevel; authProtocol?: 'MD5' | 'SHA'; authSecret?: string; privacyProtocol?: 'DES' | 'AES'; privacySecret?: string; }
export interface NetworkDeviceSnmpV2Credential { version?: 2; community: string; }
export interface NetworkDeviceSshCredential { credentialType: 'password' | 'key'; username: string; credentialValue: string; hostKeyFingerprint?: string; }
export interface NetworkDeviceTestConnectionRequest { host: string; mode?: 'snmp' | 'ssh'; version?: 2 | 3; snmpPort?: number; snmp_port?: number; sshPort?: number; ssh_port?: number; snmpv3?: NetworkDeviceSnmpCredential; snmpv2c?: NetworkDeviceSnmpV2Credential; snmpv2?: NetworkDeviceSnmpV2Credential; snmp?: NetworkDeviceSnmpCredential | NetworkDeviceSnmpV2Credential; ssh?: NetworkDeviceSshCredential; vendor?: NetworkDeviceVendor; }
export interface NetworkDeviceProbeResult { reachable: boolean; quality: string; reason?: string | null; observedAt: string; sysName?: string | null; uptimeSeconds?: number; }
export interface NetworkDeviceTestConnectionResponse { success: boolean; probe?: NetworkDeviceProbeResult; ssh?: { verified: boolean }; error?: string; }
export interface NetworkDeviceProbeResponse { success: boolean; observations?: number; interfaces?: number; error?: string; }
export interface NetworkDeviceMetric { metricId: string; value: number | null; observedAt: string | null; quality: string; source: string; dimensions?: Record<string, string> | null; }
export interface NetworkDeviceMetricsResponse { deviceId: number; metrics: NetworkDeviceMetric[]; }
export interface NetworkDeviceInterface { id: number; deviceId: number; ifIndex: number; ifName: string; ifAlias: string | null; speedBps: number | null; adminStatus: string; operStatus: string; lastSeenAt: string | null; }
export interface NetworkDeviceInterfacesResponse { interfaces: NetworkDeviceInterface[]; }
export interface NetworkDeviceCapability { key: string; state: CapabilityState; evidence: Record<string, unknown> | null; reason: string | null; checkedAt: string | null; validUntil: string | null; }
export interface NetworkDeviceCapabilitiesResponse { deviceId: number; capabilities: NetworkDeviceCapability[]; }
export interface ConfigBackupSummary { id: number; deviceId: number; versionNo: number; contentSha256: string; sourceProtocol: 'ssh'; collectedAt: string; sizeBytes: number; redactionStatus: 'redacted' | 'unredacted' | 'failed'; }
export interface ConfigBackupScheduleInput { enabled: boolean; dailyTime: string; }
export interface ConfigBackupSchedule extends ConfigBackupScheduleInput { timeZone: 'Asia/Shanghai'; lastRun: { date: string; status: 'running' | 'success' | 'failed'; errorCode: string | null } | null; }
export interface ConfigBackupDetail extends ConfigBackupSummary { preview: string; }
export interface ConfigBackupRaw extends ConfigBackupSummary { content: string; }
export type ConfigBackupResponse = ConfigBackupDetail | ConfigBackupRaw;
export interface ConfigBackupDiffResponse { fromId: number; toId: number; diff: string; }
export interface ConfigBackupSummariesResponse { backups: ConfigBackupSummary[]; }
export type NetworkResourceType = 'instance' | 'server' | 'network_device';
export interface NetworkResourceRef { type: NetworkResourceType; id: number; }
export type NetworkDeviceRelationType = 'runs_on' | 'hosts' | 'replicates_to' | 'depends_on' | 'connected_to' | 'serves';
export interface NetworkDeviceRelation { source: NetworkResourceRef; target: NetworkResourceRef; relationType: NetworkDeviceRelationType; provenance: string; metadata: Record<string, unknown> | null; validFrom: string; validUntil: string | null; }
export interface NetworkDeviceRelationInput { target: { type: 'server' | 'network_device'; id: number }; relationType: 'connected_to' | 'serves'; provenance?: string; metadata?: Record<string, unknown> | null; validFrom?: string; validUntil?: string | null; }
export interface NetworkDeviceRelationsRequest { relations: NetworkDeviceRelationInput[]; }
export interface NetworkDeviceRelationsResponse { relations: NetworkDeviceRelation[]; }

`;

const RESOURCE_CLIENT_TYPES = `export type ResourceType = 'instance' | 'server' | 'network_device';
export interface ResourceRef { type: ResourceType; id: number; }
export interface ResourceListItem { resource: ResourceRef; label: string; status: string; attributes: Record<string, string | number | boolean | null>; }
export interface ResourceListResponse { items: ResourceListItem[]; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; }
export interface ResourceOverviewItem { resource: ResourceRef; label: string; status: string; quality: 'good' | 'degraded' | 'invalid' | 'unknown' | 'partial'; freshness: 'fresh' | 'stale' | 'missing'; observedAt: string | null; unresolvedAlerts: number; relationCount: number; impactScope: ResourceRef[]; gaps: string[]; }
export interface ResourceOverviewResponse { schemaVersion: 1; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; summary: { total: number; byType: Record<ResourceType, number>; byStatus: Record<string, number>; fresh: number; stale: number; missing: number; unresolvedAlerts: number; impactedResources: number; }; items: ResourceOverviewItem[]; }
export interface ResourceMetricAggregate { value: number | null; resourceCount: number; observedAt: string | null; }
export interface ResourceMetricsSummaryResponse { schemaVersion: 1; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; scopes: Record<ResourceType, { metrics: Record<string, ResourceMetricAggregate> }>; }
export interface AnalysisEvidenceSnapshot { schemaVersion: 1; id: string; hash: string; collectedAt: string; subject: { type: 'instance' | 'server' | 'network_device'; id: number }; authorizationVersion: string; data: unknown; gaps: Array<{ code: string; scope?: string }> }
export interface ResourceAgentDiagnosisResponse { success: boolean; analysisId?: number; status?: 'queued' | 'cached' | 'unknown'; error?: string; }

`;

const SERVER_CLIENT_TYPES = `export type ServerDiagnosticQuality = 'good' | 'partial' | 'unknown' | 'unsupported';
export interface ServerDiagnosticServiceStatus { name: string; loadState: string; activeState: string; subState: string; description: string | null; }
export interface ServerDiagnosticListeningPort { protocol: 'tcp' | 'udp' | 'unknown'; address: string; port: number; process: string | null; }
export interface ServerDiagnosticProcessSample { pid: number; command: string; cpuPercent: number; memoryPercent: number; }
export interface ServerDiagnosticLogEntry { timestamp: string | null; severity: string; unit: string | null; identifier: string | null; message: string; }
export interface ServerInterfaceErrorSummary { interface: string; rxBytes: number; txBytes: number; rxErrors: number; txErrors: number; rxDrops: number; txDrops: number; }
export interface ServerDiagnosticSection<T> { source: string[]; collectedAt: string; expiresAt: string; validForMs: number; quality: ServerDiagnosticQuality; reason?: string; truncated: boolean; items: T[]; }
export interface ServerDiagnostics {
  schemaVersion: 1; serverId: number; osType: string; collectedAt: string; expiresAt: string; validForMs: number;
  quality: ServerDiagnosticQuality; truncated: boolean;
  sections: {
    services: ServerDiagnosticSection<ServerDiagnosticServiceStatus>;
    listeningPorts: ServerDiagnosticSection<ServerDiagnosticListeningPort>;
    topProcesses: ServerDiagnosticSection<ServerDiagnosticProcessSample>;
    systemLogs: ServerDiagnosticSection<ServerDiagnosticLogEntry>;
    interfaceErrors: ServerDiagnosticSection<ServerInterfaceErrorSummary>;
  };
  serviceStatus: ServerDiagnosticSection<ServerDiagnosticServiceStatus>;
  listeningPorts: ServerDiagnosticSection<ServerDiagnosticListeningPort>;
  topProcesses: ServerDiagnosticSection<ServerDiagnosticProcessSample>;
  recentSystemLogs: ServerDiagnosticSection<ServerDiagnosticLogEntry>;
  interfaceErrors: ServerDiagnosticSection<ServerInterfaceErrorSummary>;
  gaps: Array<{ section: string; reason: string }>;
}
export interface CollectServerDiagnosticsResponse { success: true; diagnostics: ServerDiagnostics; }

`;

// New contracts are rendered from the backend schemas, not hand-maintained
// string copies. Fail closed if the baseline starts using an unsupported kind.
function schemaType(schema: TSchema): string {
  if (schema[Kind] === 'Never') return 'never';
  if (schema['x-typescript-type'] === 'ProjectionFrame') return 'ProjectionFrame';
  if (schema[Kind] === 'Unknown') return 'unknown';
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map((type: string) => schemaType({ ...schema, type })).join(' | ');
  if (schema.oneOf) return `(${(schema.oneOf as TSchema[]).map(schemaType).join(' | ')})`;
  if (schema.anyOf) return `(${(schema.anyOf as TSchema[]).map(schemaType).join(' | ')})`;
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') return `Array<${schemaType(schema.items as TSchema)}>`;
  if (schema.type === 'object') {
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !schema.properties) {
      return `Record<string, ${schemaType(schema.additionalProperties as TSchema)}>`;
    }
    if (schema.patternProperties) {
      const values = Object.values(schema.patternProperties) as TSchema[];
      if (values.length !== 1) throw new Error('Unsupported investigation record schema');
      return `Record<string, ${schemaType(values[0])}>`;
    }
    const required = new Set(schema.required as string[] ?? []);
    return `{ ${Object.entries(schema.properties ?? {}).map(([key, value]) =>
      `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(value as TSchema)};`).join(' ')} }`;
  }
  if (Object.keys(schema).length === 0) return 'unknown';
  throw new Error('Unsupported investigation client schema');
}
function buildInvestigationClientTypes(): string {
  return '// Generated investigation contract baseline; routes are not implemented by these types.\n'
    + "import type { ProjectionFrame } from '../../../../packages/agent-core/src/message-projection.ts';\n\n"
    + Object.entries({ ...InvestigationSchemas, ...InvestigationHttpSchemas, ...InvestigationObservationSchemas, ...InvestigationProfileSchemas, ...InvestigationGovernanceSchemas, ...InvestigationBridgeSchemas, ...InvestigationFeedbackSchemas, ...SystemHttpSchemas }).map(([name, schema]) => `export type ${name} = ${schemaType(schema)};\n`).join('') + '\n';
}

export function buildClientTypes(): string {
  return Object.entries({ ...metricJsonSchemas, ...operationsJsonSchemas }).map(([name, schema]) => `export type ${name} = ${schemaType(schema as unknown as TSchema)};\n`).join('')
    + buildInvestigationClientTypes() + buildLegacyClientTypes()
    .replace('export interface HealthResponse {', `export interface QueueTypeObservation {
  jobType: string; queued: number; retry: number; scheduled: number; ready: number;
  running: number; deadLetter: number; expiredLeases: number; oldestReadyWaitMs: number | null;
}
export interface QueueObservation {
  schemaVersion: 1; generatedAt: string; persistence: 'mysql';
  quality: 'good' | 'degraded' | 'unknown'; types: QueueTypeObservation[]; gaps: string[];
}
export interface PlatformObservations {
  schemaVersion: 1; generatedAt: string; releaseId: string | null; commitSha: string | null;
  uptimeSeconds: number; components: unknown[]; logs: unknown; queue: QueueObservation;
}

export interface HealthResponse {`)
    .replace('export interface HealthResponse {', 'export interface EventResolveRequest { resolution_notes: string; }\nexport interface EventRecoveryConfirmationRequest { reason: string; }\nexport interface EventTransitionResult { success: boolean; error?: string; }\n\nexport interface HealthResponse {')
    .replace(
      "health_status: 'healthy' | 'warning' | 'critical' | 'unknown';",
      "health_status: 'healthy' | 'warning' | 'critical' | 'unknown' | 'error';",
    )
    .replace('export interface HealthResponse {', `${NETWORK_CLIENT_TYPES}export interface HealthResponse {`)
    .replace('export interface HealthResponse {', `${RESOURCE_CLIENT_TYPES}export interface HealthResponse {`)
    .replace('export interface HealthResponse {', `export type CronRunStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'unknown' | 'cancelled';
export interface CronRunAccepted { runId: string; jobId: number; status: CronRunStatus; message: string; }
export interface CronRun {
  runId: string; jobId: number; triggeredBy: number | null; status: CronRunStatus;
  queuedAt: string; startedAt: string | null; runnerFinishedAt: string | null; completedAt: string | null;
  completion: Record<string, unknown> | null; outputSchema: Record<string, unknown> | null;
  logId: number | null; errorCode: string | null;
}
export interface CronJobIdentity {
  owner_user_id: number | null;
  principal_type: 'user' | 'system-maintenance';
  identity_status: 'bound' | 'owner-required';
  identity_audit: Record<string, unknown> | null;
  resource_scope: { version: 1; targetInstanceId: number | null; instanceIds: number[]; serverIds: number[]; networkDeviceIds: number[] } | null;
  [key: string]: unknown;
}
export interface CronJobUpdateRequest {
  owner_user_id?: number; task_description?: string; cron_expr?: string; enabled?: boolean;
  task_type?: 'agent' | 'script'; target_instance_id?: number | null; script_id?: number;
  control_sql_capability?: 'read-only' | 'baseline-cleanup-v1' | 'silence-cleanup-v1';
  timezone?: string; description?: string; timeout_seconds?: number; retry_count?: number;
}

export interface HealthResponse {`)
    .replace('export interface HealthResponse {', `export interface LLMConnectionTestRequest { providerName: string; apiKey?: string; baseURL?: string; model?: string; apiFormat?: string; deploymentType?: string; }\nexport interface LLMModelDiscoveryRequest extends Omit<LLMConnectionTestRequest, 'model' | 'baseURL'> { baseURL: string; providerType?: 'deepseek' | 'stepfun' | 'mimo'; }\n\nexport interface HealthResponse {`)
    .replace('export interface HealthResponse {', 'export interface InfrastructureReadiness { ready: boolean; }\n\nexport interface HealthResponse {')
    .replace('export interface EvidenceSection {', `${SERVER_CLIENT_TYPES}export interface EvidenceSection {`)
    // Extend only the legacy diagnostic gap reference. Network relation types
    // are already emitted by NETWORK_CLIENT_TYPES and must not be rewritten.
    .replace(
      "resource?: { type: 'instance' | 'server'; id: number }",
      "resource?: { type: 'instance' | 'server' | 'network_device'; id: number }",
    );
}

export async function generatePublicApi(): Promise<void> {
  await Promise.all([mkdir(dirname(openApiPath), { recursive: true }), mkdir(dirname(clientPath), { recursive: true })]);
  await Promise.all([
    writeFile(openApiPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`),
    writeFile(clientPath, buildClientTypes()),
  ]);
}

export async function checkPublicApi(): Promise<boolean> {
  const expectedOpenApi = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  const expectedClient = buildClientTypes();
  const [actualOpenApi, actualClient] = await Promise.all([readFile(openApiPath, 'utf8'), readFile(clientPath, 'utf8')]);
  return actualOpenApi === expectedOpenApi && actualClient === expectedClient;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  if (check) {
    const current = await checkPublicApi().catch(() => false);
    if (!current) {
      console.error('Generated API contracts are stale. Run pnpm contracts:generate.');
      process.exitCode = 1;
    }
  } else {
    await generatePublicApi();
  }
}
