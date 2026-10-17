/** Compatibility lifecycle and structured diagnostic records. Metric collection belongs to MetricScheduler. */
import crypto from 'node:crypto';
import { databaseService } from './database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { instanceAccessLifecycle } from './resources/instance-access-lifecycle.js';
import { assertWorkflowActive } from './workflows/execution-context.js';
import { dbConnection } from './db-connection.js';
import { assetCollectionEnabled } from './metrics/config/effective-state.js';
import { metricConfigurationService } from './metrics/config/routes.js';
const actor = (id:number) => ({userId:0,username:'diagnostic-records',roles:[],permissions:['instance:view','collector:manage'],instanceScopes:{[id]:'read-write' as const},sessionVersion:0,requestId:`diagnostic-records:${id}`});
async function enabled(id:number):Promise<boolean>{
  if(process.env.METRICS_COLLECTION_ENABLED!=='true')return false;
  const pool=dbConnection.getPool();if(!pool||!await assetCollectionEnabled(pool,{type:'instance',id}))return false;
  const [rows]=await pool.execute<import('mysql2/promise').RowDataPacket[]>('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',[`instance:${id}`]);
  const published=rows[0]?(typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload):null;
  return !published || published.resolved.settings.enabled;
}
class MonitorCollector {
  start(_config?:unknown):void {}
  stop():void {}
  async stopInstance(id:number):Promise<void>{await instanceAccessLifecycle.drain(id);}
  refreshSchedule():void {}
  getStatus(){return {running:false,heartbeatMs:10000,schedule:[],owner:'MetricScheduler'};}
  async collectInstanceNow(id:number){
    await instanceAccessLifecycle.assertAvailable(id);
    return metricConfigurationService.trialCurrent(actor(id),{type:'instance',id});
  }
  async collectSlowQueriesNow() {
    try {
      const instances = await instanceDatabaseService.getAllInstances();
      if (instances.length === 0) return;
      for (const instance of instances) {
        try {
          if (!await enabled(instance.id)) continue;
          assertWorkflowActive();
          const slowQueries = await databaseService.getSlowQueries(instance.id);
          if (slowQueries && slowQueries.length > 0) {
            for (const query of slowQueries) {
              const sqlHash = crypto.createHash('md5').update(query.sql_text).digest('hex');
              await instanceAccessLifecycle.assertAvailable(instance.id);
              if (!await enabled(instance.id)) break;
              assertWorkflowActive();
              await metricsDatabaseService.recordSlowQuery({
                instance_id: instance.id,
                sql_text: query.sql_text,
                sql_hash: sqlHash,
                avg_time_ms: query.avg_time_ms,
                max_time_ms: query.max_time_ms,
                min_time_ms: query.avg_time_ms,
                execution_count: query.execution_count,
                total_time_ms: query.avg_time_ms * query.execution_count,
              });
            }
            console.log(`📊 [${instance.name}] 采集 ${slowQueries.length} 条慢查询`);
          }
        } catch (error) {
          assertWorkflowActive();
          console.error(`采集实例 ${instance.name} 慢查询失败:`, error);
        }
      }
    } catch (error) {
      console.error('慢查询采集失败:', error);
    }
  }

  async collectCapacity() {
    const outcome = { succeeded: 0, failed: 0 };
    try {
      assertWorkflowActive();
      const instances = await instanceDatabaseService.getAllInstances();
      for (const inst of instances) {
        if (inst.status !== 'active') continue;
        try {
          assertWorkflowActive();
          if (!await enabled(inst.id)) continue;
          assertWorkflowActive();
          const capacity = await databaseService.getCapacityInfo(inst.id);
          if (capacity && capacity.total_size_gb !== undefined) {
            const totalTableCount = capacity.databases
              ? capacity.databases.reduce((sum: number, db: any) => sum + (db.table_count || 0), 0)
              : 0;
            assertWorkflowActive();
            await instanceAccessLifecycle.assertAvailable(inst.id);
            if (!await enabled(inst.id)) continue;
            const saved = await metricsDatabaseService.recordCapacity({
              instance_id: inst.id,
              total_size_gb: capacity.total_size_gb,
              db_count: capacity.databases?.length || 0,
              table_count: totalTableCount,
              databases: capacity.databases || [],
              tablespaces: capacity.tablespaces || [],
              top_tables: capacity.top_tables || [],
              recorded_at: new Date(),
            } as any);
            if (saved.success) outcome.succeeded++; else outcome.failed++;
          } else { outcome.failed++; }
        } catch (error) {
          assertWorkflowActive();
          outcome.failed++;
          console.error(`采集实例 ${inst.name} 容量失败:`, error);
        }
      }
    } catch (error) {
      assertWorkflowActive();
      console.error('容量采集失败:', error);
      outcome.failed++;
    }
    return outcome;
  }

  async collectCapacityNow(): Promise<{ succeeded: number; failed: number }> { return this.collectCapacity(); }
}
export const monitorCollector=new MonitorCollector();

/** Durable event ingestion; shares the existing WorkerRuntime, writes slow_queries only. */
export function createSlowQueryCollectionJob(availableAt=new Date()):import('./workflows/worker-runtime.js').WorkflowJobInput {
  const slot=Math.floor(availableAt.getTime()/300000);
  return {id:`slow-query-collection-${slot}`,type:'diagnostic.slow-queries',schemaVersion:1,payload:{},idempotencyKey:`slow-query-collection:${slot}`,maxAttempts:3,availableAt};
}
