import { metricRegistry } from '../metric-registry.js';
import { canonicalDefinitions } from './packages/builtins.js';
import { createConfigurationRegistry } from './config/registry.js';

export interface AlertMetricCatalogEntry {
  id: string;
  is_collected: boolean;
  db_types: string[] | null;
  source: 'legacy' | 'semantic';
}

const engines = new Set(['mysql', 'postgresql', 'oracle', 'dameng']);
let semantic: Array<{ id: string; resource_type: string; namespace: string | null }> | null = null;

function semanticMetrics(): Array<{ id: string; resource_type: string; namespace: string | null }> {
  if (!semantic) {
    const registry = createConfigurationRegistry();
    semantic = [...canonicalDefinitions, ...registry.list().flatMap(release => release.extensions)]
      .map(definition => ({
        id: definition.id,
        resource_type: definition.resource_type,
        namespace: definition.category === 'extension' ? definition.namespace : null,
      }));
  }
  return semantic;
}

/**
 * Alert rules live in the legacy `alert_rules` table but may target reviewed
 * semantic metrics (`mysql.queries.per_second`, `linux.filesystem.used_ratio`,
 * ...). The legacy registry must stay the first source of truth so existing
 * rows keep their collection flags; semantic metrics are an explicit fallback,
 * never an alias or a renamed legacy definition.
 */
export function findAlertMetric(name: string, targetType: 'instance' | 'server' | 'network_device'): AlertMetricCatalogEntry | null {
  const legacy = metricRegistry.getById(name, targetType);
  if (legacy) return { id: legacy.id, is_collected: legacy.is_collected, db_types: legacy.db_types, source: 'legacy' };
  const definition = semanticMetrics().find(metric => metric.id === name && metric.resource_type === targetType);
  if (!definition) return null;
  return {
    id: definition.id,
    is_collected: true,
    db_types: targetType === 'instance' && definition.namespace && engines.has(definition.namespace)
      ? [definition.namespace] : [],
    source: 'semantic',
  };
}
