import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './resource-diagnosis.js';

const fact = { id: 'private-evidence', kind: 'observation', status: 'fact', quality: 'good', observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(), source: 'collector', payload: { metricId: 'cpu', value: 92.4 } };
const bundle = { generatedAt: new Date().toISOString(), facts: [fact], inferences: [], hypotheses: [], gaps: [], truncated: false };
const evaluation = { generatedAt: new Date().toISOString(), rulesVersion: 1, invariants: [{ ruleId: 'private-rule', version: 1, status: 'fail', reason: 'CONSTRAINT_VIOLATED', evidenceRefs: [fact.id] }], expectations: [], gaps: [] };
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); localStorage.clear(); history.replaceState({}, '', '/'); });
async function mount(tab = 'evidence') {
  localStorage.setItem('permissions', '["resources:view","ai:view","ai:manage"]');
  history.replaceState({}, '', '/resource-diagnosis?resourceType=instance&resourceId=1&diagnosisTab=' + tab);
  authFetch.mockImplementation(async (url: string) => response(url === '/api/resources' ? { items: [{ resource: { type: 'instance', id: 1 }, label: 'private-resource', status: 'online', attributes: {} }] }
    : url.endsWith('/evaluation') ? evaluation : url.endsWith('/invariants') ? { version: 1, rules: [] }
    : url.includes('/decisions') ? { items: [], gaps: [], truncated: false } : url.endsWith('/recovery-policy') ? { enabled: false, commandTypes: [] } : bundle));
  const view = document.createElement('resource-diagnosis-page') as any;
  document.body.append(view);
  await vi.waitFor(() => expect(view.evidence).not.toBeNull());
  await view.updateComplete;
  return view;
}
it.each([403, 503, 'network'])('invalidates all facts and details at refresh start, including %s failures, retaining unknown protection', async failure => {
  const view = await mount();
  view.agentResult = { analysisId: 42, status: 'unknown', result: { summary: 'private-analysis' } };
  view.pack = { relations: [], relatedEvidence: [], gaps: [{ scope: 'private-scope', code: 'private-gap' }], truncated: false };
  view.selectedEvidence = fact; view.dialog = 'evidence'; await view.updateComplete;
  const pending = deferred<any>();
  authFetch.mockImplementation(() => pending.promise);
  const refreshing = view.load(); await view.updateComplete;
  expect(view.shadowRoot.textContent).not.toContain('private-resource');
  expect(view.shadowRoot.textContent).not.toContain('private-evidence');
  expect(view.shadowRoot.querySelector('app-dialog').open).toBe(false);
  expect(view.taskActive()).toBe(true);
  if (failure === 'network') pending.resolve(Promise.reject(new TypeError('offline'))); else pending.resolve(response({}, failure as number));
  await refreshing; await view.updateComplete;
  for (const tab of ['evidence', 'evaluation', 'relations', 'result']) {
    view.switchTab(tab); await view.updateComplete;
    expect(view.shadowRoot.textContent).not.toMatch(/private-(resource|evidence|analysis|gap)/);
    expect(view.shadowRoot.querySelector('resource-evaluation')).toBeNull();
  }
  expect(view.agentResult.analysisId).toBe(42);
  await view.diagnose(true);
  expect(authFetch.mock.calls.some(([url]) => url.endsWith('/diagnose-agent'))).toBe(false);
});
it.each([false, true])('unmounts the whole evaluation tree on revocation, late response=%s', async late => {
  const view = await mount('evaluation');
  const child = view.shadowRoot.querySelector('resource-evaluation') as any;
  await vi.waitFor(() => expect(child.shadowRoot.textContent).toContain('private-rule'));
  const pending = deferred<any>();
  let oldRead: Promise<unknown> | undefined;
  if (late) { authFetch.mockImplementation(() => pending.promise); oldRead = child.load(); }
  authFetch.mockResolvedValue(response({}, 403));
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  await view.updateComplete;
  expect(view.shadowRoot.querySelector('resource-evaluation')).toBeNull();
  if (late) { pending.resolve(response(evaluation)); await oldRead; }
  await view.updateComplete;
  expect(view.shadowRoot.textContent).not.toContain('private-rule');
  expect(child.isConnected).toBe(false);
});
it('ignores a previous evidence response released after a failed list refresh', async () => {
  const view = await mount();
  const pending = deferred<any>();
  authFetch.mockImplementation((url: string) => url === '/api/resources' ? Promise.resolve(response({}, 503)) : pending.promise);
  const oldRead = view.loadEvidence();
  await view.load(); pending.resolve(response(bundle)); await oldRead; await view.updateComplete;
  expect(view.shadowRoot.querySelector('[data-evidence-id]')).toBeNull();
});
it('retains read-only evaluation after permissions change without ai:manage', async () => {
  const view = await mount('evaluation');
  window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: ['resources:view', 'ai:view'] } }));
  await vi.waitFor(() => expect(view.shadowRoot.querySelector('resource-evaluation')?.shadowRoot.textContent).toContain('private-rule'));
  expect(view.shadowRoot.textContent).toContain('无只读诊断权限');
});
