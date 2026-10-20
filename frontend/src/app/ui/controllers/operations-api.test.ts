import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactiveControllerHost } from 'lit';
import { authFetch } from '../../../api/index.ts';
import { OperationsResource, operationsApi } from './operations-api.ts';
vi.mock('../../../api/index.ts', () => ({ authFetch:vi.fn() }));
const api=vi.mocked(authFetch);
const response=(value:unknown,status=200)=>({ok:status<400,status,json:async()=>value}) as Response;
let resources: OperationsResource<unknown>[]=[];
const resource=()=>{
  const host={addController:vi.fn(),requestUpdate:vi.fn()} as unknown as ReactiveControllerHost;
  const clear=vi.fn(),r=new OperationsResource<{secret:string}>(host,clear);r.hostConnected();resources.push(r);return {r,clear};
};
beforeEach(()=>{api.mockReset();});
afterEach(()=>{resources.forEach(r=>r.hostDisconnected());resources=[];});
describe('operations HTTP authority and uncertain acceptance',()=>{
  it('sends authenticated requests with no-store and preserves reasonCode errors',async()=>{
    api.mockResolvedValue(response({reasonCode:'OPERATIONS_VERSION_CONFLICT'},409));
    await expect(operationsApi('/knowledge/one')).rejects.toMatchObject({status:409,code:'OPERATIONS_VERSION_CONFLICT'});
    expect(api).toHaveBeenCalledWith('/api/operations/knowledge/one',expect.objectContaining({cache:'no-store'}));
  });
  it.each(['slide-permissions-loaded','slide-session-expired'])('withdraws cached data and ignores late HTTP after %s',async(event)=>{
    const {r,clear}=resource();r.data={secret:'previous'};
    let release!:(v:Response)=>void;api.mockImplementation(()=>new Promise(resolve=>release=resolve));
    const pending=r.load('/knowledge/one');window.dispatchEvent(new Event(event));
    release(response({secret:'late'}));await pending;
    expect(r.data).toBeNull();expect(r.accessInvalidated).toBe(true);expect(clear).toHaveBeenCalled();
    await r.load('/knowledge/one');expect(api).toHaveBeenCalledTimes(1);
  });
  it('releases no previous target data while loading and fences an older target response',async()=>{
    const {r}=resource();let release!:(v:Response)=>void;
    api.mockImplementationOnce(()=>new Promise(resolve=>release=resolve)).mockResolvedValueOnce(response({secret:'new target'}));
    r.data={secret:'cached'};const previous=r.load('/knowledge/old');expect(r.data).toBeNull();
    r.reset();await r.load('/knowledge/new');release(response({secret:'old target'}));await previous;
    expect(r.data).toEqual({secret:'new target'});
  });
  it.each([503,'network'])('uncertain %s write cannot be replayed, including after read-only reconciliation',async(status)=>{
    const {r}=resource();
    if(status==='network')api.mockRejectedValueOnce(new Error('network'));else api.mockResolvedValueOnce(response({},status as number));
    await r.write('/actions/plans/p/submit',{expectedVersion:3});expect(r.mutationUnknown).toBe(true);
    api.mockResolvedValueOnce(response({secret:'read-only current'}));await r.load('/actions/plans/p');
    expect(r.data).toEqual({secret:'read-only current'});
    await r.write('/actions/plans/p/submit',{expectedVersion:3});expect(api).toHaveBeenCalledTimes(2);
  });
  it('explicit conflict permits correction, concurrent double-click never sends twice',async()=>{
    const {r}=resource();let release!:(v:Response)=>void;api.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));
    const pending=r.write('/knowledge/k/review',{expectedRevision:2});await r.write('/knowledge/k/review',{expectedRevision:2});
    expect(api).toHaveBeenCalledTimes(1);release(response({error:'OPERATIONS_VERSION_CONFLICT'},409));await pending;
    expect(r.mutationUnknown).toBe(false);expect(r.error).toContain('版本已变化');
  });
  it('unmount fences a late write acknowledgement and erases drafts',async()=>{
    const {r,clear}=resource();let release!:(v:Response)=>void;api.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));
    const pending=r.write('/knowledge',{sensitive:'draft'});r.hostDisconnected();release(response({secret:'created'}));
    expect(await pending).toBeNull();expect(clear).toHaveBeenCalled();expect(r.data).toBeNull();
  });
});
