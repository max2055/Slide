import { describe, expect, it } from 'vitest';
import { findAlertMetric } from './alert-metric-catalog.js';

describe('alert metric catalog', () => {
  it('keeps the legacy registry as the first source of truth', () => {
    expect(findAlertMetric('connections', 'instance')).toMatchObject({ id: 'connections', source: 'legacy' });
    expect(findAlertMetric('filesystem_size_bytes', 'server')).toMatchObject({ id: 'filesystem_size_bytes', source: 'legacy' });
  });

  it('resolves reviewed semantic metrics for new rules', () => {
    expect(findAlertMetric('mysql.queries.per_second', 'instance')).toMatchObject({
      id: 'mysql.queries.per_second', is_collected: true, db_types: ['mysql'], source: 'semantic',
    });
    expect(findAlertMetric('mysql.tables.estimated_allocated_bytes', 'instance')).toMatchObject({
      id: 'mysql.tables.estimated_allocated_bytes', db_types: ['mysql'], source: 'semantic',
    });
    expect(findAlertMetric('linux.filesystem.used_ratio', 'server')).toMatchObject({
      id: 'linux.filesystem.used_ratio', is_collected: true, db_types: [], source: 'semantic',
    });
  });

  it('never aliases a semantic metric across resource types or from an unknown name', () => {
    expect(findAlertMetric('linux.filesystem.used_ratio', 'instance')).toBeNull();
    expect(findAlertMetric('mysql.queries.per_second', 'server')).toBeNull();
    expect(findAlertMetric('not.a.metric', 'instance')).toBeNull();
  });
});
