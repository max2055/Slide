import {it,expect} from 'vitest';
import Fastify from 'fastify';
import {installPlatformObservation} from './platform-observation-service.js';
import {StructuredLogEvidenceAdapter} from './structured-log-evidence-adapter.js';
import { installSystemFailurePublisher, SystemFailurePublisher } from './system-failure-publisher.js';
import type { SystemFailure } from '../investigations/system-event-bridge.js';

it('R1 real HTTP: recovery requires the original object, query and caller scope without retaining their values', async () => {
 let now=Date.now(); const logs=new StructuredLogEvidenceAdapter(()=>now); const app=Fastify();
 const failures: SystemFailure[]=[];
 const publisher=new SystemFailurePublisher(async f=>{failures.push(f);});
 const uninstall=installSystemFailurePublisher(publisher);
 const prior=[process.env.SLIDE_RELEASE_ID,process.env.SLIDE_COMMIT_SHA];
 process.env.SLIDE_RELEASE_ID='r1';process.env.SLIDE_COMMIT_SHA='a'.repeat(40);
 let status=503;
 try {
  await installPlatformObservation(app,async()=>{},logs);
  app.get('/api/items/:id',async(_req,reply)=>reply.code(status).send({}));
  app.post('/api/items/:id',async(_req,reply)=>reply.code(status).send({}));
  await app.listen({host:'127.0.0.1',port:0});
  const base=app.listeningOrigin;
  const request=(path:string,token='private-caller',method='GET')=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`}});
  await request('/api/items/private-object?secret=private-query'); await publisher.drain();
  const event=failures[0]; status=200; now+=1000;
  for(const [path,token] of [
   ['/api/items/other?secret=private-query','private-caller'],
   ['/api/items/private-object?secret=other','private-caller'],
   ['/api/items/private-object?secret=private-query','other-caller'],
  ]) {
   await request(path,token); now+=1000;
   expect(logs.verifyFailure(event,true).conclusion).toBe('insufficient_evidence');
  }
  status=503;await request('/api/items/private-object?secret=private-query');
  expect(logs.verifyFailure(event,true).conclusion).toBe('not_improved');
  status=200;now+=1000;await request('/api/items/private-object?secret=private-query');
  expect(logs.verifyFailure(event,true).conclusion).toBe('recovered');
  const evidence=JSON.stringify([event,logs.verifyFailure(event,true),logs.query({})]);
  for(const secret of ['private-object','private-query','private-caller']) expect(evidence).not.toContain(secret);
  now+=1000;process.env.SLIDE_COMMIT_SHA='b'.repeat(40);
  await request('/api/items/private-object?secret=private-query');
  expect(logs.verifyFailure(event,true).gaps).toContain('SOURCE_COMMIT_MISMATCH');
  // Mutating requests and historical facts without their original scoped log stay unknown.
  process.env.SLIDE_COMMIT_SHA='a'.repeat(40);status=503;
  await request('/api/items/private-object','private-caller','POST');await publisher.drain();
  const post=failures.at(-1)!;status=200;now+=1000;
  await request('/api/items/private-object','private-caller','POST');
  expect(logs.verifyFailure(post,true).conclusion).toBe('insufficient_evidence');
  expect(logs.verifyFailure({...event,correlationId:'missing'},true).conclusion).toBe('insufficient_evidence');
 } finally {
  uninstall();await app.close();
  for(const [i,k] of ['SLIDE_RELEASE_ID','SLIDE_COMMIT_SHA'].entries()){if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];}
 }
});
it('Chief R1: another route parameter success cannot recover original object failure', async()=>{
 let now=Date.now();const logs=new StructuredLogEvidenceAdapter(()=>now);const app=Fastify();
 const prior=[process.env.SLIDE_RELEASE_ID,process.env.SLIDE_COMMIT_SHA];
 process.env.SLIDE_RELEASE_ID='r1';process.env.SLIDE_COMMIT_SHA='a'.repeat(40);
 try {await installPlatformObservation(app,async()=>{},logs);
 app.get('/api/items/:id',async(req,reply)=>{if((req.params as any).id==='broken')return reply.code(503).send({});return {};});
 await app.inject('/api/items/broken');const event={occurredAt:new Date(now).toISOString(),callsite:'api:GET:/api/items/:id',releaseId:'r1',commitSha:'a'.repeat(40)};
 now+=1000;await app.inject('/api/items/healthy');
 expect(logs.verifyFailure(event,true).conclusion).not.toBe('recovered');
 } finally {await app.close();for(const [i,k] of ['SLIDE_RELEASE_ID','SLIDE_COMMIT_SHA'].entries()){if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];}}
});
