import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyService } from './service.js';
import { registerMetricPolicyRoutes } from './routes.js';
import { MemoryPolicyStore, testResources, admin, pin, at } from './test-support.js';
import type { ActorContext } from '../../auth/actor-context.js';

describe('policy API', () => {
  let app: ReturnType<typeof Fastify>, store: MemoryPolicyStore, actor: ActorContext | undefined, service: PolicyService;
  const base = '/api/metrics/policy';
  const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `${base}${path}`, payload: payload as object });
  const get = (path: string) => app.inject({ method: 'GET', url: `${base}${path}` });
  const create = (id = 1, extra = {}) => service.changeBinding(admin, { type: 'instance', id }, { expected_revision: 0, package: pin, ...extra }, true);
  beforeEach(async () => {
    store = new MemoryPolicyStore(); actor = admin; app = Fastify();
    service = new PolicyService(store, createBuiltinRegistry(), testResources, () => at);
    await registerMetricPolicyRoutes(app, async request => { (request as any).user = actor; }, service, async () => actor!);
  });
  afterEach(async () => { await app.close(); });
  it('retains audit while retiring direct package binding writes', async () => {
    await create();
    expect((await post('/resources/instance/1/publish', { expected_revision: 1 })).statusCode).toBe(404);
    expect((await get('/resources/instance/1/audit')).json()).toMatchObject([{ revision: 1, action: 'binding.publish' }]);
  });
  it('group search does not reveal empty or partially inaccessible groups', async () => {
    store.groups.set('team',{id:'team',revision:1,overrides:{}});
    store.groups.set('empty',{id:'empty',revision:1,overrides:{}});
    await create(1,{group_id:'team'});await create(2,{group_id:'team'});
    actor={...admin,permissions:['instance:view'],instanceScopes:{1:'read-only'}};
    expect((await get('/groups')).json()).toEqual({groups:[]});
    actor=admin;
    const response=await get('/groups?query=tea');
    expect(response.statusCode).toBe(200);expect(response.json().groups).toMatchObject([{id:'team',can_manage:true}]);
    actor=undefined;expect((await get('/groups')).statusCode).toBe(401);
  });
});
