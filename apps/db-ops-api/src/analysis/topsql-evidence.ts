import { classifySql } from '../sql-validator.js';
import { databaseService } from '../database-service.js';
import { sqlExecutor } from '../sql-executor.js';
import { analysisAuthorizationVersion, authorizeAnalysisRequest } from './analysis-identity.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { SlowQueryRecord } from '../metrics-database-service.js';
import { redactEvidence } from './analysis-evidence.js';

/** No Agent receives database tools. Collection runs after current authorization. */
export async function collectTopSqlEvidence(instanceId: number, query: SlowQueryRecord, actor?: ActorContext, trigger = 'manual') {
  if (trigger !== 'auto' && !actor) throw new Error('ANALYSIS_ACTOR_REQUIRED');
  await authorizeAnalysisRequest({ purpose: 'topsql_analysis', subject: { type: 'instance', id: instanceId }, actor,
    message: '', systemPrompt: '', configVersion: '', evidenceVersion: '', authorizationVersion: analysisAuthorizationVersion(actor) });
  const gaps: Array<{ scope: string; code: string }> = [];
  const dialect = databaseService.getConnection(instanceId)?.db_type ?? 'mysql';
  const data: { dialect: string; sql: string | null; metrics: Record<string, unknown>; schema: unknown; indexes: unknown; explain: unknown; gaps: typeof gaps } = {
    dialect,
    sql: query.sql_text, metrics: { avg_time_ms: query.avg_time_ms, max_time_ms: query.max_time_ms, execution_count: query.execution_count,
      rows_examined: query.rows_examined, rows_sent: query.rows_sent, schema_name: query.schema_name, first_seen: query.first_seen ?? null, last_seen: query.last_seen ?? null },
    schema: null, indexes: null, explain: null, gaps,
  };
  const classified = classifySql(query.sql_text, dialect);
  if (classified.commandType !== 'read') {
    gaps.push({ scope: 'explain', code: `SQL_NOT_READ_ONLY_${classified.reasonCode}` });
  } else {
    try {
      const plan = await databaseService.getExplainPlan(instanceId, query.sql_text);
      if (!plan) gaps.push({ scope: 'explain', code: 'EXPLAIN_UNAVAILABLE' });
      else if (plan.length > 64_000 || plan.split('\n').length > 1000) gaps.push({ scope: 'explain', code: 'EXPLAIN_LIMIT_EXCEEDED' });
      else data.explain = plan;
    } catch { gaps.push({ scope: 'explain', code: 'EXPLAIN_COLLECTION_FAILED' }); }
  }
  // Do not guess table names. Only tables identified by the SQL AST are queried.
  const tables = new Set<string>();
  const scan = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const item = node as Record<string, unknown>;
    if (typeof item.table === 'string' && /^[\w$]+$/.test(item.table) && (!item.db || item.db === query.schema_name)) tables.add(item.table);
    for (const value of Object.values(item)) scan(value);
  };
  scan(classified.ast);
  if (!query.schema_name || !/^[\w$.-]+$/.test(query.schema_name) || !tables.size || tables.size > 20 || dialect !== 'mysql') {
    gaps.push({ scope: 'schema', code: 'SCHEMA_COLLECTION_UNAVAILABLE' }, { scope: 'indexes', code: 'INDEX_COLLECTION_UNAVAILABLE' });
    return redactEvidence(data) as typeof data;
  }
  const predicate = `TABLE_SCHEMA = '${query.schema_name}' AND TABLE_NAME IN (${[...tables].map(t => `'${t}'`).join(',')})`;
  for (const [scope, sql] of [
    ['schema', `SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY FROM information_schema.COLUMNS WHERE ${predicate} ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 1000`],
    ['indexes', `SELECT TABLE_SCHEMA,TABLE_NAME,INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX,NON_UNIQUE,INDEX_TYPE FROM information_schema.STATISTICS WHERE ${predicate} ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 1000`],
  ] as const) {
    try {
      const result = await sqlExecutor.executeSql(instanceId, sql, { userId: String(actor?.userId ?? 0), username: actor?.username ?? 'system', timeoutMs: 5000 });
      if (!result.success || !result.rows?.length || result.truncated || result.rows.length >= 1000) gaps.push({ scope, code: `${scope.toUpperCase()}_COLLECTION_UNAVAILABLE` });
      else data[scope] = result.rows;
    } catch { gaps.push({ scope, code: `${scope.toUpperCase()}_COLLECTION_FAILED` }); }
  }
  return redactEvidence(data) as typeof data;
}
