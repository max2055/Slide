import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {AuditLogManager,MemoryAuditLogStore} from './audit-log.js';
import {registerSystemAuditRoutes} from './system-audit-routes.js';
it.each(['/api/metrics/template-bindings/:type/:id/apply','/api/metrics/config/resources/:type/:id/activate','/api/metrics/policy/resources/:type/:id'])('records %s under the exact resource rather than a generic metrics family',async route=>{
 const app=Fastify(),store=new MemoryAuditLogStore();
 const verify=async(req:any)=>{req.user={userId:741,username:'audit-reader',permissions:['audit:view']};};
 await registerSystemAuditRoutes(app,verify,new AuditLogManager(store));
 app.post(route,{preHandler:[verify]},async()=>({ok:true}));
 await app.inject({method:'POST',url:route.replace(':type','server').replace(':id','25')});
 const result=await store.query({resourceType:'server',resourceId:'25'});expect(result.total).toBe(1);expect(result.entries[0].resourceId).toBe('25');await app.close();
});
