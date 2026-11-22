import type { TemplateCollectionPlan, TemplateReleasePlan } from '../bindings/plan.js';
import type { PackageRegistry } from '../packages/model.js';
import { metricKey } from '../policy/model.js';

export interface TemplateCadence {
  next: Record<string, number>;
  through: number | null;
}

export function planIntervals(plan: TemplateCollectionPlan): number[] {
  return [...new Set(plan.releases.flatMap(release => release.steps.flatMap(step =>
    step.items.map(item => item.interval_ms ?? plan.settings.interval_ms))))];
}

export function initialCadence(intervals: number[], at: number): TemplateCadence {
  return { next: Object.fromEntries(intervals.map(interval => [interval, at])), through: null };
}

export function nextDeadline(cadence: TemplateCadence): number {
  return Math.min(...Object.values(cadence.next));
}

export function advanceCadence(cadence: TemplateCadence, now: number): TemplateCadence {
  return {
    next: Object.fromEntries(Object.entries(cadence.next).map(([key, due]) => {
      const interval = Number(key);
      // Keep the phase across slow calls and restarts. Skip missed ticks in one step.
      const next = cadence.through !== null && due <= cadence.through
        ? due + Math.max(1, Math.floor((now - due) / interval) + 1) * interval : due;
      return [key, next];
    })),
    through: null,
  };
}

/** Step groups describe a fixed collector. Only due mappings become observations. */
export function selectDueReleases(plan: TemplateCollectionPlan, cadence: TemplateCadence, registry: PackageRegistry): TemplateReleasePlan[] {
  if (cadence.through === null) return [];
  const through = cadence.through;
  return plan.releases.flatMap(release => {
    const steps = release.steps.flatMap(step => {
      const items = step.items.filter(item => cadence.next[item.interval_ms ?? plan.settings.interval_ms] <= through);
      return items.length ? [{ ...step, items, metrics: items.map(item => item.canonical_metric) }] : [];
    });
    if (!steps.length) return [];
    const keys = new Set(steps.flatMap(step => step.metrics.map(metricKey)));
    const formulas = registry.get(release.release).derived.filter(node => release.metric_keys.includes(metricKey(node.output)));
    // Only derive from a complete batch of inputs. Extra reads never accelerate another item.
    for (let previous = -1; previous !== keys.size;) {
      previous = keys.size;
      for (const node of formulas) {
        if (node.inputs.every(input => keys.has(metricKey(input)))) keys.add(metricKey(node.output));
      }
    }
    return [{ ...release, steps, collector_ids: [...new Set(steps.map(step => step.collector_id))], metric_keys: [...keys].sort() }];
  });
}
