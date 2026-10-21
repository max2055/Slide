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
  it('detects count, omitted history and timestamp drift while ignoring row order', () => {
    const rows = [{id:1,updated_at:'2026-10-21 16:30:00.123456'},{id:2,updated_at:'2026-10-21 16:31:00.654321'}];
    expect(() => harness.assertSameRows(rows, rows.slice().reverse(), 'llm_providers')).not.toThrow();
    expect(() => harness.assertSameRows(rows, rows.slice(1), 'alert_events')).toThrow('ISOLATION_DATA_MISMATCH:alert_events');
    expect(() => harness.assertSameRows(rows, [{...rows[0],updated_at:'2026-10-22 00:00:00'},rows[1]], 'llm_providers')).toThrow('ISOLATION_DATA_MISMATCH:llm_providers');
  });
  it('stops on a read failure instead of silently omitting a classified table', async () => {
    const connection = {query:async (sql:string) => {
      if (sql.startsWith('SHOW FULL TABLES')) return [[...harness.REQUIRED_COPY,...harness.EMPTY_TABLES].map((name:string) => ({name,type:'BASE TABLE'}))];
      if (sql.includes('`alerts`')) throw Error('unreadable');
      if (sql.startsWith('SHOW FULL COLUMNS')) return [[{Field:'id',Extra:''}]];
      return [[]];
    }};
    await expect(harness.catalog(connection,'fixture')).rejects.toThrow('ISOLATION_UNREADABLE_TABLE:alerts');
  });
});

it('uses the production factory and detects effective route timestamp/config drift without any send', async () => {
  const {verifyIsolationRoute}=await import(new URL('../../../../scripts/qualification/investigation-isolation-route.ts',import.meta.url).href);
  const row={id:5,name:'deepseek',display_name:'Offline fixture',enabled:1,is_default:1,deployment_type:'api',api_format:'openai-completions',
    api_key_encrypted:'fixture-ciphertext-not-a-key',api_base_url:'https://api.deepseek.com',default_model:'deepseek-flash',models_supported:null,
    supports_function_call:true,supports_vision:false,context_window:16000,max_tokens:4096,updated_at:'2026-10-21 16:30:00.000'};
  let change:Record<string,unknown>={};
  const connection={query:async(sql:string)=>sql.includes('llm_scene_bindings')?[[]]:[[sql.includes('`target`')?{...row,...change}:row]]};
  expect((await verifyIsolationRoute(connection,'source','target')).exact).toBe(true);
  change={updated_at:'2026-10-21 16:31:00.000'};
  await expect(verifyIsolationRoute(connection,'source','target')).rejects.toThrow('ISOLATION_ROUTE_IDENTITY_MISMATCH');
  change={max_tokens:1024};
  await expect(verifyIsolationRoute(connection,'source','target')).rejects.toThrow('ISOLATION_ROUTE_IDENTITY_MISMATCH');
});
