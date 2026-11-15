import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));
import './sql-audit-tab.js';

afterEach(() => document.body.replaceChildren());

it('#682 preserves original symbols in every current-result text branch without creating HTML', async () => {
  const literal = '<img src=x onerror="window.auditHtmlExecuted=true"> < > & " &lt;';
  const key = '字段 < > &';
  const view = document.createElement('sql-audit-tab') as HTMLElement & {
    instanceId: number; currentResult: unknown; updateComplete: Promise<boolean>;
  };
  view.instanceId = 1;
  view.currentResult = { summary: literal, [key]: [literal, { [key]: literal }, 42, null], object: { [key]: literal }, scalar: literal };
  document.body.append(view);
  await view.updateComplete;
  const result = view.shadowRoot!.querySelector('.result-card')!;
  expect(result.querySelector('p')!.textContent).toBe(literal);
  expect([...result.querySelectorAll('li')].map(node => node.textContent)).toEqual([literal, `${key}: ${literal}`, '42', 'null']);
  expect(result.querySelectorAll('strong')[1].textContent).toBe(key);
  expect(result.querySelector('pre')!.textContent).toBe(JSON.stringify({ [key]: literal }, null, 2));
  expect(result.querySelector('span')!.textContent).toBe(literal);
  expect(result.querySelector('img, script')).toBeNull();
});
