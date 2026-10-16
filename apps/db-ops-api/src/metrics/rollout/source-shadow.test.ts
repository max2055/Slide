import { readFileSync } from 'node:fs';
import { describe,it,expect,vi } from 'vitest';
import type { Client } from 'ssh2';
import { SourceSnapshotCapture } from './source-shadow.js';
import { validSourceSnapshot } from './source-history.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { runPackage } from '../packages/runner.js';
import { collectFixed,type Transport } from '../packages/adapters.js';
const fixture=JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/host/fixtures.json',import.meta.url),'utf8'));
const ref={type:'server' as const,id:1};
async function snapshot(){
  const registry=createConfigurationRegistry(),release=registry.list().find(r=>r.package.id==='linux-host'&&r.package.version==='1.1.0')!,capture=new SourceSnapshotCapture();
  const sample=fixture.samples[0];
  let bytesReads=0;
  const execCommands=vi.fn(async (_client:Client,commands:string[])=>commands.map(command=>{
    let stdout='1\n';
    if(command.includes('top -bn1'))stdout=sample.gauges.cpu_usage;
    else if(command.includes('free |'))stdout=sample.gauges.memory_usage;
    else if(command.includes('df -P -B1'))stdout=bytesReads++?sample.filesystem.bytes.replaceAll('400000','450000'):sample.filesystem.bytes;
    else if(command.includes('df -Pi'))stdout=sample.filesystem.inodes;
    else if(command.includes('findmnt'))stdout=sample.filesystem.mounts;
    else if(command.includes('/proc/net/dev'))stdout=sample.network;
    else if(command.includes('/proc/diskstats'))stdout=sample.disk;
    return {stdout,stderr:'',exitCode:0,signal:null,truncated:false};
  }));
  const transport:Transport={method:'ssh',client:{} as Client,pool:{execCommands}};
  const p=release.package;
  const result=await runPackage(registry,{package:{id:p.id,version:p.version,digest:p.digest},credential_ref:'credential:fixture',overrides:{}},{
    resource:{type:'server',id:'1',attributes:{'os.family':{value:'linux',observed_at:sample.at,source:'fixture'}}},
    binding_id:'server:1',attempt_id:'fixture',config_revision:7,observed_at:sample.at,clock:()=>sample.at,evidence:{host_counter_epochs:fixture.epochs.first},resolve:async()=>transport,
    collect:(reference,t,...args)=>collectFixed(reference,capture.inCollector(reference,t),...args),
  });
  const samples=result.observations.map(o=>o.observation);
  const before=execCommands.mock.calls.length;
  const evidence=capture.compare(ref,'',samples,registry.catalog(p),p.collectors);
  expect(execCommands.mock.calls.length).toBe(before);
  return {evidence,samples,result};
}
describe('actual source snapshot comparison',()=>{
  it('replays original scalar and filesystem interpretations from each collector own response without another remote call',async()=>{
    const {evidence,samples}=await snapshot();
    expect(evidence.checks.some(c=>c.legacy_reference==='cpu_usage'&&c.state==='passed')).toBe(true);
    expect(evidence.checks.some(c=>c.legacy_reference==='filesystem_used_bytes'&&c.state==='passed')).toBe(true);
    expect(evidence.checks.every(c=>c.state==='passed')).toBe(true);
    expect(validSourceSnapshot(evidence,ref,samples)).toBe(true);
    expect(evidence.semantic_differences.every(d=>d.sample_id&&d.reason)).toBe(true);
  });
  it('rejects missing, mismatched scope/revision/sample and failed comparison evidence',async()=>{
    const {evidence,samples}=await snapshot();
    for(const bad of [null,{...evidence,revision:8},{...evidence,resource:{type:'server',id:2}},{...evidence,sample_ids:[]},
      {...evidence,checks:evidence.checks.map(c=>({...c,state:'failed'}))}])expect(validSourceSnapshot(bad,ref,samples)).toBe(false);
    const noCapture=new SourceSnapshotCapture().compare(ref,'',samples,createConfigurationRegistry().catalog({id:'linux-host',version:'1.1.0',digest:createConfigurationRegistry().list().find(r=>r.package.id==='linux-host'&&r.package.version==='1.1.0')!.package.digest}));
    expect(noCapture.checks.some(c=>c.state==='failed')).toBe(true);
  });
});
