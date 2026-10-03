import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAB_GROUPS, tabFromPath } from '../navigation.js';
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));

afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); localStorage.clear(); history.replaceState({}, '', '/'); });

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
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => ({ items: [], gaps: [], truncated: false }) }));
    const element = document.createElement('resource-diagnosis-page');
    document.body.append(element);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authFetch.mock.calls.map(([url]) => url)).toEqual(['/api/resources']);
  });
});

describe('business diagnosis explanation', () => {
  async function mount() {
    await import('./resource-diagnosis.js');
    localStorage.setItem('permissions', '["*"]');
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => ({ items: [], gaps: [], truncated: false }) }));
    const element = document.createElement('resource-diagnosis-page') as any;
    document.body.append(element); await new Promise(resolve => setTimeout(resolve, 0));
    element.selected = { type: 'instance', id: 1 };
    element.resources = [{ resource: element.selected, label: '订单数据库', status: 'online', attributes: {} }];
    return element;
  }
  it('explains stale evidence and missing inputs without calling the resource healthy', async () => {
    const element = await mount();
    element.evidence = { generatedAt: new Date().toISOString(), facts: [{ id: 'raw-evidence-id', kind: 'observation', status: 'fact', quality: 'good', observedAt: '2020-01-01T00:00:00Z', validUntil: '2020-01-01T00:05:00Z', source: 'collector', payload: { metricId: 'cpu', value: 0 } }], inferences: [], hypotheses: [], gaps: ['EVIDENCE_STALE'], truncated: false };
    await element.updateComplete;
    const text = element.shadowRoot.querySelector('[data-diagnosis-overview]').textContent;
    expect(text).toContain('订单数据库'); expect(text).toContain('不能据此判断当前异常'); expect(text).toContain('刷新');
    expect(element.shadowRoot.querySelector('[data-evidence-id] summary').textContent).not.toContain('raw-evidence-id');
    expect(element.shadowRoot.querySelector('[data-evidence-id] summary').textContent).toContain('已过期');
  });
  it('separates execution completion, partial verification and historical snapshot time', async () => {
    const element = await mount();
    element.agentResult = { analysisId: 7, status: 'completed', completedAt: '2026-10-01T10:00:00Z', result: { verification: 'partial', evidenceSnapshot: { collectedAt: '2026-10-01T09:00:00Z' }, conclusions: ['CPU 超出配置范围'], recommendations: [{ action: '检查采集连接' }] } };
    await element.updateComplete;
    const text = element.shadowRoot.querySelector('[data-analysis-id]').textContent;
    expect(text).toContain('部分完成'); expect(text).toContain('CPU 超出配置范围'); expect(text).toContain('检查采集连接'); expect(text).toContain('2026-10-01'); expect(text).toContain('未验证 Evidence ID');
  });
  it('blocks normal submissions for unknown results and preserves confirmation retry payload', async () => {
    const element = await mount(); element.agentResult = { analysisId: 7, status: 'unknown' };
    await element.diagnose(true);
    expect(authFetch.mock.calls.some(([url]) => url.endsWith('/diagnose-agent'))).toBe(false);
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => url.includes('diagnose-agent') || url.includes('/analyses/') ? { analysisId: 8, status: 'unknown' } : { items: [], gaps: [], truncated: false } }));
    await element.diagnose(true, 7);
    const call = authFetch.mock.calls.find(([url]) => url.endsWith('/diagnose-agent'));
    expect(JSON.parse(call![1].body)).toEqual({ retryOf: 7, confirmUnknownRetry: true });
  });
  it('shows an unconfirmed query separately from the last running state', async () => {
    const element = await mount(); element.agentResult = { analysisId: 7, status: 'running' }; element.statusDeadline = Date.now() - 1;
    await element.checkStatus(); await element.updateComplete;
    expect(element.shadowRoot.querySelector('[data-task-status]').textContent).toContain('状态待确认');
    expect(element.agentResult.status).toBe('running');
  });
  it('does not treat unknown timestamps or quality as current trustworthy facts', async () => {
    const element = await mount();
    const item = { id: 'evidence', kind: 'observation', status: 'fact', quality: 'unknown', observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(), source: 'collector', payload: { metricId: 'cpu', value: null } };
    element.evidence = { generatedAt: 'bad-date', facts: [item, { ...item, id: 'future', quality: 'good', observedAt: new Date(Date.now() + 120_000).toISOString() }, { ...item, id: 'no-expiry', quality: 'good', validUntil: null }], inferences: [], hypotheses: [], gaps: ['NEW_GAP'], truncated: true };
    await element.updateComplete;
    const text = element.shadowRoot.querySelector('[data-diagnosis-overview]').textContent;
    expect(text).toContain('有效期内且质量有效的事实 0 项'); expect(text).toContain('时间未知'); expect(text).toContain('返回证据已截断');
    expect(element.shadowRoot.textContent).toContain('部分证据无法确认');
    expect(element.shadowRoot.querySelector('[data-evidence-id="future"] summary').textContent).toContain('时间未知');
    expect(element.shadowRoot.querySelector('[data-evidence-id="no-expiry"] summary').textContent).toContain('有效期未知');
  });
  it('keeps querying an existing unknown task even when refreshing evidence is forbidden', async () => {
    const element = await mount();
    history.replaceState({}, '', '/resource-diagnosis?resourceType=instance&resourceId=1&analysisId=7');
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evidence') && !url.endsWith('/evaluation'), status: url.endsWith('/evidence') ? 403 : 200, json: async () => url.includes('/analyses/') ? { analysisId: 7, status: 'unknown' } : { items: [], gaps: [], truncated: false } }));
    await element.loadEvidence(); await vi.waitFor(() => expect(element.agentResult?.status).toBe('unknown')); await element.updateComplete;
    expect(element.error).toContain('无当前资源证据查看权限');
    expect(element.shadowRoot.querySelector('[data-task-status]').textContent).toContain('结果未知');
    await element.diagnose(true); expect(authFetch.mock.calls.some(([url]) => url.endsWith('/diagnose-agent'))).toBe(false);
  });
});

describe('tracked read-only diagnosis', () => {
  it('stops polling unknown and sends a billable retry only after the confirmation button', async () => {
    await import('./resource-diagnosis.js'); localStorage.setItem('permissions', '["*"]');
    history.replaceState({}, '', '/resource-diagnosis?resourceType=server&resourceId=3&analysisId=42');
    authFetch.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/evaluation'), json: async () => {
      if (url === '/api/resources') return { items: [] };
      if (url.endsWith('/evidence')) return { facts: [], inferences: [], hypotheses: [], gaps: [], truncated: false };
      if (url.endsWith('/analyses/42')) return { analysisId: 42, status: 'unknown' };
      if (url.endsWith('/diagnose-agent')) return { analysisId: 43, status: 'queued' };
      if (url.endsWith('/analyses/43')) return { analysisId: 43, status: 'pending' };
      return { items: [], gaps: [], truncated: false };
    } }));
    const element = document.createElement('resource-diagnosis-page') as any;
    document.body.append(element); await vi.waitFor(() => expect(element.agentResult?.status).toBe('unknown')); await element.updateComplete;
    expect(element.statusTimer).toBeNull(); expect(element.shadowRoot.textContent).toContain('不会自动再次调用');
    const retry = [...element.shadowRoot.querySelectorAll('button')].find((button: any) => button.textContent.includes('确认后重新分析')) as HTMLButtonElement;
    retry.click(); await element.updateComplete;
    expect(authFetch.mock.calls.filter(([url]) => url.endsWith('/diagnose-agent'))).toHaveLength(0);
    const confirm = [...element.shadowRoot.querySelectorAll('button')].find((button: any) => button.textContent.includes('接受可能再次计费并重试')) as HTMLButtonElement;
    confirm.click(); await vi.waitFor(() => expect(authFetch.mock.calls.filter(([url]) => url.endsWith('/diagnose-agent'))).toHaveLength(1));
    const call = authFetch.mock.calls.find(([url]) => url.endsWith('/diagnose-agent'));
    expect(JSON.parse(call![1].body)).toEqual({ retryOf: 42, confirmUnknownRetry: true });
  });
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
      return { items: [], gaps: [], truncated: false };
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
