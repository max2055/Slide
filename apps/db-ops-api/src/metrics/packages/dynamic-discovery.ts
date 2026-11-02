import { createHash } from 'node:crypto';
import type { MetricDefinition } from '../../contracts/metrics/index.js';
import { sealRelease, stable, type ImplementationSpec } from './model.js';
import { AdapterError, classifyError, type DecodedRow, type DriverEvidence, type Transport } from './adapters.js';
import { parseProcNetDevExact } from '../../server-metric-provider.js';

const definition = (id:string, resource_type:'server'|'instance', keys:string[], meaning:string):MetricDefinition => ({
  category:'extension', namespace:id.split('.')[0], id, semantic_version:'1.0.0', resource_type,
  meaning, unit:'count', scope:'resource', kind:'gauge', roles:['diagnostic'], temporality:'instant', monotonic:false,
  value_type:'uint64', dimensions:{keys:keys.map(name=>({name,meaning:name,required:true})),max_series_per_resource:100,max_value_length:128,overflow:'reject'},
  aggregation:{time:['last','min','max','mean'],space:['none'],missing:'preserve_null',min_coverage:1,quantiles:'not_applicable'},lifecycle:'active',
});
export const dynamicSpecs:ImplementationSpec[] = [
  {id:'builtin:linux.filesystem-discovery.v1',method:'ssh',resource_type:'server',applicability:[{attribute:'os.family',values:['linux']}],
    outputs:[{raw_field:'used',input_unit:'By',definition:{...definition('linux.filesystem.discovered_used_bytes','server',['mount','filesystem_epoch','fs_type'],
      'Used bytes from statvfs (blocks minus free blocks), one mounted filesystem root per proven FSID in a stable mount namespace. Mount moves retain identity, newly created filesystem FSIDs start new identity; bind subroots and unsupported types excluded.'),unit:'By'}}],
    permissions:['SSH login','python3 with statvfs f_fsid','read fixed procfs mount inventory'],discovery:'Complete before/after mountinfo and statvfs, ext4/xfs/btrfs/tmpfs roots excluding /proc,/sys,/dev; duplicate FSIDs (bind roots), zero FSID, errors or overflow reject the entire enumeration. No arbitrary command.'},
  {id:'builtin:linux.interface-discovery.v1',method:'ssh',resource_type:'server',applicability:[{attribute:'os.family',values:['linux']}],
    outputs:[{raw_field:'present',input_unit:'count',definition:definition('linux.network.interface.present','server',['interface','interface_epoch'],
      'One for each non-loop Linux interface in a complete procfs/sysfs snapshot. Identity is boot, network namespace and kernel ifindex; rename changes the display dimension, reboot starts a new kernel lifetime.')}],
    permissions:['SSH login','read fixed procfs/sysfs interface snapshot'],discovery:'Complete before/after kernel inventory with matching proc counters; interface_epoch is identity; interface is display name.'},
  {id:'builtin:mysql.innodb-discovery.v1',method:'sql',resource_type:'instance',applicability:[{attribute:'db.engine',values:['mysql']},{attribute:'db.version',values:['8.0','8.4']}],
    outputs:[{raw_field:'columns',input_unit:'count',definition:definition('mysql.innodb.table.internal_columns','instance',['table_id','table_epoch','table_name'],
      'INFORMATION_SCHEMA.INNODB_TABLES N_COLS for each visible InnoDB dictionary table in the bound current database, including hidden internal columns. Partition dictionary entries are distinct; not user column count or table size. TABLE_ID survives rename; drop/recreate is a new identity.')}],
    permissions:['PROCESS','SELECT information_schema.INNODB_TABLES'],discovery:'Fixed bounded native dictionary query twice; exact inventory agreement, server UUID and TABLE_ID identity, simple ASCII database identifiers only (other encodings unknown); no arbitrary SQL or non-InnoDB claim.'},
];
export function dynamicReleases() {
  return dynamicSpecs.map(spec=>sealRelease({package:{id:spec.id==='builtin:linux.filesystem-discovery.v1'?'linux-filesystem-discovery':spec.method==='ssh'?'linux-interface-discovery':'mysql-innodb-discovery',version:'1.0.0',contract_version:'1.0.0',digest:`sha256:${'0'.repeat(64)}`,
    resource_type:spec.resource_type,applicability:spec.applicability,collectors:[{id:'dynamic-members',implementation_ref:spec.id,method:spec.method,timeout_ms:5000,estimated_cost:'medium',
      mappings:spec.outputs.map(o=>({metric:{id:o.definition.id,semantic_version:'1.0.0'},raw_field:o.raw_field,input_unit:o.input_unit,output_unit:o.definition.unit,transform_version:'1.0.0',steps:['decode','normalize']}))}]},
    extensions:spec.outputs.map(o=>o.definition as Extract<MetricDefinition,{category:'extension'}>),derived:[],transforms:[{id:'normalize',version:'1.0.0'}],
    recommendations:{interval_ms:60000,timeout_ms:5000,stale_after_ms:120000,max_counter_gap_ms:300000,max_rows:100,enabled:true},
    documentation:[{collector_id:'dynamic-members',permissions:spec.permissions,discovery:spec.discovery}]}));
}
// LIMIT includes an overflow sentinel; native driver completion is required, never accept a clipped page as absence.
export const MYSQL_INNODB_DISCOVERY_SQL = "SELECT @@server_uuid AS server_uuid, TABLE_ID AS table_id, NAME AS table_name, N_COLS AS columns_count FROM information_schema.INNODB_TABLES WHERE BINARY SUBSTRING_INDEX(NAME,'/',1) = BINARY DATABASE() AND DATABASE() NOT IN ('mysql','sys','information_schema','performance_schema') ORDER BY TABLE_ID LIMIT 101";
export async function collectDynamic(id:string, transport:Transport, evidence:DriverEvidence, timeoutMs:number, maxRows:number):Promise<DecodedRow[]> {
  const started=Date.now(), remaining=()=>{const n=timeoutMs-(Date.now()-started);if(n<=0)throw new AdapterError('timeout');return n;};
  if(id==='builtin:linux.filesystem-discovery.v1' && transport.method==='ssh') {
    const {collectFilesystems}=await import('./filesystem-discovery.js');return collectFilesystems(transport,remaining(),maxRows);
  }
  if(id==='builtin:linux.interface-discovery.v1' && transport.method==='ssh') {
    if(!evidence.host_interfaces)throw new AdapterError('parse_error');
    const snapshot=await evidence.host_interfaces.read(transport,remaining());remaining();
    const members=snapshot.evidence.host_counter_epochs!.interfaces;
    const rows=parseProcNetDevExact(snapshot.stdout).filter(r=>r.name==='network_rx_bytes'||r.name==='network_tx_bytes');
    if(rows.length!==Object.keys(members).length*2 || rows.some(r=>!members[r.dimensions?.interface??''])
      || new Set(rows.map(r=>`${r.dimensions?.interface}:${r.name}`)).size!==rows.length)throw new AdapterError('parse_error');
    const names=Object.keys(members).filter(n=>n!=='lo');if(names.length>maxRows)throw new AdapterError('parse_error');
    return names.map(name=>({display_name:name,observed_at:snapshot.observed_at,dimensions:{interface:name,interface_epoch:members[name].epoch},fields:{present:{encoding:'uint64',value:'1'}}}));
  }
  if(id==='builtin:mysql.innodb-discovery.v1' && transport.method==='sql') {
    try {
      const context=async()=>{const [r]=await transport.pool.query({sql:'SELECT DATABASE() AS bound_database, @@server_uuid AS server_uuid',timeout:remaining()});remaining();
        if(!Array.isArray(r)||r.length!==1||typeof r[0]?.bound_database!=='string'||!(/^[A-Za-z0-9_]{1,64}$/).test(r[0]?.bound_database)||!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i).test(r[0]?.server_uuid))throw new AdapterError('parse_error');if(['mysql','sys','information_schema','performance_schema'].includes(r[0].bound_database))throw new AdapterError('parse_error');return r[0];};
      const initial=await context();
      const read=async()=>{const [r]=await transport.pool.query({sql:MYSQL_INNODB_DISCOVERY_SQL,timeout:remaining()});remaining();
        if(!Array.isArray(r)||r.length>Math.min(100,maxRows))throw new AdapterError('parse_error');
        const seen=new Set<string>();return r.map(v=>{const identity=String(v.table_id);
          if(!/^[1-9]\d{0,19}$/.test(identity)||seen.has(identity)||typeof v.table_name!=='string'||!v.table_name||!v.table_name.startsWith(initial.bound_database+'/')||v.table_name.length>128||typeof v.server_uuid!=='string'||v.server_uuid!==initial.server_uuid
            ||!/^\d{1,10}$/.test(String(v.columns_count)))throw new AdapterError('parse_error');seen.add(identity);
          return {display_name:v.table_name,dimensions:{table_id:identity,table_epoch:createHash('sha256').update(`${v.server_uuid}:${identity}`).digest('hex'),table_name:v.table_name},fields:{columns:{encoding:'uint64' as const,value:String(v.columns_count)}}};});};
      const before=await read(),after=await read();if(stable(before)!==stable(after)||stable(initial)!==stable(await context()))throw new AdapterError('parse_error');return before;
    }catch(e){throw e instanceof AdapterError?e:new AdapterError(classifyError(e));}
  }
  throw new AdapterError('parse_error');
}
