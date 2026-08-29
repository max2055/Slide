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
          resource_json: {},
          status: 'pending',
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
  });
});
