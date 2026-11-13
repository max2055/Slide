import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isSessionExpiryInProgress } = vi.hoisted(() => ({ isSessionExpiryInProgress: vi.fn(() => false) }));
vi.mock('../../../api/index.js', () => ({ isSessionExpiryInProgress }));
import { showToast, ToastContainer } from './app-toast-container.js';

async function mount() {
  const container = document.createElement('app-toast-container') as ToastContainer;
  document.body.append(container);
  await container.updateComplete;
  return container;
}
const messages = (container: ToastContainer) => [...container.shadowRoot!.querySelectorAll('.toast__msg')].map(el => el.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  isSessionExpiryInProgress.mockReturnValue(false);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MAX-656 / #419 Toast lifecycle', () => {
  it('warns explicitly before any container mounts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    showToast('尚未挂载');
    expect(warn).toHaveBeenCalledWith('showToast: app-toast-container not yet mounted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not deliver to an invisible old instance after unmount', async () => {
    const container = await mount();
    container.remove();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const add = vi.spyOn(container, 'addToast');
    showToast('卸载后提示');
    expect(add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a toast immediately on connection, before first render', async () => {
    const container = document.createElement('app-toast-container') as ToastContainer;
    document.body.append(container);
    showToast('同步连接提示');
    await container.updateComplete;
    expect(messages(container)).toEqual(['同步连接提示']);
  });

  it('reconnects the same instance without replaying old notifications', async () => {
    const container = await mount();
    showToast('旧通知');
    container.remove();
    expect(vi.getTimerCount()).toBe(0);
    document.body.append(container);
    showToast('重连通知');
    await container.updateComplete;
    expect(messages(container)).toEqual(['重连通知']);
  });

  it('delivers to a rebuilt container only', async () => {
    const old = await mount();
    old.remove();
    const current = await mount();
    const oldAdd = vi.spyOn(old, 'addToast');
    showToast('重建通知', 'success');
    await current.updateComplete;
    expect(messages(current)).toEqual(['重建通知']);
    expect(oldAdd).not.toHaveBeenCalled();
  });

  it('routes to the latest connected container and falls back when it leaves', async () => {
    const first = await mount();
    const second = await mount();
    showToast('第二容器');
    await second.updateComplete;
    expect(messages(first)).toEqual([]);
    expect(messages(second)).toEqual(['第二容器']);
    second.remove();
    showToast('第一容器恢复');
    await first.updateComplete;
    expect(messages(first)).toEqual(['第一容器恢复']);
    document.body.append(second);
    first.remove();
    showToast('交替卸载');
    await second.updateComplete;
    expect(messages(second)).toEqual(['交替卸载']);
  });

  it('an older disconnect and delayed first render cannot replace the new reference', async () => {
    const first = document.createElement('app-toast-container') as ToastContainer;
    document.body.append(first);
    first.remove();
    const second = await mount();
    await first.updateComplete;
    showToast('新引用保留');
    await second.updateComplete;
    expect(messages(second)).toEqual(['新引用保留']);
  });

  it('clears both auto-dismiss and exit-animation timers on disconnect', async () => {
    const container = await mount();
    showToast('等待自动关闭');
    expect(vi.getTimerCount()).toBe(1);
    container.remove();
    expect(vi.getTimerCount()).toBe(0);
    document.body.append(container);
    showToast('正在退出');
    await vi.advanceTimersByTimeAsync(3000);
    expect(container.shadowRoot!.querySelector('.toast--exit')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    container.remove();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    await container.updateComplete;
    expect(messages(container)).toEqual([]);
    container.addToast('断开时直接调用');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('manual dismissal cancels auto-dismiss and repeated clicks do not add timers', async () => {
    const container = await mount();
    showToast('手动关闭');
    await container.updateComplete;
    const close = container.shadowRoot!.querySelector('button')!;
    close.click(); close.click();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(messages(container)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the five-toast limit and frees evicted and completed timers', async () => {
    const container = await mount();
    for (let i = 0; i < 7; i++) showToast(`通知 ${i}`);
    await container.updateComplete;
    expect(messages(container)).toEqual(['通知 6', '通知 5', '通知 4', '通知 3', '通知 2']);
    expect(vi.getTimerCount()).toBe(5);
    await vi.advanceTimersByTimeAsync(3200);
    expect(messages(container)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves session-expiry error suppression and other toast types', async () => {
    const container = await mount();
    isSessionExpiryInProgress.mockReturnValue(true);
    showToast('会话错误', 'error');
    showToast('仍可提示', 'info');
    await container.updateComplete;
    expect(messages(container)).toEqual(['仍可提示']);
  });
});
