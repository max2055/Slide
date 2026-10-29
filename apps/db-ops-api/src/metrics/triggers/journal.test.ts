import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateVersion } from '../../contracts/metrics/templates.js';
import type { TriggerResourceSnapshot, TriggerRuleVersion } from '../../contracts/metrics/triggers.js';
import { NOW, baseline, near, parameterSpec, portOf, thresholdRule } from './test-support.js';
import { resolveTriggerRules } from './resolve.js';
import { compileTriggerSnapshot } from './compile.js';
import { evaluateTriggerRule, type TriggerEvaluationInput, type TriggerEvaluationResult } from './evaluate.js';
import type { TriggerEpisodeIdentity } from './episode.js';
import { TriggerEpisodeCatalog } from './catalog.js';
import {
  TRIGGER_EPISODE_JOURNAL_FILE, TriggerEpisodeJournal, TriggerEpisodeJournalError,
} from './journal.js';

const KEY = { rule_id: 'alpha-threshold', scope: 'item:alpha' };
const TRIGGERS: TemplateVersion['aggregate']['triggers'] = [{ ...KEY, version: 1 }];

const evidenceFor = (snapshot: TriggerResourceSnapshot, overrides: Record<string, unknown> = {}) => ({
  resource: { type: snapshot.resource.type, id: Number(snapshot.resource.id) },
  applied_revision: snapshot.config_revision,
  plan_identity: snapshot.plan_identity,
  application_status: 'applied',
  ...overrides,
});

async function snapshotOf(options: { rules?: TriggerRuleVersion[] } = {}): Promise<TriggerResourceSnapshot> {
  const base = await baseline({ ...options, triggers: TRIGGERS });
  const candidate = await resolveTriggerRules(base.resolution, base.catalog, portOf([base.version]).port);
  return compileTriggerSnapshot(candidate);
}

function evaluate(
  snapshot: TriggerResourceSnapshot,
  request: Partial<TriggerEvaluationInput> = {},
): TriggerEvaluationResult {
  return evaluateTriggerRule(snapshot, KEY, {
    input: { now: NOW, last_seen_at: '2026-10-29T11:59:55.000Z', previous: null, samples: [near(95)], ...request },
    applied: evidenceFor(snapshot),
  });
}

function identityOf(snapshot: TriggerResourceSnapshot): TriggerEpisodeIdentity {
  const rule = snapshot.rules.find(entry => entry.rule_id === KEY.rule_id && entry.scope === KEY.scope)!;
  return {
    resource: snapshot.resource, rule_id: rule.rule_id, version: rule.version,
    body_hash: rule.body_hash, scope: rule.scope,
  };
}

async function ninetyFiveSnapshot(): Promise<TriggerResourceSnapshot> {
  return snapshotOf({
    rules: [thresholdRule({
      parameters: parameterSpec(
        {
          problem_threshold: { type: 'number' as const, min: 0, max: 1000 },
          recovery_threshold: { type: 'number' as const, min: 0, max: 1000 },
        },
        { problem_threshold: 95, recovery_threshold: 70 },
      ),
    })],
  });
}

// Every test gets a fresh temporary directory and gives it back afterwards; no
// journal file is ever left in the repository.
const directories: string[] = [];

async function exclusiveDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'max239-episode-journal-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const journalOf = (directory: string) => new TriggerEpisodeCatalog(new TriggerEpisodeJournal(directory));
const textOf = (directory: string) => readFile(join(directory, TRIGGER_EPISODE_JOURNAL_FILE), 'utf8');

async function expectJournalError(
  run: () => unknown,
  code: string,
): Promise<void> {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TriggerEpisodeJournalError);
  expect((thrown as TriggerEpisodeJournalError).code).toBe(code);
}

describe('file episode journal', () => {
  it('reads a closed record back into a new catalog instance and continues from it', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();

    const writer = journalOf(directory);
    const opened = writer.apply(identity, evaluate(snapshot))!;
    expect(opened).toMatchObject({ state: 'open', occurrence: 0, recovery_count: 0 });
    const closed = writer.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(60)] }))!;
    expect(closed).toMatchObject({ state: 'closed', closed_at: NOW, recovery_count: 1 });

    // A new catalog instance over the same directory reads the closed record back
    // unchanged: same episode id, same occurrence, one recovery.
    const reader = journalOf(directory);
    const readBack = reader.get(identity)!;
    expect(readBack).toEqual(closed);
    expect(readBack).toMatchObject({ episode_id: closed.episode_id, state: 'closed', occurrence: 0, recovery_count: 1 });
    expect(reader.size).toBe(1);

    // Replaying the recovery over the read-back record opens nothing and closes
    // no second time, and leaves the journal file as it was.
    const before = await textOf(directory);
    expect(reader.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(60)] }))).toEqual(readBack);
    expect(await textOf(directory)).toBe(before);

    // The next definite problem is occurrence 1 under a new id, and that is the
    // record the following instance reads back.
    const reopened = reader.apply(identity, evaluate(snapshot))!;
    expect(reopened.episode_id).not.toBe(closed.episode_id);
    expect(reopened).toMatchObject({ state: 'open', occurrence: 1, closed_at: null, recovery_count: 0 });
    expect(journalOf(directory).get(identity)).toEqual(reopened);
  });

  it('treats a missing file as an empty journal — the counterexample, not a restart pass', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);
    expect(existsSync(path)).toBe(false);

    const catalog = journalOf(directory);
    expect(catalog.get(identity)).toBeNull();
    expect(catalog.size).toBe(0);

    // No previous record is readable, so the problem starts at occurrence 0 —
    // exactly what an in-memory catalog does after a process restart. This is a
    // counterexample, not evidence that a restart resumes the episode.
    expect(catalog.apply(identity, evaluate(snapshot))).toMatchObject({ state: 'open', occurrence: 0 });
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a corrupt journal instead of treating it as empty', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);

    for (const [name, text] of [
      ['not JSON', '{ not a journal'],
      ['empty file', ''],
      ['wrong envelope', '{"format":"something-else","version":1,"records":{}}'],
      ['wrong version', '{"format":"slide.trigger-episode-journal","version":2,"records":{}}'],
    ] as const) {
      await writeFile(path, text, 'utf8');
      await expectJournalError(() => journalOf(directory).get(identity), 'TRIGGER_EPISODE_JOURNAL_UNREADABLE');
      await expectJournalError(
        () => journalOf(directory).apply(identity, evaluate(snapshot)),
        'TRIGGER_EPISODE_JOURNAL_UNREADABLE',
      );
      // The refused read never started an occurrence 0 episode, and the damaged
      // file was not overwritten with a fresh one.
      expect(await textOf(directory), name).toBe(text);
    }
  });

  it('refuses a truncated journal instead of treating it as empty', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);

    journalOf(directory).apply(identity, evaluate(snapshot));
    const complete = await textOf(directory);
    const truncated = complete.slice(0, Math.floor(complete.length / 2));
    await writeFile(path, truncated, 'utf8');

    await expectJournalError(() => journalOf(directory).get(identity), 'TRIGGER_EPISODE_JOURNAL_UNREADABLE');
    await expectJournalError(
      () => journalOf(directory).apply(identity, evaluate(snapshot)),
      'TRIGGER_EPISODE_JOURNAL_UNREADABLE',
    );
    expect(await textOf(directory)).toBe(truncated);
  });

  it('refuses a record filed under an identity hash it does not belong to', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);

    journalOf(directory).apply(identity, evaluate(snapshot));
    const file = JSON.parse(await textOf(directory));
    const [stored] = Object.values(file.records) as Array<Record<string, unknown>>;
    file.records = { [`sha256:${'f'.repeat(64)}`]: stored };
    await writeFile(path, JSON.stringify(file), 'utf8');

    await expectJournalError(() => journalOf(directory).get(identity), 'TRIGGER_EPISODE_JOURNAL_IDENTITY');
    await expectJournalError(
      () => journalOf(directory).apply(identity, evaluate(snapshot)),
      'TRIGGER_EPISODE_JOURNAL_IDENTITY',
    );
  });

  it('refuses a record carrying a field the episode record does not have', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);

    journalOf(directory).apply(identity, evaluate(snapshot));
    const file = JSON.parse(await textOf(directory));
    for (const stored of Object.values(file.records) as Array<Record<string, unknown>>) {
      stored.acknowledged_by = 42;
    }
    await writeFile(path, JSON.stringify(file), 'utf8');

    await expectJournalError(() => journalOf(directory).get(identity), 'TRIGGER_EPISODE_JOURNAL_RECORD');
    await expectJournalError(
      () => journalOf(directory).apply(identity, evaluate(snapshot)),
      'TRIGGER_EPISODE_JOURNAL_RECORD',
    );
  });

  it('keeps the 90 and 95 bodies apart — neither reads nor closes the other record', async () => {
    const ninety = await snapshotOf();
    const ninetyFive = await ninetyFiveSnapshot();
    const identity90 = identityOf(ninety);
    const identity95 = identityOf(ninetyFive);
    expect(identity90.body_hash).not.toBe(identity95.body_hash);

    const directory = await exclusiveDirectory();
    const catalog = journalOf(directory);
    const opened90 = catalog.apply(identity90, evaluate(ninety))!;
    const opened95 = catalog.apply(identity95, evaluate(ninetyFive, { samples: [near(99)] }))!;
    expect(opened95.identity_hash).not.toBe(opened90.identity_hash);
    expect(opened95).toMatchObject({ state: 'open', occurrence: 0, recovery_count: 0 });

    // Both records are read back from the file, under their own identity.
    const reader = journalOf(directory);
    expect(reader.get(identity90)).toEqual(opened90);
    expect(reader.get(identity95)).toEqual(opened95);
    expect(reader.size).toBe(2);
    expect(reader.get({ ...identity90, scope: 'item:beta' })).toBeNull();
    expect(reader.get({ ...identity90, resource: { type: 'instance', id: '8' } })).toBeNull();

    // Recovering the 95 identity closes only that record; the 90 record stays
    // open and is not rewritten.
    reader.apply(identity95, evaluate(ninetyFive, { previous: 'problem', samples: [near(60)] }));
    const after = journalOf(directory);
    expect(after.get(identity95)).toMatchObject({ state: 'closed', recovery_count: 1 });
    expect(after.get(identity90)).toEqual(opened90);
    expect(after.size).toBe(2);
  });

  it('writes nothing when the pure transition records nothing', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const path = join(directory, TRIGGER_EPISODE_JOURNAL_FILE);
    const catalog = journalOf(directory);

    // A recovery with no open episode and an explicit nodata both record nothing,
    // so no journal file appears at all.
    expect(catalog.apply(identity, evaluate(snapshot, { samples: [near(60)] }))).toBeNull();
    expect(catalog.apply(identity, evaluate(snapshot, { samples: [], last_seen_at: null }))).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(catalog.size).toBe(0);
  });

  it('leaves exactly one journal file in the exclusive directory', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const catalog = journalOf(directory);

    catalog.apply(identity, evaluate(snapshot));
    catalog.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(85)] }));
    catalog.apply(identity, evaluate(snapshot, { previous: 'problem', samples: [near(60)] }));
    catalog.apply(identity, evaluate(snapshot));

    expect(await readdir(directory)).toEqual([TRIGGER_EPISODE_JOURNAL_FILE]);
  });

  it('does not read a missing directory as an empty journal', async () => {
    const snapshot = await snapshotOf();
    const identity = identityOf(snapshot);
    const directory = await exclusiveDirectory();
    const missing = join(directory, 'not-created');

    // The caller owns the directory; a directory that does not exist is a caller
    // error, not "this identity has no episode".
    expect(() => journalOf(missing).get(identity)).toThrow(/ENOENT/);
    expect(() => journalOf(missing).apply(identity, evaluate(snapshot))).toThrow(/ENOENT/);
  });
});
