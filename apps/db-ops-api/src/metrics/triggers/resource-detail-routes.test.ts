import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
const mocks=vi.hoisted(()=>({execute:vi.fn(),reload:vi.fn(),status:vi.fn(),access:vi.fn()}));
vi.mock('../../db-connection.js',()=>({dbConnection:{getPool:()=>({execute:mocks.execute})}}));
vi.mock('../../auth/actor-context.js',async original=>({...await original<any>(),actorContextService:{revalidateActor:mocks.reload}}));
vi.mock('../templates/routes.js',()=>({templateBindingService:{status:mocks.status,assertAccess:mocks.access}}));
import {registerResourceTriggerRead} from './resource-detail-routes.js';
import {baseline,portOf} from './test-support.js';
import {resolveTriggerRules} from './resolve.js';
import {compileTriggerSnapshot} from './compile.js';
let app:ReturnType<typeof Fastify>;
beforeEach(async()=>{vi.resetAllMocks();mocks.reload.mockResolvedValue({permissions:['metric:view']});mocks.access.mockResolvedValue(undefined);app=Fastify();await registerResourceTriggerRead(app,async(req:any)=>{req.user={permissions:['metric:view']};});});
afterEach(async()=>{await app.close();});
it('reads the original applied revision after a newer target failed instead of advertising target rules',async()=>{
 const base=await baseline();const snapshot=compileTriggerSnapshot(await resolveTriggerRules(base.resolution,base.catalog,portOf([base.version]).port));
 mocks.status.mockResolvedValue({revision:snapshot.config_revision+1,application:{status:'failed'},effective:{revision:snapshot.config_revision}});
 mocks.execute.mockResolvedValue([[{payload:JSON.stringify(snapshot)}]]);
 const r=await app.inject({url:`/api/metrics/template-bindings/${snapshot.resource.type}/${snapshot.resource.id}/effective-triggers`});
 expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({revision:snapshot.config_revision,state:'available',snapshot});
 expect(mocks.execute.mock.calls[0][1]).toEqual([`${snapshot.resource.type}:${snapshot.resource.id}`,snapshot.config_revision]);
 expect(r.headers['cache-control']).toContain('no-store');
});
it('reports unavailable snapshot explicitly instead of claiming zero effective rules',async()=>{
 mocks.status.mockResolvedValue({effective:null});const r=await app.inject({url:'/api/metrics/template-bindings/server/3/effective-triggers'});
 expect(r.json()).toEqual({resource:{type:'server',id:3},revision:null,state:'unavailable',snapshot:null});expect(mocks.execute).not.toHaveBeenCalled();
});
it('denies revocation before releasing any prior snapshot',async()=>{
 mocks.status.mockResolvedValue({effective:null});mocks.reload.mockResolvedValueOnce({permissions:['metric:view']}).mockResolvedValueOnce({permissions:[]});
 const r=await app.inject({url:'/api/metrics/template-bindings/instance/1/effective-triggers'});expect(r.statusCode).toBe(403);expect(r.json()).not.toHaveProperty('snapshot');
});
it('refuses corrupt applied evidence',async()=>{
 mocks.status.mockResolvedValue({effective:{revision:1}});mocks.execute.mockResolvedValue([[{payload:'{}'}]]);
 const r=await app.inject({url:'/api/metrics/template-bindings/instance/1/effective-triggers'});expect(r.statusCode).toBe(503);expect(r.json()).not.toHaveProperty('snapshot');
});
