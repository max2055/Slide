/** Transactional persistence for the maintenance-window service. No collector or event writer. */
import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { actorContextService, type ActorContext } from './auth/actor-context.js';
import { canManageResource, canReadResource, MysqlResourceRelationStore } from './resources/resource-service.js';
import { RefSchema, OperationKeySchema, rule, type Ref } from './metrics/policy/model.js';
import { stable } from './metrics/packages/model.js';
const date = z.string().datetime({ offset: true });
export const MaintenanceInput = z.strictObject({
 name: z.string().trim().min(1).max(128), reason: z.string().trim().min(1).max(1000),
 resources: z.array(RefSchema).min(1).max(650).nullable(),
 starts_at: date, ends_at: date, timezone: z.string().max(80),
}).superRefine((v,c) => {
 if(Date.parse(v.ends_at)<=Date.parse(v.starts_at)) c.addIssue({code:'custom',message:'MAINTENANCE_DURATION'});
 try { new Intl.DateTimeFormat('en',{timeZone:v.timezone}); } catch { c.addIssue({code:'custom',message:'MAINTENANCE_TIMEZONE'}); }
 if(v.resources && new Set(v.resources.map(r=>`${r.type}:${r.id}`)).size!==v.resources.length) c.addIssue({code:'custom',message:'MAINTENANCE_DUPLICATE_RESOURCE'});
});
export const WeeklyScheduleInput = z.object({
 day_of_week:z.string().max(50).transform(v=>v.split(',').map(d=>d.trim()).join(',')).pipe(z.string().regex(/^(\*|[1-7](,[1-7])*)$/)),
 start_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
 end_time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
 timezone:z.string().min(1).max(50).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}}, 'MAINTENANCE_TIMEZONE'),
});
export const WeeklyInput = z.strictObject({
 name:z.string().trim().min(1).max(100), reason:z.string().max(1000),
 resources:z.array(RefSchema).length(1).nullable(),
 ...WeeklyScheduleInput.shape,
}).superRefine((v,c)=>{
 if(v.resources?.some(r=>r.type!=='instance'))c.addIssue({code:'custom',message:'MAINTENANCE_WEEKLY_INSTANCE'});
 if(v.start_time.padEnd(8,':00')===v.end_time.padEnd(8,':00'))c.addIssue({code:'custom',message:'MAINTENANCE_DURATION'});
});
function weekly(row:any){return {kind:'weekly',id:String(row.id),revision:Number(row.revision),name:row.name,
 reason:row.description??'',resources:row.instance_id==null?null:[{type:'instance',id:Number(row.instance_id)}],
 day_of_week:row.day_of_week,start_time:row.start_time,end_time:row.end_time,timezone:row.timezone,
 cancelled_at:row.enabled?null:new Date(row.updated_at).toISOString()};}
export type Interval = z.infer<typeof MaintenanceInput> & {id:string;revision:number;cancelled_at:string|null;changed_at:string;actor_id:number};
const decode = (v:any) => typeof v==='string'?JSON.parse(v):v;
export function intervalContains(v:Interval, ref:Ref, at:number) {
 return Date.parse(v.starts_at)<=at && at<Math.min(Date.parse(v.ends_at),v.cancelled_at?Date.parse(v.cancelled_at):Infinity) &&
 (!v.resources || v.resources.some(r=>r.type===ref.type&&r.id===ref.id));
}
export class MaintenanceIntervals {
 constructor(private pool:()=>Pool, private clock=()=>Date.now()){}
 private access(actor:ActorContext, v:Pick<Interval,'resources'>,write:boolean) {
  rule(!write || actor.permissions.includes('*') || actor.permissions.includes('maintenance:manage'),'MAINTENANCE_FORBIDDEN',403);
  if(!v.resources) rule(actor.permissions.includes('*')&&!actor.resourceBoundary,'MAINTENANCE_GLOBAL_FORBIDDEN',403);
  else for(const ref of v.resources) rule(write?canManageResource(actor,ref):canReadResource(actor,ref),'MAINTENANCE_FORBIDDEN',403);
 }
 private async transaction<T>(actor:ActorContext, work:(c:PoolConnection,live:()=>Promise<ActorContext>)=>Promise<T>):Promise<T>{
  const c=await this.pool().getConnection();
  let reusable=false;
  try {
   await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
   await c.execute('SELECT id FROM maintenance_scope_lock WHERE id=1 FOR UPDATE');
   const live=()=>actorContextService.revalidateActorOn(c as any,actor,actor.requestId);
   await live(); const result=await work(c,live); await c.commit(); reusable=true; return result;
  } catch(e){try{await c.rollback();reusable=true;}catch{/* Unknown transaction state must not return to the pool. */}throw e;} finally {if(reusable)c.release();else c.destroy();}
 }
 async change(actor:ActorContext,id:string|null,raw:unknown){
  if(id && /^[1-9]\d*$/.test(id))return this.changeWeekly(actor,id,raw);
  const input=z.strictObject({operation_key:OperationKeySchema,expected_revision:z.number().int().nonnegative(),value:MaintenanceInput.optional(),cancel:z.boolean().optional()}).parse(raw);
  rule(input.cancel===true ? !!id&&!input.value : !!input.value,'MAINTENANCE_INPUT');
  const fingerprint=createHash('sha256').update(stable({id,...input})).digest('hex');
  return this.transaction(actor,async(c,live)=>{
   const [ops]=await c.execute<RowDataPacket[]>('SELECT fingerprint,payload FROM maintenance_operations WHERE actor_id=? AND operation_key=?',[actor.userId,input.operation_key]);
   if(ops.length){rule(ops[0].fingerprint===fingerprint,'MAINTENANCE_KEY_REUSED',409);const stored=decode(ops[0].payload);const current=await live();for(const window of stored.required)this.access(current,window,true);return stored.result;}
   const [rows]=id?await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_intervals WHERE id=? FOR UPDATE',[id]):[[]];
   const previous:Interval|null=rows[0]?decode(rows[0].payload):null;
   rule(!id||previous,'MAINTENANCE_NOT_FOUND',404);
   if(previous)this.access(await live(),previous,true);
   rule(input.cancel||!previous?.cancelled_at,'MAINTENANCE_CANCELLED',409);
   rule((previous?.revision??0)===input.expected_revision,'MAINTENANCE_REVISION',409);
   const at=new Date(this.clock()).toISOString();
   let next:Interval = input.cancel ? {...previous!,cancelled_at:previous!.cancelled_at??at} :
    {...input.value!,id:id??randomUUID(),revision:previous?.revision??0,cancelled_at:null,changed_at:at,actor_id:actor.userId};
   this.access(await live(),next,true);
   const assets=new MysqlResourceRelationStore(()=>c as any);
   for(const ref of next.resources??[]) rule(await assets.exists(ref),'MAINTENANCE_RESOURCE_MISSING',404);
   const unchanged=previous && (input.cancel?!!previous.cancelled_at:stable({name:previous.name,reason:previous.reason,resources:previous.resources,starts_at:previous.starts_at,ends_at:previous.ends_at,timezone:previous.timezone})===stable(input.value));
   if(unchanged)next=previous; else {
    next={...next,revision:(previous?.revision??0)+1,changed_at:at,actor_id:actor.userId};
    await c.execute('INSERT INTO maintenance_intervals(id,revision,payload) VALUES(?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),payload=VALUES(payload)',[next.id,next.revision,JSON.stringify(next)]);
    await c.execute('INSERT INTO maintenance_interval_history(id,revision,payload) VALUES(?,?,?)',[next.id,next.revision,JSON.stringify(next)]);
   }
   const result={success:true,window:next,noop:!!unchanged};
   await c.execute('INSERT INTO maintenance_operations VALUES(?,?,?,?)',[actor.userId,input.operation_key,fingerprint,JSON.stringify({result,required:previous?[previous,next]:[next]})]);
   const final=await actorContextService.revalidateActorOn(c as any,actor,actor.requestId,true);
   this.access(final,next,true); if(previous)this.access(final,previous,true);
   return result;
  });
 }
 private async changeWeekly(actor:ActorContext,id:string,raw:unknown){
  const input=z.strictObject({operation_key:OperationKeySchema,expected_revision:z.number().int().nonnegative(),value:WeeklyInput.optional(),cancel:z.boolean().optional()}).parse(raw);
  rule(input.cancel===true?!input.value:!!input.value,'MAINTENANCE_INPUT');
  const fingerprint=createHash('sha256').update(stable({id,...input})).digest('hex');
  return this.transaction(actor,async(c,live)=>{
   const [ops]=await c.execute<RowDataPacket[]>('SELECT fingerprint,payload FROM maintenance_operations WHERE actor_id=? AND operation_key=?',[actor.userId,input.operation_key]);
   if(ops.length){rule(ops[0].fingerprint===fingerprint,'MAINTENANCE_KEY_REUSED',409);const stored=decode(ops[0].payload);const current=await live();for(const v of stored.required)this.access(current,v,true);return stored.result;}
   const [rows]=await c.execute<RowDataPacket[]>('SELECT * FROM maintenance_windows WHERE id=? FOR UPDATE',[id]);
   rule(rows.length===1,'MAINTENANCE_NOT_FOUND',404);const previous=weekly(rows[0]);
   this.access(await live(),previous as any,true);
   rule(previous.revision===input.expected_revision,'MAINTENANCE_REVISION',409);
   rule(input.cancel||!previous.cancelled_at,'MAINTENANCE_CANCELLED',409);
   const value=input.cancel?previous:input.value!;
   this.access(await live(),value as any,true);
   const assets=new MysqlResourceRelationStore(()=>c as any);
   for(const ref of value.resources??[])rule(await assets.exists(ref as Ref),'MAINTENANCE_RESOURCE_MISSING',404);
   const normalize=(v:any)=>({name:v.name,reason:v.reason,resources:v.resources,timezone:v.timezone,day_of_week:v.day_of_week,start_time:v.start_time.length===5?v.start_time+':00':v.start_time,end_time:v.end_time.length===5?v.end_time+':00':v.end_time});
   const noop=input.cancel?!!previous.cancelled_at:stable(normalize(previous))===stable(normalize(value));
   if(!noop){
    const v=normalize(value);
    await c.execute('UPDATE maintenance_windows SET name=?,description=?,instance_id=?,day_of_week=?,start_time=?,end_time=?,timezone=?,enabled=?,revision=revision+1 WHERE id=?',[v.name,v.reason,v.resources?.[0].id??null,v.day_of_week,v.start_time,v.end_time,v.timezone,input.cancel?0:1,id]);
   }
   const [updated]=await c.execute<RowDataPacket[]>('SELECT * FROM maintenance_windows WHERE id=?',[id]);const next=weekly(updated[0]);
   if(!noop)await c.execute('INSERT INTO maintenance_weekly_history VALUES(?,?,?)',[id,next.revision,JSON.stringify({...updated[0],actor_id:actor.userId,changed_at:new Date(this.clock()).toISOString()})]);
   const result={success:true,window:next,noop};
   await c.execute('INSERT INTO maintenance_operations VALUES(?,?,?,?)',[actor.userId,input.operation_key,fingerprint,JSON.stringify({result,required:[previous,next]})]);
   const final=await actorContextService.revalidateActorOn(c as any,actor,actor.requestId,true);this.access(final,previous as any,true);this.access(final,next as any,true);
   return result;
  });
 }
 async list(actor:ActorContext){return this.transaction(actor,async(c,live)=>{
  const [rows]=await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_intervals');
  const [legacy]=await c.execute<RowDataPacket[]>('SELECT * FROM maintenance_windows');
  const current=await live(); return [...rows.map(r=>decode(r.payload) as Interval),...legacy.map(weekly)].filter(v=>{try{this.access(current,v as any,false);return true;}catch{return false;}});
 });}
 async resources(actor:ActorContext){return this.transaction(actor,async(c,live)=>{
  const result:Array<Ref&{name:string}>=[];
  for(const [type,table,label] of [['instance','database_instances','name'],['server','servers','label'],['network_device','network_devices','name']] as const){
   const [rows]=await c.execute<RowDataPacket[]>(`SELECT id,${label} AS name FROM ${table} ORDER BY id`);
   const current=await live();for(const row of rows){const ref={type,id:Number(row.id)};if(canManageResource(current,ref))result.push({...ref,name:String(row.name??`${type}:${row.id}`)});}
  }
  const final=await live();return result.filter(r=>canManageResource(final,r));
 });}
 async operation(actor:ActorContext,key:string){OperationKeySchema.parse(key);return this.transaction(actor,async(c,live)=>{
  const [rows]=await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_operations WHERE actor_id=? AND operation_key=?',[actor.userId,key]);
  if(!rows.length)return {status:'absent'};const stored=decode(rows[0].payload);const current=await live();for(const window of stored.required)this.access(current,window,true);return {status:'committed',result:stored.result};
 });}
 async history(actor:ActorContext,ref:Ref,from:string,to:string){
  date.parse(from);date.parse(to);rule(Date.parse(from)<Date.parse(to),'MAINTENANCE_RANGE');
  return this.transaction(actor,async(c,live)=>{
   rule(canReadResource(await live(),ref),'MAINTENANCE_FORBIDDEN',403);
   const [rows]=await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_interval_history ORDER BY id,revision');
   const values=rows.map(r=>decode(r.payload) as Interval);
   const [links]=await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_event_links');
   const event_links=links.map(row=>decode(row.payload)).filter(v=>v.resource?.type===ref.type&&Number(v.resource?.id)===ref.id&&Date.parse(v.at)>=Date.parse(from)&&Date.parse(v.at)<Date.parse(to)).map(v=>({...v,intervals:v.intervals?.map((interval:any)=>({...interval,resources:[ref]}))}));
   rule(canReadResource(await live(),ref),'MAINTENANCE_FORBIDDEN',403);
   return {resource:ref,from,to,intervals:effectiveIntervals(values).filter(v=>(!v.resources||v.resources.some(r=>r.type===ref.type&&r.id===ref.id))&&Date.parse(v.effective_from)<Date.parse(v.effective_to)&&Date.parse(v.effective_from)<Date.parse(to)&&Date.parse(v.effective_to)>Date.parse(from)).map(v=>({...v,resources:[ref]})),event_links};
  });
 }
}
/** Historical revision validity is half-open; edits never rewrite prior facts. */
export function effectiveIntervals(values:Interval[]){
 return values.map(v=>{
  const next=values.find(n=>n.id===v.id&&n.revision===v.revision+1);
  return {...v,effective_from:new Date(Math.max(Date.parse(v.starts_at),Date.parse(v.changed_at))).toISOString(),
   effective_to:new Date(Math.min(Date.parse(v.ends_at),next?Date.parse(next.changed_at):Infinity,v.cancelled_at?Date.parse(v.cancelled_at):Infinity)).toISOString()};
 });
}
/** Called inside the unique event writer transaction. */
export async function maintenanceAt(c:Pick<PoolConnection,'execute'>,ref:Ref,at:number){
 const [rows]=await c.execute<RowDataPacket[]>('SELECT payload FROM maintenance_interval_history ORDER BY id,revision');
 return effectiveIntervals(rows.map(r=>decode(r.payload) as Interval)).filter(v=>Date.parse(v.effective_from)<=at&&at<Date.parse(v.effective_to)&&
  (!v.resources||v.resources.some(r=>r.type===ref.type&&r.id===ref.id)));
}
