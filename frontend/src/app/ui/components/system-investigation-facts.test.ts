import { afterEach, expect, it, vi } from 'vitest';
import { html, render } from 'lit';
vi.mock('../../../api/index.ts', () => ({ authFetch: vi.fn() }));
import { authFetch } from '../../../api/index.ts';
import './system-investigation-facts.ts';
const id = '11111111-1111-4111-8111-111111111111';
const event = '22222222-2222-4222-8222-222222222222';
const data = { events: [{ eventId: event, fact: { event: { summary: 'api: HTTP_503', occurredAt: '2026-11-01T00:00:00.000Z' } }, returnTo: '/events?view=system', verifications: [] }], truncated:false,modelInvoked:false };
const tick = () => new Promise(r => setTimeout(r, 0));
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });
async function setup() {
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify(data), {status:200}));
  const host=document.createElement('div'); document.body.append(host);
  render(html`<system-investigation-facts .investigationId=${id} .version=${4}></system-investigation-facts>`, host);
  await tick(); await tick(); return host.querySelector('system-investigation-facts')!;
}
it('opening original facts is GET-only with explicit missing version and no implicit model command',async()=>{
  const el=await setup(); expect(el.textContent).toContain('缺少源码版本');
  expect(authFetch).toHaveBeenCalledTimes(1); expect(vi.mocked(authFetch).mock.calls[0][1]).toEqual({cache:'no-store'});
  expect(el.textContent).toContain('尚未复测');
});
it('uncertain response retries the same expected revision/key and accepts no claimed outcome',async()=>{
  const el=await setup(); const button=()=>Array.from(el.querySelectorAll('button')).find(b=>b.textContent?.includes('复测'))!;
  vi.mocked(authFetch).mockRejectedValueOnce(new TypeError('offline'));
  button().click(); await tick(); expect(el.textContent).toContain('offline');
  const first=vi.mocked(authFetch).mock.calls[1];
  vi.mocked(authFetch).mockRejectedValueOnce(new TypeError('offline')); button().click(); await tick();
  const retry=vi.mocked(authFetch).mock.calls[2]; expect(retry).toEqual(first);
  expect(JSON.parse(String(first[1]?.body))).toEqual({ investigationId:id,expectedVersion:4 });
});
it('revocation erases facts and rejects late reads',async()=>{
  const el=await setup(); expect(el.textContent).toContain('HTTP_503');
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}})); await tick();
  expect(el.textContent).not.toContain('HTTP_503'); expect(el.textContent).toContain('权限已变化');
  expect(Array.from(el.querySelectorAll('button')).every(b=>b.disabled)).toBe(true);
});

it('Chief R2: old investigation denial must not erase newly loaded investigation',async()=>{
 const el:any=await setup(); let resolve:any;
 vi.mocked(authFetch).mockImplementationOnce(()=>new Promise(r=>resolve=r));
 const old=el.verify(event);
 vi.mocked(authFetch).mockImplementation(async()=>new Response(JSON.stringify(data),{status:200}));
 el.investigationId='33333333-3333-4333-8333-333333333333';
 await tick();await tick();expect(el.textContent).toContain('HTTP_503');
 resolve(new Response('{}',{status:403})); await old;await tick();
 expect(el.textContent).toContain('HTTP_503');
});

it.each(['success','denial','conflict','offline'])('R2: late %s cannot alter the new verification, facts or retry key',async(outcome)=>{
 const el:any=await setup(); let finish!: (r:Response)=>void; let fail!: (e:Error)=>void;
 vi.mocked(authFetch).mockImplementationOnce(()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;}));
 const old=el.verify(event);
 vi.mocked(authFetch).mockImplementation(async()=>new Response(JSON.stringify(data),{status:200}));
 el.investigationId='33333333-3333-4333-8333-333333333333';await tick();await tick();
 let rejectCurrent!: (e:Error)=>void;
 vi.mocked(authFetch).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectCurrent=reject;}));
 const current=el.verify(event);await tick();
 expect(el.textContent).toContain('正在复测');
 if(outcome==='offline') fail(new TypeError('old offline'));
 else finish(new Response(JSON.stringify({conclusion:'recovered'}),{status:outcome==='success'?200:outcome==='denial'?403:409}));
 await old;await tick();
 expect(el.textContent).toContain('HTTP_503');expect(el.textContent).toContain('正在复测');expect(el.textContent).not.toContain('old offline');
 const calls=vi.mocked(authFetch).mock.calls;const newRequest=calls.at(-1)!;
 rejectCurrent(new TypeError('current offline'));await current;await tick();
 vi.mocked(authFetch).mockRejectedValueOnce(new TypeError('retry offline'));
 Array.from(el.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b=>b.textContent?.includes('重试原'))!.click();await tick();
 expect(vi.mocked(authFetch).mock.calls.at(-1)).toEqual(newRequest);
});
