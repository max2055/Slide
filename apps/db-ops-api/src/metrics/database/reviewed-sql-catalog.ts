/** Trusted deployment artifact, reviewed through the same code-review gate as fixed SQL.
 * Add a schema-validated manifest here after checking source_digest, definition, permissions,
 * bounded SELECT and engine/version evidence. No HTTP/configuration input can populate it.
 * Do not include credentials, connection addresses or SQL containing secrets. */
export const reviewedSqlCatalog: unknown[] = [{
  id: 'mysql-custom-processlist-connections',
  version: '1.0.0',
  bundle: {id:'mysql-custom-existing-scalars',version:'1.0.0'},
  base: {
    id: 'mysql-diagnostics', version: '1.1.0',
    digest: 'sha256:785a03fc665f5dbb374e5896a41b4134dd1f2af6f64deeee06c4dca432b7250f',
  },
  engine: 'mysql', source_id: 'connections',
  source_digest: 'sha256:feefb786c78e59522b6802677904ec3e6ec43ad94ebcf1a3c86046703b21a46e',
  sql: 'SELECT COUNT(*) as count FROM information_schema.PROCESSLIST',
  definition: {
    category: 'extension', namespace: 'custom', id: 'custom.mysql.processlist_connections',
    semantic_version: '1.0.0', resource_type: 'instance', unit: 'count',
    meaning: 'Snapshot count of information_schema.PROCESSLIST rows visible to the bound account. Includes sleeping sessions; PROCESS is needed for all accounts. Not Threads_connected or active transactions.',
    scope: 'resource', kind: 'gauge', roles: ['diagnostic'], temporality: 'instant', monotonic: false,
    value_type: 'uint64', dimensions: { keys: [], max_series_per_resource: 1, max_value_length: 128, overflow: 'reject' },
    aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' },
    lifecycle: 'active',
  },
  permissions: ['SELECT information_schema.PROCESSLIST; PROCESS for visibility across accounts'],
  // Candidate approval travels with this code artifact; merge/deployment still require independent PR review.
  review: { reference: 'MAX-189 / PR #202: existing mysql3306 connections source; MySQL 9.6 read-only validation', reviewed_by: 'MAX-189 implementation review; independent PR review required' },
}, {
  id: 'mysql-custom-slow-query-snapshot', version:'1.0.0',
  bundle: {id:'mysql-custom-existing-scalars',version:'1.0.0'},
  base: {id:'mysql-diagnostics',version:'1.1.0',digest:'sha256:785a03fc665f5dbb374e5896a41b4134dd1f2af6f64deeee06c4dca432b7250f'},
  engine:'mysql',source_id:'slow_queries',
  source_digest:'sha256:91d1d18151ded241a4aa25db3853319704141e3bd5edc638096bb9500412dac5',
  sql:"SELECT VARIABLE_VALUE AS Value FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Slow_queries'",
  definition:{
    category:'extension',namespace:'custom',id:'custom.mysql.slow_queries_snapshot',semantic_version:'1.0.0',resource_type:'instance',unit:'count',
    meaning:'Exact snapshot of cumulative MySQL Slow_queries visible in global_status. Preserves the existing gauge configuration; not an interval count or rate, no reset epoch claimed.',
    scope:'resource',kind:'gauge',roles:['diagnostic'],temporality:'instant',monotonic:false,value_type:'uint64',
    dimensions:{keys:[],max_series_per_resource:1,max_value_length:128,overflow:'reject'},
    aggregation:{time:['last','min','max','mean'],space:['none'],missing:'preserve_null',min_coverage:1,quantiles:'not_applicable'},lifecycle:'active',
  },
  permissions:['SELECT performance_schema.global_status'],
  review:{reference:'MAX-189 / PR #202: existing mysql3306 slow_queries gauge; MySQL 9.6 read-only validation',reviewed_by:'MAX-189 implementation review; independent PR review required'},
}];
