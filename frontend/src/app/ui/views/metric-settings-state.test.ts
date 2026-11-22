import { afterEach, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
import './metric-settings.js';

afterEach(() => { document.body.replaceChildren(); authFetch.mockReset(); });

it('loads the template list without requesting catalogs, policies, audits or governance', async () => {
  authFetch.mockResolvedValue(Response.json({ templates: [], can_manage: true }));
  const page = document.createElement('metric-settings');
  document.body.append(page);
  await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
  expect(authFetch.mock.calls[0][0]).toBe('/api/metrics/templates/library');
  expect(page.shadowRoot?.querySelectorAll('template-library')).toHaveLength(1);
  expect(page.shadowRoot?.querySelector('template-governance')).toBeNull();
});
