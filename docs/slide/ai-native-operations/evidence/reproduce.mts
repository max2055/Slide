// R00 bounded probes: no network, provider, database connection or durable writes.
// Run from repository root: pnpm --filter slide-api exec tsx ../../docs/slide/ai-native-operations/evidence/reproduce.mts
import assert from 'node:assert/strict';
import { OutboxService } from '../../../../apps/db-ops-api/src/workflows/outbox-service.js';
import { getAccessibleInstanceIds, hasInstanceAccess, requireInstanceAccess } from '../../../../apps/db-ops-api/src/auth/require-instance-access.js';
import { AgentRunService } from '../../../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { DisplayStreamAuthority } from '../../../../apps/db-ops-api/src/adapter/display-stream.js';
import { createMessageProjection, reduceMessageProjection, type ProjectionFrame } from '../../../../packages/agent-core/src/message-projection.js';

const findings: Record<string, unknown>[] = [];
let releases = 0;
const connection = {
  async beginTransaction() { throw new Error('FIXTURE_BEGIN_FAILED'); },
  async commit() {}, async rollback() {}, release() { releases++; }, async execute() {},
};
await assert.rejects(new OutboxService({ async getConnection() { return connection; } }).transaction(async () => {}), /FIXTURE_BEGIN_FAILED/);
assert.equal(releases, 0);
findings.push({ id: 'FINAL-0026', beginRejected: true, releases });

let storedId: unknown;
const outbox = new OutboxService({ async getConnection() { return connection; } });
const execute = async (_sql: string, values?: unknown[]) => { storedId ??= values?.[0]; };
const input = { eventType: 'fixture.event', schemaVersion: 1, aggregateType: 'fixture', aggregateId: '1', aggregateVersion: 1, payload: {}, idempotencyKey: 'same' };
const first = await outbox.append({ execute }, input);
const second = await outbox.append({ execute }, input);
assert.equal(first, storedId); assert.notEqual(second, storedId);
findings.push({ id: 'FINAL-0300', duplicateReturnedStoredId: second === storedId, boundary: 'executor models ON DUPLICATE KEY UPDATE id=id; no real MySQL used' });

const actor = { permissions: [], roles: [], instanceScopes: { 1: 'read-only' as const, 2: 'read-only' as const }, resourceBoundary: { instanceIds: [1] } };
assert.deepEqual(getAccessibleInstanceIds(actor), [1, 2]);
assert.equal(hasInstanceAccess(actor, 2), false);
let status = 200;
const reply = { code(n: number) { status = n; return this; }, send() { return this; } };
await requireInstanceAccess()({ user: actor, params: { id: 2 } }, reply);
assert.equal(status, 200);
findings.push({ ids: ['FINAL-0126', 'FINAL-0127'], helperAllowsOutsideBoundary: false, listedIds: [1, 2], middlewareStatus: status, boundary: 'constructed bounded actor; production browser actor does not carry a persisted resourceBoundary' });

let updateValues: unknown[] | undefined;
const runs = new AgentRunService(() => ({ async query<T>(_sql: string, values?: unknown[]) { updateValues = values; return [{ affectedRows: 1 } as T, undefined]; } }));
await runs.finish('fixture', 'failed', false, 0);
assert.deepEqual(updateValues?.slice(1, 3), [null, null]);
findings.push({ id: 'FINAL-2384', resultFalsePersistedAs: updateValues?.[1], errorZeroPersistedAs: updateValues?.[2] });

const hub = new DisplayStreamAuthority();
let projection = createMessageProjection('fixture-run');
const events: unknown[] = [];
try {
  hub.start('fixture-session', 'fixture-run', 'fixture-turn', () => projection);
  hub.watch({}, 'fixture-session', 'fixture-sub', event => { events.push(structuredClone(event)); return true; });
  const start: ProjectionFrame = { version: 1, runId: 'fixture-run', attempt: 1, sequence: 1, operations: [{ type: 'part.start', messageId: 'message', part: { id: 'part', type: 'text', text: 'first', source: 'fact', status: 'partial' } }] };
  projection = reduceMessageProjection(projection, start); hub.publish('fixture-session', start);
  const end: ProjectionFrame = { ...start, sequence: 2, operations: [{ type: 'part.end', partId: 'part', status: 'completed' }] };
  projection = reduceMessageProjection(projection, end); hub.publish('fixture-session', end);
  const rejected: ProjectionFrame = { ...start, sequence: 3, operations: [{ type: 'part.append', partId: 'part', text: 'late' }] };
  const unchanged = reduceMessageProjection(projection, rejected);
  assert.deepEqual(unchanged.parts, projection.parts);
  assert.equal(unchanged.sequence, 3);
  const before = events.length;
  hub.publish('fixture-session', rejected);
  // The display authority batches text; wait one bounded window for its flush.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(events.length > before);
  findings.push({ id: 'FINAL-0084', lateAppendIgnored: true, sequenceAdvanced: true, lateFrameEmitted: true, boundary: 'candidate claim of unchanged state reference is false for this case; client divergence still needs end-to-end evidence' });
} finally { hub.dispose(); }
console.log(JSON.stringify({ schemaVersion: 1, findings }, null, 2));
