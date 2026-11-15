import type { Pool } from 'mysql2/promise';
import { assertMetricSchedulerSchema } from './runtime.js';

/** Capture the live probes for the exhaustive real-MySQL mutation matrix. */
export async function schedulerSchemaProbes(): Promise<string[]> {
  const queries: string[] = [];
  await assertMetricSchedulerSchema({ query: async (sql: string) => {
    queries.push(sql); return [[{ id: 1 }], []];
  } } as unknown as Pool);
  return queries.filter(sql => sql.endsWith('LIMIT 0'));
}
