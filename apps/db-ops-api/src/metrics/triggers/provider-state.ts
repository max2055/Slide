import type { TriggerResourceSnapshot, TriggerRuleSnapshot } from '../../contracts/metrics/triggers.js';
import { stable } from '../packages/model.js';
import type { DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';

/** A current provider fact, never a recovery or a mutation of historical evidence. */
export function triggerProviderState(
  binding: DecodedTemplateBindingPayload | null,
  metric: { id: string; semantic_version: string },
  dimensions: Record<string, string>,
) {
  if (!binding) return { state: 'unknown' as const, reason: 'binding_unavailable' };
  const plan = binding.pending.plan;
  const provider =
    plan.settings.enabled &&
    plan.releases.some((release) =>
      release.steps.some((step) =>
        step.items.some(
          (item) =>
            item.canonical_metric.id === metric.id &&
            item.canonical_metric.semantic_version === metric.semantic_version &&
            Object.entries(item.dimensions).every(([key, value]) => dimensions[key] === value),
        ),
      ),
    );
  if (!provider) return { state: 'stopped' as const, reason: 'no_enabled_provider' };
  return binding.application.status === 'applied' &&
    binding.application.applied_revision === binding.binding.revision
    ? { state: 'active' as const, reason: 'current_provider' }
    : { state: 'pending' as const, reason: 'configuration_pending' };
}

/** Only removal of other pins preserves an unchanged rule's continuous head.
 * A stop/rebind, changed rule, item, parameters or provider starts the existing
 * revision-scoped event policy; no previous episode is closed or rewritten.
 */
export function continuesAfterPinRemoval(
  previous: TriggerResourceSnapshot | null,
  current: TriggerResourceSnapshot,
  rule: TriggerRuleSnapshot,
): boolean {
  return (
    previous !== null &&
    previous.config_revision + 1 === current.config_revision &&
    current.templates.length < previous.templates.length &&
    current.templates.every((pin) => previous.templates.some((old) => stable(old) === stable(pin))) &&
    previous.rules.some((old) => stable(old) === stable(rule))
  );
}
