import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));

import { agentApprovalsLoadError } from './approval-dashboard.ts';
import './approval-dashboard.ts';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  document.body.replaceChildren();
  authFetch.mockReset();
});

describe('approval dashboard visibility', () => {
  it('distinguishes permission failures from unavailable approval storage', () => {
    expect(agentApprovalsLoadError(403)).toContain('权限');
    expect(agentApprovalsLoadError(503)).toContain('迁移');
  });

  it('renders SQL and Agent approvals together without a type filter tab', async () => {
    authFetch.mockResolvedValue(response({
      items: [
        {
          id: 1,
          kind: 'sql',
          instance_id: 7,
          sql_text: 'SELECT 1',
          risk_level: 'low',
          status: 'pending',
          created_at: '2026-08-28T00:00:00.000Z',
        },
        {
          id: 'agent-1',
          kind: 'agent',
          tool_name: 'discover_database_endpoints',
          requester_id: 9,
          args_redacted: { cidr: '10.17.12.0/24' },
          resource_json: { type: 'instance', instanceId: 7 },
          status: 'pending',
          risk_level: 'high',
          created_at: '2026-08-28T00:00:00.000Z',
        },
      ],
    }));

    const subject = document.createElement('approval-dashboard');
    document.body.append(subject);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (subject as any).updateComplete;

    expect(subject.shadowRoot?.querySelectorAll('.tabs')).toHaveLength(1);
    expect(subject.shadowRoot?.querySelector('[aria-label="审批类型"]')).toBeNull();
    expect(subject.shadowRoot?.textContent).toContain('discover_database_endpoints');
    expect(subject.shadowRoot?.textContent).toContain('SELECT 1');
    const root = subject.shadowRoot!;
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label^="查看完整证据：Agent #agent-1"]')!;
    const card = trigger.closest('app-card');
    expect(card?.textContent).toContain('申请人 9');
    expect(card?.textContent).toContain('instance #7');
    trigger.click();
    await (subject as any).updateComplete;
    const dialog = root.querySelector('app-dialog')!;
    expect(dialog.textContent).toContain('Agent #agent-1');
    expect(dialog.textContent).toContain('申请人9');
    expect(dialog.textContent).toContain('10.17.12.0/24');
    expect(dialog.textContent).toContain('关联 Operation未提供');
    expect(authFetch).toHaveBeenCalledTimes(1);
    dialog.querySelector<HTMLButtonElement>('button[slot="footer"]')!.click();
    await (subject as any).updateComplete;
    await vi.waitFor(() => expect(root.activeElement).toBe(trigger));
    trigger.click();
    await (subject as any).updateComplete;
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded'));
    await (subject as any).updateComplete;
    expect(root.querySelector('app-dialog')).toBeNull();
    expect(root.textContent).not.toContain('10.17.12.0/24');
  });

  it('shows the Agent evidence gaps when the existing receipt omits target and parameters', async () => {
    authFetch.mockResolvedValue(response({ items: [{ id: '12', kind: 'agent', tool_name: 'fixture_tool', status: 'pending' }] }));
    const subject = document.createElement('approval-dashboard');
    document.body.append(subject);
    const root = subject.shadowRoot!;
    const selector = 'button[aria-label^="查看完整证据：Agent #12"]';
    await vi.waitFor(() => expect(root.querySelector(selector)).not.toBeNull());
    expect(root.textContent).toContain('申请人 未提供');
    expect(root.textContent).toContain('未提供目标资源');
    expect(root.textContent).toContain('风险：未提供');
    root.querySelector<HTMLButtonElement>(selector)!.click();
    await (subject as any).updateComplete;
    const dialog = root.querySelector('app-dialog');
    expect(dialog?.textContent).toContain('未提供脱敏参数');
    expect(dialog?.textContent).toContain('关联 Operation未提供');
  });

  it('batch approves pending requests for the same Agent tool', async () => {
    const pending = {
      tool_name: 'slide_check_status',
      requester_id: 9,
      args_redacted: { include_details: true },
      resource_json: { type: 'none' },
      status: 'pending',
      risk_level: 'high',
      created_at: '2026-08-28T00:00:00.000Z',
      expires_at: '2026-08-28T00:30:00.000Z',
      kind: 'agent',
    };
    authFetch
      .mockResolvedValueOnce(response({ items: [{ ...pending, id: 'agent-1' }, { ...pending, id: 'agent-2' }] }))
      .mockResolvedValueOnce(response({ success: true, count: 2 }))
      .mockResolvedValueOnce(response({ items: [] }));

    const subject = document.createElement('approval-dashboard');
    document.body.append(subject);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (subject as any).updateComplete;

    const button = subject.shadowRoot?.querySelector<HTMLButtonElement>('.agent-batch-approve');
    expect(button?.textContent).toContain('同工具全部通过 (2)');
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authFetch).toHaveBeenNthCalledWith(2, '/api/agent/approvals/batch-review', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ toolName: 'slide_check_status', action: 'approve', scope: 'once' }),
    }));
  });

  it('shows both SQL batch outcomes and refreshes while keeping the receipt available', async () => {
    const pending = [4, 5].map(id => ({
      id, kind: 'sql', instance_id: 7, sql_text: `UPDATE counter SET value = 1 WHERE id = ${id}`,
      risk_level: 'high', status: 'pending', created_at: '2026-08-28T00:00:00.000Z',
    }));
    let completeRefresh!: (value: Response) => void;
    const refresh = new Promise<Response>(resolve => { completeRefresh = resolve; });
    authFetch
      .mockResolvedValueOnce(response({ items: pending }))
      .mockResolvedValueOnce(response([
        { id: 4, success: false, error: '审批请求不存在或已处理' },
        { id: 5, success: true },
      ]))
      .mockReturnValueOnce(refresh);
    const subject = document.createElement('approval-dashboard');
    document.body.append(subject);
    const root = subject.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelectorAll('.approval-card')).toHaveLength(2));
    root.querySelectorAll<HTMLInputElement>('input[aria-label^="选择审批"]').forEach(input => input.click());
    await vi.waitFor(() => expect(root.querySelector('.batch-bar')?.textContent).toContain('通过 (2)'));
    root.querySelector<HTMLButtonElement>('.batch-bar .btn-success')!.click();
    await vi.waitFor(() => expect(root.querySelector('app-dialog .btn-success')?.textContent).toContain('确认通过'));
    const confirm = root.querySelector<HTMLButtonElement>('app-dialog .btn-success')!;
    confirm.click();
    confirm.click();

    await vi.waitFor(() => expect(root.querySelector('app-dialog [role="status"]')?.textContent).toContain('#5 · 已完成'));
    expect(root.querySelector('app-dialog [role="status"]')?.textContent).toContain('#4 · 未完成 · 审批请求不存在或已处理');
    expect(root.querySelector('app-dialog .btn-success')).toBeNull();
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/approval/unified?status=pending', '/api/approval/batch-review', '/api/approval/unified?status=pending',
    ]);

    completeRefresh(response({ items: [] }));
    await vi.waitFor(() => expect(root.querySelector('app-empty-state')).not.toBeNull());
    expect(root.querySelectorAll('app-dialog li')).toHaveLength(2);
    root.querySelector<HTMLButtonElement>('app-dialog button[slot="footer"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('app-dialog')).toBeNull());
  });
});
