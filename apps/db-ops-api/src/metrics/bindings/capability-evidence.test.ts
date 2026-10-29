/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R2 — bootstrap capability evidence.
 *
 * These tests bind the reuse boundaries: the same probed intent is one row, and
 * evidence can never answer for another resource, credential, pin, revision,
 * draft or a closed validity window. A store that cannot be read or parsed is a
 * refusal, never an implicit "nothing was probed". The writer's authorization
 * boundaries are real calls, not decoration.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import {
  CAPABILITY_EVIDENCE_UPSERT_SQL, CAPABILITY_EVIDENCE_FORMAT, CAPABILITY_EVIDENCE_TTL_MS,
  CapabilityEvidenceError, capabilityEvidenceKey, parseCapabilityEvidence, probeIntentDigest,
  readCapabilityEvidence, writeCapabilityEvidence, type CapabilityEvidenceIdentity,
} from './capability-evidence.js';
import type { Capability } from '../../contracts/metrics/index.js';
import type { ResourceBindingCandidate } from '../../contracts/metrics/templates.js';

const AT = '2026-10-30T02:00:00.000Z';
const NOW = Date.parse(AT);
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const pin = (version = 2, character = 'b') => ({
  template_id: 'tpl-max238', version, content_hash: hash(character),
});
const candidate = (overrides: Record<string, unknown> = {}): ResourceBindingCandidate => ({
  resource: { type: 'instance', id: 11 }, package: null, group_id: null,
  overrides: {}, revision: 0, template_pins: [pin()], ...overrides,
} as ResourceBindingCandidate);
const identity = (overrides: Partial<CapabilityEvidenceIdentity> = {}): CapabilityEvidenceIdentity => ({
  resource: { type: 'instance', id: 11 }, revision: 0, template_pins: [pin()],
  credential_ref: 'credential:asset-instance-11',
  target_identity: hash('e'), actor_id: 7,
  intent_digest: probeIntentDigest(candidate()), ...overrides,
});
const capability = (overrides: Partial<Capability> = {}): Capability => ({
  resource_id: '11', metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' },
  status: 'supported', method: 'sql',
  basis: [{ kind: 'method', evidence: 'fixed_read_succeeded' }],
  evaluated_at: AT, valid_until: '2026-10-30T02:15:00.000Z', ...overrides,
});
const record = (id: CapabilityEvidenceIdentity, overrides: Record<string, unknown> = {}) => ({
  format: CAPABILITY_EVIDENCE_FORMAT, evidence_key: capabilityEvidenceKey(id),
  ...id, capabilities: [capability()], source: 'read_only_probe',
  probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(), ...overrides,
});

/** One exact row map plus a connection that records the statements it saw. */
function fakePool(initial: Record<string, unknown> = {},
  options: { queryFails?: boolean; existingWins?: boolean; commitFails?: boolean } = {}) {
  const rows = new Map<string, unknown>(Object.entries(initial));
  const statements: string[] = [];
  let committed = 0;
  const connection = {
    async beginTransaction() { statements.push('BEGIN'); },
    async commit() {
      statements.push('COMMIT');
      if (options.commitFails) throw new Error('connection reset during commit');
      committed++;
    },
    async rollback() { statements.push('ROLLBACK'); },
    async release() { statements.push('RELEASE'); },
    async destroy() { statements.push('DESTROY'); },
    async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      const key = sql.replace(/\s+/g, ' ').trim();
      statements.push(key);
      if (/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/i.test(key)) return [{}, []];
      if (/^SELECT payload FROM metric_capability_evidence/.test(key)) {
        if (options.queryFails) throw new Error('driver detail');
        return [rows.has(String(params[0])) ? [{ payload: JSON.stringify(rows.get(String(params[0]))) }] : [], []];
      }
      if (/^INSERT INTO metric_capability_evidence/.test(key)) {
        const existed = rows.has(String(params[0]));
        // A real concurrent upsert may lose to the other writer's row.
        if (!(options.existingWins && existed)) rows.set(String(params[0]), JSON.parse(String(params[1])) as unknown);
        return [{ affectedRows: existed ? 2 : 1 }, []];
      }
      throw new Error(`unexpected statement: ${key}`);
    },
  };
  const pool = { getConnection: async () => connection };
  return { pool: pool as unknown as Pool, rows, statements, committed: () => committed };
}

describe('capability evidence identity', () => {
  it('keys differ for another resource, credential, pin content, revision or draft intent', () => {
    const base = capabilityEvidenceKey(identity());
    expect(capabilityEvidenceKey(identity({ resource: { type: 'instance', id: 12 } }))).not.toBe(base);
    expect(capabilityEvidenceKey(identity({ credential_ref: 'credential:asset-instance-12' }))).not.toBe(base);
    // The same resource with a rewritten target or a rotated credential version.
    expect(capabilityEvidenceKey(identity({ target_identity: hash('f') }))).not.toBe(base);
    // The same resource probed by another principal.
    expect(capabilityEvidenceKey(identity({ actor_id: 8 }))).not.toBe(base);
    expect(capabilityEvidenceKey(identity({ template_pins: [pin(2, 'c')] }))).not.toBe(base);
    expect(capabilityEvidenceKey(identity({ template_pins: [pin(3, 'b')] }))).not.toBe(base);
    expect(capabilityEvidenceKey(identity({ revision: 1 }))).not.toBe(base);
    expect(capabilityEvidenceKey(identity({
      intent_digest: probeIntentDigest(candidate({ overrides: { interval_ms: { mode: 'set', value: 30000 } } })),
    }))).not.toBe(base);
  });

  it('pin order is not identity', () => {
    const left = pin(2, 'b'), right = { template_id: 'tpl-other', version: 1, content_hash: hash('d') };
    expect(capabilityEvidenceKey(identity({ template_pins: [left, right] })))
      .toBe(capabilityEvidenceKey(identity({ template_pins: [right, left] })));
  });

  it('the intent digest covers every candidate field', () => {
    const base = probeIntentDigest(candidate());
    expect(probeIntentDigest(candidate({ group_id: 'prod' }))).not.toBe(base);
    expect(probeIntentDigest(candidate({ overrides: { enabled: { mode: 'set', value: false } } }))).not.toBe(base);
    expect(probeIntentDigest(candidate({ revision: 3 }))).not.toBe(base);
    expect(probeIntentDigest(candidate({ template_pins: [pin(3, 'b')] }))).not.toBe(base);
  });
});

describe('stored evidence parsing', () => {
  it('accepts the exact identity inside its window', () => {
    const id = identity();
    expect(parseCapabilityEvidence(record(id), id, NOW).capabilities).toHaveLength(1);
  });
  it('rejects a row stored under another key', () => {
    const id = identity();
    expect(() => parseCapabilityEvidence(record(id, { evidence_key: hash('f') }), id, NOW))
      .toThrow(CapabilityEvidenceError);
  });
  it('rejects identity drift even with a valid key envelope', () => {
    const id = identity();
    expect(() => parseCapabilityEvidence(record(id), identity({ revision: 1 }), NOW))
      .toThrow(CapabilityEvidenceError);
    expect(() => parseCapabilityEvidence(record(id), identity({ template_pins: [pin(3)] }), NOW))
      .toThrow(CapabilityEvidenceError);
    // A rewritten target/credential version or another principal is not the
    // identity that wrote the row, even under the same resource and pins.
    expect(() => parseCapabilityEvidence(record(id), identity({ target_identity: hash('f') }), NOW))
      .toThrow(CapabilityEvidenceError);
    expect(() => parseCapabilityEvidence(record(id), identity({ actor_id: 8 }), NOW))
      .toThrow(CapabilityEvidenceError);
  });
  it('rejects expired, unparsable and foreign-resource facts', () => {
    const id = identity();
    const expired = record(id, { expires_at: AT });
    expect(() => parseCapabilityEvidence(expired, id, NOW)).toThrow('CAPABILITY_EVIDENCE_EXPIRED');
    expect(() => parseCapabilityEvidence('{not json', id, NOW)).toThrow('CAPABILITY_EVIDENCE_INVALID');
    expect(() => parseCapabilityEvidence(record(id, { capabilities: [capability({ resource_id: '99' })] }), id, NOW))
      .toThrow('CAPABILITY_EVIDENCE_INVALID');
    expect(() => parseCapabilityEvidence(record(id, { source: 'client' }), id, NOW))
      .toThrow('CAPABILITY_EVIDENCE_INVALID');
  });
  it('an unreadable query is a store refusal, never "absent"', async () => {
    const { pool } = fakePool({}, { queryFails: true });
    const connection = await pool.getConnection();
    await expect(readCapabilityEvidence(connection, identity(), NOW)).rejects.toMatchObject({
      code: 'CAPABILITY_EVIDENCE_UNAVAILABLE',
    });
  });
  it('a missing row is the only absent answer', async () => {
    const { pool } = fakePool();
    const connection = await pool.getConnection();
    await expect(readCapabilityEvidence(connection, identity(), NOW)).resolves.toBeNull();
  });
});

describe('evidence writer', () => {
  it('writes one row through the upsert after a live grant on the held connection', async () => {
    const { pool, rows, committed } = fakePool();
    const authorize = vi.fn(async () => undefined);
    const written = await writeCapabilityEvidence({
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => pool, authorize });
    expect(written.record.capabilities).toHaveLength(1);
    expect(rows.size).toBe(1);
    expect(committed()).toBe(1);
    // After the admission wait, after the connection/transaction began, after
    // the upsert's row-lock wait, and once more after the read-back wait
    // immediately before the commit that publishes the evidence.
    expect(authorize).toHaveBeenCalledTimes(4);
  });

  it('a grant revoked after the read-back rolls the row back instead of committing it', async () => {
    const { pool, committed, statements } = fakePool();
    const authorize = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked-after-read'));
    await expect(writeCapabilityEvidence({
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => pool, authorize })).rejects.toThrow('revoked-after-read');
    // The row was written inside the transaction and the refusal rolled it back:
    // the read-back wait is no longer an unprotected path to a published fact.
    // (The fake applies writes eagerly, so the assertions are the absence of a
    // commit plus the ROLLBACK; the real MySQL chain proves the row itself.)
    expect(committed()).toBe(0);
    expect(statements).toContain('ROLLBACK');
  });

  it('an ambiguous commit is reported as unknown, never as written', async () => {
    const { pool, statements } = fakePool({}, { commitFails: true });
    await expect(writeCapabilityEvidence({
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => pool })).rejects.toMatchObject({ code: 'CAPABILITY_EVIDENCE_COMMIT_UNKNOWN' });
    expect(statements).toContain('ROLLBACK');
    expect(statements).toContain('COMMIT');
  });

  it('an identical repeat is the same row, not a second publication', async () => {
    const { pool, rows, statements } = fakePool();
    const input = {
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    };
    await writeCapabilityEvidence(input, { pool: () => pool });
    await writeCapabilityEvidence(input, { pool: () => pool });
    expect(rows.size).toBe(1);
    expect(statements.filter(statement => statement === CAPABILITY_EVIDENCE_UPSERT_SQL)).toHaveLength(2);
  });

  it('a revoked grant after the upsert rolls it back and stores nothing', async () => {
    const { pool, rows, committed } = fakePool();
    const authorize = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(writeCapabilityEvidence({
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => pool, authorize })).rejects.toThrow('revoked');
    expect(committed()).toBe(0);
    expect(rows.size).toBe(0);
  });

  it('an unavailable pool fails closed before any connection', async () => {
    await expect(writeCapabilityEvidence({
      ...identity(), capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => null })).rejects.toMatchObject({ code: 'CAPABILITY_EVIDENCE_UNAVAILABLE' });
  });

  it('reads back the row another probe won instead of pretending it wrote its own', async () => {
    const id = identity();
    const other = record(id, {
      capabilities: [capability({ basis: [{ kind: 'method', evidence: 'other_probe' }] })],
    });
    const { pool } = fakePool({ [capabilityEvidenceKey(id)]: other }, { existingWins: true });
    const written = await writeCapabilityEvidence({
      ...id, capabilities: [capability()],
      probed_at: AT, expires_at: new Date(NOW + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
    }, { pool: () => pool });
    expect(written.record.capabilities[0].basis[0].evidence).toBe('other_probe');
  });
});
