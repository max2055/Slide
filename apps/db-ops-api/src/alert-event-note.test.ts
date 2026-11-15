import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => fixture } }));
vi.mock('./alert-rca-service', () => ({ alertRCAService: {} }));
import { alertEventService } from './alert-event-service.js';
beforeEach(() => { fixture.execute.mockReset(); });
// MAX-584 / #657: note persistence must use the existing action enum contract.
it('records note_added with the original note and actor identity', async () => {
  fixture.execute.mockResolvedValue([{}]);
  expect(await alertEventService.addHandlerNote(55, '原文\n第二行', 7)).toEqual({ success: true });
  const [sql, params] = fixture.execute.mock.calls[0];
  expect(sql).toContain('INSERT INTO alert_event_logs');
  expect(params.slice(0, 3)).toEqual([55, 'note_added', 7]);
  expect(JSON.parse(params[3])).toEqual({ note: '原文\n第二行', user_id: 7 });
});
it('reports a rejected write as failure', async () => {
  fixture.execute.mockRejectedValue(new Error('write rejected'));
  expect(await alertEventService.addHandlerNote(55, 'retain me', 7)).toEqual({ success: false, error: 'write rejected' });
});
