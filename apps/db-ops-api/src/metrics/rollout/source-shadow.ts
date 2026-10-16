import type { MetricDefinition, NormalizedObservation } from '../../contracts/metrics/index.js';
import serverMetricProvider, { FILESYSTEM_BYTES_COMMAND, FILESYSTEM_INODES_COMMAND, FILESYSTEM_MOUNTS_COMMAND } from '../../server-metric-provider.js';
import { parseFilesystemEvidence } from '../../linux-host-evidence-service.js';
import { migrateReference } from '../consumers/migration.js';
import type { Transport } from '../packages/adapters.js';
import { stable } from '../packages/model.js';
import type { Ref } from '../policy/model.js';

/** Replay the original interpretation of the same real fixed response. No second polling loop,
 * synthetic old samples, or extra remote requests. Missing capture never counts as a passed check. */
export class SourceSnapshotCapture {
  private ssh = new Map<string, string>();
  private context = '';
  inCollector(reference: string, transport: Transport): Transport { this.context = reference; return this.wrap(transport); }
  private sql: Array<{text:string;rows:unknown;reference:string}> = [];
  wrap(transport: Transport): Transport {
    if(transport.method==='ssh')return {...transport,pool:{...transport.pool,execCommands:async(client,commands,options)=>{
      const result=await transport.pool.execCommands(client,commands,options);
      commands.forEach((command,i)=>{const r=result[i];if(r&&!r.truncated&&r.exitCode===0)this.ssh.set(`${this.context}:${command}`,r.stdout);});return result;
    }}};
    if(transport.method==='sql')return {...transport,pool:{query:async options=>{
      const result=await transport.pool.query(options);this.sql.push({text:options.sql,rows:structuredClone(result[0]),reference:this.context});return result;
    }}};
    return transport;
  }
  compare(ref:Ref,engine:string,samples:NormalizedObservation[],catalog:MetricDefinition[], collectors: Array<{id:string;implementation_ref:string}> = []){
    const checks:Array<{metric_id:string;sample_id:string;legacy_reference:string;legacy_value:number|null;value:number|null;dimensions:Record<string,string>;state:'passed'|'failed';unit:string}> = [];
    const add=(o:NormalizedObservation,oldId:string,legacy:number|null,dimensions:Record<string,string>,unit:string)=>{
      const definition=catalog.find(d=>d.id===o.metric.id&&d.semantic_version===o.metric.semantic_version)!;
      const next=o.value&&'value'in o.value?Number(o.value.value):null;
      const exact=next===null||o.value?.encoding==='float64'||Number.isSafeInteger(next);
      const same=legacy===null?next===null:next!==null&&Number.isFinite(legacy)&&Math.abs(next-legacy)<=Math.max(0.000001,Math.abs(legacy)*1e-12);
      checks.push({metric_id:o.metric.id,sample_id:o.id,legacy_reference:oldId,legacy_value:legacy,value:next,dimensions,unit,
        state:exact&&same&&definition.unit===unit&&stable(dimensions)===stable(o.dimensions)&&o.quality.status==='good'?'passed':'failed'});
    };
    const response = (o:NormalizedObservation,command:string) => this.ssh.get(`${collectors.find(c=>c.id===o.source.collector_id)?.implementation_ref??''}:${command}`);
    if(ref.type==='server'){
      for(const legacy of serverMetricProvider.getDefinitions('rhel')){
        const id=migrateReference(ref,engine,legacy.name).metric_id;
        const sample=samples.find(o=>o.metric.id===id&&Object.keys(o.dimensions).length===0);
        const captured=sample?response(sample,legacy.command):undefined;
        if(sample){
          const unit=legacy.unit==='bytes'?'By':legacy.unit==='seconds'?'s':legacy.unit==='load'?'1':legacy.unit??'1';
          add(sample,legacy.name,captured===undefined?null:legacy.parse(captured),{},unit);
        }
      }
      for(const [oldId,key,field,unit] of [
        ['filesystem_used_bytes','host.filesystem.used_bytes','usedBytes','By'],['filesystem_size_bytes','host.filesystem.size_bytes','sizeBytes','By'],
        ['filesystem_available_bytes','linux.filesystem.available_bytes','availableBytes','By'],['filesystem_inode_usage','linux.filesystem.inode_used_percent','inodeUsagePercent','%'],
      ] as const) for(const o of samples.filter(o=>o.metric.id===key)){
        const bytes=response(o,FILESYSTEM_BYTES_COMMAND);if(bytes===undefined)continue;
        const filesystems=parseFilesystemEvidence(bytes,response(o,FILESYSTEM_INODES_COMMAND)??'',response(o,FILESYSTEM_MOUNTS_COMMAND)??'');
        const fs=filesystems.find(fs=>stable({mount:fs.mount,device:fs.device,fs_type:fs.fsType??'unknown'})===stable(o.dimensions));
        if(fs)add(o,oldId,fs[field]===null?null:Number(fs[field]),o.dimensions,unit);
      }
    }
    if(ref.type==='instance'){
      // These historical counts have the same SQL scope. The response alias is the only difference.
      const count=samples.find(o=>['mysql.processlist.count','postgresql.activity.count','oracle.sessions.count','dameng.sessions.count'].includes(o.metric.id));
      if(count){
        const frame=this.sql.find(r=>/^SELECT COUNT\(\*\)(?: AS connections)? FROM (?:information_schema\.PROCESSLIST|pg_stat_activity|V\$SESSION|V\$SESSIONS)$/i.test(r.text.trim()));
        if(frame&&Array.isArray(frame.rows)&&frame.rows.length===1){const raw=frame.rows[0];const v=Array.isArray(raw)?raw[0]:Object.values(raw as object)[0];add(count,'connections',v===null?null:Number(v),{},'count');}else add(count,'connections',null,{},'count');
      }
      for(const [oldId,id,field] of [['threads_running','mysql.threads.running','Threads_running'],['threads_connected','mysql.threads.connected','Threads_connected'],['open_files','mysql.files.open','Open_files']] as const){
        const o=samples.find(o=>o.metric.id===id),frame=this.sql.find(r=>Array.isArray(r.rows)&&r.rows.some(x=>x?.Variable_name===field));
        if(o&&frame&&Array.isArray(frame.rows))add(o,oldId,Number(frame.rows.find(x=>x.Variable_name===field).Value)||0,{},'count');
      }
    }
    return {mode:'same_actual_source_snapshot',resource:ref,revision:samples[0]?.versions.config_revision??0,remote_requests_added:0,checks,
      sample_ids:samples.map(o=>o.id),measured_at:new Date().toISOString(),
      semantic_differences:samples.filter(o=>!checks.some(c=>c.sample_id===o.id)).map(o=>({metric_id:o.metric.id,sample_id:o.id,
        reason:catalog.find(d=>d.id===o.metric.id)?.kind==='counter'?'Exact cumulative counter and authoritative epoch replace lossy unversioned totals/rates; old epochs cannot be imported.':
          o.metric.id==='db.uptime_seconds'?'No historical database uptime source; initialize from actual server status.':
          `Definition ${o.metric.id}@${o.metric.semantic_version}: ${catalog.find(d=>d.id===o.metric.id)?.meaning??'unregistered'}. No equivalent historical scalar identity is asserted; preserve native unit, scope, dimensions and quality.`}))};
  }
}
