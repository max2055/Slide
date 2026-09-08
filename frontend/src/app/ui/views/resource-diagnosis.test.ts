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
    authFetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === '/api/resources'
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
