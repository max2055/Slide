import { allocationHash, readExecutionAllocation, taskExecutionConfiguration, type FrozenExecutionAllocation, type TaskExecutionConfiguration } from './execution-allocation.js';
import {acknowledgeSummary, parseSummaryJson, summaryRejection, responseHash as canonicalReceiptHash} from '@slide/agent-core';
import { createHash, randomUUID } from 'node:crypto';
import { metricDiscoveryPage } from '../metrics/consumers/discovery.js';
import type { Pool } from 'mysql2/promise';
import { MODEL_ANALYSIS_POLICY } from './model-analysis.js';
import {
  AgentRunner,
  NoopHook,
  ToolRegistry,
  checkpointFacts,
  type LLMProvider,
  type LLMResponse,
  type Message,
  type SessionEntry,
} from '@slide/agent-core';
import { ActorAuthenticationError, type ActorContext } from '../auth/actor-context.js';
import {
  CanonicalStore,
  type InvestigationConnection,
  type InvestigationExecutionBinding,
} from '../adapter/canonical-store.js';
import { persistedMessageParts } from '../adapter/message-parts.js';
import { AgentRunService, type AgentRun, type AgentRunState } from '../adapter/agent-run-service.js';
import type { ClaimedJob, JobExecutionContext } from '../workflows/worker-runtime.js';
import { InvestigationAuthorization, type InvestigationAuthoritySnapshot } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { investigationPrompt, resolveInvestigationProfile } from './profiles.js';
import type { InvestigationProfile } from './contracts.js';
import { InvestigationEffectiveBudgetService, resolveAdmissionConfiguration, type InvestigationAdmissionConfiguration } from './effective-budget.js';
import {resolveInvestigationRuntime} from './runtime-configuration.js';
import { InvestigationCaseReferences } from './case-references.js';
import {
  MysqlInvestigationBudgetLedger,
  budgetUsage,
  type BudgetPolicy,
  type BudgetPrices,
  type BudgetUsage,
  type BudgetReservation,
} from './budget-ledger.js';
import { getToolSecurityDefinition } from '../tools/security-catalog.js';
import { resolveToolResourceFromArgs } from '../tools/resource-resolver.js';
import { redactSensitiveText } from '../security/log-redaction.js';
import { redactSensitiveData } from '../security/sensitive-data.js';
import { investigationToolContract, investigationToolPolicy } from './tool-contract.js';
import { systemInvestigationHistory } from './system-tools.js';
import { investigationStop, type InvestigationStop } from './execution-summary.js';
import { analysisProviderIdentity } from '../analysis/analysis-execution.js';

const decode = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Selection is a data bound, not authority. Execution still checks ACL/fence.
 * A returned page must agree with the actual resource and every selected ID;
 * null/unknown and repeated dimensions are records too, never filtered out.
 */
function selectedObservationPage(result: any, args?: Record<string, any>): boolean {
  const ids = args?.metricIds, rows = result.data?.observations, ref = result.data?.resource;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 32
    && ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9_.]{0,127}$/.test(id))
    && new Set(ids).size === ids.length
    && ['instance', 'server', 'network_device'].includes(args?.resourceType)
    && Number.isSafeInteger(args?.resourceId) && args!.resourceId > 0
    && ref?.type === args?.resourceType && ref?.id === args?.resourceId
    && Number.isSafeInteger(args?.limit ?? 100) && (args?.limit ?? 100) >= 1 && (args?.limit ?? 100) <= 100
    && Array.isArray(rows) && rows.length <= (args?.limit ?? 100)
    && rows.every(row => row && typeof row === 'object' && ids.includes(row.metricId)
      && row.resource?.type === ref.type && row.resource?.id === ref.id);
}
/** A selection route, never an observation or permission to replay a receipt.
 * Resolve the resource from the current call/receipt, not a guessed metric alias.
 */
function metricReadGuidance(result: any, toolName?: string, args?: Record<string, any>) {
  if (!['query_metrics', 'get_resource_observations', 'get_server_metrics'].includes(toolName ?? '')) return undefined;
  const ref = result.data?.resource;
  const type = ref?.type ?? args?.resourceType ?? (toolName === 'get_server_metrics' ? 'server' : undefined);
  const id = ref?.id ?? args?.resourceId ?? args?.serverId ?? result.details?.server_id;
  if (!['instance', 'server', 'network_device'].includes(type) || !Number.isSafeInteger(id) || id <= 0) return undefined;
  if (args?.resourceType !== undefined && args.resourceType !== type
    || args?.resourceId !== undefined && args.resourceId !== id
    || args?.serverId !== undefined && args.serverId !== id) return undefined;
  const selected = toolName === 'get_resource_observations' && selectedObservationPage(result, args);
  const returnedMetricIds = selected ? [...new Set<string>(result.data.observations.map((row: any) => row.metricId))]
    : toolName === 'query_metrics' && Array.isArray(result.data?.metrics)
      ? result.data.metrics.map((m: any) => m.definition?.id).filter((id: unknown) => typeof id === 'string') : [];
  const resource = { resourceType: type, resourceId: id };
  const filesystemIds = ['host.filesystem.used_bytes', 'host.filesystem.size_bytes'];
  const other = returnedMetricIds.length === 1 && filesystemIds.includes(returnedMetricIds[0])
    ? filesystemIds.find(id => id !== returnedMetricIds[0]) : undefined;
  const window = result.data?.window;
  // The product profile supplies the related ID, not a guessed alias or proof
  // of collection capability. Use the SAME bounded window, never array order.
  const pairedRead = other && result.data?.profile?.columns?.some((c: any) => c.metric?.id === other)
    && Date.parse(window?.to) > Date.parse(window?.from) && Date.parse(window.to) - Date.parse(window.from) <= 3600000
    ? { tool: 'query_metrics', arguments: { ...resource, mode: 'history', metric_ids: [other],
      from: window.from, to: window.to, interval: '1m' } } : undefined;
  return { discover: { tool: 'query_metrics', arguments: { ...resource, mode: 'discover', discovery_limit: 8 } },
    ...(pairedRead ? { pairedRead, ...(result.data?.selection ? { completeRead: { tool: 'query_metrics', arguments: { ...pairedRead.arguments, metric_ids: returnedMetricIds } } } : {}), pairing: 'Read completeRead (if selected) and pairedRead before conclusions. Match unique full mount/device/fs_type, window, observed_at and unit, never array index. Missing/duplicate peers, null, failures or zero capacity are gaps, not a healthy percentage. This route does not assert capability.' } : {}),
    ...(returnedMetricIds.length ? { returnedMetricIds,
      history: { tool: 'query_metrics', arguments: { ...resource, mode: 'history', interval: '1m', series_index: 0 } } } : {}),
    instructions: returnedMetricIds.length
      ? 'Choose one returnedMetricIds (not proof of capability); discover+metric_ids:[id] gives its definition without catalog rediscovery. history: metric_ids:[id], UTC from/to(exclusive), interval:1m, <=1h/60 buckets. Follow query_metrics history time contract. Start series_index:0 for unknown dimensions; returned dimensions/selection.total_series guide remaining series/windows. Pair filesystem metrics by full dimensions, not series_index. Legacy snapshots lack full semantics; failure is not zero.'
      : 'Read one discovered metric_ids; UTC from/to, interval:1m, <=1h/60 buckets. Follow query_metrics history time contract. Start series_index:0; inspect dimensions/selection.total_series to cover all series/windows. Legacy scalars lack full semantics.' };
}
/** Directory only: indices identify THIS receipt/window, not stable identities
 * across metrics. Keep duplicate dimensions as separate entries. A page never
 * authorizes another resource or silently discards a series from numeric data.
 */
function metricSeriesSelection(data: any, args?: Record<string, any>) {
  if (data?.contract_version !== '1.0.0' || data.metrics?.length !== 1) return undefined;
  const metric = data.metrics[0], ref = data.resource, window = data.window;
  if (!Array.isArray(metric?.series) || !metric.series.length
    || !['instance', 'server', 'network_device'].includes(ref?.type) || !Number.isSafeInteger(ref?.id) || ref.id <= 0
    || typeof metric.definition?.id !== 'string' || !/^[a-z][a-z0-9_.]{0,127}$/.test(metric.definition.id)
    || args?.resourceType !== undefined && args.resourceType !== ref.type
    || args?.resourceId !== undefined && args.resourceId !== ref.id
    || !(Date.parse(window?.to) > Date.parse(window?.from)) || Date.parse(window.to) - Date.parse(window.from) > 3600000) return undefined;
  const start = data.selection?.series_index ?? 0, total = data.selection?.total_series ?? metric.series.length;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(total) || total < start + metric.series.length || total > 100) return undefined;
  const entries = metric.series.slice(0, 16).map((s: any, i: number) => ({ series_index: start + i, dimensions: s.dimensions }));
  if (Buffer.byteLength(JSON.stringify(entries)) > 8192) return undefined;
  return { total_series: total, entries, directoryComplete: start === 0 && entries.length === total,
    read: { tool: 'query_metrics', arguments: { resourceType: ref.type, resourceId: ref.id,
      mode: 'history', metric_ids: [metric.definition.id], from: window.from, to: window.to, interval: '1m', series_index: start } },
    instructions: 'Directory contains no values. Read each required index for this metric/window; indices may change across metrics/windows. Pair by full dimensions and observation time/unit. A missing or duplicate peer remains unresolved.' };
}
/** Hoist schema/series metadata repeated byte-identically in every bucket of a
 * multi-series page. Values, windows, quality, dimensions and evidence ids stay
 * per bucket; the canonical receipt keeps the unmodified page.
 */
function compactSeriesPage(metric: any): any {
  const series = Array.isArray(metric?.series) ? metric.series : [];
  const buckets = series.flatMap((s: any) => Array.isArray(s?.buckets) ? s.buckets : []);
  if (!buckets.length) return metric;
  const identical = (values: unknown[]) => values.length > 0 && values.every(v => v !== undefined)
    && new Set(values.map(canonicalReceiptHash)).size === 1;
  const defaults: Record<string, unknown> = {};
  for (const key of ['contract_version', 'metric', 'unit', 'window', 'accuracy', 'freshness', 'coverage', 'sample_count']) {
    const values = buckets.map((b: any) => b?.[key]);
    if (identical(values)) defaults[key] = values[0];
  }
  const sources = buckets.flatMap((b: any) => Array.isArray(b?.sources) ? b.sources : []);
  const sourceShape = new Set(['id', 'source', 'versions']);
  const innerShape = new Set(['attempt_id', 'binding_id', 'collector_id', 'metric_binding_id']);
  const compactableSources = sources.length > 0 && sources.every((entry: any) => entry && typeof entry === 'object'
    && Object.keys(entry).every(key => sourceShape.has(key))
    && (!entry.source || (typeof entry.source === 'object' && Object.keys(entry.source).every(key => innerShape.has(key)))));
  const sourceDefaults: Record<string, unknown> = {};
  if (compactableSources) {
    for (const key of ['attempt_id', 'binding_id', 'collector_id']) {
      const values = sources.map((entry: any) => entry.source?.[key]);
      if (identical(values)) sourceDefaults[key] = values[0];
    }
    const versions = sources.map((entry: any) => entry.versions);
    if (identical(versions)) sourceDefaults.versions = versions[0];
  }
  const compactSource = (entry: any) => {
    if (!compactableSources) return entry;
    const compact: Record<string, unknown> = { id: entry.id };
    if (entry.source?.metric_binding_id !== undefined) compact.metric_binding_id = entry.source.metric_binding_id;
    for (const key of ['attempt_id', 'binding_id', 'collector_id'])
      if (entry.source?.[key] !== undefined && !Object.hasOwn(sourceDefaults, key)) compact[key] = entry.source[key];
    if (entry.versions !== undefined && !Object.hasOwn(sourceDefaults, 'versions')) compact.versions = entry.versions;
    return compact;
  };
  const compactBucket = (bucket: any, dimensions: unknown) => {
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bucket ?? {})) {
      if (Object.hasOwn(defaults, key)) continue;
      if (key === 'dimensions' && canonicalReceiptHash(value) === canonicalReceiptHash(dimensions)) continue;
      if (key === 'sources' && Array.isArray(value)) { compact.sources = value.map(compactSource); continue; }
      compact[key] = value;
    }
    return compact;
  };
  const attempt = metric.attempt && typeof metric.attempt === 'object'
    ? (({ observation_ids: _ids, ...rest }: Record<string, unknown>) => rest)(metric.attempt)
    : metric.attempt;
  return { ...metric, attempt,
    ...(Object.keys(defaults).length ? { bucketDefaults: defaults } : {}),
    ...(Object.keys(sourceDefaults).length ? { sourceDefaults } : {}),
    series: series.map((s: any) => ({ ...s, buckets: (Array.isArray(s?.buckets) ? s.buckets : [])
      .map((b: any) => compactBucket(b, s.dimensions)) })) };
}
/** Model projection only; the complete bounded receipt is persisted first.
 * Keep live Ops batches small enough to leave room for protected history.
 * This cap is a planning limit; ContextManager still enforces final admission.
 */
export function investigationToolContextResult(result: unknown, toolCallId: string, profile: string, toolName?: string, args?: Record<string, any>): unknown {
  if (result === null || typeof result !== 'object' || (result as any).success !== true
    || (result as any).status === 'error') return result;
  const json = JSON.stringify(result);
  if (profile !== 'ops') return json;
  if ((result as any).policyDecision?.allow === false) return result;
  if ((result as any).data?.contextReference && ((result as any).data?.evidenceOmitted === true
    || ['single_metric_v1', 'metric_window_v1', 'metric_series_v1', 'metric_discovery_v1', 'bounded_observations_v1', 'bounded_server_metrics_v1'].includes((result as any).data?.contextProjection))) return json;
  const { policyDecision: _audit, ...observation } = result as Record<string, unknown>;
  const reference = { toolCallId, sha256: canonicalReceiptHash(result), bytes: Buffer.byteLength(json) };
  const data = observation.data as Record<string, any> | undefined;
  const metricRead = metricReadGuidance(result, toolName, args);
  if (toolName === 'query_metrics' && Array.isArray(data?.definitions)) {
    // Old durable discovery includes the whole policy/plan. Keep its hash but
    // expose a legal first page. New receipts already contain the bounded page.
    const { columns: _columns, ...profile } = data.profile ?? {};
    const page = data.discovery ? { definitions: data.definitions, metric_ids: data.metric_ids, discovery: data.discovery }
      : metricDiscoveryPage(data.definitions);
    return JSON.stringify({ ...observation, data: { resource: data.resource, profile,
      configuration_revision: data.configuration_revision ?? data.effective?.published_revision ?? null,
      ...page, contextProjection: 'metric_discovery_v1', contextReference: reference } });
  }
  // Semantic selection is the bound, not a larger generic byte threshold.
  // One metric/series/bucket (including null or no series) remains readable with
  // its complete definition, capability, attempt, quality and audited sources.
  // The default core profile's unrelated columns add no selected observations.
  if (toolName === 'query_metrics' && data?.contract_version === '1.0.0'
    && Array.isArray(data.metrics) && data.metrics.length === 1
    && Array.isArray(data.metrics[0]?.series) && data.metrics[0].series.length <= 1
    && data.metrics[0].series.every((s: any) => Array.isArray(s.buckets) && s.buckets.length <= 1)) {
    const { columns: _columns, ...profile } = data.profile ?? {};
    return JSON.stringify({ ...observation, data: { ...data, profile,
      contextProjection: 'single_metric_v1', contextReference: reference, ...(metricRead?.pairedRead ? { metricRead,
        seriesSelection: metricSeriesSelection(data, args) } : {}) } });
  }
  // A dimensioned metric is not inherently oversized. Preserve the complete
  // semantic page under THREE independent bounds; never select/merge healthy
  // rows, omit nulls or cap just the first N series. Final assertFits still owns
  // admission of the full request, including schemas, reasoning and suffixes.
  if (toolName === 'query_metrics' && data?.contract_version === '1.0.0'
    && data.metrics?.length === 1 && Array.isArray(data.metrics[0]?.series)) {
    const series = data.metrics[0].series, duration = Date.parse(data.window?.to) - Date.parse(data.window?.from);
    if (series.length > 1 && series.length <= 16 && duration > 0 && duration <= 3600000
      && series.every((s: any) => Array.isArray(s.buckets) && s.buckets.length <= 60
        && s.buckets.every((b: any) => Date.parse(b.window?.to) > Date.parse(b.window?.from)
          && Date.parse(b.window.to) - Date.parse(b.window.from) <= 60000))
      && series.reduce((n: number, s: any) => n + s.buckets.length, 0) <= 60) {
      const { columns: _columns, ...profile } = data.profile ?? {};
      const view = JSON.stringify({ ...observation, data: { ...data, profile,
        metrics: [compactSeriesPage(data.metrics[0])],
        contextProjection: 'metric_series_v1', contextReference: reference, ...(metricRead ? { metricRead } : {}) } });
      if (Buffer.byteLength(view) <= 16384) return view;
    }
  }
  if (toolName === 'query_metrics' && data?.contract_version === '1.0.0'
    && Array.isArray(data.metrics) && data.metrics.length === 1
    && Array.isArray(data.metrics[0]?.series) && data.metrics[0].series.length === 1) {
    const series = data.metrics[0].series[0], buckets = series.buckets;
    const duration = Date.parse(data.window?.to) - Date.parse(data.window?.from);
    if (duration > 0 && duration <= 3600000 && Array.isArray(buckets) && buckets.length > 1 && buckets.length <= 60
      && buckets.every((b: any) => Date.parse(b.window?.to) > Date.parse(b.window?.from)
        && Date.parse(b.window.to) - Date.parse(b.window.from) <= 60000)) {
      const defaults: Record<string, unknown> = {};
      // Values, times, quality, coverage and sources stay explicit per bucket.
      // Hoist only schema/series metadata repeated identically in every row.
      for (const key of ['contract_version', 'metric', 'unit', 'dimensions'])
        if (Object.hasOwn(buckets[0], key) && buckets.every((b: any) => Object.hasOwn(b, key)
          && canonicalReceiptHash(b[key]) === canonicalReceiptHash(buckets[0][key]))) defaults[key] = buckets[0][key];
      const { columns: _columns, ...profile } = data.profile ?? {};
      return JSON.stringify({ ...observation, data: { ...data, profile,
        metrics: [{ ...data.metrics[0], series: [{ ...series, bucketDefaults: defaults,
          buckets: buckets.map((b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => !Object.hasOwn(defaults, k)))) }] }],
        contextProjection: 'metric_window_v1', contextReference: reference, ...(metricRead?.pairedRead ? { metricRead,
          seriesSelection: metricSeriesSelection(data, args) } : {}) } });
    }
  }
  // Generated completion/count labels duplicate structured data; other prose
  // can contain evidence or a warning and must survive the projection.
  // Failures/denials never enter this branch. Complete receipts remain canonical.
  if (observation.data && typeof observation.data === 'object' && Object.keys(observation.data).length) {
    const summary = observation.summary;
    const data = observation.data as Record<string, unknown>;
    const redundant = typeof summary === 'string' && (
      /^(?:get_instance_summary|get_resource_observations|get_resource_relations) 执行完成$/.test(summary)
      || (Number.isSafeInteger(data.total) && (summary === `找到 ${data.total} 条活跃告警`
        || summary === `服务器 #${(observation.details as any)?.server_id} 告警 ${data.total} 条`)));
    if (redundant) delete observation.summary;
    if (Array.isArray(observation.next_actions) && !observation.next_actions.length) delete observation.next_actions;
    if (observation.artifacts && typeof observation.artifacts === 'object' && !Object.keys(observation.artifacts).length) delete observation.artifacts;
  }
  const compact = JSON.stringify(observation);
  // Row/series selection bounds the legacy page. Preserve every business field;
  // the byte ceiling only rejects opaque oversized records, never truncates them.
  // These pages have no full metric definition/capability: route to discovery
  // rather than relabelling a legacy scalar as a semantic observation.
  const selectedObservations = toolName === 'get_resource_observations' && args?.metricIds !== undefined;
  const boundedObservations = toolName === 'get_resource_observations'
    && (selectedObservations ? selectedObservationPage(result, args)
      : Array.isArray(data?.observations) && data.observations.length <= 4);
  const boundedServerMetrics = toolName === 'get_server_metrics'
    && Array.isArray(data?.latest) && data.latest.length <= 1
    && Array.isArray(data?.history) && data.history.length <= 1;
  if ((boundedObservations || boundedServerMetrics) && Buffer.byteLength(compact) <= 16384) {
    return JSON.stringify({ ...observation, data: { ...data,
      contextProjection: boundedObservations ? 'bounded_observations_v1' : 'bounded_server_metrics_v1',
      contextReference: reference, ...(metricRead ? { metricRead } : {}) } });
  }
  if (!selectedObservations && Buffer.byteLength(compact) <= 512) {
    // executeToolWithPolicy appends this runtime audit envelope to every
    // receipt. It is not observation data or model authority. Keep it in
    // canonical facts/SQL, but do not repeat actor/request ACL metadata in the
    // live model batch. All business fields and failure semantics stay exact.
    return compact;
  }
  // Preserve warning/recovery metadata even when the observation payload is
  // omitted. It must never turn into an apparently empty healthy response.
  const { data: _data, ...metadata } = observation;
  // Some handlers return row payloads at the receipt root. They are evidence,
  // not warning/recovery metadata; keep them in the canonical receipt referenced
  // below instead of bypassing the oversized-payload projection.
  if (Array.isArray(metadata.rows)) delete metadata.rows;
  return JSON.stringify({ ...metadata, status: 'warning',
    data: { contextReference: reference, evidenceOmitted: true, ...(selectedObservations ? { valuesProvided: false } : {}), requiresNarrowerRead: true,
      ...(toolName === 'query_metrics' && Array.isArray(data?.metrics)
        ? { metric_ids: data.metrics.map((m: any) => m.definition?.id) } : {}),
      ...(toolName === 'query_metrics' && metricSeriesSelection(data, args) ? { seriesSelection: metricSeriesSelection(data, args) } : {}),
      ...(metricRead ? { metricRead } : {}) } });
}
/** Ephemeral model view only. Durable facts and checkpoints retain full results. */
export function investigationContextMessages(messages: Message[], profile: string): Message[] {
  if (profile !== 'ops') return messages;
  // Provider normalization can omit the optional tool-message name. Resolve it
  // from the adjacent assistant call group, never from an unrelated old ID.
  const calls = new Map<string, { name: string; args?: Record<string, any> }>();
  return messages.map(message => {
    if (message.role !== 'tool') {
      calls.clear();
      for (const call of message.tool_calls ?? []) {
        let args: Record<string, any> | undefined;
        try { args = JSON.parse(call.function.arguments); } catch { /* Invalid arguments grant no resource hint. */ }
        calls.set(call.id, { name: call.function.name, args });
      }
      return message;
    }
    if (message.name === 'search_case_references') return message;
    if (message.role !== 'tool' || !message.tool_call_id || typeof message.content !== 'string') return message;
    let result: unknown;
    try { result = JSON.parse(message.content); } catch { return message; }
    const call = calls.get(message.tool_call_id), name = message.name ?? call?.name;
    // A handler can fail after policy allowed execution. Keep the complete
    // business failure in the model view, without repeating an ALLOW audit
    // envelope. This runs after ToolExecutor; failure object semantics and
    // durable receipts stay untouched. A policy denial is never stripped.
    if ((result as any)?.success === false && (result as any)?.policyDecision?.allow === true) {
      const { policyDecision: _audit, ...failure } = result as Record<string, unknown>;
      const metricRead = ['METRIC_NAME_INVALID', 'GET_METRICS_FAILED'].includes(String(failure.errorCode))
        ? metricReadGuidance(result, name, call?.args) : undefined;
      return { ...message, content: JSON.stringify({ ...failure, ...(metricRead ? { metricRead } : {}) }), messageParts: undefined };
    }
    const content = investigationToolContextResult(result, message.tool_call_id, profile, name, call?.args);
    return typeof content === 'string' && content !== message.content
      ? { ...message, content, messageParts: undefined } : message;
  });
}
// Only these reviewed handlers require no browser, approval, credential read or
// interactive session. Profile membership alone never grants background safety.
const BACKGROUND_SAFE = new Set([
  'get_instance_summary',
  'query_metrics',
  'list_active_alerts',
  'get_server_metrics',
  'get_server_alerts',
  'get_resource_observations',
  'get_resource_relations',
  'get_platform_observations',
  'search_case_references',
]);
export interface InvestigationExecuteCommand {
  investigationId: string;
  requestId: string;
  job: ClaimedJob;
  context: JobExecutionContext;
}
export interface InvestigationRuntimeDependencies {
  providerForPurpose: (purpose: string) => Promise<LLMProvider>;
  toolsForActor: (actor: ActorContext) => ToolRegistry;
}
export interface InvestigationExecutorOptions extends InvestigationRuntimeDependencies {
  pool: () => Pool | null;
  caseReferences?: InvestigationCaseReferences;
  /** Trusted server-side test configuration; never taken from workflow payloads. */
  contextInputLimit?: number;
  runtimeContext?: import('./runtime-configuration.js').InvestigationRuntimeConfiguration;
  /** Durable operator settings; tests may inject a fixture. */
  effectiveBudget?: Pick<InvestigationEffectiveBudgetService, 'readStored'>;
  authorization?: InvestigationAuthorization;
  systemToolsForInvestigation?: (actor: ActorContext, snapshot: Readonly<Record<string, any>>) => ToolRegistry;
  budget: { policy: BudgetPolicy; domain: string; reserveCostMicros: number; prices?: BudgetPrices; maxExecutionTokens?: number; taskExecution?: TaskExecutionConfiguration };
}
export function investigationContextLimits(providerWindow: number | undefined, inputLimit?: number) {
  if (inputLimit !== undefined && (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || inputLimit > 100_000)) {
    throw new Error('INVESTIGATION_CONTEXT_INPUT_LIMIT');
  }
  return {
    contextWindowTokens: Math.min(providerWindow ?? 16_000, inputLimit === undefined ? 16_000 : inputLimit + 4096 + 1024),
    ...(inputLimit === undefined ? {} : { contextBlockLimit: inputLimit }),
  };
}
interface ExecutionState {
  schemaVersion: 1;
  requestId: string;
  jobId: string;
  fencingToken: number;
  deadlineAt: number;
  reservationId: string;
  reservedTokens: number;
  executionAllocation?: FrozenExecutionAllocation;
  allocationRunId?: string;
  usage: BudgetUsage;
  usageUnknown: boolean;
  provider: { id: string; inputHash: string; messageId: string | null; sourceRequestId?: string; status: 'sent' | 'received'; purpose?:'summary'; sourceHash?:string; response?: LLMResponse } | null;
  lastSummaryReceipt?: unknown;
  lastProviderReceipt?: unknown;
  provenance?: { modelVersion: string; promptVersion: string; providerId?: number; routeVersion?: string; inputHash?: string };
  runtimeContext?: import('./runtime-configuration.js').InvestigationRuntimeContext;
  /** Effective Profile limits frozen at the first execution of this Run. */
  profileBudget?: Readonly<InvestigationProfile['budget']>;
  terminal?: InvestigationStop;
  tools: Record<string, { name: string; inputHash: string; status: 'running' | 'returned'; result?: unknown }>;
}
/** Derived view of durable current-request receipts, never of a model summary.
 * Raw message IDs need not exist in the in-memory Runtime; do not manufacture
 * them or rewrite legacy provenance. Caller refreshes state under live ACL/fence.
 */
export function investigationExecutionEvidence(source: readonly Message[], state: ExecutionState,
  binding: Pick<InvestigationExecutionBinding, 'runId' | 'requestId' | 'jobId' | 'fencingToken'>, historyLength = 0, summary?: { sourceHash: string; summary: unknown }) {
  const view: NonNullable<import('@slide/agent-core').AgentRunSpec['contextEvidence']> = () => ({ runId: binding.runId,
    requestId: binding.requestId, receipts: [], omitted: [] });
  const result = view(source);
  if (state?.schemaVersion !== 1 || state.requestId !== binding.requestId || state.jobId !== binding.jobId
    || state.fencingToken !== binding.fencingToken) return result;
  if (summary) {
    const receipt = state.lastSummaryReceipt as any;
    const sourceHash = createHash('sha256').update(JSON.stringify(source.map(({ messageParts: _parts, ...fact }) => fact))).digest('hex');
    if (state.usageUnknown || receipt?.status !== 'accepted' || receipt.purpose !== 'summary'
      || receipt.sourceHash !== sourceHash || summary.sourceHash !== sourceHash || !receipt.response
      || receipt.responseHash !== canonicalReceiptHash(receipt.response) || summaryRejection(receipt.response)
      || canonicalReceiptHash(summary.summary) !== canonicalReceiptHash(parseSummaryJson(receipt.response.content))) return result;
  }
  for (let i = 0; i < source.length; i++) {
    const assistant = source[i];
    if (assistant.role !== 'assistant' || assistant.source && assistant.source !== 'fact'
      || assistant.runId && assistant.runId !== binding.runId
      || i < historyLength && assistant.runId !== binding.runId) continue;
    const returned = new Map<string, Message>();
    for (let j = i + 1; source[j]?.role === 'tool'; j++) {
      const tool = source[j];
      if (tool.tool_call_id) returned.set(tool.tool_call_id, tool);
    }
    for (const call of assistant.tool_calls ?? []) {
      const durable = state.tools[call.id], tool = returned.get(call.id);
      if (!durable || durable.status !== 'returned' || durable.name !== call.function.name || !tool
        || tool.source && tool.source !== 'fact' || tool.runId && tool.runId !== binding.runId
        || tool.name && tool.name !== durable.name || typeof tool.content !== 'string') continue;
      try {
        const args = JSON.parse(call.function.arguments), raw = JSON.parse(tool.content);
        if (hash(args) !== durable.inputHash || canonicalReceiptHash(raw) !== canonicalReceiptHash(durable.result)) continue;
        let content = investigationToolContextResult(raw, call.id, 'ops', durable.name, args);
        if (typeof content === 'string') {
          const projected = JSON.parse(content);
          if (projected.data?.contextProjection === 'metric_window_v1') {
            for (const metric of projected.data.metrics) for (const series of metric.series) {
              for (const key of Object.keys(series.buckets[0])) if (!['value','window','observed_at'].includes(key)
                && series.buckets.every((b: any) => Object.hasOwn(b, key) && canonicalReceiptHash(b[key]) === canonicalReceiptHash(series.buckets[0][key]))) {
                series.bucketDefaults[key] = series.buckets[0][key];
                series.buckets = series.buckets.map((b: any) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== key)));
              }
              const columns = [...new Set<string>(series.buckets.flatMap((b: object) => Object.keys(b)))];
              // Missing keys remain distinct from null via an explicit mask.
              series.bucketColumns = columns;
              series.buckets = series.buckets.map((b: Record<string, unknown>) => [columns.map(k => Object.hasOwn(b, k)), columns.map(k => b[k] ?? null)]);
            }
            projected.data.contextProjection = 'metric_window_receipt_v1';
            content = JSON.stringify(projected);
          }
        }
        const receipt = { toolCallId: call.id, receiptHash: canonicalReceiptHash(raw), content: typeof content === 'string' ? content : JSON.stringify(raw) };
        // Admission belongs to the complete final request, not a byte cap.
        result.receipts.push(receipt);
      } catch { /* Malformed/unknown sources cannot become current evidence. */ }
    }
  }
  return result;
}
const usageOf = (response: LLMResponse): BudgetUsage | null => {
  try {
    return budgetUsage({
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      cachedInputTokens: response.usage.cached_tokens ?? 0,
    });
  } catch {
    return null;
  }
};
function callerFrom(snapshot: InvestigationAuthoritySnapshot): ActorContext {
  return {
    userId: snapshot.actor.id,
    username: `investigation-actor-${snapshot.actor.id}`,
    roles: [],
    requestId: `investigation:${snapshot.investigationId}`,
    principalKind: snapshot.actor.kind,
    sessionVersion: snapshot.sessionVersion,
    permissions: snapshot.globalInstanceAccess ? [...snapshot.permissions, 'instance:*'] : snapshot.permissions,
    instanceScopes: snapshot.instanceScopes,
    resourceBoundary: snapshot.globalInstanceAccess ? undefined : snapshot.resourceBoundary,
  };
}

/** Model parameters are untrusted. Targets are parsed against the security
 * catalog, with conflicting aliases rejected rather than silently preferred. */
export function boundedInvestigationArguments(
  name: string,
  value: Record<string, unknown>,
  budget: {
    maxBytes: number;
    maxRows: number;
    maxWindowMs: number;
  },
  now: number,
): { args: Record<string, unknown>; targets: { type: 'instance' | 'server' | 'network_device'; id: number }[] } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(JSON.stringify(value)) > budget.maxBytes
  )
    throw new Error('INVESTIGATION_TOOL_INPUT_LIMIT');
  const args = structuredClone(value);
  for (const aliases of [
    ['instance_id', 'instanceId'],
    ['server_id', 'serverId'],
    ['network_device_id', 'networkDeviceId'],
  ]) {
    if (aliases.every((k) => args[k] !== undefined) && args[aliases[0]] !== args[aliases[1]])
      throw new Error('INVESTIGATION_TARGET_AMBIGUOUS');
  }
  if (
    args.instance_name !== undefined ||
    args.host !== undefined ||
    args.command !== undefined ||
    args.sql !== undefined ||
    (args.resourceType !== undefined &&
      (args.instance_id !== undefined ||
        args.instanceId !== undefined ||
        args.serverId !== undefined ||
        args.server_id !== undefined ||
        args.networkDeviceId !== undefined ||
        args.network_device_id !== undefined))
  )
    throw new Error('INVESTIGATION_TARGET_AMBIGUOUS');
  const resource = resolveToolResourceFromArgs(name, args);
  if (resource.error) throw new Error('INVESTIGATION_TARGET_INVALID');
  const targets: { type: 'instance' | 'server' | 'network_device'; id: number }[] = [];
  if (resource.instanceId !== undefined) targets.push({ type: 'instance', id: resource.instanceId });
  if (resource.serverId !== undefined) targets.push({ type: 'server', id: resource.serverId });
  if (resource.networkDeviceId !== undefined) targets.push({ type: 'network_device', id: resource.networkDeviceId });
  for (const key of ['limit', 'maxRows', 'rows'])
    if (
      args[key] !== undefined &&
      (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > budget.maxRows)
    )
      throw new Error('INVESTIGATION_TOOL_ROW_LIMIT');
  const from = args.from ?? args.since,
    to = args.to ?? new Date(now).toISOString();
  if (
    (args.to !== undefined && from === undefined) ||
    (args.from !== undefined && args.since !== undefined) ||
    (args.range !== undefined && args.range !== '1h')
  )
    throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  if (
    from !== undefined &&
    (typeof from !== 'string' ||
      typeof to !== 'string' ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) > now ||
      Date.parse(to) < Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > budget.maxWindowMs)
  )
    throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  if (args.period !== undefined && args.period !== '1h') throw new Error('INVESTIGATION_TOOL_WINDOW_LIMIT');
  // Bound the handlers' implicit history defaults as well as explicit windows.
  if (name === 'query_metrics' && args.mode === 'history' && args.from === undefined) {
    args.from = new Date(now - budget.maxWindowMs).toISOString();
    args.to = new Date(now).toISOString();
  }
  if (name === 'list_active_alerts') {
    args.limit ??= Math.min(100, budget.maxRows);
    args.since ??= new Date(now - budget.maxWindowMs).toISOString();
  }
  return { args, targets };
}
function boundedResult(value: unknown, maxRows: number, maxBytes: number): unknown {
  const copy = (v: any, depth = 0): any => {
    if (depth > 20) return '[depth limit]';
    if (typeof v === 'string') return redactSensitiveText(v);
    if (Array.isArray(v)) return v.slice(0, maxRows).map((x) => copy(x, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x, depth + 1)]));
    return v;
  };
  const result = copy(redactSensitiveData(value)),
    json = JSON.stringify(result);
  if (json === undefined || Buffer.byteLength(json) > maxBytes)
    return { success: false, errorCode: 'INVESTIGATION_TOOL_OUTPUT_LIMIT', error: '工具结果超过调查输出限额' };
  return result;
}

export class InvestigationExecutor {
  private readonly inFlight = new Map<string, Promise<AgentRun>>();
  private readonly canonical: CanonicalStore;
  private readonly runs: AgentRunService;
  private readonly authorization: InvestigationAuthorization;
  private readonly bridge: InvestigationSessionBridge;
  private readonly ledger: MysqlInvestigationBudgetLedger;
  private readonly cases: InvestigationCaseReferences;
  private readonly effectiveBudget: Pick<InvestigationEffectiveBudgetService, 'readStored'>;
  constructor(private readonly options: InvestigationExecutorOptions) {
    this.authorization = options.authorization ?? new InvestigationAuthorization();
    this.canonical = new CanonicalStore(options.pool as never, this.authorization);
    this.runs = new AgentRunService(options.pool as never, this.authorization);
    this.bridge = new InvestigationSessionBridge(options.pool, this.authorization);
    this.effectiveBudget = options.effectiveBudget ?? new InvestigationEffectiveBudgetService(options.pool);
    if (options.budget.taskExecution) taskExecutionConfiguration(options.budget.taskExecution, options.budget.domain, options.budget.policy);
    // Copy trusted configuration before any asynchronous execution or caller mutation.
    this.options = { ...options, budget: structuredClone(options.budget) };
    this.ledger = new MysqlInvestigationBudgetLedger(options.pool, options.budget.policy, options.budget.maxExecutionTokens, this.options.budget.taskExecution);
    this.cases = options.caseReferences ?? InvestigationCaseReferences.create(options.pool);
  }
  /** New reservations honor the durable admission setting. A stored receipt or
   * a MAX-222 task contract keeps the base policy of its own domain. */
  private admissionLedger(admission: InvestigationAdmissionConfiguration): MysqlInvestigationBudgetLedger {
    return this.options.budget.taskExecution ? this.ledger
      : new MysqlInvestigationBudgetLedger(this.options.pool, admission.policy, this.options.budget.maxExecutionTokens);
  }
  private async transaction<T>(work: (c: InvestigationConnection) => Promise<T>): Promise<T> {
    // Ingress owns domain before newly created Session rows. Executor owns
    // Session -> Investigation -> Request -> Job before domain. InnoDB may
    // choose either transaction as a deadlock victim; retry SQL-only work.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactionOnce(work);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw error;
      }
    }
  }
  private async transactionOnce<T>(work: (c: InvestigationConnection) => Promise<T>): Promise<T> {
    const pool = this.options.pool();
    if (!pool) throw new Error('INVESTIGATION_STORE_UNAVAILABLE');
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const value = await work(c as unknown as InvestigationConnection);
      await c.commit();
      return value;
    } catch (error) {
      try {
        await c.rollback();
      } catch {
        /* retain original */
      }
      throw error;
    } finally {
      c.release();
    }
  }
  execute(
    command: InvestigationExecuteCommand,
    runtime: InvestigationRuntimeDependencies = this.options,
  ): Promise<AgentRun> {
    const key = `${command.requestId}:${command.job.id}:${command.context.workerId}:${command.context.fencingToken}`;
    const previous = this.inFlight.get(key);
    if (previous) return previous;
    const promise = this.executeOwned(command, runtime);
    this.inFlight.set(key, promise);
    void promise
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      })
      .catch(() => {});
    return promise;
  }
  private async executeOwned(
    command: InvestigationExecuteCommand,
    runtime: InvestigationRuntimeDependencies,
  ): Promise<AgentRun> {
    const { investigationId, requestId, job, context } = command;
    if (
      !uuid.test(investigationId) ||
      !uuid.test(requestId) ||
      job.type !== 'investigation.execute' ||
      job.payload.investigationId !== investigationId ||
      job.payload.requestId !== requestId ||
      job.fencingToken !== context.fencingToken
    )
      throw new Error('INVESTIGATION_JOB_INVALID');
    context.signal.throwIfAborted();
    const pool = this.options.pool();
    if (!pool) throw new Error('INVESTIGATION_STORE_UNAVAILABLE');
    const [requests] = await pool.query<any[]>(
      'SELECT request_snapshot, actor_id, actor_kind, message_id, job_id FROM investigation_requests WHERE id = ? AND investigation_id = ?',
      [requestId, investigationId],
    );
    const request = requests[0],
      snapshot = request && decode(request.request_snapshot),
      frozen = snapshot?.authority as InvestigationAuthoritySnapshot;
    if (
      !request ||
      request.job_id !== job.id ||
      !frozen ||
      frozen.actor.id !== Number(request.actor_id) ||
      frozen.actor.kind !== request.actor_kind
    )
      throw new Error('INVESTIGATION_REQUEST_INVALID');
    const actor = callerFrom(frozen),
      profile = resolveInvestigationProfile(snapshot.profileId, snapshot.profileVersion);
    const base = {
      investigationId,
      requestId,
      jobId: job.id,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
    };
    // A completed/cancelled replay settles its persisted receipt, never dispatches.
    const prior = await this.runs.findByIdempotencyKey(actor.userId, `investigation:${requestId}`);
    if (prior && prior.state !== 'running') {
      await this.transaction((c) => this.canonical.assertInvestigationLease(c, base));
      await this.settle(prior, base);
      return prior;
    }
    let run: AgentRun;
    try {
      await this.bridge.requestAuthority(actor, investigationId, requestId);
      run = await this.transaction((c) => this.runs.claimInvestigation(c, this.canonical, actor, base));
    } catch (error) {
      // Withdrawal before Run creation does not fabricate a competing queued
      // Run state. Keep a failed job for the admission owner to inspect.
      if (!prior) {
        const reason = this.reason(error);
        if (
          !['INVESTIGATION_NOT_FOUND', 'INVESTIGATION_OPERATION_FORBIDDEN', 'INVESTIGATION_CANCELLED'].includes(reason)
        )
          throw error;
        const rejected = await this.transaction((c) => this.runs.rejectInvestigationRequest(c, actor, base, reason));
        await this.settle(rejected, base);
        return rejected;
      }
      const terminal = await this.transaction((c) =>
        this.runs.terminateInvestigation(c, actor, { ...base, runId: prior.id }, 'failed', this.reason(error)),
      );
      await this.settle(terminal, base);
      return terminal;
    }
    const existingState = (run.result as { investigationExecution?: ExecutionState } | undefined)
      ?.investigationExecution;
    // Only a NEW fenced lease may recover another invocation. The same
    // owner/fence in a different service instance cannot reset state or close it.
    if (existingState?.fencingToken === context.fencingToken)
      throw new Error('INVESTIGATION_EXECUTION_ALREADY_RUNNING');
    const binding = { ...base, runId: run.id };
    const control = new AbortController();
    const abort = () => control.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    let checking = false;
    let pendingCheck: Promise<unknown> | undefined;
    // Browser lifecycle never owns this controller. Persisted cancel/live ACL
    // are checked during I/O as well as at every dispatch/checkpoint boundary.
    const timer = setInterval(() => {
      if (checking || control.signal.aborted) return;
      checking = true;
      pendingCheck = this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding))
        .catch((error) => control.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 250);
    const operations = new Set<Promise<unknown>>();
    const observe = (p: Promise<unknown>) => {
      operations.add(p);
      void p.catch(() => {}).finally(() => operations.delete(p));
    };
    try {
      let access = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
      let state: ExecutionState = decode(access.run.result_json)?.investigationExecution;
      if (decode(access.run.result_json)?.completionPending) {
        const completed = await this.transaction((c) =>
          this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
        );
        await this.settle(completed, base);
        return completed;
      }
      const storedBudget = state ? undefined : await this.effectiveBudget.readStored();
      const executionTokenLimit = storedBudget?.runtime.maxExecutionTokens ?? this.options.budget.maxExecutionTokens;
      // Operator settings apply to new Runs. A resumed Run keeps the Profile
      // limits frozen in its own durable state; a MAX-222 allocation keeps its
      // task contract instead of the operator setting.
      const effectiveProfileBudget: Readonly<InvestigationProfile['budget']> = storedBudget
        ? { ...profile.budget, ...storedBudget.profileLimits } : profile.budget;
      const activeAdmission = state ? undefined : resolveAdmissionConfiguration(storedBudget, this.options.budget);
      // A durable receipt or MAX-222 execution domain always wins over the
      // current setting, so an in-flight Run keeps its original domain/policy.
      const domainOf = (request: { execution_domain?: unknown; request_snapshot: unknown }) => {
        const snapshot = decode(request.request_snapshot);
        const receiptDomain = typeof snapshot?.budgetReceipt?.domain === 'string' ? snapshot.budgetReceipt.domain : undefined;
        return request.execution_domain?.toString() ?? receiptDomain ?? activeAdmission?.domain ?? this.options.budget.domain;
      };
      if (!state) {
        state = await this.transaction(async (c) => {
          const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
          const persisted = decode(current.run.result_json)?.investigationExecution as ExecutionState | undefined;
          if (persisted) {
            if (persisted.fencingToken === context.fencingToken)
              throw new Error('INVESTIGATION_EXECUTION_ALREADY_RUNNING');
            return persisted;
          }
          const requestSnapshot = decode(current.request.request_snapshot);
          const receipt = requestSnapshot?.budgetReceipt;
          const mode = actor.principalKind === 'service' ? 'automatic' : 'manual';
          const executionDomain = current.request.execution_domain?.toString() ?? null;
          const receiptDomain = typeof receipt?.domain === 'string' ? receipt.domain : undefined;
          // A request that already holds a durable receipt (or a MAX-222 task
          // domain) keeps its domain across later policy rotations. Only a
          // brand-new manual reservation resolves the current admission policy.
          const domain = executionDomain ?? receiptDomain ?? activeAdmission!.domain;
          const allocation = readExecutionAllocation(requestSnapshot?.executionAllocation, { requestId,
            investigationId, profile, domain, executionDomain,
            mode }, this.options.budget.policy, this.options.budget.taskExecution);
          const runProfileBudget = allocation ? profile.budget : effectiveProfileBudget;
          let reservation: BudgetReservation;
          if (mode === 'automatic' || receipt) {
            reservation = await this.ledger.reuseExecutionInTransaction(c, requestId, {
              domain,
              mode,
              profile,
            }, executionTokenLimit);
          } else {
            const admission = await this.admissionLedger(activeAdmission!).reserveExecutionInTransaction(c, {
              requestId,
              domain,
              mode,
              profile,
              reserveTokens: allocation?.configuration.maxTotalTokens ?? executionTokenLimit ?? profile.budget.maxTokens,
              ...(allocation ? { executionAllocation: allocation } : {}),
              reserveCostMicros: this.options.budget.reserveCostMicros,
              prices: this.options.budget.prices,
            }, executionTokenLimit);
            if (admission.accepted === false) throw new Error(`INVESTIGATION_BUDGET_${admission.reason}`);
            reservation = admission.reservation;
          }
          // An allocation sent without our execution checkpoint is unknown,
          // never a permit to restart the whole Runtime.
          if (reservation.state !== 'reserved') throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          const initial: ExecutionState = {
            schemaVersion: 1,
            requestId,
            jobId: job.id,
            fencingToken: context.fencingToken,
            deadlineAt: Date.now() + runProfileBudget.deadlineMs,
            reservationId: reservation.id,
            reservedTokens: reservation.reservedTokens,
            ...(allocation ? { executionAllocation: allocation, allocationRunId: run.id } : {}),
            profileBudget: runProfileBudget,
            usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
            usageUnknown: false,
            provider: null,
            tools: {},
          };
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [
            JSON.stringify({ investigationExecution: initial }),
            run.id,
          ]);
          await this.canonical.assertInvestigationLease(c, binding);
          return initial;
        });
      }
      const frozenAllocation = readExecutionAllocation(decode(access.request.request_snapshot)?.executionAllocation, {
        requestId, investigationId, profile, domain: domainOf(access.request), executionDomain: access.request.execution_domain?.toString() ?? null,
        mode: actor.principalKind === 'service' ? 'automatic' : 'manual',
      }, this.options.budget.policy, this.options.budget.taskExecution);
      if (allocationHash(frozenAllocation ?? null) !== allocationHash(state.executionAllocation ?? null)
        || frozenAllocation && (state.allocationRunId !== run.id || state.reservedTokens !== frozenAllocation.configuration.maxTotalTokens))
        throw new Error('INVESTIGATION_ALLOCATION_INVALID');
      const executionBudget = frozenAllocation ? { ...(state.profileBudget ?? profile.budget), maxToolCalls: frozenAllocation.configuration.maxToolCalls,
        maxProviderAttempts: frozenAllocation.configuration.maxProviderAttempts, deadlineMs: frozenAllocation.configuration.deadlineMs }
        : state.profileBudget ?? effectiveProfileBudget;
      if (state.schemaVersion !== 1 || state.requestId !== requestId || state.jobId !== job.id)
        throw new Error('INVESTIGATION_CHECKPOINT_INVALID');
      const update = async (work: (s: ExecutionState, c: InvestigationConnection) => void | Promise<void>) =>
        this.transaction(async (c) => {
          const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
          const result = decode(current.run.result_json),
            next: ExecutionState = result.investigationExecution;
          await work(next, c);
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [
            JSON.stringify({ ...result, investigationExecution: next }),
            run.id,
          ]);
          await this.canonical.assertInvestigationLease(c, binding);
          state = next;
        });
      await update((s) => {
        s.fencingToken = context.fencingToken;
      });
      const readReceipt = async (c: InvestigationConnection) => {
        const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
        const currentAllocation = readExecutionAllocation(decode(current.request.request_snapshot)?.executionAllocation, {
          requestId, investigationId, profile, domain: domainOf(current.request), executionDomain: current.request.execution_domain?.toString() ?? null,
          mode: actor.principalKind === 'service' ? 'automatic' : 'manual',
        }, this.options.budget.policy, this.options.budget.taskExecution);
        const currentState = decode(current.run.result_json)?.investigationExecution;
        if (allocationHash(currentAllocation ?? null) !== allocationHash(frozenAllocation ?? null)
          || allocationHash(currentState?.executionAllocation ?? null) !== allocationHash(frozenAllocation ?? null)
          || frozenAllocation && currentState?.allocationRunId !== run.id) throw new Error('INVESTIGATION_ALLOCATION_INVALID');
        const reservation = await this.ledger.reuseExecutionInTransaction(c, requestId, {
          domain: domainOf(current.request),
          mode: actor.principalKind === 'service' ? 'automatic' : 'manual',
          profile,
        }, executionTokenLimit);
        if (reservation.id !== state.reservationId || reservation.reservedTokens !== state.reservedTokens)
          throw new Error('BUDGET_CONFLICT');
        await this.canonical.assertInvestigationLease(c, binding);
        return reservation;
      };
      let receipt = await this.transaction(async (c) => {
        await this.canonical.lockInvestigationExecution(c, actor, binding);
        return readReceipt(c);
      });
      if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
      let checkpoint = access.checkpoint?.canonical_run_id === run.id ? access.checkpoint : undefined;
      if (checkpoint && checkpoint.canonical_turn_id !== access.messageId)
        throw new Error('INVESTIGATION_CHECKPOINT_INVALID');
      // Runtime response_ready is durable evidence to stage the same answer.
      // An unaccepted candidate or any other terminal checkpoint must never
      // re-enter the model loop after an OS exit.
      if (checkpoint?.terminal_resolution || checkpoint?.phase === 'final_response' || state.terminal?.source === 'tool_receipt') {
        // A fatal-tool checkpoint can precede Runtime's terminal checkpoint.
        // Its durable receipt closes this execution after a process exit too.
        const resolution = (checkpoint?.terminal_resolution ?? (state.terminal?.source === 'tool_receipt'
          ? { kind: 'partial', reasonCode: state.terminal.reasonCode } : undefined)) as { kind?: string; reasonCode?: string } | undefined;
        const candidate = checkpoint?.assistantMessage as Message | undefined;
        if (
          resolution?.kind === 'response_ready' &&
          checkpoint?.phase === 'final_response' &&
          candidate?.role === 'assistant' &&
          typeof candidate.content === 'string' &&
          !candidate.tool_calls?.length
        ) {
          await this.transaction((c) =>
            this.runs.stageInvestigationCompletion(c, this.canonical, actor, binding, {
              type: 'complete',
              stopReason: 'completed',
              finalContent: redactSensitiveText(candidate.content as string),
              resolution: { kind: 'response_ready', reasonCode: 'RUNTIME_RESPONSE_READY', retryable: false },
            }),
          );
          const completed = await this.transaction((c) =>
            this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
          );
          await this.settle(completed, base);
          return completed;
        }
        if (!resolution) {
          await update((s) => {
            s.usageUnknown = true;
          });
          throw new Error('INVESTIGATION_FINAL_RESPONSE_UNKNOWN');
        }
        await update(s => {
          const terminal = investigationStop(checkpoint ?? {});
          if (!s.terminal || terminal.reasonCode !== 'INVESTIGATION_RUNTIME_PARTIAL') s.terminal = terminal;
        });
        const terminalState =
          resolution.kind === 'cancelled' ? 'cancelled' : resolution.kind === 'timed_out' ? 'timed_out' : 'partial';
        const terminal = await this.transaction((c) =>
          this.runs.terminateInvestigation(
            c,
            actor,
            binding,
            terminalState,
            state.terminal?.reasonCode ?? investigationStop(checkpoint ?? {}).reasonCode,
          ),
        );
        await this.settle(terminal, base);
        return terminal;
      }
      const pending = (checkpoint?.pendingToolCalls ?? checkpoint?.pending_tool_calls) as any[] | undefined;
      if (pending?.length) {
        if (pending.some((call) => state.tools[call.id]?.status !== 'returned'))
          throw new Error('INVESTIGATION_TOOL_UNKNOWN');
        checkpoint = {
          ...checkpoint,
          phase: 'tools_completed',
          pendingToolCalls: [],
          completedToolResults: pending.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: profile.id === 'system' ? JSON.stringify(state.tools[call.id].result) : JSON.stringify(state.tools[call.id].result, null, 2),
          })),
        };
        await this.persistCheckpoint(actor, binding, checkpoint);
      }
      if ((checkpoint?.context_request_v1 as any)?.status === 'rejected') throw new Error('SUMMARY_INVALID');
      if (Date.now() >= state.deadlineAt) throw new Error('INVESTIGATION_DEADLINE');
      const actual = await runtime.providerForPurpose(profile.modelScene);
      const model = actual.getDefaultModel();
      const modelCapabilities = actual.getModelCapabilities?.();
      // The task deployment can choose a smaller allocation within verified
      // provider capacity. Once persisted, an in-flight run keeps its allocation.
      const legacyContext = this.options.contextInputLimit === undefined ? undefined
        : {...investigationContextLimits(modelCapabilities?.contextWindowTokens, this.options.contextInputLimit),
          maxTokens: Math.min(4096, modelCapabilities?.preferredOutputTokens ?? 4096, modelCapabilities?.maxOutputTokens ?? 4096)};
      const configuredRuntime = storedBudget ? { contextWindowTokens: storedBudget.runtime.contextWindowTokens,
        maxTokens: storedBudget.runtime.outputTokens, summaryMaxTokens: storedBudget.runtime.summaryOutputTokens } : this.options.runtimeContext;
      const runtimeContext = resolveInvestigationRuntime(modelCapabilities, configuredRuntime,
        frozenAllocation ? { contextWindowTokens: frozenAllocation.configuration.contextWindowTokens,
          maxTokens: frozenAllocation.configuration.maxTokens, summaryMaxTokens: frozenAllocation.configuration.summaryMaxTokens }
          : state.runtimeContext ?? legacyContext);
      const modelPrompt = investigationPrompt(profile) + (profile.id === 'ops'
        ? investigationToolPolicy(snapshot.resources, executionBudget) + MODEL_ANALYSIS_POLICY : '');
      await update(s => {
        s.runtimeContext = runtimeContext;
        const identity = analysisProviderIdentity(actual);
        s.provenance = { modelVersion: model, promptVersion: `${profile.id}@${profile.version}/prompt:${profile.prompt.version}/sha256:${createHash('sha256').update(modelPrompt).digest('hex')}`,
          ...(identity.providerId === undefined ? {} : { providerId: identity.providerId }),
          ...(identity.routeVersion === 'unavailable' ? {} : { routeVersion: identity.routeVersion }) };
      });
      let modelMessageId: string | undefined;
      let modelSourceRequestId: string | undefined;
      const dispatch = async (send: () => Promise<LLMResponse>, input: unknown, identity?: any): Promise<LLMResponse> => {
        control.signal.throwIfAborted();
        if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
        if(identity && (identity.purpose!=='summary' || !uuid.test(identity.id) || !/^[a-f0-9]{64}$/.test(identity.sourceHash)))throw Error('INVESTIGATION_PROVIDER_UNKNOWN');
        const id = identity?.id ?? randomUUID();
        await update(async (s, c) => {
          // Recheck the immutable receipt at each new intent, including after
          // tool I/O and recovery. Neither a stale snapshot nor model/event
          // supplied lane/domain may authorize this provider call.
          receipt = await readReceipt(c);
          if (s.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          if (s.provenance && !s.provenance.inputHash) s.provenance.inputHash = hash(input);
          s.provider = { ...(identity ? {purpose:'summary' as const, sourceHash:identity.sourceHash}:{}), id, inputHash: hash(input), ...(identity ? {} : {sourceRequestId: modelSourceRequestId}), messageId: identity ? null : modelMessageId ?? null, status: 'sent' };
        });
        // The entire execution allocation stays sent through all subsequent
        // turns. Only the Run's durable terminal receipt may release it.
        // markSent gates the first dispatch of this whole request. Further
        // model turns are distinct intents within the same allocation; a
        // recovered sent intent is rejected above, never replayed here.
        if (receipt.state === 'reserved') {
          const sent = await this.ledger.markSent(state.reservationId);
          if (!sent.dispatchAllowed) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          receipt.state = 'sent';
        } else if (receipt.state !== 'sent') throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
        let started = false;
        const beginSend = () => { control.signal.throwIfAborted(); started = true; return send(); };
        let response: LLMResponse;
        try {
          const egress = await this.transaction(async c => {
            await this.canonical.lockInvestigationExecution(c, actor, binding);
            if (profile.id !== 'ops' || profile.version !== 2) return { actor, refs: [] };
            const live = await this.authorization.authorize(c, actor, await this.authorization.load(c, investigationId), 'continue', [], frozen);
            return { actor: live.actor, refs: await this.cases.load(c, investigationId) };
          });
          response = await this.cases.send(egress.actor, egress.refs, beginSend, async c => {
            await this.canonical.lockInvestigationExecution(c as unknown as InvestigationConnection, actor, binding);
          });
        } catch (error) {
          // A failed final reference check did not send a provider request.
          // Preserve earlier usage, without inventing unknown usage/noReplay.
          if (!started) await this.transaction(async c => {
            // Cleanup has no content side effect and must remain possible
            // after ACL withdrawal. Follow the terminal owner's lock order,
            // proving the exact original request, actor, Run and live fence.
            await c.query('SELECT session_id FROM chat_sessions WHERE session_id=? FOR UPDATE', [run.sessionId]);
            await c.query('SELECT id FROM investigations WHERE id=? FOR UPDATE', [investigationId]);
            const [request] = await c.query<any[]>('SELECT message_id,job_id FROM investigation_requests WHERE id=? AND investigation_id=? FOR UPDATE', [requestId, investigationId]);
            await this.canonical.assertInvestigationLease(c, binding);
            const [rows] = await c.query<any[]>('SELECT result_json FROM agent_runs WHERE id=? AND actor_id=? AND session_id=? AND message_id=? AND idempotency_key=? AND state=\'running\' FOR UPDATE',
              [run.id, actor.userId, run.sessionId, request[0]?.message_id, `investigation:${requestId}`]);
            if (request[0]?.job_id !== job.id || !rows.length) throw new Error('INVESTIGATION_RUN_INVALID');
            const result = decode(rows[0].result_json), next: ExecutionState = result.investigationExecution;
            if (next.provider?.id !== id || next.fencingToken !== context.fencingToken) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
            next.provider = null;
            await c.query('UPDATE agent_runs SET result_json=? WHERE id=?', [JSON.stringify(result), run.id]);
            state = next;
          });
          throw error;
        }
        control.signal.throwIfAborted();
        const usage = usageOf(response);
        await update((s) => {
          if (s.provider?.id !== id) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
          s.provider.status = 'received';
          if (identity || response.finishReason === 'length') s.provider.response = structuredClone(response);
          if (!usage) s.usageUnknown = true;
          else {
            s.usage.inputTokens += usage.inputTokens;
            s.usage.cachedInputTokens += usage.cachedInputTokens;
            s.usage.outputTokens += usage.outputTokens;
          }
        });
        return response;
      };
      const provider: LLMProvider = {
        getDefaultModel: () => model,
        getModelCapabilities: actual.getModelCapabilities?.bind(actual),
        countPromptTokens: actual.countPromptTokens?.bind(actual),
        projectMessages: (messages, model) => investigationContextMessages(actual.projectMessages?.(messages, model) ?? messages, profile.id),
        chat: (messages, tools, options) => dispatch(() => actual.chat(messages, tools, options), [messages, tools], (options as any)?.requestIdentity),
        chatStream: (messages, tools, callbacks, options) =>
          dispatch(() => actual.chatStream(messages, tools, callbacks, options), [messages, tools], (options as any)?.requestIdentity),
      };
      // Keep lossless JSON in Runtime facts/checkpoints and SQL evidence.
      // Only provider.projectMessages above may replace it with a reference.
      const contextToolResult = (result: unknown, _toolId: string) => result !== null && typeof result === 'object'
        && (result as { success?: boolean }).success === true && (result as { status?: string }).status !== 'error'
        ? JSON.stringify(result) : result;
      let currentToolId: string | undefined;
      let fatalToolFailure: { toolCallId: string; stop: InvestigationStop } | undefined;
      const effective = await this.transaction(async (c) =>
        this.authorization.authorize(
          c,
          actor,
          await this.authorization.load(c, investigationId),
          'continue',
          [],
          frozen,
        ),
      );
      const scopedRegistry = (actor: ActorContext) => {
        if (profile.id === 'system') return this.options.systemToolsForInvestigation?.(actor, snapshot) ?? new ToolRegistry();
        const base = runtime.toolsForActor(actor), registry = new ToolRegistry();
        for (const name of base.toolNames) registry.register(base.get(name)!);
        if (profile.version === 2) this.cases.register(registry, actor);
        return registry;
      };
      const source = scopedRegistry(effective.actor),
        tools = new ToolRegistry();
      for (const name of effective.tools) {
        const tool = source.get(name),
          security = getToolSecurityDefinition(name);
        if (
          !tool ||
          !(profile.id === 'system' ? !!this.options.systemToolsForInvestigation && profile.toolAllowlist.includes(name) : BACKGROUND_SAFE.has(name)) ||
          !tool.readOnly ||
          tool.requiresApproval ||
          tool.ownerOnly ||
          security?.effect !== 'read'
        )
          continue;
        const contract = profile.id === 'system' ? tool : investigationToolContract(tool, snapshot.resources, executionBudget);
        if (!contract) continue;
        tools.register({
          ...tool,
          ...contract,
          concurrencySafe: false,
          exclusive: true,
          timeoutMs: Math.min(tool.timeoutMs ?? 10_000, 10_000),
          execute: async (value, toolContext) => {
            const toolId = currentToolId;
            if (!toolId) throw new Error('INVESTIGATION_TOOL_BINDING_INVALID');
            let wrote = false, started = false;
            try {
              toolContext?.signal?.throwIfAborted();
              control.signal.throwIfAborted();
              const { args, targets } = boundedInvestigationArguments(name, value, executionBudget, Date.now());
              const live = await this.transaction(async (c) => {
                await this.canonical.lockInvestigationExecution(c, actor, binding);
                await readReceipt(c);
                return this.authorization.authorizeTool(
                  c,
                  actor,
                  await this.authorization.load(c, investigationId),
                  frozen,
                  name,
                  targets.length
                    ? targets
                    : security.resource === 'instance'
                      ? snapshot.resources.filter((r: any) => r.type === 'instance')
                      : [],
                );
              });
              const existing = state.tools[toolId];
              if (existing) {
                if (existing.inputHash !== hash(args) || existing.name !== name || existing.status !== 'returned')
                  throw new Error('INVESTIGATION_TOOL_UNKNOWN');
                return contextToolResult(existing.result, toolId);
              }
              await update((s) => {
                s.tools[toolId] = { name, inputHash: hash(args), status: 'running' };
              });
              wrote = true;
              toolContext?.signal?.throwIfAborted();
              control.signal.throwIfAborted();
              const liveTool = scopedRegistry(live.actor).get(name);
              if (!liveTool?.readOnly || liveTool.requiresApproval || liveTool.ownerOnly)
                throw new Error('INVESTIGATION_TOOL_FORBIDDEN');
              started = true;
              const result = boundedResult(
                await liveTool.execute(args, { ...toolContext, signal: toolContext?.signal ?? control.signal }),
                executionBudget.maxRows,
                executionBudget.maxBytes,
              );
              toolContext?.signal?.throwIfAborted();
              control.signal.throwIfAborted();
              await this.transaction(async c => {
                await this.canonical.lockInvestigationExecution(c, actor, binding);
                await this.authorization.authorizeTool(c, actor, await this.authorization.load(c, investigationId), frozen, name,
                  targets.length ? targets : security.resource === 'instance' ? snapshot.resources.filter((r: any) => r.type === 'instance') : []);
              });
              await update(async (s, c) => {
                if (name === 'search_case_references') await this.cases.retain(c, investigationId, result);
                s.tools[toolId] = { name, inputHash: hash(args), status: 'returned', result };
              });
              return contextToolResult(result, toolId);
            } catch (error) {
              // Only this wrapper knows the original handler was never entered, so only here may it withdraw its
              // own write-ahead record; reliable model usage then stays known. Once the handler started, a throw,
              // timeout or abort leaves the record running and the whole execution unknown. If the withdrawal
              // cannot be persisted the record also stays running (fail closed).
              if (wrote && !started)
                await update((s) => { if (s.tools[toolId]?.status === 'running') delete s.tools[toolId]; }).catch(() => undefined);
              // failOnToolError is enabled: an actual thrown tool exception is
              // fatal. Returned Error text and Core's repeat guard are not.
              fatalToolFailure ??= { toolCallId: toolId, stop: { ...investigationStop({ stopReason: 'tool_error',
                error: `Error: ${error instanceof Error ? error.message : String(error)}` }), source: 'tool_receipt' } };
              throw error;
            }
          },
        });
      }
      const messages: SessionEntry[] = [];
      let before: string | undefined;
      do {
        const page = await this.transaction((c) =>
          this.canonical.getInvestigationPage(c, actor, binding, 1000, before),
        );
        messages.unshift(...page.messages);
        before = page.nextBefore ?? undefined;
        if (messages.length > 10_000) throw new Error('INVESTIGATION_HISTORY_LIMIT');
      } while (before);
      const initialMessages: Message[] = [
        {
          role: 'system',
          source: 'runtime',
          contextAuthority: 'policy',
          content: modelPrompt,
        },
        ...(profile.id === 'system' ? systemInvestigationHistory(messages) : messages),
      ];
      const hook = new NoopHook();
      hook.beforeIteration = async (ctx) => {
        modelMessageId = ctx.messageId;
        modelSourceRequestId = ctx.sourceRequestId;
      };
      const result = await new AgentRunner(provider).run({
        runtimeRunId: run.id,
        initialMessages,
        tools,
        model,
        ...runtimeContext,
        maxIterations: executionBudget.maxProviderAttempts,
        // Context admission must reserve the same configured output ceiling
        // as dispatch, including qualification-only reductions. Keep the
        // configured context and execution-token ceilings unchanged.
        maxTokens: Math.min(runtimeContext.maxTokens, state.reservedTokens),
        maxToolResultChars: executionBudget.maxBytes,
        budgetLimits: {
          maxToolCalls: executionBudget.maxToolCalls,
          maxProviderAttempts: executionBudget.maxProviderAttempts,
          maxTotalTokens: state.reservedTokens,
          maxNoProgressSteps: executionBudget.maxProviderAttempts,
        },
        runTimeoutMs: Math.max(1, state.deadlineAt - Date.now()),
        toolTimeoutMs: 10_000,
        llmTimeoutS: Math.max(1, (state.deadlineAt - Date.now()) / 1000),
        concurrentTools: false,
        failOnToolError: true,
        hook,
        signal: control.signal,
        sessionKey: access.sessionId,
        idempotencyKey: `investigation:${requestId}`,
        resumeCheckpoint: checkpoint,
        recoveryLimits: { total: 0, empty: 0, continuation: 0, stream: 0, repetition: 0, context: 0 },
        // System uses deterministic history references; do not attempt an
        // unbudgeted summary at the soft watermark. The hard context cap stays.
        contextPolicy: {summaryMaxTokens: runtimeContext.summaryMaxTokens,
          ...(profile.id === 'system' ? {watermark: 1, target: 0.5}
            : profile.id === 'ops' ? {recentToolBatches: 1 as const, evidenceReferences: 'canonical' as const} : {})},
        ...(profile.id === 'ops' ? { contextEvidence: (source: readonly Message[], summary) => investigationExecutionEvidence(source, state, binding,
          initialMessages.length, summary) } : {}),
        onProviderRequest: observe,
        onToolExecution: observe,
        onToolEvent: async (e) => {
          if (e.phase === 'running' && !e.progress) currentToolId = e.toolCallId;
        },
        checkpointCallback: async (payload) => {
          const fatalStop = payload.phase === 'tools_completed' && fatalToolFailure
            && (payload.completedToolResults as Message[] | undefined)?.some(t => t.tool_call_id === fatalToolFailure!.toolCallId)
            ? fatalToolFailure.stop : undefined;
          await this.persistCheckpoint(actor, binding, payload, fatalStop);
          const current = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
          state = decode(current.run.result_json).investigationExecution;
          if (!state.provider) modelMessageId = undefined;
        },
      });
      // Runtime races cancellation/timeouts against the original I/O promise.
      // Finish its fenced writes (including known-unsent cleanup) while this
      // Run is still running, before reading the terminal receipt or settling.
      await Promise.allSettled(operations);
      access = await this.transaction((c) => this.canonical.lockInvestigationExecution(c, actor, binding));
      state = decode(access.run.result_json).investigationExecution;
      if (state.provider) throw new Error('INVESTIGATION_PROVIDER_UNKNOWN');
      if (Object.values(state.tools).some((t) => t.status === 'running')) throw new Error('INVESTIGATION_TOOL_UNKNOWN');
      await update(s => { s.terminal = investigationStop(result); });
      let terminal: AgentRun;
      if (result.stopReason === 'completed' && (!result.resolution || result.resolution.kind === 'response_ready')) {
        await this.transaction((c) =>
          this.runs.stageInvestigationCompletion(c, this.canonical, actor, binding, {
            type: 'complete',
            stopReason: 'completed',
            finalContent: redactSensitiveText(result.finalContent ?? ''),
            resolution: result.resolution ?? {
              kind: 'response_ready',
              reasonCode: 'RUNTIME_RESPONSE_READY',
              retryable: false,
            },
          }),
        );
        terminal = await this.transaction((c) =>
          this.runs.recoverInvestigationCompletion(c, this.canonical, actor, binding),
        );
      } else {
        const terminalState: Exclude<AgentRunState, 'running' | 'completed'> =
          result.resolution?.kind === 'timed_out'
            ? 'timed_out'
            : result.resolution?.kind === 'cancelled'
              ? 'cancelled'
              : 'partial';
        terminal = await this.transaction((c) =>
          this.runs.terminateInvestigation(
            c,
            actor,
            binding,
            terminalState,
            state.terminal!.reasonCode,
          ),
        );
      }
      await this.settle(terminal, base);
      return terminal;
    } catch (error) {
      await Promise.allSettled(operations);
      let code = this.reason(control.signal.aborted ? control.signal.reason : error);
      const persisted = await this.runs.getForActor(binding.runId, actor.userId, run.sessionId);
      if (persisted?.state === 'running' && (persisted.result as { completionPending?: boolean })?.completionPending && !control.signal.aborted) {
        // Completion storage failed after the durable answer intent. Preserve it
        // for a new fenced invocation; never turn it into failed or call a model.
        let live = false;
        try { await this.transaction(c => this.canonical.lockInvestigationExecution(c, actor, binding)); live = true; }
        catch (authorityError) { code = this.reason(authorityError); }
        if (live) throw error;
      }
      if (
        code === 'INVESTIGATION_FENCE_LOST' ||
        code === 'INVESTIGATION_EXECUTION_ALREADY_RUNNING' ||
        context.signal.aborted
      )
        throw error; // new owner alone recovers
      const state =
        code === 'INVESTIGATION_CANCELLED'
          ? 'cancelled'
          : code === 'INVESTIGATION_DEADLINE'
            ? 'timed_out'
            : /UNKNOWN/.test(code)
              ? 'partial'
              : 'failed';
      const terminal = await this.transaction((c) => this.runs.terminateInvestigation(c, actor, binding, state, code));
      await this.settle(terminal, base);
      return terminal;
    } finally {
      clearInterval(timer);
      context.signal.removeEventListener('abort', abort);
      await pendingCheck;
      // Provider/tool I/O can outlive the Runtime boundary. Collect them before
      // handing off; late writes re-check signal and the current SQL fence.
      await Promise.allSettled(operations);
    }
  }
  private async persistCheckpoint(
    actor: ActorContext,
    binding: InvestigationExecutionBinding,
    payload: Record<string, unknown>,
    fatalToolStop?: InvestigationStop,
  ): Promise<void> {
    await this.transaction(async (c) => {
      const access = await this.canonical.lockInvestigationExecution(c, actor, binding);
      const checkpoint = { ...payload, canonical_run_id: binding.runId, canonical_turn_id: access.messageId };
      const facts = checkpointFacts(checkpoint, binding.runId)
        .filter((m) => m.role === 'tool' || m.tool_calls?.length)
        .map((m) => {
          // Core checkpoints default their turn to runtimeRunId before the caller
          // binds the admitted user fact. Preserve Parts and generating identity,
          // while assigning the same persisted turn on every replay.
          const doc = m.messageParts && structuredClone(m.messageParts);
          if (doc) {
            doc.runId = binding.runId;
            doc.turnId = access.messageId;
            doc.legacy.runId = binding.runId;
            doc.legacy.turnId = access.messageId;
          }
          return { ...m, runId: binding.runId, turnId: access.messageId, ...(doc ? { messageParts: doc } : {}) };
        });
      const acknowledged = facts.map((m) =>
        persistedMessageParts(
          m,
          'checkpoint',
          m.tool_calls?.some((call) => !facts.some((result) => result.tool_call_id === call.id))
            ? 'partial'
            : 'completed',
        ),
      );
      // Retain each fact's generating boundary in both the persisted and Core
      // checkpoint. A new model attempt must not re-stamp prior tool results.
      if (payload.assistantMessage && facts.some((m) => m.role === 'assistant'))
        payload.assistantMessage = acknowledged.find((m) => m.role === 'assistant');
      if (Array.isArray(payload.completedToolResults))
        payload.completedToolResults = acknowledged.filter((m) => m.role === 'tool');
      Object.assign(checkpoint, payload, { canonical_run_id: binding.runId, canonical_turn_id: access.messageId });
      await this.canonical.appendInvestigationToolFacts(
        c,
        actor,
        binding,
        facts,
        Number(payload.iteration ?? 0),
        checkpoint,
      );
      {
        const result = decode(access.run.result_json), state: ExecutionState = result?.investigationExecution;
        if(acknowledgeSummary(state?.provider, payload)) {
          state.lastSummaryReceipt = { ...payload.context_request_v1 as object, response:state.provider!.response };
          state.provider = null;
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [JSON.stringify(result), binding.runId]);
        }
      }
      if (payload.phase === 'rejected_final_response') {
        const result = decode(access.run.result_json), state: ExecutionState = result?.investigationExecution;
        const provider = state?.provider, receipt = payload.model_response_v1 as any;
        const candidate = payload.assistantMessage as Message | undefined;
        if (provider) {
          // This transaction already proved the live actor, original request,
          // Run/session/turn and lease/fence. A hash-bound raw length receipt is
          // additionally required: a received flag alone never permits refund.
          if (state.schemaVersion !== 1 || state.requestId !== binding.requestId || state.jobId !== binding.jobId
            || state.fencingToken !== binding.fencingToken || !uuid.test(provider.id)
            || !/^[a-f0-9]{64}$/.test(provider.inputHash) || receipt?.inputHash !== provider.inputHash
            || !provider.sourceRequestId || receipt.sourceRequestId !== provider.sourceRequestId
            || (payload.stream_state_v1 as any)?.sourceRequestId !== provider.sourceRequestId
            || provider.purpose || provider.status !== 'received' || !provider.response || !usageOf(provider.response)
            || state.usageUnknown || !provider.messageId || receipt?.messageId !== provider.messageId
            || candidate?.id !== provider.messageId || candidate.role !== 'assistant'
            || candidate.content !== provider.response.content || candidate.tool_calls?.length || provider.response.toolCalls.length
            || provider.response.error || provider.response.errorKind || provider.response.finishReason !== 'length'
            || receipt.status !== 'rejected' || receipt.reasonCode !== 'OUTPUT_LIMIT'
            || (payload.terminal_resolution as any)?.kind !== 'partial'
            || (payload.terminal_resolution as any)?.reasonCode !== 'OUTPUT_LIMIT'
            || canonicalReceiptHash(provider.response) !== receipt.responseHash) throw Error('INVESTIGATION_PROVIDER_UNKNOWN');
          state.lastProviderReceipt = { ...provider, ...receipt, response: provider.response };
          state.provider = null;
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [JSON.stringify(result), binding.runId]);
        }
      }
      if (['awaiting_tools', 'tools_completed', 'final_response', 'rejected_tool_batch'].includes(String(payload.phase))) {
        const result = decode(access.run.result_json),
          state: ExecutionState = result?.investigationExecution;
        if (
          state?.provider?.purpose !== 'summary' && state?.provider?.status === 'received' &&
          state.provider.messageId &&
          (payload.assistantMessage as { id?: string } | undefined)?.id === state.provider.messageId
        ) {
          state.provider = null;
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [JSON.stringify(result), binding.runId]);
        }
      }
      if (payload.terminal_resolution || fatalToolStop) {
        const current = await this.canonical.lockInvestigationExecution(c, actor, binding);
        const result = decode(current.run.result_json), state: ExecutionState = result?.investigationExecution;
        if (state) {
          const terminal = payload.terminal_resolution ? investigationStop(payload) : fatalToolStop!;
          if (!state.terminal || terminal.reasonCode !== 'INVESTIGATION_RUNTIME_PARTIAL') state.terminal = terminal;
          await c.query('UPDATE agent_runs SET result_json = ? WHERE id = ?', [JSON.stringify(result), binding.runId]);
        }
      }
      await this.canonical.assertInvestigationLease(c, binding);
    });
  }
  private async settle(run: AgentRun, binding: Omit<InvestigationExecutionBinding, 'runId'>): Promise<void> {
    const state = (run.result as { investigationExecution?: ExecutionState } | undefined)?.investigationExecution;
    if (!state) {
      // Live withdrawal/cancel can reject an admitted request before Runtime
      // checkpoint creation. The persisted terminal, original binding and
      // current lease authorize accounting cleanup, never provider dispatch.
      const reservation = await this.transaction(async (c) => {
        await c.query('SELECT session_id FROM chat_sessions WHERE session_id=? FOR UPDATE', [run.sessionId]);
        const [investigations] = await c.query<any[]>('SELECT session_id FROM investigations WHERE id=? FOR UPDATE', [
          binding.investigationId,
        ]);
        const [requests] = await c.query<any[]>('SELECT * FROM investigation_requests WHERE id=? FOR UPDATE', [
          binding.requestId,
        ]);
        await this.canonical.assertInvestigationLease(c, binding);
        const [runs] = await c.query<any[]>('SELECT * FROM agent_runs WHERE id=? FOR UPDATE', [run.id]);
        const request = requests[0],
          terminal = runs[0],
          snapshot = request && decode(request.request_snapshot);
        if (
          !terminal ||
          terminal.state === 'running' ||
          terminal.session_id !== run.sessionId ||
          investigations[0]?.session_id !== run.sessionId ||
          request?.investigation_id !== binding.investigationId ||
          request.job_id !== binding.jobId ||
          request.message_id !== terminal.message_id ||
          Number(request.actor_id) !== Number(terminal.actor_id) ||
          terminal.idempotency_key !== `investigation:${binding.requestId}` ||
          snapshot?.authority?.actor?.id !== Number(request.actor_id) ||
          snapshot?.authority?.actor?.kind !== request.actor_kind
        )
          throw new Error('INVESTIGATION_EXECUTION_INVALID');
        if (!snapshot.budgetReceipt) return null;
        // Settlement reads the receipt's own durable domain; a rotated policy
        // must never redirect cleanup/refund to the new domain.
        const receiptDomain = snapshot.budgetReceipt.domain;
        if (typeof receiptDomain !== 'string' || !receiptDomain) throw new Error('INVESTIGATION_EXECUTION_INVALID');
        return this.ledger.reuseExecutionInTransaction(c, binding.requestId, {
          domain: receiptDomain,
          mode: request.actor_kind === 'service' ? 'automatic' : 'manual',
          profile: resolveInvestigationProfile(snapshot.profileId, snapshot.profileVersion),
        });
      });
      if (reservation?.state === 'reserved') await this.ledger.cancelUnsent(reservation.id);
      else if (reservation && ['sent', 'unknown'].includes(reservation.state))
        await this.ledger.settle(reservation.id, null);
      return;
    }
    const reservation = await this.ledger.read(state.reservationId);
    if (reservation.state === 'reserved') {
      if (state.provider) {
        await this.ledger.markSent(reservation.id);
        await this.ledger.settle(reservation.id, null);
      } else await this.ledger.cancelUnsent(reservation.id);
      return;
    }
    const unknown =
      state.usageUnknown || !!state.provider || Object.values(state.tools).some((t) => t.status === 'running');
    await this.ledger.settle(reservation.id, unknown ? null : state.usage);
  }
  private reason(error: unknown): string {
    if (error instanceof ActorAuthenticationError) return 'INVESTIGATION_NOT_FOUND';
    const message = error instanceof Error ? error.message : String(error);
    return /^[A-Z][A-Z0-9_]{0,127}$/.test(message) ? message : 'INVESTIGATION_EXECUTION_FAILED';
  }
}
