import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const location = new URL('../../../../scripts/qualification/prepare-investigation-isolation.mjs', import.meta.url);
// Exact predecessor filter from the r2 draft; demonstrates the DEFAULT_GENERATED
// bug before the portable harness exists. Never used by production preparation.
const harness = existsSync(location) ? await import(location.href) : {
  copyColumns: (columns: any[]) => columns.filter(c => !/GENERATED/.test(c.Extra)).map(c => c.Field),
};
describe('faithful investigation isolation preflight', () => {
  it('preserves default timestamps while excluding only actual generated columns', () => {
    const columns = [
      { Field: 'id', Extra: '' }, { Field: 'created_at', Extra: 'DEFAULT_GENERATED' },
      { Field: 'updated_at', Extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' },
      { Field: 'computed_v', Extra: 'VIRTUAL GENERATED' }, { Field: 'computed_s', Extra: 'STORED GENERATED' },
    ];
    expect(harness.copyColumns(columns)).toEqual(['id', 'created_at', 'updated_at']);
  });
  it('fails closed on unclassified or missing read tables and unreadable table metadata', async () => {
    expect(() => harness.tablePlan(['alerts', 'unreviewed_new_read_table'])).toThrow(/UNCLASSIFIED|MISSING/);
    expect(() => harness.tablePlan(harness.REQUIRED_COPY.filter((t: string) => t !== 'alerts'))).toThrow(/MISSING.*alerts/);
    const names = [...harness.REQUIRED_COPY, ...harness.EMPTY_TABLES];
    const plan = harness.tablePlan(names);
    expect(plan.find((t: any) => t.name === 'alert_events').mode).toBe('copy');
    expect(plan.find((t: any) => t.name === 'agent_tool_execution_intents').mode).toBe('empty');
  });
});
