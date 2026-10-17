import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMetricBulkRoutes } from './routes.js';
import type { BulkConfigurationService } from './service.js';
import { BulkPreviewSchema } from './model.js';
import { admin } from '../policy/test-support.js';
import { PolicyError } from '../policy/model.js';

describe('bulk configuration HTTP boundary',()=>{
  const app=Fastify();let authenticated=true;
  const preview=vi.fn(async(_actor,input)=>BulkPreviewSchema.parse(input));
  const get=vi.fn(async()=>{throw new PolicyError('BULK_NOT_FOUND',404);});
  const confirm=vi.fn(async()=>({queued:true}));
  const service={preview,get,confirm,list:async()=>({jobs:[]}),cancel:vi.fn(),retry:vi.fn()} as unknown as BulkConfigurationService;
  afterEach(async()=>{await app.close();});
  it('denies missing identity, rejects unbounded/duplicate inputs and masks foreign ownership',async()=>{
    await registerMetricBulkRoutes(app,async request=>{if(authenticated)(request as any).user=admin;},service,false);
    authenticated=false;
    expect((await app.inject({method:'POST',url:'/api/metrics/config/bulk/preview',payload:{}})).statusCode).toBe(401);
    expect(preview).not.toHaveBeenCalled();authenticated=true;
    for(const resources of [[],[{type:'instance',id:1},{type:'instance',id:1}],Array.from({length:101},(_,i)=>({type:'instance',id:i+1}))]){
      expect((await app.inject({method:'POST',url:'/api/metrics/config/bulk/preview',payload:{key:'valid-key',resources}})).statusCode).toBe(400);
    }
    expect((await app.inject('/api/metrics/config/bulk/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await app.inject('/api/metrics/config/bulk/not-a-uuid')).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/metrics/config/bulk/00000000-0000-4000-8000-000000000000/confirm',payload:{digest:'a'.repeat(64),force:true}})).statusCode).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
    const list=await app.inject('/api/metrics/config/bulk');expect(list.statusCode).toBe(200);expect(list.headers['cache-control']).toBe('private, no-store');
  });
});
