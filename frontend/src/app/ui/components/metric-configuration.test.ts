import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './metric-configuration.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 15));
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); sessionStorage.clear(); });

const mount = async (resourceId = 1) => {
  const element = document.createElement('metric-configuration') as any;
  element.resourceId = resourceId;
  document.body.append(element);
  for (let i = 0; i < 30 && element.mode === 'loading'; i++) await settle();
  return element;
};

it('a template binding opens the native fixed-version flow', async () => {
  authFetch.mockImplementation(async () => ({ ok: true, json: async () => ({
    source: 'template', revision: 5, template_pins: [], application: null, pending: null, effective: null, published_at: null }) }));
  const element = await mount();
  expect(element.mode).toBe('native');
  expect(element.renderRoot.querySelector('native-template-configuration')).not.toBeNull();
  expect(element.renderRoot.querySelector('legacy-metric-configuration')).toBeNull();
});

it('a legacy single-package binding keeps its existing editor', async () => {
  authFetch.mockImplementation(async () => ({ ok: true, json: async () => ({
    source: 'package', revision: 3, template_pins: [], application: null, pending: null, effective: null, published_at: null }) }));
  const element = await mount();
  expect(element.mode).toBe('legacy');
  expect(element.renderRoot.querySelector('legacy-metric-configuration')).not.toBeNull();
});

it('a failed binding read is an error, never an assumed unbound resource', async () => {
  authFetch.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ error: 'POLICY_FAILED' }) }));
  const element = await mount();
  expect(element.mode).toBe('error');
  expect(element.shadowRoot.textContent).toContain('暂时无法完成操作');
  expect(element.renderRoot.querySelector('native-template-configuration')).toBeNull();
  expect(element.renderRoot.querySelector('legacy-metric-configuration')).toBeNull();
});

it('a legacy resource may enter the native flow explicitly and return without writing', async () => {
  const calls: string[] = [];
  authFetch.mockImplementation(async (url: string) => { calls.push(String(url)); return { ok: true, json: async () => ({
    source: 'package', revision: 3, template_pins: [], application: null, pending: null,
    configuration: { overrides: {}, group_id: null }, effective: null, published_at: null }) }; });
  const element = await mount();
  expect(element.mode).toBe('legacy');
  const enter = element.renderRoot.querySelector('.switch button') as HTMLButtonElement;
  expect(enter.textContent).toContain('改用固定版本模板配置');
  enter.click();
  await settle();
  expect(element.mode).toBe('native');
  expect(element.renderRoot.querySelector('native-template-configuration')).not.toBeNull();
  // Switching editors is a client-side choice: no request beyond the source read.
  const writes = calls.filter(url => !/template-bindings\/instance\/1$/.test(url));
  expect(writes.filter(url => /\/apply$/.test(url))).toHaveLength(0);
  const back = element.renderRoot.querySelector('.switch button') as HTMLButtonElement;
  expect(back.textContent).toContain('返回旧版单包配置');
});
