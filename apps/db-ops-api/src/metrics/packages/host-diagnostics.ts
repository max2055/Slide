import type { MetricDefinition } from '../../contracts/metrics/index.js';
import { builtinReleases } from './builtins.js';
import { sealRelease, type ImplementationSpec, type PackageRelease } from './model.js';

const applicability = [{ attribute: 'os.family', values: ['linux'] }];
function gauge(id: string, unit: MetricDefinition['unit'], meaning: string, dimensions: string[] = [], integer = false): MetricDefinition {
  return {category:'extension',namespace:'linux',id,semantic_version:'1.0.0',resource_type:'server',unit,meaning,scope:'resource',kind:'gauge',roles:['diagnostic'],
    temporality:'instant',monotonic:false,value_type:integer?'uint64':'float64',dimensions:{keys:dimensions.map(name=>({name,meaning:`Stable ${name} identity`,required:true})),
      max_series_per_resource:100,max_value_length:128,overflow:'reject'},aggregation:{time:['last','min','max','mean'],space:['none'],missing:'preserve_null',min_coverage:1,quantiles:'not_applicable'},lifecycle:'active'};
}
export const hostGaugeFields = [
  ['memory_used','linux.memory.used_bytes','By','free -b used memory bytes; not database memory.',true],
  ['memory_total','linux.memory.total_bytes','By','free -b total physical memory bytes.',true],
  ['load_5min','linux.load.five_minutes','1','/proc/loadavg five-minute runnable/uninterruptible task load average.',false],
  ['load_15min','linux.load.fifteen_minutes','1','/proc/loadavg fifteen-minute runnable/uninterruptible task load average.',false],
  ['swap_usage','linux.swap.used_percent','%','free used/total swap; real zero when no configured swap.',false],
  ['process_count','linux.processes.count','count','ps -e process row count at this snapshot.',true],
  ['top_processes_cpu','linux.processes.sample_max_cpu_percent','%','Maximum pcpu in the bounded top 20 processes sorted by CPU; ps lifetime CPU percent, not host CPU.',false],
  ['top_processes_memory','linux.processes.cpu_sample_max_memory_percent','%','Maximum pmem within top 20 processes sorted by CPU; not necessarily host-wide maximum memory consumer.',false],
] as const;
const gauges: ImplementationSpec = {id:'builtin:linux.diagnostic-gauges.v1',method:'ssh',resource_type:'server',applicability,
  outputs:hostGaugeFields.map(([raw_field,id,unit,meaning,integer])=>({raw_field,definition:gauge(id,unit,meaning,[],integer),input_unit:unit})),
  permissions:['SSH login','run fixed free, procfs and bounded ps commands'],discovery:'Singleton numeric host diagnostics; no arbitrary process or command parameters'};
const filesystem: ImplementationSpec = {id:'builtin:linux.filesystem-diagnostics.v1',method:'ssh',resource_type:'server',applicability,
  outputs:[{raw_field:'available',definition:gauge('linux.filesystem.available_bytes','By','Filesystem bytes available to an unprivileged process from df; excludes reserved free blocks.',['mount','device','fs_type'],true),input_unit:'By'},
    {raw_field:'inode_usage',definition:gauge('linux.filesystem.inode_used_percent','%','df inode IUse percentage; NULL where filesystem does not report inodes.',['mount','device','fs_type']),input_unit:'%'}],
  permissions:['SSH login','run fixed df and findmnt commands'],discovery:'Same bounded mounted filesystems as the canonical bytes; no aggregation across mounts'};
const events = gauge('linux.network.events_total','count','Cumulative interface receive/transmit errors or drops by event, direction and lifecycle epoch.',['interface','direction','event'],true);
events.kind='counter';events.temporality='cumulative';events.monotonic=true;events.aggregation.time=['last','rate'];
const network: ImplementationSpec = {id:'builtin:linux.network-diagnostics.v1',method:'ssh',resource_type:'server',applicability,
  outputs:[{raw_field:'events',definition:events,input_unit:'count'}],permissions:['SSH login','read /proc/net/dev'],
  discovery:'Bounded non-loop interface errors/drops; exact uint64 and authoritative host/interface epoch required'};
export const hostDiagnosticSpecs = [gauges,filesystem,network];
export function hostDiagnosticRelease(): PackageRelease {
  const releases=builtinReleases(),host=releases.find(r=>r.package.id==='linux-host')!,basic=releases.find(r=>r.package.id==='linux-basic')!;
  const additions=hostDiagnosticSpecs.map(s=>({id:s.id.split(':')[1].replace(/\./g,'-'),implementation_ref:s.id,method:s.method,timeout_ms:5000,estimated_cost:'low' as const,
    mappings:s.outputs.map(o=>({metric:{id:o.definition.id,semantic_version:o.definition.semantic_version},raw_field:o.raw_field,input_unit:o.input_unit,output_unit:o.definition.unit,
      transform_version:'1.0.0',steps:['decode','normalize'] as Array<'decode'|'normalize'>}))}));
  return sealRelease({...host,package:{...host.package,version:'1.1.0',collectors:[...basic.package.collectors,...host.package.collectors,...additions]},
    extensions:[...basic.extensions,...host.extensions,...hostDiagnosticSpecs.flatMap(s=>s.outputs.map(o=>o.definition as Extract<MetricDefinition,{category:'extension'}>))],
    documentation:[...basic.documentation,...host.documentation,...hostDiagnosticSpecs.map((s,i)=>({collector_id:additions[i].id,permissions:s.permissions,discovery:s.discovery}))]});
}
