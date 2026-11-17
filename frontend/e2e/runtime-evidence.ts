import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { validateEvent } from '../../scripts/qualification/runtime-browser-evidence.mjs';

const key = randomBytes(32);
let written = 0;
export function runtimeEvidence(page: Page, scenario: string, testInfo: TestInfo) {
  const file = process.env.RUNTIME_EVIDENCE_FILE;
  const link = (value: string) => createHmac('sha256', key).update(value).digest('hex');
  let session = '';
  let desired = '';
  let failed = false;
  let dropped = 0;
  let businessFailed = false;
  const tasks = new Set<Promise<void>>();
  const emit = (kind: string, data: Record<string, unknown>) => {
    if (!file) return;
    try {
      if (++written > 1900 && !['collection', 'result'].includes(kind)) { failed = true; dropped++; return; }
      const wallBefore = Date.now();
      const mono = performance.now();
      const row = validateEvent({ scenario, kind, wallBefore, mono, wallAfter: Date.now(), ...data });
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { failed = true; dropped++; }
  };
  const normalize = (value: string) => value.replace(/^agent:[^:]+:/, '');
  const response = (r: any) => {
    let url: URL;
    try { url = new URL(r.url()); } catch { return; }
    if (url.pathname !== '/api/chat/history' || !session || normalize(url.searchParams.get('sessionKey') ?? '') !== session) return;
    const task = (async () => {
      let count = 0, matches = false, length = 0;
      if (r.ok()) {
        const body = await r.json();
        const messages = Array.isArray(body) ? body : body.messages;
        if (!Array.isArray(messages)) throw new Error('INVALID_HISTORY');
        count = messages.length;
        matches = messages.some((m: any) => m.content === desired);
        length = messages.filter((m: any) => m.content === desired).reduce((sum: number, m: any) => sum + m.content.length, 0);
      }
      emit('http', { status: r.status(), session: link(session), count, matches, length });
    })().catch(() => { failed = true; dropped++; });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  };
  page.on('response', response);
  const ws = (socket: any) => {
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, ({ payload }: any) => {
        try {
          if (typeof payload !== 'string') return;
          if (payload.length > 1_000_000) { failed = true; dropped++; return; }
          const frame = JSON.parse(payload);
          if (!['chat.watch', 'run.snapshot', 'complete', 'run.started', 'stream.snapshot', 'stream.event', 'error'].includes(frame.type)) return;
          if (!session || normalize(String(frame.sessionKey ?? frame.run?.sessionId ?? '')) !== session) return;
          const data: Record<string, unknown> = { direction, event: frame.type, session: link(session) };
          const id = frame.runId ?? frame.run?.id;
          if (typeof id === 'string') data.run = link(id);
          const message = frame.messageId ?? frame.run?.messageId;
          if (typeof message === 'string') data.message = link(message);
          if (['running', 'completed', 'failed', 'cancelled', 'timed_out', 'partial'].includes(frame.run?.state)) data.state = frame.run.state;
          emit('ws', data);
        } catch { /* Unrelated/non-JSON frames never enter evidence. */ }
      });
    }
  };
  page.on('websocket', ws);
  emit('phase', { phase: 'started' });
  return {
    bind(id: string, expected: string) { session = id; desired = expected; },
    phase(phase: string) { emit('phase', { phase }); },
    snapshot(run: string, state: string, pending: boolean, rows: Array<{ content: string }>) {
      emit('snapshot', { run: link(run), session: link(session), state, pending, count: rows.length,
        matches: rows.some(r => r.content === desired), length: rows.reduce((n, r) => n + r.content.length, 0) });
    },
    fail() { failed = true; dropped++; },
    testFailed() { businessFailed = true; },
    async finish() {
      page.off('response', response); page.off('websocket', ws);
      await Promise.allSettled([...tasks]);
      if (failed) emit('collection', { failed: true, count: dropped });
      emit('result', { status: businessFailed ? 'failed' : testInfo.status ?? 'interrupted' });
    },
  };
}
