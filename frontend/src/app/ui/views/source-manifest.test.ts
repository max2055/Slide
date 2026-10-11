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
  expect(root.querySelector('button')).toBeNull();
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
it('preserves the last good snapshot when a refresh fails', async () => {
  authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ releaseId: 'last-good', files: [] })))
    .mockResolvedValue(new Response(JSON.stringify({ error: 'SOURCE_STORAGE_UNAVAILABLE' }), { status: 503 }));
  const view = document.createElement('source-manifest'); document.body.append(view); await settle();
  await (view as any).load(); await settle();
  expect(view.shadowRoot!.textContent).toContain('last-good');
  expect(view.shadowRoot!.textContent).toContain('存储不可用');
});
