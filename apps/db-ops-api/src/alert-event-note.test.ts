import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ execute: vi.fn(), analyzeAlert: vi.fn() }));
vi.mock('./db-connection', () => ({ dbConnection: { getPool: () => fixture } }));
vi.mock('./alert-rca-service', () => ({ alertRCAService: { analyzeAlert: fixture.analyzeAlert } }));
import { alertEventService } from './alert-event-service.js';
beforeEach(() => { fixture.execute.mockReset(); fixture.analyzeAlert.mockReset(); });
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

it('does not record a successful RCA action when every member is rejected', async () => {
  fixture.execute.mockResolvedValueOnce([[{ alert_id: 11 }, { alert_id: 12 }]]);
  fixture.analyzeAlert.mockResolvedValue({ success: false });
  expect(await alertEventService.triggerRCAForEvent(55, 7)).toEqual({ success: false });
  expect(fixture.analyzeAlert).toHaveBeenCalledTimes(2);
  expect(fixture.execute).toHaveBeenCalledTimes(1);
});

it('returns and records legacy analyses and native investigations', async () => {
  const investigationId = 'b9f9b923-33f0-448c-a6f7-64d9b8e6e098';
  fixture.execute.mockResolvedValueOnce([[{ alert_id: 11 }, { alert_id: 12 }]]).mockResolvedValueOnce([{}]);
  fixture.analyzeAlert.mockResolvedValueOnce({ success: true, investigationId })
    .mockResolvedValueOnce({ success: true, analysisId: 9, sessionKey: 'rca-11' });
  expect(await alertEventService.triggerRCAForEvent(55, 7)).toEqual({
    success: true, analysisIds: [9], sessionKeys: ['rca-11'], investigationIds: [investigationId],
  });
  const [, params] = fixture.execute.mock.calls[1];
  expect(params.slice(0, 3)).toEqual([55, 'note_added', 7]);
  expect(JSON.parse(params[3])).toMatchObject({ action: 'rca_triggered', investigation_ids: [investigationId], analysis_ids: [9] });
});
