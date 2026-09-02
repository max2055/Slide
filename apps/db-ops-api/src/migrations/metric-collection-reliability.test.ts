import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { splitSqlStatements } from './runner.js';

const migration = readFileSync(
  resolve(import.meta.dirname, '../../sql/migrations/082_metric_collection_reliability.sql'),
  'utf8',
);

describe('metric collection reliability migration', () => {
  it('preserves sparse samples and installs indexes matching latest/history ordering', () => {
    expect(migration).toContain('MODIFY COLUMN cpu_usage DECIMAL(5,2) DEFAULT NULL');
    expect(migration).toContain('idx_instance_time (instance_id, recorded_at, id)');
    expect(migration).toContain('idx_server_time (server_id, recorded_at, id)');
    expect(migration).toContain('idx_server_metric_time (server_id, metric_name, recorded_at, id)');
    expect(migration).toContain('idx_network_device_observation_time (device_id, observed_at, id)');
    expect(migration).toMatch(/SET is_collected = FALSE\s+WHERE target_type = 'instance' AND id = 'health_score'/);
    for (const column of [
      'active_transactions',
      'slow_queries',
      'threads_running',
      'threads_connected',
      'bytes_received',
      'bytes_sent',
      'queries_total',
      'commits_total',
      'rollbacks_total',
    ]) {
      expect(migration).toMatch(new RegExp(`MODIFY COLUMN ${column} [^,]+ COMMENT '[^']+'`));
    }
    expect(splitSqlStatements(migration)).toHaveLength(4);
  });
});
