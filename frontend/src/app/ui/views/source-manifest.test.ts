import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './source-manifest.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });
it.each(['SOURCE_SIGNING_KEY_INVALID', 'SOURCE_SNAPSHOT_UNTRUSTED', 'SOURCE_NOT_SYNCED', 'SOURCE_NOT_CONFIGURED'])('renders safe snapshot guidance for %s without an irrelevant retry', async code => {
  authFetch.mockResolvedValue(new Response(JSON.stringify({ error: code }), { status: 409 }));
  const view = document.createElement('source-manifest'); document.body.append(view); await settle();
  const root = view.shadowRoot!;
  expect(root.querySelector('[role="alert"]')!.textContent).not.toMatch(/SOURCE_|Error:/);
  expect(root.querySelector('details')!.hasAttribute('open')).toBe(false);
  expect([...root.querySelectorAll('button')].filter(button => !button.closest('app-dialog'))).toHaveLength(0);
  if (code === 'SOURCE_SIGNING_KEY_INVALID') {
    expect(root.textContent).toContain('SLIDE_SOURCE_SIGNING_KEY');
    expect(root.textContent).toContain('至少 32 字节');
  }
});
it('offers GET retry for HTML responses, clears the error and renders the snapshot', async () => {
  authFetch.mockResolvedValueOnce(new Response('<html>Authorization: secret</html>', { status: 502 }))
    .mockResolvedValue(new Response(JSON.stringify({ releaseId: 'fixture', files: [] })));
  const view = document.createElement('source-manifest'); document.body.append(view); await settle();
  expect(view.shadowRoot!.textContent).not.toContain('secret');
  view.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click(); await settle();
  expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
  expect(view.shadowRoot!.textContent).toContain('fixture');
});
it('invalidates the last snapshot when a refresh fails', async () => {
  authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ releaseId: 'last-good', files: [] })))
    .mockResolvedValue(new Response(JSON.stringify({ error: 'SOURCE_STORAGE_UNAVAILABLE' }), { status: 503 }));
  const view = document.createElement('source-manifest'); document.body.append(view); await settle();
  await (view as any).load(); await settle();
  expect(view.shadowRoot!.textContent).not.toContain('last-good');
  expect(view.shadowRoot!.textContent).toContain('存储不可用');
});
it.each([200, 403, 503])('closes old item details on revision change before manifest %s completes', async status => {
  const old = { releaseId: 'old', files: [{ path: 'src/private-old.ts', digest: 'private-digest', bytes: 20 }] };
  authFetch.mockResolvedValue(new Response(JSON.stringify(old)));
  const view = document.createElement('source-manifest') as any; document.body.append(view); await settle();
  await view.browse(); await view.updateComplete;
  const button = [...view.shadowRoot.querySelectorAll('button')].find((b: any) => b.textContent === '查看') as HTMLButtonElement;
  button.click(); await view.updateComplete;
  expect(view.shadowRoot.textContent).toContain('private-digest');
  let release!: (value: Response) => void;
  authFetch.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  view.revision++; await view.updateComplete;
  expect(view.shadowRoot.querySelector('app-dialog').open).toBe(false);
  expect(view.shadowRoot.textContent).not.toContain('private-digest');
  release(new Response(JSON.stringify(status === 200 ? { releaseId: 'new', files: [] } : { error: 'SOURCE_STORAGE_UNAVAILABLE' }), { status }));
  await settle();
  expect(view.shadowRoot.textContent).not.toContain('private-old');
});
it.each(['revision', 'permissions', 'session', 'disconnect'])('rejects an old manifest response after %s invalidation', async invalidation => {
  let release!: (value: Response) => void;
  authFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }))
    .mockResolvedValue(new Response(JSON.stringify({ releaseId: 'new-generation', files: [] })));
  const view = document.createElement('source-manifest') as any; document.body.append(view); await settle();
  if (invalidation === 'revision') { view.revision++; await view.updateComplete; await settle(); }
  if (invalidation === 'permissions') window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
  if (invalidation === 'session') window.dispatchEvent(new Event('slide-session-expired'));
  if (invalidation === 'disconnect') view.remove();
  release(new Response(JSON.stringify({ releaseId: 'private-old-response', files: [] }))); await settle();
  expect(view.shadowRoot.textContent).not.toContain('private-old-response');
});
