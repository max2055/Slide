import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '../../../api/index.js';
import { InstanceDetailPage } from './instance-detail.js';

vi.mock('../../../api/index.js', () => ({ authFetch: vi.fn() }));
// Keep this regression focused on the parent detail DOM and its timers.
vi.mock('../components/investigation-operation-context.ts', () => ({}));
vi.mock('../components/resource-investigation-links.js', () => ({}));
vi.mock('../components/instance-diagnosis-modal.js', () => ({}));

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(authFetch).mockReset();
});

describe('detail evidence ages independently of network refresh', () => {
  it.each(['overview', 'capacity'])('%s downgrades its rendered evidence with auto-refresh off', async tab => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T04:00:00Z'));
    window.history.replaceState({}, '', '/');
    const at = new Date().toISOString();
    const element = new InstanceDetailPage() as any;
    element.instanceId = 1;
    element.instance = { id: 1, name: 'MySQL', db_type: 'mysql', status: 'active', hasCredential: true };
    element.overview = {
      resource: { type: 'instance', id: 1 }, status: 'healthy', quality: 'good',
      freshness: 'fresh', observedAt: at, gaps: [], unresolvedAlerts: 0,
    };
    element.capacity = { total_size_gb: 0.66, observed_at: at, source: 'MySQL', scope: '账号可见库', top_tables: [] };
    element.activeTab = tab;
    element.loading = false;
    document.body.append(element);
    await element.updateComplete;
    element._toggleAutoRefresh();
    await element.updateComplete;
    expect(element.autoRefresh).toBe(false);
    expect(element.refreshTimer).toBeNull();

    const content = () => element.shadowRoot!.textContent as string;
    expect(content()).toContain('当前观测健康');
    expect(content()).toContain(tab === 'overview' ? '新鲜' : '新鲜（5分钟内）');
    const refresh = vi.spyOn(element, 'refreshCurrentTab');
    await vi.advanceTimersByTimeAsync(330_000);
    await element.updateComplete;

    expect(content()).toContain('当前健康待确认');
    expect(content()).not.toContain('当前观测健康');
    if (tab === 'overview') {
      expect(content()).toContain('当前证据不足以判断运行状态');
      expect(content()).toContain('过期');
      expect(content()).not.toContain('新鲜');
    } else {
      expect(content()).toContain('已过期（超过5分钟）');
      expect(content()).not.toContain('新鲜（5分钟内）');
      expect(content()).toContain('0.66 GB');
    }
    expect(refresh).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();

    element.remove();
    const update = vi.spyOn(element, 'requestUpdate');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(update).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(authFetch).not.toHaveBeenCalled();

    // A reattached detail also gets a timer, without reviving network refresh.
    document.body.append(element);
    element.overview = { ...element.overview, observedAt: new Date().toISOString() };
    element.capacity = { ...element.capacity, observed_at: new Date().toISOString() };
    await element.updateComplete;
    expect(content()).toContain('当前观测健康');
    await vi.advanceTimersByTimeAsync(330_000);
    await element.updateComplete;
    expect(content()).toContain('当前健康待确认');
    expect(authFetch).not.toHaveBeenCalled();
  });
});
