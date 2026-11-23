import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import './metric-study.js';
import { apiClient,authFetch } from '../../../api/index.js';
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const settle=()=>new Promise(r=>setTimeout(r,0));
const catalog={metrics:[{metric:{id:'db.uptime_seconds',semantic_version:'1.0.0'},definition:{meaning:'运行时长'}}],snapshots:[]};
let fetch:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{localStorage.clear();apiClient.setToken('old-access');apiClient.setRefreshToken('refresh');fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>String(url).endsWith('/dimensions')?json({dimensions:[{}]}):json(catalog));});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();localStorage.clear();});
async function mount(){const el:any=document.createElement('metric-study');el.resourceType='instance';el.resourceId=7;document.body.append(el);await settle();await settle();await el.updateComplete;return el;}
it('loads historical metric choices without asking the user for internal IDs',async()=>{const el=await mount();expect(el.catalog.metrics).toHaveLength(1);expect(el.busy).toBe(false);expect(el.shadowRoot.textContent).toContain('运行时长');});
it.each(['own','parallel'])('actual authFetch %s refresh preserves a successful study and clears busy',async mode=>{
  const el=await mount();let calls=0;let release!:(v:any)=>void;const hold=new Promise(r=>release=r);
  fetch.mockImplementation(async url=>{if(String(url).endsWith('/refresh'))return json({token:'new-access',refreshToken:'new-refresh'});if(String(url).endsWith('/parallel'))return ++calls===1?json({},401):json({});if(mode==='parallel')return hold;return ++calls===1?json({},401):json({buckets:[],tier:'1h'});});
  const work=el.queryTrend();if(mode==='parallel'){await authFetch('/api/metrics/parallel');release(json({buckets:[],tier:'1h'}));}await work;expect(el.busy).toBe(false);expect(el.trend.result.tier).toBe('1h');expect(apiClient.getToken()).toBe('new-access');
});
it.each(['resource','session','permissions','clear'])('rejects old successful or forbidden results after %s changes',async change=>{
  const el=await mount();let release!:(v:any)=>void;fetch.mockImplementation(()=>new Promise(r=>release=r));const pending=el.queryTrend();
  if(change==='resource')el.resourceId=8;if(change==='clear')el.resourceId=0;if(change==='session')apiClient.setToken('other-user');if(change==='permissions')window.dispatchEvent(new Event('slide-permissions-loaded'));
  // Resolve the old request before the Lit update; resource values already fence it.
  release(json({buckets:[{count:999}],tier:'1h'}));fetch.mockResolvedValue(json({metrics:[],snapshots:[]}));await pending;await settle();await el.updateComplete;expect(el.trend).toBeNull();expect(el.busy).toBe(false);
});
it('true same-scope 403 clears previously visible protected data',async()=>{const el=await mount();fetch.mockResolvedValue(json({},403));await el.queryTrend();expect(el.catalog).toBeNull();expect(el.busy).toBe(false);expect(el.error).toContain('无权限');});
it('Chief R5: expired raw is explicit and never offered as raw comparison or replay evidence',async()=>{
 const el=await mount();fetch.mockResolvedValueOnce(json({buckets:[{from:'2026-07-01T00:00:00Z',to:'2026-07-02T00:00:00Z',count:2,numeric_count:2,min:{numerator:'1',denominator:'1'},max:{numerator:'9',denominator:'1'},avg:{numerator:'5',denominator:'1'},quality:'partial',coverage:0.1,max_gap_ms:600000,invalid_count:0,non_numeric_count:0,estimated_count:0,raw_status:'expired',statistics_complete:true}],note:'保全趋势',evidence_hash:'hash'}));await el.queryTrend();await el.updateComplete;
 expect(el.shadowRoot.textContent).toContain('原始已过期');expect([...el.shadowRoot.querySelectorAll('button')].some((b:any)=>b.textContent==='查看原始观测')).toBe(false);
 fetch.mockResolvedValue(json({error:'HISTORY_RAW_EXPIRED'},409));el.ruleKey='{}';await el.replayWindow();expect(el.error).toContain('不能用于回放');expect(el.busy).toBe(false);
});

it('retries only the failed long-window operation with its original window', async () => {
  const el = await mount();
  const requests: unknown[] = [];
  fetch.mockImplementation(async (url, options) => {
    expect(String(url)).toContain('/study/trend');
    requests.push(JSON.parse(String((options as RequestInit)?.body)));
    return requests.length === 1 ? json({}, 503) : json({ buckets: [], tier: '1h' });
  });
  await el.queryTrend();
  await el.updateComplete;
  expect(el.error).toContain('长窗口趋势服务暂不可用（503）');
  expect(el.error).not.toContain('保留');
  const retry = [...el.shadowRoot.querySelectorAll('button')].find((button: any) => button.textContent === '重试长窗口趋势') as HTMLButtonElement;
  retry.click();
  await settle();
  expect(requests).toEqual([requests[0], requests[0]]);
  expect(Date.parse((requests[0] as any).to) - Date.parse((requests[0] as any).from)).toBe(30 * 86_400_000);
  expect(el.shadowRoot.textContent).toContain('研究窗口没有趋势记录');
  expect(el.shadowRoot.textContent).not.toContain('正在读取长窗口趋势');
});

it.each([200, 503])('ignores a superseded trend response (%s) even when fetch completes after abort', async status => {
  const second = { id: 'mysql.threads.connected', semantic_version: '1.0.0' };
  fetch.mockResolvedValueOnce(json({ ...catalog, metrics: [...catalog.metrics, { metric: second, definition: { unit: 'count' } }] }));
  const el = await mount();
  let release!: (response: Response) => void;
  let firstSignal: AbortSignal | undefined;
  fetch.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/dimensions')) return json({ dimensions: [{ scope: 'replica' }] });
    const body = JSON.parse(String((options as RequestInit).body));
    if (body.metric.id === second.id) return json({ buckets: [], evidence_hash: 'B' });
    firstSignal = (options as RequestInit).signal ?? undefined;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const first = el.queryTrend();
  const choices = el.shadowRoot.querySelector('select[aria-label="历史研究指标"]');
  choices.value = JSON.stringify(second);
  choices.dispatchEvent(new Event('change'));
  await settle();
  expect(firstSignal?.aborted).toBe(true);
  await el.queryTrend();
  release(json({ buckets: [], evidence_hash: 'A' }, status));
  await first;
  await el.updateComplete;
  expect(el.shadowRoot.textContent).toContain('证据 B');
  expect(el.shadowRoot.textContent).not.toMatch(/证据 A|重试长窗口趋势/);
});
