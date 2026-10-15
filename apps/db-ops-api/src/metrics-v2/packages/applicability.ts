import type { CollectorPackage, Resource } from '../../contracts/metrics-v2/index.js';

export interface ApplicabilityCheck {
  attribute: string;
  value: string | number | boolean | null;
  supported_values: string[];
  status: 'supported' | 'unsupported' | 'unknown';
}
/** Metadata checks only; a match does not prove target permissions or successful collection. */
export function checkApplicability(pack: CollectorPackage, resource: Resource, at: string): ApplicabilityCheck[] {
  return pack.applicability.map(condition => {
    const attribute = resource.attributes[condition.attribute];
    const value = attribute && Date.parse(attribute.observed_at) <= Date.parse(at) ? attribute.value : undefined;
    const normalized = condition.attribute === 'db.version' && typeof value === 'string'
      ? value.match(/^(\d+\.\d+)(?:\.|$)/)?.[1] : value === undefined ? undefined : String(value).toLowerCase();
    return { attribute: condition.attribute, value: value ?? null, supported_values: [...condition.values],
      status: value === undefined ? 'unknown' : normalized !== undefined && condition.values.includes(normalized) ? 'supported' : 'unsupported' };
  });
}
