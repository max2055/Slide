import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../i18n/index.ts';
import { DashboardHeader } from './dashboard-header.ts';

async function mount() {
  const header = new DashboardHeader();
  header.tab = 'investigations';
  document.body.append(header);
  await header.updateComplete;
  return header;
}
const label = (header: DashboardHeader) =>
  header.querySelector('.dashboard-header__breadcrumb-current')?.textContent;

beforeEach(async () => { await i18n.setLocale('en'); });
afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale('en');
  vi.restoreAllMocks();
});

describe('dashboard breadcrumb language subscription', () => {
  it('updates the same route after the asynchronous Chinese translation loads', async () => {
    const header = await mount();
    expect(label(header)).toBe('AI Workspace');
    const loading = i18n.setLocale('zh-CN');
    await loading;
    await header.updateComplete;
    expect(header.tab).toBe('investigations');
    expect(label(header)).toBe('AI 工作空间');
  });

  it('follows language switches and retains the effective language on remount', async () => {
    await i18n.setLocale('zh-CN');
    const header = await mount();
    expect(label(header)).toBe('AI 工作空间');
    await i18n.setLocale('en');
    await header.updateComplete;
    expect(label(header)).toBe('AI Workspace');
    header.remove();
    const restored = await mount();
    expect(label(restored)).toBe('AI Workspace');
    await i18n.setLocale('zh-CN');
    await restored.updateComplete;
    expect(label(restored)).toBe('AI 工作空间');
  });

  it('unsubscribes on disconnect and reconnects without changing navigation', async () => {
    const header = await mount();
    header.remove();
    const update = vi.spyOn(header, 'requestUpdate');
    await i18n.setLocale('zh-CN');
    expect(update).not.toHaveBeenCalled();
    document.body.append(header);
    await i18n.setLocale('en');
    await i18n.setLocale('zh-CN');
    await header.updateComplete;
    expect(label(header)).toBe('AI 工作空间');
    const navigate = vi.fn();
    header.addEventListener('navigate', navigate);
    header.querySelector<HTMLElement>('.dashboard-header__breadcrumb-link')!.click();
    expect(navigate.mock.calls[0][0].detail).toBe('overview');
  });
});
