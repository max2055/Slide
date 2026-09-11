import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAB_GROUPS, tabFromPath } from '../navigation.js';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));

afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); history.replaceState({}, '', '/'); });

describe('cross-resource diagnosis', () => {
  it('preserves four groups and registers diagnosis under operations', () => {
    expect(TAB_GROUPS).toHaveLength(4);
    expect(TAB_GROUPS.find(group => group.label === 'operations')?.tabs).toContain('resource-diagnosis');
    expect(tabFromPath('/resource-diagnosis')).toBe('resource-diagnosis');
  });

  it('loads a deep-linked resource and exposes missing evidence without inventing facts', async () => {
    await import('./resource-diagnosis.js');
    history.replaceState({}, '', '/resource-diagnosis?resourceType=network_device&resourceId=3');
    authFetch.mockImplementation(async (url: string) => url.endsWith('/evaluation') ? { ok: false, json: async () => ({ error: 'EVALUATION_UNAVAILABLE' }) } : ({ ok: true, json: async () => url === '/api/resources'
      ? { items: [{ resource: { type: 'network_device', id: 3 }, label: 'Edge switch', status: 'unknown', attributes: {} }] }
      : { schemaVersion: 1, resource: { type: 'network_device', id: 3 }, generatedAt: new Date().toISOString(), facts: [], inferences: [], hypotheses: [], gaps: ['OBSERVATIONS_EMPTY'], truncated: false } }));
    const element = document.createElement('resource-diagnosis-page') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await new Promise(resolve => setTimeout(resolve, 10));
    await element.updateComplete;
    expect(authFetch).toHaveBeenCalledWith('/api/resources/network_device/3/evidence');
    expect(element.shadowRoot?.textContent).toContain('OBSERVATIONS_EMPTY');
    expect(element.shadowRoot?.querySelector('[data-kind="facts"] app-empty-state')).not.toBeNull();
  });

  it('rejects an unsupported deep-link type before requesting evidence', async () => {
    await import('./resource-diagnosis.js');
    history.replaceState({}, '', '/resource-diagnosis?resourceType=constructor&resourceId=3');
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const element = document.createElement('resource-diagnosis-page');
    document.body.append(element);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual(['/api/resources']);
  });
});

describe('tracked read-only diagnosis', () => {
  it.each(['instance', 'server', 'network_device'])('follows %s cached receipt to a real result without auto submitting', async type => {
    await import('./resource-diagnosis.js');
    localStorage.setItem('permissions', '["*"]');
    history.replaceState({}, '', `/resource-diagnosis?resourceType=${type}&resourceId=3&returnTo=%2Fdashboard%3Fscope%3Dserver`);
    let status = 'running';
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => {
      if (url === '/api/resources') return { items: [] };
      if (url.endsWith('/evidence')) return { facts: [], inferences: [], hypotheses: [], gaps: [], truncated: false };
      if (url.endsWith('/diagnose-agent')) return { analysisId: 42, status: 'cached' };
      if (url.endsWith('/analyses/42')) return { analysisId: 42, status, result: status === 'completed' ? { summary: 'Real stored result' } : null };
      return {};
    } }));
    const element = document.createElement('resource-diagnosis-page') as any;
    document.body.append(element); await new Promise(resolve => setTimeout(resolve, 10));
    expect(authFetch.mock.calls.some(([url]) => url.endsWith('/diagnose-agent'))).toBe(false);
    await element.diagnose(true); await new Promise(resolve => setTimeout(resolve, 0));
    expect(element.agentResult.status).toBe('running');
    expect(location.search).toContain('analysisId=42');
    await element.diagnose(true);
    expect(authFetch.mock.calls.filter(([url]) => url.endsWith('/diagnose-agent'))).toHaveLength(1);
    status = 'completed'; element.startStatus(); await new Promise(resolve => setTimeout(resolve, 0)); await element.updateComplete;
    expect(element.shadowRoot.textContent).toContain('Real stored result');
    expect(element.shadowRoot.textContent).toContain('历史诊断上下文');
    expect(element.shadowRoot.querySelector('a[href="/dashboard?scope=server"]')).not.toBeNull();
    element.remove(); expect(element.statusTimer).toBeNull();
  });
  it('keeps pending identity on timeout and stops polling when leaving', async () => {
    await import('./resource-diagnosis.js');
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => ({ items: [] }) }));
    const element = document.createElement('resource-diagnosis-page') as any;
    document.body.append(element); await new Promise(resolve => setTimeout(resolve, 0));
    element.selected = { type: 'server', id: 1 }; element.agentResult = { analysisId: 9, status: 'running' }; element.statusDeadline = Date.now() - 1;
    await element.checkStatus();
    expect(element.taskMessage).toBe('等待超时，任务状态待确认'); expect(element.agentResult.status).toBe('running');
    element.statusTimer = setTimeout(() => {}, 3000); element.remove(); expect(element.statusTimer).toBeNull();
  });
});
