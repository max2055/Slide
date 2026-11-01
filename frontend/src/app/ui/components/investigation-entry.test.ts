import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { InvestigationEntry } from './investigation-entry.ts';
import { investigationApi, InvestigationApiError } from '../controllers/investigation-api.ts';
vi.mock('../controllers/investigation-api.ts', async original => ({ ...await original<object>(), investigationApi: vi.fn() }));
const context = { schemaVersion: 1 as const, resourceRefs: [{ type: 'instance' as const, id: 7, role: 'primary' as const }],
  from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T01:00:00.000Z', dimensions: {},
  metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, sourceEventIds: [12], returnTo: '/instance-detail?id=7' };
const value = () => ({ context: structuredClone(context), facts: [], modelInvoked: false });
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); sessionStorage.clear(); vi.mocked(investigationApi).mockResolvedValue(value()); });
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function mounted() {
  const view = new InvestigationEntry(); view.context = structuredClone(context); document.body.append(view);
  await view.updateComplete; await new Promise(resolve => setTimeout(resolve, 0)); await view.updateComplete; return view;
}
it('mount only reads facts and never creates or admits a task', async () => {
  await mounted(); expect(vi.mocked(investigationApi).mock.calls.map(c => c[0])).toEqual(['/entry-facts']);
});
it.each(['slide-session-expired','slide-permissions-loaded'])('%s discards late facts and erases rendered context', async event => {
  let release!: (v: any) => void;
  vi.mocked(investigationApi).mockImplementation(() => new Promise(resolve => release = resolve));
  const view = await mounted();
  window.dispatchEvent(new CustomEvent(event)); release(value());
  await new Promise(resolve => setTimeout(resolve, 0)); await view.updateComplete;
  expect(view.textContent).not.toContain('db.uptime_seconds'); expect(view.querySelector('a')).toBeNull();
});
it('scope change clears old pending command instead of saving a stale target', async () => {
  const view = await mounted();
  vi.mocked(investigationApi).mockRejectedValueOnce(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE'));
  await (view as any).save();
  view.context = { ...context, returnTo: '/instance-detail?id=7&tab=another' }; await view.updateComplete;
  expect((view as any).pendingContext).toBeNull(); expect((view as any).unknown).toBe(false);
});
it('unknown submission retries exact frozen context and same stored key', async () => {
  const view = await mounted();
  vi.mocked(investigationApi).mockRejectedValue(new InvestigationApiError(503, 'INVESTIGATION_QUEUE_UNAVAILABLE'));
  await (view as any).save(); await (view as any).save();
  const calls = vi.mocked(investigationApi).mock.calls.filter(c => c[0] === '/drafts');
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(sessionStorage.length).toBe(1);
});
it('HTTP revocation clears facts and notifies the workspace to erase its detail', async () => {
  const view = await mounted(), denied = vi.fn(); view.addEventListener('investigation-entry-denied', denied);
  vi.mocked(investigationApi).mockRejectedValue(new InvestigationApiError(404, 'INVESTIGATION_NOT_FOUND'));
  await (view as any).load(); await view.updateComplete;
  expect(view.querySelector('a')).toBeNull(); expect(denied).toHaveBeenCalledOnce();
});

it('CHIEF same-context parent rerender during save must preserve completion and release saving', async () => {
  const view = await mounted();
  let release!: (v: any) => void;
  vi.mocked(investigationApi).mockImplementation(path => path === '/drafts' ? new Promise(resolve => release = resolve) : Promise.resolve(value()));
  const created = vi.fn(); view.addEventListener('investigation-draft-created', created);
  const saving = (view as any).save();
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  view.context = structuredClone(context); await view.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
  release({id:'00000000-0000-4000-8000-000000000001',context,modelInvoked:false});
  await saving; await view.updateComplete;
  expect({saving:(view as any).saving, completed:created.mock.calls.length}).toEqual({saving:false,completed:1});
});

it('a different absolute window invalidates a pending save and releases the new scope', async () => {
  const view = await mounted(); let release!: (v: any) => void;
  vi.mocked(investigationApi).mockImplementation(path => path === '/drafts'
    ? new Promise(resolve => release = resolve) : Promise.resolve(value()));
  const created = vi.fn(); view.addEventListener('investigation-draft-created', created);
  const saving = (view as any).save();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  view.context = { ...context, from: '2026-10-30T00:30:00.000Z' }; await view.updateComplete;
  release({ id: '00000000-0000-4000-8000-000000000001' }); await saving; await view.updateComplete;
  expect(created).not.toHaveBeenCalled();
  expect((view as any).saving).toBe(false); expect((view as any).pendingKey).toBe('');
});

it('a live read rejection during save prevents late success from reopening denied content', async () => {
  const view = await mounted(); let release!: (v: any) => void;
  vi.mocked(investigationApi).mockImplementation(path => path === '/drafts'
    ? new Promise(resolve => release = resolve) : Promise.reject(new InvestigationApiError(404, 'INVESTIGATION_NOT_FOUND')));
  const created = vi.fn(); view.addEventListener('investigation-draft-created', created);
  const saving = (view as any).save(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await (view as any).load();
  release({ id: '00000000-0000-4000-8000-000000000001' }); await saving; await view.updateComplete;
  expect(created).not.toHaveBeenCalled(); expect(view.querySelector('a')).toBeNull();
  expect(view.textContent).not.toContain('db.uptime_seconds'); expect((view as any).saving).toBe(false);
});
