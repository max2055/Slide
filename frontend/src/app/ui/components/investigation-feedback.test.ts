import { afterEach, it, expect, vi } from 'vitest';
import { InvestigationFeedback } from './investigation-feedback.ts';
import { investigationApi, InvestigationApiError } from '../controllers/investigation-api.ts';
vi.mock('../controllers/investigation-api.ts', async original => ({ ...await original<object>(), investigationApi: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });
const record = { id: 'audit', version: 3, investigationId: 'one', actorId: 101, createdAt: '2026-01-01T00:00:00.000Z',
  command: { resultId: 'result-one', resultVersion: 1, expectedVersion: 2, kind: 'rating', rating: 'incorrect', note: '<script>unsafe()</script>' }, staleResult: false, references: [] };
async function form() {
  vi.mocked(investigationApi).mockResolvedValueOnce({ items: [], nextBefore: null });
  const view = new InvestigationFeedback();
  view.investigationId = 'one'; view.resultId = 'result-one'; view.resultVersion = 1; view.investigationVersion = 2;
  document.body.append(view); await view.updateComplete; await Promise.resolve(); await view.updateComplete;
  const input = view.querySelector('textarea')!; input.value = 'sensitive draft'; input.dispatchEvent(new Event('input')); await view.updateComplete;
  return view;
}
it.each(['slide-session-expired', 'slide-permissions-loaded'])('%s clears feedback/history/pending and ignores late responses', async event => {
  const view = await form(); let release!: (value: unknown) => void;
  vi.mocked(investigationApi).mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const saved = vi.fn(); view.addEventListener('investigation-feedback-saved', saved);
  const pending = (view as any).submit();
  window.dispatchEvent(new CustomEvent(event)); release(record); await pending; await view.updateComplete;
  expect(saved).not.toHaveBeenCalled(); expect(view.textContent).not.toContain('sensitive draft');
  expect(view.querySelector('textarea')).toBeNull(); expect(view.textContent).toContain('重新核验');
});
it('result version changes erase prior sensitive drafts and ignore in-flight writes', async () => {
  const view = await form(); let release!: (value: unknown) => void;
  vi.mocked(investigationApi).mockImplementationOnce(() => new Promise(resolve => release = resolve));
  vi.mocked(investigationApi).mockResolvedValueOnce({ items: [], nextBefore: null });
  const pending = (view as any).submit(); view.resultId = 'result-two'; view.resultVersion = 2; await view.updateComplete;
  release(record); await pending; await view.updateComplete;
  expect(view.querySelector('textarea')!.value).toBe(''); expect(view.textContent).not.toContain('unsafe');
});
it('explicit version conflict preserves draft and uses refreshed investigation version on correction', async () => {
  const view = await form();
  vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(409, 'VERSION_CONFLICT'));
  await (view as any).submit(); await view.updateComplete;
  expect(view.querySelector('textarea')!.value).toBe('sensitive draft'); expect(view.querySelector('[role=alert]')!.textContent).toContain('调查已更新');
  view.investigationVersion = 4;
  vi.mocked(investigationApi).mockResolvedValueOnce(record); await (view as any).submit();
  expect(JSON.parse(vi.mocked(investigationApi).mock.calls.at(-1)![1]!.body as string).expectedVersion).toBe(4);
});
it('unknown acceptance freezes controls and retries identical body/key', async () => {
  const view = await form();
  vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE'));
  vi.mocked(investigationApi).mockResolvedValueOnce(record);
  await (view as any).submit(); await view.updateComplete;
  expect(view.querySelector('textarea')!.disabled).toBe(true); expect(view.textContent).toContain('核对原提交');
  await (view as any).submit(); await view.updateComplete;
  const calls = vi.mocked(investigationApi).mock.calls.slice(-2); expect(calls[0]).toEqual(calls[1]);
  expect(view.querySelector('.feedback-history script')).toBeNull(); expect(view.textContent).toContain('<script>');
});
it.each([401,404])('authority HTTP %s erases form and history', async status => {
  const view = await form(); vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(status, 'INVESTIGATION_NOT_FOUND'));
  await (view as any).submit(); await view.updateComplete; expect(view.querySelector('textarea')).toBeNull();
});
it('operator-only rejection retains readable draft; read-only UI cannot submit', async () => {
  const view = await form(); vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(403, 'INVESTIGATION_OPERATION_FORBIDDEN'));
  await (view as any).submit(); await view.updateComplete; expect(view.querySelector('textarea')!.value).toBe('sensitive draft');
  view.readonly = true; await view.updateComplete;
  const before = vi.mocked(investigationApi).mock.calls.length; await (view as any).submit();
  expect(vi.mocked(investigationApi).mock.calls.length).toBe(before); expect(view.querySelector('form')).toBeNull();
});
it('active execution disables closure and invalid proof is rejected before HTTP', async () => {
  const view = await form(); (view as any).kind = 'close'; view.activeRequest = true; await view.updateComplete;
  expect(view.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
  view.activeRequest = false; (view as any).problemStatus = 'resolved'; await view.updateComplete;
  const before = vi.mocked(investigationApi).mock.calls.length; await (view as any).submit(); await view.updateComplete;
  expect(vi.mocked(investigationApi).mock.calls.length).toBe(before); expect(view.querySelector('[role=alert]')!.textContent).toContain('证据 ID');
});
it('a late historical page cannot overwrite newly accepted feedback', async () => {
  const view = await form(); let release!: (value: unknown) => void;
  vi.mocked(investigationApi).mockImplementationOnce(() => new Promise(resolve => release = resolve));
  const loading = (view as any).load();
  vi.mocked(investigationApi).mockResolvedValueOnce(record);
  await (view as any).submit();
  release({ items: [], nextBefore: null }); await loading; await view.updateComplete;
  expect(view.querySelectorAll('.feedback-history li')).toHaveLength(1);
});

it('uses the actual report binding with visible local observation times and clears confirmation when report changes',async()=>{
  const view=await form();view.actionReport={id:'report',version:2,contentHash:'a'.repeat(64),state:'passed',validUntil:new Date(Date.now()+60000).toISOString(),observedFrom:'2026-01-01T00:00:00.000Z',observedUntil:'2026-01-01T00:05:00.000Z',evidence:[]};
  (view as any).kind='close';(view as any).problemStatus='resolved';await view.updateComplete;
  const check=view.querySelector<HTMLInputElement>('input[type=checkbox]')!;check.click();await view.updateComplete;
  expect(view.querySelector<HTMLInputElement>('input[aria-label="观察开始时间"]')!.value).toBeTruthy();
  expect(view.querySelector<HTMLInputElement>('input[aria-label="观察结束时间"]')!.value).toBeTruthy();
  vi.mocked(investigationApi).mockResolvedValueOnce(record);await (view as any).submit();
  const command=JSON.parse(vi.mocked(investigationApi).mock.calls.at(-1)![1]!.body as string);
  expect(command.verification).toMatchObject({actionReport:{id:'report',version:2,hash:'a'.repeat(64)},evidenceIds:[],from:'2026-01-01T00:00:00.000Z',to:'2026-01-01T00:05:00.000Z'});
  view.actionReport={...view.actionReport,version:3,contentHash:'b'.repeat(64)};await view.updateComplete;expect((view as any).useActionReport).toBe(false);
});
