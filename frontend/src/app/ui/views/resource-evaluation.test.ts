import { afterEach, expect, it, vi } from 'vitest';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './resource-evaluation.js';
afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });
it('renders returned rule decisions, statistical expectations and evidence references', async () => {
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ rulesVersion: 1, generatedAt: '2026-09-08', invariants: [{ ruleId: 'cpu-valid', version: 1, status: 'unknown', reason: 'NO_SAMPLE', evidenceRefs: ['ev-1'] }], expectations: [{ metricId: 'cpu', status: 'unknown', reason: 'BASELINE_SHORT', mean: null, deviation: null, sampleCount: 2, evidenceRefs: ['ev-2'] }], gaps: ['BASELINE_SHORT'] }) });
  const view = document.createElement('resource-evaluation') as HTMLElement & { resourceType: string; resourceId: number };
  view.resourceType = 'server'; view.resourceId = 2; document.body.append(view);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(authFetch).toHaveBeenCalledWith('/api/resources/server/2/evaluation');
  expect(view.shadowRoot?.textContent).toContain('cpu-valid');
  expect(view.shadowRoot?.textContent).toContain('BASELINE_SHORT');
  expect(view.shadowRoot?.textContent).toContain('ev-1');
});
