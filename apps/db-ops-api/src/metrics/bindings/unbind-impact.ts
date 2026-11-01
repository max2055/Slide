import type { ResourceBindingCandidate, TemplatePin } from '../../contracts/metrics/templates.js';
import { stable } from '../packages/model.js';
import { PolicyError } from '../policy/model.js';
import { preflightResourceBinding, type TemplateVersionReadPort } from './preflight.js';

/** Read each pin separately: the preview must explain even overlapping providers. */
export async function analyzeUnbindImpact(binding: ResourceBindingCandidate, remove: TemplatePin[], port: TemplateVersionReadPort) {
  const pinned = new Map(binding.template_pins.map(pin => [pin.template_id, pin]));
  const selected = new Set<string>();
  for (const pin of remove) {
    if (selected.has(pin.template_id) || !pinned.has(pin.template_id) || stable(pinned.get(pin.template_id)) !== stable(pin)) {
      throw new PolicyError('UNBIND_PREVIEW_PIN_CONFLICT', 409);
    }
    selected.add(pin.template_id);
  }
  const sources = [];
  for (const pin of binding.template_pins) {
    const result = await preflightResourceBinding({ ...binding, template_pins: [pin] }, port);
    if (result.kind !== 'template_preflight') throw new PolicyError('UNBIND_PREVIEW_INVALID', 409);
    sources.push(result.pins[0]);
  }
  const remaining = sources.filter(source => !selected.has(source.pin.template_id));
  const removed = sources.filter(source => selected.has(source.pin.template_id));
  const removed_items = removed.flatMap(source => source.items.map(item => {
    const remaining_providers = remaining.flatMap(other => other.items
      .filter(candidate => candidate.canonical_metric.id === item.canonical_metric.id
        && candidate.canonical_metric.semantic_version === item.canonical_metric.semantic_version)
      .map(candidate => ({ template_id: other.pin.template_id, item_id: candidate.item_id,
        item_version: candidate.version, pin: other.pin, unit: candidate.unit, dimensions: candidate.dimensions })));
    return { pin: source.pin, template_id: item.template_id, item_id: item.item_id,
      item_version: item.version, canonical_metric: item.canonical_metric, unit: item.unit,
      dimensions: item.dimensions, loses_provider: remaining_providers.length === 0, remaining_providers };
  }));
  return { removed_pins: removed.map(source => source.pin), remaining_pins: remaining.map(source => source.pin),
    removed_items, triggers: removed.flatMap(source => source.triggers.map(trigger => ({
      pin: source.pin, template_id: source.pin.template_id, ...trigger,
    }))), configuration: { group_id: binding.group_id, overrides: binding.overrides },
    history: 'retained' as const, rule_effect: 'references_only_unknown' as const };
}
