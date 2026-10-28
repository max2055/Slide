/**
 * MAX-238 / B2C — isolated selected-only release plans.
 *
 * `buildTemplateCollectionPlan` turns one accepted {@link ResolvedTemplateBinding}
 * into per-exact-release execution plans. It is a pure projection: no registry,
 * store, scheduler, credential or route is touched, nothing is persisted or
 * applied, and the legacy single-package branch never reaches it. Each release
 * keeps its own plan; only collectors of the same release whose resolved
 * parameters also agree may share a query. See
 * `docs/slide/development/MAX-238/b2c-resolver-plan.md`.
 */
import { createHash } from 'node:crypto';
import type { ApplicabilityCheck } from '../packages/applicability.js';
import { stable } from '../packages/model.js';
import { metricKey, type Settings } from '../policy/model.js';
import { groupQueries, jitterFor, requestsPerHour } from '../scheduler/compiler.js';
import type { CollectorPlan } from '../scheduler/compiler.js';
import type { Capability, CollectorDefinition } from '../../contracts/metrics/index.js';
import type { MetricRef, PackageReleaseRef } from '../templates/model.js';
import {
  templateResolutionIdentity,
  type ResolvedTemplateBinding, type ResolvedTemplateExclusion, type ResolvedTemplateItem,
  type ResolvedTemplateParameters, type TemplateSettingSource,
} from './resolve.js';

export type TemplatePlanErrorCode = 'PLAN_INPUT_INVALID' | 'PLAN_RELEASE_INCONSISTENT' | 'PLAN_SERIES_BUDGET';

export class TemplatePlanError extends Error {
  constructor(
    public readonly code: TemplatePlanErrorCode,
    public readonly release: PackageReleaseRef | null = null,
  ) {
    super(code);
    this.name = 'TemplatePlanError';
  }
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const copyRef = (release: PackageReleaseRef): PackageReleaseRef => ({
  id: release.id, version: release.version, digest: release.digest,
});

/** One executable item inside a step; qualified identity and ordered mapping are kept. */
export interface TemplatePlanItem {
  pin: ResolvedTemplateItem['pin'];
  template_id: string;
  item_id: string;
  item_version: number;
  canonical_metric: MetricRef;
  unit: ResolvedTemplateItem['unit'];
  dimensions: ResolvedTemplateItem['dimensions'];
  mapping: ResolvedTemplateItem['mapping'];
  capability: Capability;
}

/** One selected collector read of one exact release with one resolved parameter signature. */
export interface TemplatePlanStep {
  release: PackageReleaseRef;
  release_ref: string;
  collector_id: string;
  implementation_id: string;
  method: ResolvedTemplateItem['method'];
  estimated_cost: CollectorDefinition['estimated_cost'];
  timeout_ms: number;
  timeout_source: TemplateSettingSource;
  logical_reads: number;
  /** Identity of the effective parameter values shared by every item of this step. */
  parameter_signature: string;
  metrics: MetricRef[];
  items: TemplatePlanItem[];
}

export interface TemplateReleasePlan {
  release: PackageReleaseRef;
  release_ref: string;
  interval_ms: number;
  timeout_ms: number;
  jitter_ms: number;
  applicability: ApplicabilityCheck[];
  collector_ids: string[];
  metric_keys: string[];
  queries: CollectorPlan['queries'];
  requests_per_hour_estimate: number;
  steps: TemplatePlanStep[];
}

export interface TemplateCollectionPlan {
  kind: 'template_collection_plan';
  internal: true;
  persisted: false;
  applied: false;
  /** False when the resolution blocks (unsupported/unknown), is switched off or has no runnable step. */
  executable: boolean;
  identity: string;
  resource: { type: ResolvedTemplateBinding['resource']['type']; id: string };
  revision: number;
  settings: Settings;
  parameters: ResolvedTemplateParameters[];
  /** Unresolved trigger references travel with the plan; no trigger has been evaluated. */
  triggers: ResolvedTemplateBinding['triggers'];
  releases: TemplateReleasePlan[];
  excluded: ResolvedTemplateExclusion[];
  budget: {
    estimate: true;
    request_unit: 'logical_reads';
    estimated_series_upper_bound: number;
    max_series_per_resource: number;
    requests_per_hour_estimate: number;
  };
}

/** Identity of one template's effective parameter values, never its display names. */
function parameterSignature(template: ResolvedTemplateParameters): string {
  return `sha256:${createHash('sha256')
    .update(stable(template.parameters.map(entry => ({ name: entry.name, effective: entry.effective }))))
    .digest('hex')}`;
}

function planItem(item: ResolvedTemplateItem): TemplatePlanItem {
  return {
    pin: { ...item.pin }, template_id: item.template_id, item_id: item.item_id, item_version: item.item_version,
    canonical_metric: { ...item.canonical_metric }, unit: item.unit, dimensions: { ...item.dimensions },
    mapping: { ...item.mapping, steps: [...item.mapping.steps] }, capability: structuredClone(item.capability),
  };
}

/**
 * Build the internal plan for the exact releases the resolution selected.
 *
 * Contract and behavior:
 * - Only items with decision `collect` enter steps, queries, metric keys or the
 *   request estimate; disabled, unsupported, unknown and unselected items never do.
 * - Each step belongs to one exact release and collector; a collector or
 *   implementation reappearing in another release stays in that other release.
 * - Collectors of one release may share a query only when method, implementation
 *   and the items' effective parameter values agree; `step.order`/mapping step
 *   order is preserved and never flattened into a metric or collector name.
 * - The series budget counts concrete selected items (each bound item is one
 *   series), excluding disabled and unsupported decisions, never generic
 *   discovery rows.
 * - A legacy delegate or any other input shape is rejected instead of being
 *   coerced into a multi-template plan.
 */
export function buildTemplateCollectionPlan(resolution: ResolvedTemplateBinding): TemplateCollectionPlan {
  if (resolution === null || typeof resolution !== 'object' || resolution.kind !== 'template_resolution') {
    throw new TemplatePlanError('PLAN_INPUT_INVALID');
  }
  const signatures = new Map<string, string>();
  for (const template of resolution.templates) signatures.set(template.pin.template_id, parameterSignature(template));

  const releases: TemplateReleasePlan[] = [];
  let estimatedSeries = 0;
  let requestsPerHourEstimate = 0;
  for (const release of resolution.releases) {
    const steps: TemplatePlanStep[] = [];
    for (const collector of release.collectors) {
      const groups = new Map<string, ResolvedTemplateItem[]>();
      for (const item of collector.items) {
        if (item.decision !== 'collect') continue;
        const signature = signatures.get(item.template_id);
        if (signature === undefined || item.release_ref !== release.release_ref
          || item.collector_id !== collector.collector_id) {
          throw new TemplatePlanError('PLAN_RELEASE_INCONSISTENT', copyRef(release.release));
        }
        const group = groups.get(signature) ?? [];
        group.push(item);
        groups.set(signature, group);
      }
      for (const [signature, items] of [...groups.entries()].sort(([left], [right]) => compare(left, right))) {
        items.sort((left, right) => compare(left.template_id, right.template_id) || compare(left.item_id, right.item_id)
          || left.item_version - right.item_version);
        const metrics = [...new Map(items.map(item => [metricKey(item.canonical_metric), { ...item.canonical_metric }])).entries()]
          .sort(([left], [right]) => compare(left, right)).map(([, metric]) => metric);
        steps.push({
          release: copyRef(collector.release), release_ref: collector.release_ref,
          collector_id: collector.collector_id, implementation_id: collector.implementation_id,
          method: collector.method, estimated_cost: collector.estimated_cost,
          timeout_ms: collector.timeout_ms, timeout_source: structuredClone(collector.timeout_source),
          logical_reads: collector.method === 'ssh' ? 2 : 1, parameter_signature: signature,
          metrics, items: items.map(planItem),
        });
      }
    }
    steps.sort((left, right) => compare(left.collector_id, right.collector_id)
      || compare(left.implementation_id, right.implementation_id) || compare(left.method, right.method)
      || compare(left.parameter_signature, right.parameter_signature));
    const queries = groupQueries(steps.map(step => ({
      id: step.collector_id, method: step.method, implementation_ref: step.implementation_id,
      estimated_cost: step.estimated_cost,
      // The resolved parameters are part of the merge boundary, not only the implementation.
      group_key: `${step.method}:${step.implementation_id}:${step.parameter_signature}`,
    })));
    const releaseRequests = requestsPerHour(queries, resolution.settings.interval_ms);
    requestsPerHourEstimate += releaseRequests;
    const metricKeys = [...new Set(steps.flatMap(step => step.metrics.map(metricKey)))].sort(compare);
    releases.push({
      release: copyRef(release.release), release_ref: release.release_ref,
      interval_ms: resolution.settings.interval_ms, timeout_ms: resolution.settings.timeout_ms,
      jitter_ms: jitterFor(resolution.resource.type, resolution.resource.id, release.release.id,
        resolution.settings.interval_ms),
      applicability: structuredClone(release.applicability),
      collector_ids: [...new Set(steps.map(step => step.collector_id))].sort(compare),
      metric_keys: metricKeys, queries, requests_per_hour_estimate: releaseRequests, steps,
    });
    estimatedSeries += release.collectors.reduce((count, collector) => count
      + collector.items.filter(item => item.decision !== 'disabled' && item.decision !== 'unsupported').length, 0);
  }
  if (estimatedSeries > resolution.settings.max_series_per_resource) {
    throw new TemplatePlanError('PLAN_SERIES_BUDGET', null);
  }

  const plan: TemplateCollectionPlan = {
    kind: 'template_collection_plan', internal: true, persisted: false, applied: false,
    executable: resolution.executable && releases.some(entry => entry.steps.length > 0),
    identity: templateResolutionIdentity(resolution),
    resource: { ...resolution.resource }, revision: resolution.revision,
    settings: { ...resolution.settings },
    parameters: structuredClone(resolution.templates), triggers: structuredClone(resolution.triggers),
    releases, excluded: structuredClone(resolution.excluded),
    budget: {
      estimate: true, request_unit: 'logical_reads',
      estimated_series_upper_bound: estimatedSeries,
      max_series_per_resource: resolution.settings.max_series_per_resource,
      requests_per_hour_estimate: requestsPerHourEstimate,
    },
  };
  return structuredClone(plan);
}
