import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/app-toast-container.js', () => ({ showToast: vi.fn() }));

import './feishu-notification-settings.js';

type Page = HTMLElement & Record<string, any>;

function page(): Page {
  return document.createElement('feishu-notification-settings') as Page;
}

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('Feishu notification settings', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    authFetch.mockReset();
  });

  it('loads an existing Feishu channel without placing its secret in the form', async () => {
    authFetch.mockResolvedValue(response([{
      id: 9, name: '飞书告警', type: 'feishu', enabled: false,
      config: { endpoint: 'https://open.feishu.cn', hasCredential: true },
    }]));
    const subject = page();
    document.body.append(subject);
    await subject.load();
    await subject.updateComplete;

    expect(subject.channelId).toBe(9);
    expect(subject.webhookUrl).toBe('');
    expect(subject.endpoint).toBe('https://open.feishu.cn');
    expect(subject.secret).toBe('');
    expect(subject.shadowRoot?.textContent).toContain('已安全保存');
  });

  it('saves a new Feishu webhook with the supplied signing secret and enabled state', async () => {
    authFetch.mockResolvedValue(response([]));
    const subject = page();
    document.body.append(subject);
    await subject.load();
    const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/example';
    subject.webhookUrl = webhookUrl;
    subject.secret = 'signing-secret';
    subject.enabled = true;
    authFetch.mockResolvedValueOnce(response({ id: 10 }));

    await subject.save();

    expect(authFetch).toHaveBeenLastCalledWith('/api/notification/channels', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: '飞书告警', type: 'feishu', enabled: true,
        config: { webhook_url: webhookUrl, secret: 'signing-secret', severity: 'info' },
      }),
    }));
    expect(subject.secret).toBe('');
  });

  it('does not save a non-Feishu HTTPS webhook URL', async () => {
    authFetch.mockResolvedValue(response([]));
    const subject = page();
    document.body.append(subject);
    await subject.load();
    subject.webhookUrl = 'https://example.com/hook';
    subject.secret = 'signing-secret';
    const callsBeforeSave = authFetch.mock.calls.length;

    await subject.save();

    expect(authFetch).toHaveBeenCalledTimes(callsBeforeSave);
    expect(subject.error).toContain('open.feishu.cn');
  });
});
