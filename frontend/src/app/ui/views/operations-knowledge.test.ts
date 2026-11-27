import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.ts';
import type { OperationsKnowledge } from './operations-knowledge.ts';
import './operations-knowledge.ts';
import type { CaseRecord } from '../controllers/operations-api.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
const api=vi.mocked(authFetch);
const watchCase = vi.hoisted(() => vi.fn());
vi.mock('../controllers/operations-api.ts',async importOriginal=>({...await importOriginal<any>(),watchCase}));
const record=():CaseRecord=>({id:'case',revision:4,version:2,contentHash:'a'.repeat(64),state:'pending_review',author:{kind:'user',id:11},resources:[],validUntil:new Date(Date.now()+600000).toISOString(),tombstone:false,referenceOnly:true,
  content:{title:'合成案例：服务无响应',symptoms:'当前症状',faultType:'服务异常',confirmedCause:'已确认事实',actions:'隔离测试',actualEffect:'恢复',counterexamples:'依赖故障不适用'},applicability:{conditions:'有证据',productVersion:'1',resourceVersion:'1'},source:{investigationId:'inv',resultId:'result',resultVersion:3,evidence:[]}});
const json=(v:unknown,status=200)=>({ok:status<400,status,json:async()=>v}) as Response;
const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const investigation = (id: string, resultVersion: number) => ({
  id, title: '同名故障调查', lifecycle: 'closed', createdAt: '2026-11-22T08:00:00Z',
  activeRequestId: null, resources: [{ type: 'instance', id: id === firstId ? 11 : 12 }],
  latestOutcome: { resultVersion },
});
const investigations = (items: ReturnType<typeof investigation>[], nextCursor: string | null = null) =>
  json({ items, nextCursor, authorizedCounts: { total: items.length } });
const inventory = () => json({ dataQuality: 'complete', items: [
  { resource: { type: 'instance', id: 11 }, label: '交易库', status: 'unknown' },
  { resource: { type: 'instance', id: 12 }, label: '报表库', status: 'unknown' },
] });
const prepared = (investigationId: string, resultVersion: number, title: string) => json({
  candidate: { investigationId, resultVersion, content: { ...record().content, title },
    applicability: record().applicability, validUntil: record().validUntil }, redactionPolicyVersion: 'case-redaction/v1',
});
let view:OperationsKnowledge;
async function mount(r=record()){
  history.replaceState({},'','/operations-knowledge?case=case');api.mockResolvedValueOnce(json(r));
  view=document.createElement('operations-knowledge') as OperationsKnowledge;view.permissions=new Set(['operations:cases:view','operations:cases:review']);
  document.body.append(view);await flush();return view.shadowRoot!;
}
async function flush(){await new Promise(r=>setTimeout(r,0));await view?.updateComplete;}
async function mountHome(path = '/operations-knowledge') {
  history.replaceState({}, '', path);
  view = document.createElement('operations-knowledge') as OperationsKnowledge;
  view.permissions = new Set(['operations:cases:view', 'operations:cases:manage']);
  document.body.append(view);
  await flush();
  return view.shadowRoot!;
}
const emptyKnowledge = () => json({ items: [], nextCursor: null, authorizedCounts: { total: 0 } });
const button = (root: ShadowRoot, name: string) =>
  [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
const prepareReads = () => api.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/prepare?'));
beforeEach(()=>{api.mockReset();watchCase.mockReset().mockReturnValue(() => {});localStorage.setItem('user',JSON.stringify({id:22}));});
afterEach(()=>{view?.remove();localStorage.clear();history.replaceState({},'','/');});
it('review submits the exact displayed revision, content version and hash',async()=>{
  const root=await mount();const textarea=root.querySelector('textarea[aria-label="审核或撤回依据"]') as HTMLTextAreaElement;
  textarea.value='独立人工审核';textarea.dispatchEvent(new Event('input'));await flush();
  api.mockResolvedValueOnce(json({id:'case'})).mockResolvedValueOnce(json({...record(),state:'published'}));
  [...root.querySelectorAll('button')].find(b=>b.textContent?.includes('审核发布当前版本'))!.click();await flush();
  const review=api.mock.calls.find(([url])=>String(url).endsWith('/review'))!;
  expect(JSON.parse(review[1]!.body as string)).toEqual({expectedRevision:4,version:2,contentHash:'a'.repeat(64),decision:'approved',note:'独立人工审核'});
});
it('author cannot self review and expired tombstones expose no content or publish action',async()=>{
  localStorage.setItem('user',JSON.stringify({id:11}));const root=await mount();
  expect([...root.querySelectorAll('button')].find(b=>b.textContent?.includes('审核发布当前版本'))?.disabled).toBe(true);
  view.remove();await mount({...record(),state:'expired',tombstone:true,content:undefined,source:undefined,applicability:undefined});
  expect(view.shadowRoot!.textContent).not.toContain('已确认事实');expect(view.shadowRoot!.textContent).toContain('正文不可引用');
  expect([...view.shadowRoot!.querySelectorAll('button')].some(b=>b.textContent?.includes('审核发布当前版本'))).toBe(false);
});
it('permission changes clear the article and open draft before a late response can restore them',async()=>{
  const root=await mount();expect(root.textContent).toContain('已确认事实');
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded',{detail:{permissions:[]}}));await flush();
  expect(root.textContent).not.toContain('已确认事实');expect(root.textContent).not.toContain('当前症状');expect(root.textContent).toContain('内容已清除');
});

it('identifies a listed version in the detail URL and leaves newer content undisplayed', async () => {
  const newer = { ...record(), state: 'published' as const };
  const listed = { ...newer, version: 1, content: { ...newer.content!, title: '合成旧版记录' } };
  api.mockResolvedValueOnce(json({ items: [listed], nextCursor: null, authorizedCounts: { total: 1 } }))
    .mockResolvedValueOnce(json(newer));
  const root = await mountHome();
  button(root, '合成旧版记录')!.click();
  await flush();
  expect(new URL(location.href).searchParams.get('caseVersion')).toBe('1');
  expect(root.querySelector('[role=alert]')?.textContent).toContain('版本已变化');
  expect(root.textContent).not.toContain(newer.content!.confirmedCause);
  expect(watchCase).not.toHaveBeenCalled();
});

it('clears pinned detail content when the live watch sees a newer version', async () => {
  const current = { ...record(), state: 'published' as const };
  api.mockResolvedValueOnce(json(current));
  const root = await mountHome('/operations-knowledge?case=case&caseVersion=2');
  expect(root.textContent).toContain(current.content!.confirmedCause);
  const receive = watchCase.mock.calls[0][1];
  receive({ ...current, version: 3, content: { ...current.content!, confirmedCause: '新版本事实' } });
  await flush();
  expect(root.querySelector('[role=alert]')?.textContent).toContain('返回列表重新搜索');
  expect(root.textContent).not.toContain(current.content!.confirmedCause);
  expect(root.textContent).not.toContain('新版本事实');
});

it('starts with an authorized paginated source search and distinguishes empty, no match and read failure', async () => {
  api.mockResolvedValueOnce(emptyKnowledge());
  const root = await mountHome();
  api.mockResolvedValueOnce(inventory()).mockResolvedValueOnce(investigations([investigation(firstId, 0)], 'next'))
    .mockResolvedValueOnce(investigations([investigation(secondId, 2)]));
  button(root, '选择来源调查')!.click();
  await flush();
  expect(root.querySelector('textarea')).toBeNull();
  expect(button(root, '读取来源生成脱敏草稿')).toBeUndefined();
  expect(prepareReads()).toEqual([]);
  expect(root.textContent).toContain('报表库');
  expect(api.mock.calls.map(([url]) => url)).toContain('/api/investigations?state=closed&limit=20&cursor=next');

  const objects = root.querySelector<HTMLSelectElement>('.source-filters select')!;
  objects.value = 'instance:12';
  api.mockResolvedValueOnce(json({}, 503));
  objects.dispatchEvent(new Event('change'));
  await flush();
  expect(root.textContent).toContain('读取来源调查失败');
  expect(root.textContent).not.toContain('没有匹配的调查');
  api.mockResolvedValueOnce(investigations([]));
  button(root, '重试读取调查')!.click();
  await flush();
  expect(api.mock.lastCall?.[0]).toContain('resource=instance%3A12');
  expect(root.querySelector('app-dialog app-empty-state')?.getAttribute('title')).toBe('没有匹配的调查');

  objects.value = '';
  api.mockResolvedValueOnce(investigations([]));
  objects.dispatchEvent(new Event('change'));
  await flush();
  expect(root.querySelector('app-dialog app-empty-state')?.getAttribute('title')).toBe('暂无可用的来源调查');
});

it('drops a late preparation after switching result versions and clears checked drafts when changing the source', async () => {
  api.mockResolvedValueOnce(emptyKnowledge());
  const root = await mountHome();
  api.mockResolvedValueOnce(inventory()).mockResolvedValueOnce(investigations([investigation(firstId, 1)]));
  button(root, '从调查整理案例')!.click();
  await flush();
  button(root, '选择结果 V1')!.click();
  await flush();
  let finishOld!: (value: Response) => void;
  api.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  button(root, '读取来源生成脱敏草稿')!.click();
  await flush();
  api.mockResolvedValueOnce(investigations([investigation(firstId, 2), investigation(secondId, 3)]));
  button(root, '重新选择来源')!.click();
  await flush();
  button(root, '选择结果 V2')!.click();
  await flush();
  api.mockResolvedValueOnce(prepared(firstId, 2, '新版本草稿'));
  button(root, '读取来源生成脱敏草稿')!.click();
  finishOld(prepared(firstId, 1, '旧版本草稿'));
  await flush();

  const title = () => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="案例标题"]')?.value;
  expect(title()).toBe('新版本草稿');
  expect(prepareReads()).toEqual([1, 2].map(v => `/api/operations/knowledge/prepare?investigationId=${firstId}&resultVersion=${v}`));
  root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await flush();
  expect(button(root, '保存案例草稿')?.disabled).toBe(false);
  api.mockResolvedValueOnce(investigations([investigation(secondId, 3)]));
  button(root, '重新选择来源')!.click();
  await flush();
  expect(title()).toBeUndefined();
  expect(button(root, '保存案例草稿')).toBeUndefined();
  expect(button(root, '选择结果 V3')).toBeDefined();
});

it('uses the exact linked version and never falls through to the newer version when the server rejects it', async () => {
  api.mockResolvedValueOnce(emptyKnowledge()).mockResolvedValueOnce(json({ error: 'OPERATIONS_PRECONDITION_FAILED' }, 422))
    .mockResolvedValueOnce(inventory()).mockResolvedValueOnce(investigations([investigation(firstId, 3)]));
  const root = await mountHome(`/operations-knowledge?sourceInvestigation=${firstId}&resultVersion=2`);
  expect(prepareReads()).toEqual([`/api/operations/knowledge/prepare?investigationId=${firstId}&resultVersion=2`]);
  expect(root.textContent).toContain('该来源或结果版本已不可引用');
  expect(button(root, '选择结果 V3')).toBeDefined();
  expect(button(root, '保存案例草稿')).toBeUndefined();
});

it('clears the source and ignores a late draft on a permission change', async () => {
  api.mockResolvedValueOnce(emptyKnowledge());
  let finish!: (value: Response) => void;
  api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const root = await mountHome(`/operations-knowledge?sourceInvestigation=${firstId}&resultVersion=1`);
  expect(root.textContent).toContain(firstId);
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  finish(prepared(firstId, 1, '过期草稿'));
  await flush();
  expect(root.textContent).not.toContain(firstId);
  expect(root.textContent).not.toContain('过期草稿');
  expect(root.querySelector('textarea')).toBeNull();
  expect(button(root, '从调查整理案例')?.disabled).toBe(true);
});

it.each([
  { saveStatus: 404, saveError: 'OPERATIONS_NOT_FOUND', checkStatus: 404, checkError: 'OPERATIONS_NOT_FOUND' },
  { saveStatus: 422, saveError: 'OPERATIONS_PRECONDITION_FAILED', checkStatus: 503, checkError: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' },
])('does one read-only check of the submitted source after $saveStatus and handles verification $checkStatus',
  async ({ saveStatus, saveError, checkStatus, checkError }) => {
    api.mockResolvedValueOnce(emptyKnowledge()).mockResolvedValueOnce(prepared(firstId, 2, '待保存正文'));
    const root = await mountHome(`/operations-knowledge?sourceInvestigation=${firstId}&resultVersion=2`);
    root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await flush();
    let finishCheck!: (value: Response) => void;
    api.mockResolvedValueOnce(json({ error: saveError }, saveStatus))
      .mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
    root.querySelector('form#case-candidate')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(root.textContent).toContain('正在核对提交时的来源与结果版本');
    expect(button(root, '保存案例草稿')?.disabled).toBe(true);
    expect(button(root, '重新选择来源')?.disabled).toBe(true);
    if (checkStatus === 404) api.mockResolvedValueOnce(inventory()).mockResolvedValueOnce(investigations([
      investigation(firstId, 2), investigation(secondId, 3),
    ]));
    finishCheck(json({ error: checkError }, checkStatus));
    await flush();
    const exactRead = `/api/operations/knowledge/prepare?investigationId=${firstId}&resultVersion=2`;
    expect(prepareReads()).toEqual([exactRead, exactRead]);
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    if (checkStatus === 404) {
      expect(root.textContent).toContain('该来源或结果版本已不可引用');
      expect(root.textContent).not.toContain(firstId);
      expect(root.querySelector('form#case-candidate')).toBeNull();
      expect(button(root, '选择结果 V3')).toBeDefined();
    } else {
      expect(root.textContent).toContain('暂无法核对提交时的来源');
      expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="案例标题"]')?.value).toBe('待保存正文');
    }
  },
);
