import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prepareSystemFailure, type SystemFailure } from './system-event-bridge.js';
import { SystemFailurePublisher, installSystemFailurePublisher } from '../platform/system-failure-publisher.js';
import { installPlatformObservation } from '../platform/platform-observation-service.js';
import { WorkerRuntime } from '../workflows/worker-runtime.js';
import { recordRuntimeEvent } from '../platform/runtime-events.js';
import { StructuredLogEvidenceAdapter } from '../platform/structured-log-evidence-adapter.js';

const failure = (): SystemFailure => ({ component: 'api', sourceEventId: randomUUID(), correlationId: randomUUID(),
  occurredAt: new Date().toISOString(), stableErrorCode: 'HTTP_500', callsite: 'api:GET:/failure', origin: 'user_operation', httpStatus: 500 });
describe('System producer boundaries', () => {
  it('forces every Agent and investigation/System delivery failure to engine origin', () => {
    expect(prepareSystemFailure({ ...failure(), component: 'agent' }).event.origin).toBe('investigation_engine');
    for (const jobType of ['investigation.execute', 'system.event.ingest']) {
      expect(prepareSystemFailure({ ...failure(), component: 'queue', origin: 'workflow', facts: { jobType } }).event.origin).toBe('investigation_engine');
    }
  });
  it('rejects request/job/model payloads and malformed versions before persistence', () => {
    expect(() => prepareSystemFailure({ ...failure(), facts: { payload: { token: 'private' } } } as any)).toThrow('EVENT_INPUT_INVALID');
    expect(() => prepareSystemFailure({ ...failure(), commitSha: 'main' })).toThrow('EVENT_INPUT_INVALID');
    expect(() => prepareSystemFailure({ ...failure(), httpStatus: 999 })).toThrow('EVENT_INPUT_INVALID');
    expect(() => prepareSystemFailure({ ...failure(), occurredAt: 'unknown' })).toThrow('EVENT_INPUT_INVALID');
  });
  it('bounds pending SQL, freezes the input and counts failed/overflow writes without recursive publication', async () => {
    let complete!: () => void;
    const record = vi.fn((_f: SystemFailure) => new Promise<void>(resolve => { complete = resolve; }));
    const publisher = new SystemFailurePublisher(record, 1);
    const original = failure(); publisher.publish(original); original.stableErrorCode = 'MUTATED';
    publisher.publish(failure()); await Promise.resolve();
    expect(record.mock.calls[0][0].stableErrorCode).toBe('HTTP_500');
    expect(publisher.observation()).toMatchObject({ pending: 1, lostEvents: 1, acceptedEvents: 0 });
    complete(); await publisher.drain();
    expect(publisher.observation()).toMatchObject({ pending: 0, lostEvents: 1, acceptedEvents: 1 });
    const failed = new SystemFailurePublisher(async () => { throw new Error('db credential'); });
    failed.publish(failure()); await failed.drain();
    expect(failed.observation()).toMatchObject({ lostEvents: 1, quality: 'degraded', gaps: ['SYSTEM_EVENT_WRITE_LOST'] });
    expect(JSON.stringify(failed.observation())).not.toContain('credential');
  });
  it('5xx response completes while SQL is pending; 400/403 do not publish, request bodies never persist', async () => {
    const facts: SystemFailure[] = []; let complete!: () => void;
    const publisher = new SystemFailurePublisher(async f => { facts.push(f); await new Promise<void>(resolve => { complete = resolve; }); });
    const uninstall = installSystemFailurePublisher(publisher), app = Fastify();
    try {
      await installPlatformObservation(app, async () => {}, new StructuredLogEvidenceAdapter());
      app.post('/failure', async (_r, reply) => reply.code(503).send({ token: 'private' }));
      app.get('/bad', async (_r, reply) => reply.code(400).send({}));
      app.get('/denied', async (_r, reply) => reply.code(403).send({}));
      const response = await app.inject({ method: 'POST', url: '/failure?token=private', payload: { secret: 'private' } });
      expect(response.statusCode).toBe(503); expect(publisher.observation().pending).toBe(1);
      await app.inject('/bad'); await app.inject('/denied');
      expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ httpStatus: 503, callsite: 'api:POST:/failure' });
      expect(JSON.stringify(facts)).not.toContain('private');
    } finally { complete?.(); await publisher.drain(); uninstall(); await app.close(); }
  });
  it('persists investigation worker failures only after fenced fail and never includes handler text/payload', async () => {
    const record = vi.fn(async () => {}), publisher = new SystemFailurePublisher(record), uninstall = installSystemFailurePublisher(publisher);
    const job = { id: randomUUID(), type: 'investigation.execute', payload: { token: 'private' }, attempts: 1, maxAttempts: 1, fencingToken: 4 };
    const store = { claim: vi.fn(async () => job), complete: vi.fn(async () => true), fail: vi.fn(async () => true), heartbeat: vi.fn(async () => true) };
    try {
      expect(await new WorkerRuntime(store, randomUUID()).runOnce(async () => { throw new Error('private'); })).toBe('dead_letter');
      await publisher.drain();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ origin: 'investigation_engine', facts: { jobId: job.id, jobType: job.type,
        attempt: 1, fencingToken: 4, outcome: 'dead_letter' } }));
      expect(JSON.stringify(record.mock.calls)).not.toContain('private');
      store.fail.mockResolvedValue(false);
      await new WorkerRuntime(store, randomUUID()).runOnce(async () => { throw new Error('private'); });
      await publisher.drain(); expect(record).toHaveBeenCalledTimes(1);
      store.fail.mockResolvedValue(true); job.type = 'system.event.ingest';
      await new WorkerRuntime(store, randomUUID()).runOnce(async () => { throw new Error('intake-down'); });
      await publisher.drain(); expect(record).toHaveBeenCalledTimes(1);
    } finally { uninstall(); }
  });
  it('candidate rejection is engine-only; unknown terminal cannot invent a failure', async () => {
    const record = vi.fn(async () => {}), publisher = new SystemFailurePublisher(record), uninstall = installSystemFailurePublisher(publisher);
    try {
      recordRuntimeEvent({ type: 'candidate.reject', runId: randomUUID(), turnId: randomUUID(), sequence: 2, content: 'private' } as any);
      recordRuntimeEvent({ type: 'turn.terminal', runId: randomUUID(), turnId: randomUUID(), sequence: 3 } as any);
      await publisher.drain(); expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ component: 'agent', origin: 'investigation_engine' }));
      expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    } finally { uninstall(); }
  });
});
