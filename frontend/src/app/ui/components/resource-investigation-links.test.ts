import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({authFetch:vi.fn()}));
vi.mock('../../../api/index.ts',()=>({authFetch}));
import './resource-investigation-links.ts';

const response=(body:unknown)=>({ok:true,json:async()=>body});
async function mount() {
  const element=document.createElement('resource-investigation-links') as any;
  element.resourceType='server';element.resourceId=101;document.body.append(element);
  await element.updateComplete;
  return element;
}
beforeEach(()=>{authFetch.mockReset();});
afterEach(()=>document.body.replaceChildren());

it('opens persisted investigations without admitting new work',async()=>{
  authFetch.mockResolvedValue(response({items:[{id:'existing',title:'CPU 调查'}]}));
  const element=await mount();
  await vi.waitFor(()=>expect(element.shadowRoot.querySelector('a[href="/investigations?investigation=existing"]')).not.toBeNull());
  expect(authFetch).toHaveBeenCalledTimes(1);
  expect(authFetch).toHaveBeenCalledWith('/api/investigations?resource=server:101&limit=5',expect.objectContaining({cache:'no-store'}));
});

it('shows a recoverable error for a successful HTTP response with an invalid list instead of crashing or reporting no investigations',async()=>{
  authFetch.mockResolvedValue(response({hosts:[]}));
  const element=await mount();
  await vi.waitFor(()=>expect(element.shadowRoot.querySelector('[role="alert"]')).not.toBeNull());
  expect(element.shadowRoot.querySelector('app-empty-state')).toBeNull();
  expect(element.shadowRoot.querySelector('button')?.textContent).toContain('重新加载调查');
});

it('discards an in-flight response after permission revocation',async()=>{
  let finish!:(value:unknown)=>void;
  authFetch.mockImplementation(()=>new Promise(resolve=>finish=resolve));
  const element=await mount();
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}}));
  finish(response({items:[{id:'private',title:'撤权后不得显示'}]}));
  await vi.waitFor(()=>expect(element.shadowRoot.querySelector('[role="alert"]')?.textContent).toContain('权限已变更'));
  expect(element.shadowRoot.textContent).not.toContain('撤权后不得显示');
  expect(element.shadowRoot.querySelector('a[href*="investigation=private"]')).toBeNull();
});
