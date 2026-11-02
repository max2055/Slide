import Fastify from 'fastify';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {actorContextService, ActorAuthenticationError, type ActorContext} from '../auth/actor-context.js';
import {instanceDatabaseService} from '../instance-database-service.js';
import {serverDatabaseService} from '../server-database-service.js';
import {networkDeviceDatabaseService} from '../network-devices/network-device-database-service.js';
import {registerResourceIdentityRoutes} from './resource-identity-routes.js';
import {registerInstanceListRoutes} from '../instance-list-routes.js';
import {registerNetworkDeviceRoutes} from '../network-devices/network-device-routes.js';

const actor: ActorContext = {userId:741,username:'reader',roles:[],permissions:['instance:view','servers:view','network_devices:view'],instanceScopes:{25:'read-only'},sessionVersion:1,requestId:'race'};
const targets = [
 {type:'instance',url:'/api/database/instances',service:instanceDatabaseService,detail:'getInstanceById',list:'getManagedInstances',secret:'password_encrypted'},
 {type:'server',url:'/api/servers',service:serverDatabaseService,detail:'getServerById',list:'getAllServers',secret:'credential_encrypted'},
 {type:'network_device',url:'/api/network-devices',service:networkDeviceDatabaseService,detail:'getDeviceById',list:'getAllDevices',secret:'snmp_credential_encrypted'},
] as const;
afterEach(()=>vi.restoreAllMocks());
describe('identity reads authorize after asynchronous storage reads',()=>{
 for(const target of targets) for(const list of [false,true]) {
  for(const change of ['permission revoked','account disabled','ACL removed','authorized'] as const) {
   it(`${target.type} ${list?'list':'detail'}: ${change} during storage`,async()=>{
    const app=Fastify();
    const verify=async(request:any)=>{request.user=actor;};
    await registerResourceIdentityRoutes(app,verify);await registerInstanceListRoutes(app,verify);await registerNetworkDeviceRoutes(app,verify);
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const row={id:25,name:'protected-identity',host:'192.0.2.1',db_type:'mysql',port:3306,database_name:'fixture',status:'active',created_at:'2026-11-01T00:00:00Z',[target.secret]:'synthetic-secret'};
    vi.spyOn(target.service as any,list?target.list:target.detail).mockImplementation(async()=>{entered();await waiting;return list?[row]:row;});
    let changed=false;
    vi.spyOn(actorContextService,'revalidateActor').mockImplementation(async()=>{
     if(!changed)return actor;
     if(change==='account disabled')throw new ActorAuthenticationError();
     if(change==='permission revoked')return {...actor,permissions:[]};
     if(change==='ACL removed')return {...actor,instanceScopes:{},resourceBoundary:{instanceIds:[],serverIds:[],networkDeviceIds:[]}};
     return actor;
    });
    vi.spyOn(serverDatabaseService,'decryptCredentials').mockReturnValue({username:'reader'} as any);
    const pending=app.inject({url:target.url+(list?'':'/25')});
    // inject is thenable; start the request before waiting for the storage gate.
    const responsePromise=Promise.resolve(pending);
    await started;changed=true;release();
    const response=await responsePromise;
    if(change==='authorized'){
     expect(response.statusCode).toBe(200);expect(response.body).toContain('protected-identity');expect(response.body).not.toContain('synthetic-secret');
    }else if(change==='ACL removed'&&list){expect(response.statusCode).toBe(200);expect(response.json()).toEqual([]);}
    else {expect(response.statusCode).toBe(change==='account disabled'?401:403);expect(response.body).not.toContain('protected-identity');expect(response.body).not.toContain('synthetic-secret');}
    await app.close();vi.restoreAllMocks();
   });
  }
 }
});
