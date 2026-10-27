/**
 * MAX-237 / T2B — exclusive drill test for the storage-compatibility candidate.
 *
 * Runs ONLY against the one disposable fixture created by `env-start.sh` and
 * refuses anything else (the migration program re-proves container hostname,
 * allowlisted user and the exact three schemas before every transfer). It
 * exercises, in order:
 *
 *   plan (fresh process, connections forbidden) → zero connection/zero write
 *   unknown handle / wrong schema allowlist → refused, zero writes
 *   up failure injection after parents / after version snapshot → target empty,
 *     source unchanged, re-read through two independent connections
 *   real up → manifest equality + adapter spot checks + fresh-connection re-read
 *   identical re-run → explicit no-op; drifted target → refused, no overwrite
 *   candidate rows that DDL 140 cannot represent → down refused, nothing changed
 *   safe down → restore manifest identical to the source aggregate
 *
 *   npx tsx docs/slide/development/MAX-237/t2b/drill.ts --out <evidence.json>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_SCHEMA, COPY_ORDER, DrillError, RESTORE_SCHEMA, SOURCE_SCHEMA, checkDownRepresentable,
  diffFrozenStructure, down, expectedFrom, loadConfig, openPool, readCredentials, readManifest,
  readSchemaStructure, rowCounts, seedSource, up, verifyLiveFixture,
  type ForeignKeyShape, type FrozenStructure,
} from './migrate.js';
import {
  MySqlTemplateRepository,
} from '../../../../../apps/db-ops-api/src/metrics/templates/mysql-repository.js';

const require = createRequire(new URL('../../../../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = fileURLToPath(new URL('../../../../../apps/db-ops-api/', import.meta.url));
const MIGRATE = join(HERE, 'migrate.ts');

type Step = { step: string; status: 'PASS' | 'FAIL'; detail: unknown };

const steps: Step[] = [];
function record(step: string, detail: unknown): void {
  steps.push({ step, status: 'PASS', detail });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function expectDrillError(reason: string, run: () => Promise<unknown>): Promise<DrillError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DrillError && error.reason === reason) return error;
    throw new Error(`expected DrillError ${reason}, got ${(error as Error)?.name}: ${(error as Error)?.message}`);
  }
  throw new Error(`expected DrillError ${reason}, but the call succeeded`);
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail, but it succeeded');
}

interface FaultCounter { releases: number; destroys: number }

interface FaultOptions {
  counter?: FaultCounter;
  begin?: 'throw';
  rollback?: 'throw';
  /** `before`: the COMMIT is never sent; `after`: the server committed, ack lost. */
  commit?: 'before' | 'after';
  destroy?: 'throw';
  /** Interrupts the first write whose SQL is matched, inside the transaction. */
  interrupt?: (sql: string) => boolean;
  /** Collects business DML statements issued on connection handles. */
  dml?: string[];
}

const newCounter = (): FaultCounter => ({ releases: 0, destroys: 0 });

/**
 * Labelled connection-fault wrapper. It observes release/destroy and injects
 * transaction faults only; it is never used as evidence of a real transaction
 * outcome on its own. Real outcomes are read back through an independent pool.
 */
function faultPool(
  real: import('mysql2/promise').Pool, options: FaultOptions,
): import('mysql2/promise').Pool {
  const counter = options.counter ?? newCounter();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'getConnection') {
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, {
            get(conn, key) {
              switch (key) {
                case 'beginTransaction':
                  return options.begin === 'throw'
                    ? async () => { throw new Error('fault: begin not forwarded'); }
                    : () => conn.beginTransaction();
                case 'rollback':
                  return options.rollback === 'throw'
                    ? async () => { throw new Error('fault: rollback not forwarded; live socket'); }
                    : () => conn.rollback();
                case 'commit':
                  if (options.commit === 'before') {
                    return async () => { throw new Error('fault: commit not forwarded; live socket'); };
                  }
                  if (options.commit === 'after') {
                    return async () => {
                      await conn.commit();
                      throw new Error('fault: commit acknowledgement lost');
                    };
                  }
                  return () => conn.commit();
                case 'release':
                  return () => { counter.releases += 1; conn.release(); };
                case 'destroy':
                  return () => {
                    counter.destroys += 1;
                    conn.destroy();
                    if (options.destroy === 'throw') throw new Error('fault: destroy reported failure');
                  };
                case 'query':
                  return async (sql: string, values?: unknown[]) => {
                    if (options.dml && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
                      options.dml.push(sql.replace(/\s+/g, ' ').slice(0, 160));
                    }
                    if (options.interrupt?.(sql)) {
                      throw new DrillError('injected-failure', 'injected failure inside the copy transaction');
                    }
                    return conn.query(sql, values);
                  };
                default: {
                  const value = Reflect.get(conn, key);
                  return typeof value === 'function' ? value.bind(conn) : value;
                }
              }
            },
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Starts and commits an unrelated transaction on the writer pool. */
async function unrelatedTransaction(writer: import('mysql2/promise').Pool): Promise<void> {
  const connection = await writer.getConnection();
  try {
    await connection.beginTransaction();
    await connection.commit();
  } finally {
    connection.release();
  }
}

/** FK-safe drill-owned reset of one schema (test setup, never rollback evidence). */
async function cleanSchema(pool: import('mysql2/promise').Pool, schema: string): Promise<void> {
  for (const table of [...COPY_ORDER].reverse()) {
    await pool.query(`DELETE FROM \`${schema}\`.\`${table}\``);
  }
}

function readRootPassword(cfg: ReturnType<typeof loadConfig>): string {
  const match = /^MYSQL_ROOT_PASSWORD=(.*)$/m.exec(readFileSync(cfg.credentialsPath, 'utf8'));
  if (!match) throw new Error('root password is missing from the private credentials file');
  return match[1]!.trim();
}

/** Root is used only for drift-variant DDL inside this run's own fixture. */
function mysqlRootDdl(
  cfg: ReturnType<typeof loadConfig>, rootPassword: string, sql: string,
): void {
  execFileSync('docker', [
    'exec', '-e', `MYSQL_PWD=${rootPassword}`, '-i', cfg.handle.container_id,
    'mysql', '-uroot', '-N', '-e', sql,
  ], { cwd: APP_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs the real CLI in a fresh process so "plan opens no connection" is meaningful. */
function runCliProcess(args: string[], env: NodeJS.ProcessEnv, expectFailure = false): unknown {
  try {
    const stdout = execFileSync('npx', ['--no-install', 'tsx', MIGRATE, ...args], {
      cwd: APP_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (expectFailure) throw new Error(`expected a non-zero exit for ${args.join(' ')}`);
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (!expectFailure) throw error;
    if (failure.status === 0) throw new Error(`expected a non-zero exit for ${args.join(' ')}`);
    return JSON.parse(failure.stderr ?? '{}') as unknown;
  }
}

const poolOptions = (credentials: { port: number; user: string; password: string; database: string }) => ({
  host: '127.0.0.1', port: credentials.port, user: credentials.user, password: credentials.password,
  database: credentials.database, waitForConnections: true, connectionLimit: 4,
  supportBigNumbers: true, bigNumberStrings: true,
});

async function tableCounts(pool: import('mysql2/promise').Pool, schema: string) {
  return rowCounts(pool, schema);
}

const emptyCounts = Object.fromEntries(COPY_ORDER.map(table => [table, 0]));

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex >= 0 ? process.argv[outIndex + 1]! : null;
  const scenarioIndex = process.argv.indexOf('--scenario');
  const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : null;
  if (scenario !== 'reject' && scenario !== 'safe') {
    throw new Error('usage: drill.ts --scenario reject|safe [--out <evidence.json>] '
      + '(reject and safe each require their own fresh fixture)');
  }
  const reject = scenario === 'reject';
  const cfg = loadConfig();
  const credentials = readCredentials(cfg);
  const env = { ...process.env, MAX237_T2B_STATE_DIR: cfg.stateDir };
  const startedAt = new Date().toISOString();
  const pool = openPool(cfg);
  let pool2: import('mysql2/promise').Pool | null = null;
  let adapterPool: import('mysql2/promise').Pool | null = null;
  let faultWriter: import('mysql2/promise').Pool | null = null;
  const evidence: Record<string, unknown> = {
    task: 'MAX237-T2B',
    scenario,
    generated_at: startedAt,
    fixture: {
      container_name: cfg.handle.container_name,
      container_id: cfg.handle.container_id,
      image_id: cfg.handle.image_id,
      volume: cfg.handle.volume,
      port: cfg.handle.port,
      schemas: cfg.handle.schemas,
      source_schema: SOURCE_SCHEMA,
      candidate_schema: CANDIDATE_SCHEMA,
      restore_schema: RESTORE_SCHEMA,
    },
    ddl: {
      original_140_sha256: sha256File(join(HERE, '../t2a/sql/140_metric_template_aggregate.sql')),
      candidate_sha256: sha256File(join(HERE, 'sql/t2b_metric_template_aggregate.sql')),
    },
  };

  try {
    // ---------------------------------------------------------- plan / guards
    const plan = runCliProcess(['plan'], { ...env, MAX237_T2B_FORBID_CONNECT: '1' });
    record('plan runs in a fresh process with connections forbidden', plan);

    const forbidden = runCliProcess(['execute', 'up'], { ...env, MAX237_T2B_FORBID_CONNECT: '1' }, true);
    record('execute refuses to connect while connections are forbidden', forbidden);

    const badDir = mkdtempSync(join(cfg.stateDir, 'bad-handle-'));
    try {
      const badHandle = {
        ...cfg.handle,
        schemas: [SOURCE_SCHEMA, CANDIDATE_SCHEMA],
        candidate_schema: 'max237_t2b_wrong',
      };
      writeFileSync(join(badDir, 'handle.json'), `${JSON.stringify(badHandle, null, 2)}\n`, { mode: 0o600 });
      const rejected = runCliProcess(['plan'], { ...process.env, MAX237_T2B_STATE_DIR: badDir }, true);
      record('unknown handle / wrong schema allowlist is refused with zero writes', rejected);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }

    await verifyLiveFixture(pool, cfg);
    pool2 = openPool(cfg);
    await verifyLiveFixture(pool2, cfg);
    const [identity] = await pool.query('SELECT @@version AS version, @@hostname AS hostname');
    evidence.server = (identity as { version: string; hostname: string }[])[0];
    record('live fixture proven on two independent connections', {
      version: (identity as { version: string }[])[0]!.version,
      schemas: cfg.handle.schemas,
    });

    const initial = {
      source: await tableCounts(pool, SOURCE_SCHEMA),
      candidate: await tableCounts(pool, CANDIDATE_SCHEMA),
      restore: await tableCounts(pool, RESTORE_SCHEMA),
    };
    if (JSON.stringify(initial) !== JSON.stringify({
      source: emptyCounts, candidate: emptyCounts, restore: emptyCounts,
    })) {
      throw new Derr('fixture is not empty; recreate it with env-start.sh before drilling', initial);
    }
    record('fixture starts empty in all three schemas', initial);

    const emptyManifests = {
      source: await readManifest(pool, SOURCE_SCHEMA, 'source'),
      candidate: await readManifest(pool, CANDIDATE_SCHEMA, 'candidate'),
      restore: await readManifest(pool, RESTORE_SCHEMA, 'restore'),
    };
    const assertEmptyManifestsUnchanged = async (label: string): Promise<void> => {
      const now = {
        source: await readManifest(pool2!, SOURCE_SCHEMA, 'source'),
        candidate: await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate'),
        restore: await readManifest(pool2!, RESTORE_SCHEMA, 'restore'),
      };
      for (const key of ['source', 'candidate', 'restore'] as const) {
        if (now[key].sha256 !== emptyManifests[key].sha256) {
          throw new Derr(`${label}: ${key} schema changed before the first business DML`, {
            before: emptyManifests[key].sha256, after: now[key].sha256,
          });
        }
      }
    };

    // ------------------------ frozen structure: pure diff branches (not real DDL)
    const candidateShape = await readSchemaStructure(pool, CANDIDATE_SCHEMA);
    const sourceShape = await readSchemaStructure(pool, SOURCE_SCHEMA);
    const restoreShape = await readSchemaStructure(pool, RESTORE_SCHEMA);
    if (diffFrozenStructure(sourceShape, sourceShape).length !== 0
      || diffFrozenStructure(candidateShape, candidateShape).length !== 0
      || diffFrozenStructure(restoreShape, restoreShape).length !== 0) {
      throw new Derr('identical structure snapshots were not treated as equal', {});
    }
    const mutations: [string, (shape: FrozenStructure) => void][] = [
      ['missing column', shape => { delete shape.metric_template_items.columns.created_at; }],
      ['extra column', shape => {
        shape.metric_template_items.columns.drift_extra = {
          type: 'int', nullable: 'YES', charset: null, collation: null,
        };
      }],
      ['narrowed type', shape => { shape.metric_templates_v2.columns.name!.type = 'varchar(32)'; }],
      ['nullability', shape => { shape.metric_templates_v2.columns.name!.nullable = 'YES'; }],
      ['charset/collation', shape => {
        shape.metric_template_items.columns.created_at!.charset = 'utf8mb4';
        shape.metric_template_items.columns.created_at!.collation = 'utf8mb4_bin';
      }],
      ['engine', shape => { shape.metric_template_items.engine = 'MyISAM'; }],
      ['primary key', shape => { shape.metric_template_items.indexes.PRIMARY!.columns.pop(); }],
      ['unique key', shape => { shape.metric_template_versions.indexes.uk_content!.unique = false; }],
      ['prefix index', shape => {
        shape.metric_template_item_versions.indexes.idx_canonical!.columns[0]!.subPart = 64;
      }],
    ];
    const caughtDrifts: string[] = [];
    for (const [label, mutate] of mutations) {
      const copy = structuredClone(candidateShape);
      mutate(copy);
      const diffs = diffFrozenStructure(copy, candidateShape);
      if (diffs.length === 0) throw new Derr(`frozen-structure diff missed ${label}`, copy);
      caughtDrifts.push(`${label}: ${diffs[0]}`);
    }
    // Foreign-key matrix (synthetic): every frozen FK in each of the three
    // schemas, including the cross-schema same-named table and both rule sides.
    const foreignKeyMutations: [string, (fk: ForeignKeyShape) => void][] = [
      ['cross-schema reference (same table/column names)', fk => {
        fk.referencedSchema = fk.referencedSchema === SOURCE_SCHEMA ? CANDIDATE_SCHEMA : SOURCE_SCHEMA;
      }],
      ['referenced table', fk => { fk.referencedTable = `${fk.referencedTable}_drift`; }],
      ['referenced columns', fk => { fk.referencedColumns = fk.referencedColumns.map(name => `${name}_drift`); }],
      ['ON UPDATE CASCADE', fk => { fk.updateRule = 'CASCADE'; }],
      ['ON UPDATE SET NULL', fk => { fk.updateRule = 'SET NULL'; }],
      ['ON DELETE CASCADE', fk => { fk.deleteRule = 'CASCADE'; }],
      ['ON DELETE SET NULL', fk => { fk.deleteRule = 'SET NULL'; }],
    ];
    const foreignKeyDrifts: string[] = [];
    for (const [label, schema, shape] of [
      ['source', SOURCE_SCHEMA, sourceShape], ['candidate', CANDIDATE_SCHEMA, candidateShape],
      ['restore', RESTORE_SCHEMA, restoreShape],
    ] as const) {
      for (const table of COPY_ORDER) {
        for (const name of Object.keys(shape[table].foreignKeys)) {
          for (const [mutationLabel, mutate] of foreignKeyMutations) {
            const copy = structuredClone(shape);
            mutate(copy[table].foreignKeys[name]!);
            const diffs = diffFrozenStructure(copy, shape, schema);
            if (diffs.length === 0) {
              throw new Derr(`frozen-structure diff missed FK ${label}.${table}.${name} ${mutationLabel}`, copy);
            }
            foreignKeyDrifts.push(`${label}.${table}.${name} ${mutationLabel}: ${diffs[0]}`);
          }
        }
      }
    }
    record('frozen-structure comparator rejects every drift class (synthetic snapshots)', {
      drifts: caughtDrifts, foreign_key_drifts: foreignKeyDrifts,
      note: 'synthetic snapshots; real DDL drift rows follow',
    });

    // ------------------------------ seed identity rejection (real connection)
    const wrongIdentityCfg = { ...cfg, handle: { ...cfg.handle, container_id: '0'.repeat(64) } };
    const identityError = await expectDrillError('wrong-fixture',
      () => seedSource(wrongIdentityCfg, pool));
    await assertEmptyManifestsUnchanged('seed identity rejection');
    record('seed write entry rejects a connection that is not the recorded fixture', {
      reason: identityError.reason, message: identityError.message,
    });

    const rootPassword = readRootPassword(cfg);
    const structureTrial = async (trial: {
      label: string;
      schema: string;
      drift: string;
      restore: string;
      attempt: () => Promise<unknown>;
      assertUnchanged: () => Promise<void>;
    }): Promise<unknown> => {
      const before = await readSchemaStructure(pool, trial.schema);
      mysqlRootDdl(cfg, rootPassword, trial.drift);
      let error: DrillError | null = null;
      let assertionFailure: unknown = null;
      try {
        error = await expectDrillError('structure-drift', trial.attempt);
        await trial.assertUnchanged();
      } catch (failure) {
        assertionFailure = failure;
      }
      mysqlRootDdl(cfg, rootPassword, trial.restore);
      const after = await readSchemaStructure(pool, trial.schema);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Derr(`${trial.label}: the frozen structure was not restored exactly`, { before, after });
      }
      await verifyLiveFixture(pool, cfg);
      if (assertionFailure) throw assertionFailure;
      return {
        label: trial.label, schema: trial.schema,
        drift_statement: trial.drift, restore_statement: trial.restore,
        diffs: (error!.detail as { diffs?: string[] } | null)?.diffs ?? [],
        structure_sha256: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
      };
    };

    if (reject) {
      // ------------------------- real DDL: foreign-key reference and rule drift
      // Reproduces both Chief FAIL counterexamples inside this fixture and proves
      // seed/up/down each refuse before their first business DML.
      const manifestOfAll = async (target: import('mysql2/promise').Pool) => ({
        source: await readManifest(target, SOURCE_SCHEMA, 'source'),
        candidate: await readManifest(target, CANDIDATE_SCHEMA, 'candidate'),
        restore: await readManifest(target, RESTORE_SCHEMA, 'restore'),
      });
      const readDraftForeignKey = async (target: import('mysql2/promise').Pool) => {
        const [rows] = await target.query(
          `SELECT k.REFERENCED_TABLE_SCHEMA AS referenced_schema, k.REFERENCED_TABLE_NAME AS referenced_table,
                  r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
            WHERE k.TABLE_SCHEMA = ? AND k.CONSTRAINT_NAME = 'fk_draft_template'
            ORDER BY k.ORDINAL_POSITION`, [CANDIDATE_SCHEMA],
        );
        return rows as {
          referenced_schema: string; referenced_table: string; update_rule: string; delete_rule: string;
        }[];
      };
      const fkDrop = 'ALTER TABLE `max237_t2b`.`metric_template_drafts` DROP FOREIGN KEY `fk_draft_template`';
      const fkAddOriginal = 'ALTER TABLE `max237_t2b`.`metric_template_drafts` '
        + 'ADD CONSTRAINT `fk_draft_template` FOREIGN KEY (`template_id`) '
        + 'REFERENCES `max237_t2b`.`metric_templates_v2` (`template_id`)';
      const fkVariant = (label: string, reference: string, expected: {
        referenced_schema: string; update_rule: string; delete_rule: string;
      }) => ({
        label,
        statement: 'ALTER TABLE `max237_t2b`.`metric_template_drafts` '
          + `ADD CONSTRAINT \`fk_draft_template\` FOREIGN KEY (\`template_id\`) REFERENCES ${reference}`,
        expected,
      });
      for (const variant of [
        fkVariant('candidate fk_draft_template references the source schema',
          '`max237_t2b_d1`.`metric_templates_v2` (`template_id`)',
          { referenced_schema: SOURCE_SCHEMA, update_rule: 'NO ACTION', delete_rule: 'NO ACTION' }),
        fkVariant('candidate fk_draft_template ON DELETE CASCADE',
          '`max237_t2b`.`metric_templates_v2` (`template_id`) ON DELETE CASCADE',
          { referenced_schema: CANDIDATE_SCHEMA, update_rule: 'NO ACTION', delete_rule: 'CASCADE' }),
      ]) {
        const structureBefore = await readSchemaStructure(pool2!, CANDIDATE_SCHEMA);
        const manifestsBefore = await manifestOfAll(pool2!);
        mysqlRootDdl(cfg, rootPassword, fkDrop);
        let trial: unknown = null;
        try {
          mysqlRootDdl(cfg, rootPassword, variant.statement);
          const actual = await readDraftForeignKey(pool2!);
          if (actual.length !== 1
            || actual[0]!.referenced_schema !== variant.expected.referenced_schema
            || actual[0]!.update_rule !== variant.expected.update_rule
            || actual[0]!.delete_rule !== variant.expected.delete_rule) {
            throw new Derr(`${variant.label}: the fixture does not report the constructed FK`, actual);
          }
          const entries: unknown[] = [];
          for (const entry of ['seed', 'up', 'down'] as const) {
            const dml: string[] = [];
            const counted = faultPool(pool, { dml });
            const run = entry === 'seed' ? () => seedSource(cfg, counted)
              : entry === 'up' ? () => up(cfg, counted)
                : () => down(cfg, counted);
            const error = await expectDrillError('structure-drift', run);
            if (dml.length !== 0) {
              throw new Derr(`${variant.label}: ${entry} issued business DML before refusing`, dml);
            }
            entries.push({
              entry, reason: error.reason, business_dml: dml.length,
              diffs: (error.detail as { diffs?: string[] } | null)?.diffs ?? [],
            });
          }
          const manifestsAfter = await manifestOfAll(pool2!);
          if (JSON.stringify(manifestsAfter) !== JSON.stringify(manifestsBefore)) {
            throw new Derr(`${variant.label}: a refused entry changed the three schemas`, {
              before: manifestsBefore, after: manifestsAfter,
            });
          }
          trial = {
            label: variant.label, drift_statement: variant.statement,
            actual_foreign_key: actual, entries, manifests: manifestsAfter,
            source_unchanged: true, candidate_unchanged: true, restore_unchanged: true,
          };
        } finally {
          try {
            mysqlRootDdl(cfg, rootPassword, fkDrop);
          } catch {
            // already dropped by a failed variant statement
          }
          mysqlRootDdl(cfg, rootPassword, fkAddOriginal);
        }
        const structureAfter = await readSchemaStructure(pool2!, CANDIDATE_SCHEMA);
        if (JSON.stringify(structureAfter) !== JSON.stringify(structureBefore)) {
          throw new Derr(`${variant.label}: the frozen structure was not restored exactly`, {
            before: structureBefore, after: structureAfter,
          });
        }
        await verifyLiveFixture(pool2!, cfg);
        record('real foreign-key drift is refused before the first business DML', trial);
      }

      // Real DDL drift on the source: seed must reject before its first INSERT.
      const sourceDrift = await structureTrial({
        label: 'source narrowed column type',
        schema: SOURCE_SCHEMA,
        drift: 'ALTER TABLE `max237_t2b_d1`.`metric_templates_v2` MODIFY `name` VARCHAR(32) NOT NULL',
        restore: 'ALTER TABLE `max237_t2b_d1`.`metric_templates_v2` MODIFY `name` VARCHAR(128) NOT NULL',
        attempt: () => seedSource(cfg, pool),
        assertUnchanged: () => assertEmptyManifestsUnchanged('source structure drift'),
      });
      record('real source structure drift blocks seed before its first write', sourceDrift);
    }

    // --------------------------------------------------------------- seeding
    const seeded = await seedSource(cfg, pool);
    const sourceManifestAfterSeed = seeded.sha256;
    evidence.source_manifest = seeded;
    record('representative 140 source aggregate seeded', {
      sha256: seeded.sha256,
      rows: Object.fromEntries(COPY_ORDER.map(table => [table, seeded.tables[table].length])),
    });

    // Real DDL drift on the candidate: up must reject before its first INSERT.
    const candidateDrift = await structureTrial({
      label: 'candidate missing query index',
      schema: CANDIDATE_SCHEMA,
      drift: 'ALTER TABLE `max237_t2b`.`metric_template_item_versions` DROP INDEX `idx_canonical`',
      restore: 'ALTER TABLE `max237_t2b`.`metric_template_item_versions` '
        + 'ADD KEY `idx_canonical` (`canonical_metric_id`(128), `canonical_semantic_version`(16))',
      attempt: () => up(cfg, pool),
      assertUnchanged: async () => {
        const counts = await tableCounts(pool2!, CANDIDATE_SCHEMA);
        if (JSON.stringify(counts) !== JSON.stringify(emptyCounts)) {
          throw new Derr('candidate structure drift: the candidate received a write', counts);
        }
        const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
        if (sourceNow.sha256 !== sourceManifestAfterSeed) {
          throw new Derr('candidate structure drift: the source changed', {
            expected: sourceManifestAfterSeed, actual: sourceNow.sha256,
          });
        }
      },
    });
    record('real candidate structure drift blocks up before its first write', candidateDrift);

    if (reject) {
      // -------------------------------------------------- rejection scenario
      // Legal out-of-range rows stay in the candidate. Down must refuse before
      // its first DML, all three schemas keep their complete manifest, and the
      // fixture is discarded whole afterwards — never "DELETE the new rows and
      // then down the same candidate".
      const upResult = await up(cfg, pool);
      if (upResult.status !== 'copied') throw new Derr('first up was not a copy', upResult);
      evidence.candidate_manifest = {
        schema: CANDIDATE_SCHEMA, sha256: upResult.observed.sha256,
        rows: Object.fromEntries(COPY_ORDER.map(table => [table, upResult.observed.tables[table].length])),
      };
      record('up copies the whole aggregate into an empty candidate in one transaction', {
        sha256: upResult.observed.sha256, rows: upResult.rows,
      });

      adapterPool = mysql.createPool(poolOptions(credentials));
      const adapter = new MySqlTemplateRepository(adapterPool);
      await adapter.create({
        template_id: 't2b-edge-a', name: 'Edge A', status: 'draft', current_published_version: null,
        revision: 0, created_by: 2147483648, created_at: '0000-01-01T00:00:00.000Z', updated_at: '0000-01-01T00:00:00.000Z',
      }, {
        template_id: 't2b-edge-a', revision: 0, aggregate: {
          template_id: 't2b-edge-a', base: null, items: [], triggers: [],
          parameters: { schema: {}, defaults: {} },
          capabilities: {
            discovery: { contract_version: '1.0.0', ref: null, executable: false },
            graphs: { contract_version: '1.0.0', ref: null, executable: false },
          },
        }, published_version: null, updated_by: 9007199254740991, updated_at: '0000-01-01T00:00:00.000Z',
      });
      const longId = `a.${'b'.repeat(510)}`;
      await adapter.putItemVersion({
        template_id: 't2b-edge-a', item_id: 'edge', display_name: 'Edge',
        canonical_metric: { id: longId, semantic_version: `${'1'.repeat(96)}.0.0` }, unit: 's', dimensions: {},
        collector_ref: { package_release: `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`, implementation_id: 'builtin:mysql.status.v1' },
        params_default: {}, source_chain: {
          actor_id: 1, request_id: 'req-edge', base: null, created_at: '0000-01-01T00:00:00.000Z',
          published_at: '0000-01-01T00:00:00.000Z', retired_at: null, migration_ref: null,
        },
      });
      const withEdge = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
      const problems = checkDownRepresentable(withEdge);
      for (const expected of ['exceeds INT', 'not VARCHAR(128)', 'not VARCHAR(16)', 'precedes DATETIME year 1000']) {
        if (!problems.some(problem => problem.includes(expected))) {
          throw new Derr(`out-of-range data did not report ${expected}`, problems);
        }
      }
      const sourceBeforeRefuse = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      const restoreBeforeRefuse = await readManifest(pool2!, RESTORE_SCHEMA, 'restore');
      const downRefused = await expectDrillError('down-irreversible', () => down(cfg, pool));
      const afterRefuse = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
      const sourceAfterRefuse = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      const restoreAfterRefuse = await readManifest(pool2!, RESTORE_SCHEMA, 'restore');
      if (afterRefuse.sha256 !== withEdge.sha256) throw new Derr('refused down changed the candidate', { withEdge, afterRefuse });
      if (sourceAfterRefuse.sha256 !== sourceBeforeRefuse.sha256) {
        throw new Derr('refused down changed the source', { sourceBeforeRefuse, sourceAfterRefuse });
      }
      if (restoreAfterRefuse.sha256 !== restoreBeforeRefuse.sha256) {
        throw new Derr('refused down changed the restore schema', { restoreBeforeRefuse, restoreAfterRefuse });
      }
      const retainedRows = Object.fromEntries(COPY_ORDER.map(table =>
        [table, withEdge.tables[table].filter(row => String(row.template_id).startsWith('t2b-edge-'))]));
      evidence.rejection = {
        down_reason: downRefused.reason,
        problems,
        manifests: { candidate: withEdge, source: sourceAfterRefuse, restore: restoreAfterRefuse },
        retained_rows: retainedRows,
        cleanup: 'fixture discarded whole by env-clean.sh after this scenario; no row-level delete',
      };
      record('legal out-of-range rows are refused by down with all three schemas intact and the rows retained', {
        reason: downRefused.reason, problems, candidate: afterRefuse.sha256,
        source: sourceAfterRefuse.sha256, restore: restoreAfterRefuse.sha256,
        retained: Object.fromEntries(COPY_ORDER.map(table => [table, retainedRows[table]!.length])),
      });
    } else {

    // --------------------------- transaction disposal on the exclusive fixture
    // One writer connection only: a released connection with an open transaction
    // is exactly the reuse that MySQL implicitly commits. An independent pool
    // reads the externally visible state.
    faultWriter = mysql.createPool({ ...poolOptions(credentials), connectionLimit: 1 });
    const expectedCandidateManifest = (): ReturnType<typeof expectedFrom> =>
      expectedFrom('candidate', CANDIDATE_SCHEMA, seeded);
    const assertCandidateEmpty = async (label: string): Promise<void> => {
      const fromA = await tableCounts(faultWriter!, CANDIDATE_SCHEMA);
      const fromB = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      if (JSON.stringify(fromA) !== JSON.stringify(emptyCounts)
        || JSON.stringify(fromB) !== JSON.stringify(emptyCounts)) {
        throw new Derr(`${label}: the candidate is not empty`, { fromA, fromB });
      }
      const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      if (sourceNow.sha256 !== sourceManifestAfterSeed) {
        throw new Derr(`${label}: the source changed`, { expected: sourceManifestAfterSeed, actual: sourceNow.sha256 });
      }
    };

    // Normal rollback: the server confirmed it, so the connection is released.
    for (const inject of ['after-parents', 'after-versions']) {
      const counter = newCounter();
      const observedPool = faultPool(faultWriter, { counter });
      const error = await expectDrillError('injected-failure', () => up(cfg, observedPool, inject));
      if (counter.releases !== 1 || counter.destroys !== 0) {
        throw new Derr(`confirmed rollback ${inject} did not release exactly once`, counter);
      }
      await assertCandidateEmpty(`confirmed rollback ${inject}`);
      record(`up failure ${inject} with a confirmed rollback releases the connection`, {
        message: error.message, counter, target: emptyCounts,
      });
    }

    // A failed BEGIN never leaves the socket reusable.
    {
      const counter = newCounter();
      const beginFault = faultPool(faultWriter, { counter, begin: 'throw' });
      const error = await captureError(() => up(cfg, beginFault));
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('a failed begin was not destroyed exactly once', counter);
      }
      await assertCandidateEmpty('begin failure');
      record('a failed begin destroys the connection and releases nothing', {
        message: error.message, counter,
      });
    }

    // Rollback not forwarded: the socket still holds the open transaction.
    {
      const counter = newCounter();
      const rollbackFault = faultPool(faultWriter, { counter, rollback: 'throw' });
      const error = await expectDrillError('injected-failure', () => up(cfg, rollbackFault, 'after-parents'));
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('an unconfirmed rollback was not destroyed exactly once', counter);
      }
      const before = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      await unrelatedTransaction(faultWriter);
      const after = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      if (JSON.stringify(before) !== JSON.stringify(emptyCounts)
        || JSON.stringify(after) !== JSON.stringify(emptyCounts)) {
        throw new Derr('an unconfirmed rollback leaked rows after an unrelated transaction', { before, after });
      }
      const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      if (sourceNow.sha256 !== sourceManifestAfterSeed) throw new Derr('the source changed', sourceNow.sha256);
      record('unconfirmed rollback destroys the live transaction instead of releasing it', {
        message: error.message, counter,
        externally_visible_before: before,
        externally_visible_after_unrelated_transaction: after,
        source_unchanged: true,
      });
    }

    // A failing destroy must keep the original failure and never release.
    {
      const counter = newCounter();
      const destroyFault = faultPool(faultWriter, {
        counter, rollback: 'throw', destroy: 'throw',
      });
      const error = await expectDrillError('injected-failure', () => up(cfg, destroyFault, 'after-parents'));
      if (!/injected failure after copying parent rows/.test(error.message)) {
        throw new Derr('a failing destroy replaced the original failure', error.message);
      }
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('a failing destroy fell back to release', counter);
      }
      await assertCandidateEmpty('failing destroy');
      record('a failing destroy keeps the original failure and never falls back to release', {
        message: error.message, counter,
      });
    }

    // COMMIT never reached the server: the target is empty and stays empty.
    {
      const counter = newCounter();
      const commitFault = faultPool(faultWriter, { counter, commit: 'before' });
      const error = await expectDrillError('commit-not-applied', () => up(cfg, commitFault));
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('a non-applied commit was not destroyed exactly once', counter);
      }
      const before = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      await unrelatedTransaction(faultWriter);
      const after = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      if (JSON.stringify(before) !== JSON.stringify(emptyCounts)
        || JSON.stringify(after) !== JSON.stringify(emptyCounts)) {
        throw new Derr('a non-applied commit leaked rows', { before, after });
      }
      await assertCandidateEmpty('commit not applied');
      record('a COMMIT that never reached the server is classified as not applied', {
        detail: error.detail, counter, target_before: before, target_after: after,
      });
    }

    // Server committed, acknowledgement lost: classify by a fresh manifest read.
    {
      const counter = newCounter();
      const commitFault = faultPool(faultWriter, { counter, commit: 'after' });
      const error = await expectDrillError('commit-unconfirmed', () => up(cfg, commitFault));
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('a lost commit acknowledgement was not destroyed exactly once', counter);
      }
      const observed = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
      if (observed.sha256 !== expectedCandidateManifest().sha256) {
        throw new Derr('the committed copy is not the expected candidate manifest', {
          observed: observed.sha256, expected: expectedCandidateManifest().sha256,
        });
      }
      const counts = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      if (JSON.stringify(counts) === JSON.stringify(emptyCounts)) {
        throw new Derr('a lost acknowledgement was reported with an empty target', counts);
      }
      const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      if (sourceNow.sha256 !== sourceManifestAfterSeed) throw new Derr('the source changed', sourceNow.sha256);
      const noRetry = await up(cfg, faultWriter);
      if (noRetry.status !== 'no-op') {
        throw new Derr('a re-run after the lost acknowledgement was not an explicit no-op', noRetry);
      }
      record('a real commit whose acknowledgement was lost is unconfirmed, and a re-run is a no-op', {
        detail: error.detail, counter, candidate_manifest: observed.sha256,
        rows: counts, rerun: noRetry.status, source_unchanged: true,
      });
    }

    // Drill-owned reset between fault trials (test setup, never rollback evidence).
    await cleanSchema(faultWriter, CANDIDATE_SCHEMA);
    await assertCandidateEmpty('drill reset after the commit trials');

    // --------------------------------------------- real up (pool health proof)
    const upCounter = newCounter();
    const upPool = faultPool(faultWriter, { counter: upCounter });
    const upResult = await up(cfg, upPool);
    if (upResult.status !== 'copied') throw new Derr('first up was not a copy', upResult);
    if (upCounter.releases !== 1 || upCounter.destroys !== 0) {
      throw new Derr('the confirmed commit did not release exactly once', upCounter);
    }
    const candidateManifest = upResult.observed.sha256;
    const expectedCandidate = upResult.expected.sha256;
    if (candidateManifest !== expectedCandidate) throw new Derr('up manifest mismatch', upResult);
    evidence.candidate_manifest = {
      schema: CANDIDATE_SCHEMA, sha256: candidateManifest,
      rows: Object.fromEntries(COPY_ORDER.map(table => [table, upResult.observed.tables[table].length])),
    };
    record('up copies the whole aggregate into an empty candidate in one transaction', {
      sha256: candidateManifest, rows: upResult.rows,
    });

    // Adapter spot checks on the candidate schema.
    adapterPool = mysql.createPool(poolOptions(credentials));
    const adapter = new MySqlTemplateRepository(adapterPool);
    const legacyA = await adapter.getTemplate('tpl-legacy-a');
    const legacyB = await adapter.getTemplate('tpl-legacy-b');
    const draftA = await adapter.getDraft('tpl-legacy-a');
    const itemsA = await adapter.latestItemVersions('tpl-legacy-a');
    const version1 = await adapter.getVersion('tpl-legacy-a', 1);
    const version2 = await adapter.getVersion('tpl-legacy-a', 2);
    const [rawChain] = await pool.query(
      `SELECT source_chain FROM \`${CANDIDATE_SCHEMA}\`.metric_template_item_versions
        WHERE template_id = 'tpl-legacy-a' AND item_id = 'uptime' AND version = 1`,
    );
    const chainValue = (rawChain as { source_chain: unknown }[])[0]!.source_chain;
    const parsedChain = typeof chainValue === 'string' ? JSON.parse(chainValue) : chainValue;
    const spot = {
      legacyA, legacyB, draftA, itemsA, version1, version2, sourceChainCreatedAt: (parsedChain as { created_at: string }).created_at,
    };
    if (legacyA?.revision !== 5 || legacyA.current_published_version !== 2 || legacyA.created_by !== 2147483647
      || legacyA.created_at !== '1000-01-01T00:00:00.000Z' || legacyA.updated_at !== '2026-10-27T12:34:56.789Z') {
      throw new Derr('template spot check failed', legacyA);
    }
    if (legacyB?.created_by !== null || legacyB.created_at !== '1000-01-01T00:00:00.000Z') {
      throw new Derr('NULL actor/year spot check failed', legacyB);
    }
    if (draftA?.published_version !== 2 || draftA.updated_by !== null
      || (draftA.aggregate as { parameters: { schema: Record<string, unknown> } }).parameters.schema.interval_ms === undefined) {
      throw new Derr('draft/JSON spot check failed', draftA);
    }
    if (itemsA.map(item => `${item.item_id}@${item.version}`).sort().join(',') !== 'queries@1,uptime@2') {
      throw new Derr('item version spot check failed', itemsA);
    }
    if (version1?.published_at !== '2026-01-02T03:04:05.006Z' || version1.retired_at !== '2026-02-03T04:05:06.120Z'
      || version2?.retired_at !== null) {
      throw new Derr('version timestamp spot check failed', { version1, version2 });
    }
    if ((parsedChain as { created_at: string }).created_at !== '2026-01-01T00:00:00.1Z') {
      throw new Derr('JSON source_chain was rewritten', parsedChain);
    }
    // Close and reopen: the rows are persisted, not connection state.
    await adapterPool.end();
    adapterPool = mysql.createPool(poolOptions(credentials));
    const fresh = new MySqlTemplateRepository(adapterPool);
    if ((await fresh.getTemplate('tpl-legacy-a'))?.updated_at !== '2026-10-27T12:34:56.789Z') {
      throw new Derr('fresh-connection re-read failed', await fresh.getTemplate('tpl-legacy-a'));
    }
    record('adapter reads persisted candidate rows: PK, revision, pointer, NULL, JSON and instants', spot);

    // ------------------------------------------------------ no-op / drift
    const rerun = await up(cfg, pool);
    if (rerun.status !== 'no-op') throw new Derr('identical re-run was not a no-op', rerun);
    record('identical re-run is an explicit no-op and writes nothing', { status: rerun.status, sha256: rerun.observed.sha256 });

    await pool.query(`UPDATE \`${CANDIDATE_SCHEMA}\`.metric_templates_v2 SET name = 'Drifted' WHERE template_id = 'tpl-legacy-a'`);
    const drifted = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    const driftError = await expectDrillError('target-drift', () => up(cfg, pool));
    const afterDrift = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    if (afterDrift.sha256 !== drifted.sha256) throw new Derr('drift run overwrote the target', { drifted, afterDrift });
    const [driftedName] = await pool.query(
      `SELECT name FROM \`${CANDIDATE_SCHEMA}\`.metric_templates_v2 WHERE template_id = 'tpl-legacy-a'`,
    );
    if ((driftedName as { name: string }[])[0]!.name !== 'Drifted') throw new Derr('drift run changed the drifted row', driftedName);
    await pool.query(`UPDATE \`${CANDIDATE_SCHEMA}\`.metric_templates_v2 SET name = 'Legacy A' WHERE template_id = 'tpl-legacy-a'`);
    record('drifted target is refused without overwriting', { reason: driftError.reason, detail: driftError.detail });

    const restored = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    if (restored.sha256 !== candidateManifest) throw new Derr('candidate manifest did not return to the copied aggregate', restored);
    record('candidate manifest restored after the drift trial', { sha256: restored.sha256 });

    // The out-of-range rejection lives in the separate `reject` scenario: this
    // fixture only ever holds safe old data, so the roundtrip below is a real
    // down of a representable candidate and never follows a row-level cleanup.

    // Real DDL drift on the restore schema: down must reject before its first INSERT.
    const restoreDrift = await structureTrial({
      label: 'restore missing unique content index',
      schema: RESTORE_SCHEMA,
      drift: 'ALTER TABLE `max237_t2b_restore`.`metric_template_versions` DROP INDEX `uk_content`',
      restore: 'ALTER TABLE `max237_t2b_restore`.`metric_template_versions` '
        + 'ADD UNIQUE KEY `uk_content` (`template_id`, `content_hash`)',
      attempt: () => down(cfg, pool),
      assertUnchanged: async () => {
        const candidateNow = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
        const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
        const restoreNow = await tableCounts(pool2!, RESTORE_SCHEMA);
        if (candidateNow.sha256 !== candidateManifest) {
          throw new Derr('restore structure drift: the candidate changed', {
            expected: candidateManifest, actual: candidateNow.sha256,
          });
        }
        if (sourceNow.sha256 !== sourceManifestAfterSeed) {
          throw new Derr('restore structure drift: the source changed', sourceNow.sha256);
        }
        if (JSON.stringify(restoreNow) !== JSON.stringify(emptyCounts)) {
          throw new Derr('restore structure drift: the restore schema received a write', restoreNow);
        }
      },
    });
    record('real restore structure drift blocks down before its first write', restoreDrift);

    // ------------------------------ down transaction disposal on the same writer
    const downInterrupt = (sql: string): boolean =>
      sql.startsWith('INSERT INTO `max237_t2b_restore`.`metric_template_drafts`');
    const assertRestoreEmpty = async (label: string): Promise<void> => {
      const fromA = await tableCounts(faultWriter!, RESTORE_SCHEMA);
      const fromB = await tableCounts(pool2!, RESTORE_SCHEMA);
      if (JSON.stringify(fromA) !== JSON.stringify(emptyCounts)
        || JSON.stringify(fromB) !== JSON.stringify(emptyCounts)) {
        throw new Derr(`${label}: the restore schema is not empty`, { fromA, fromB });
      }
    };
    {
      const counter = newCounter();
      const confirmed = faultPool(faultWriter, { counter, interrupt: downInterrupt });
      const error = await expectDrillError('injected-failure', () => down(cfg, confirmed));
      if (counter.releases !== 1 || counter.destroys !== 0) {
        throw new Derr('a confirmed down rollback did not release exactly once', counter);
      }
      await assertRestoreEmpty('confirmed down rollback');
      record('down failure with a confirmed rollback releases the connection', {
        message: error.message, counter,
      });
    }
    {
      const counter = newCounter();
      const unconfirmed = faultPool(faultWriter, {
        counter, rollback: 'throw', interrupt: downInterrupt,
      });
      const error = await expectDrillError('injected-failure', () => down(cfg, unconfirmed));
      if (counter.destroys !== 1 || counter.releases !== 0) {
        throw new Derr('an unconfirmed down rollback was not destroyed exactly once', counter);
      }
      const before = await tableCounts(pool2!, RESTORE_SCHEMA);
      await unrelatedTransaction(faultWriter);
      const after = await tableCounts(pool2!, RESTORE_SCHEMA);
      if (JSON.stringify(before) !== JSON.stringify(emptyCounts)
        || JSON.stringify(after) !== JSON.stringify(emptyCounts)) {
        throw new Derr('an unconfirmed down rollback leaked rows', { before, after });
      }
      const candidateNow = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
      const sourceNow = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      if (candidateNow.sha256 !== candidateManifest || sourceNow.sha256 !== sourceManifestAfterSeed) {
        throw new Derr('an unconfirmed down rollback changed the source schemas', {
          candidate: candidateNow.sha256, source: sourceNow.sha256,
        });
      }
      record('down unconfirmed rollback destroys the connection and leaves all three schemas unchanged', {
        message: error.message, counter,
        externally_visible_before: before,
        externally_visible_after_unrelated_transaction: after,
        source_unchanged: true, candidate_unchanged: true,
      });
    }

    // -------------------------------------------------------------- safe down
    const downCounter = newCounter();
    const downPool = faultPool(faultWriter, { counter: downCounter });
    const downResult = await down(cfg, downPool);
    if (downResult.status !== 'copied') throw new Derr('first down was not a copy', downResult);
    if (downCounter.releases !== 1 || downCounter.destroys !== 0) {
      throw new Derr('the confirmed down commit did not release exactly once', downCounter);
    }
    if (downResult.observed.sha256 !== sourceManifestAfterSeed) {
      throw new Derr('down restore manifest differs from the source aggregate', {
        observed: downResult.observed.sha256, expected: sourceManifestAfterSeed,
      });
    }
    const candidateAfterDown = await pool2!.query(
      `SELECT COUNT(*) AS n FROM \`${CANDIDATE_SCHEMA}\`.metric_templates_v2`,
    );
    if (Number((candidateAfterDown as unknown as { n: number }[][])[0]![0]!.n) !== 2) {
      throw new Derr('down deleted candidate rows', candidateAfterDown);
    }
    evidence.restore_manifest = {
      schema: RESTORE_SCHEMA, sha256: downResult.observed.sha256,
      rows: Object.fromEntries(COPY_ORDER.map(table => [table, downResult.observed.tables[table].length])),
    };
    record('safe down copies into the empty restore schema and round-trips the source manifest', {
      restore_sha256: downResult.observed.sha256,
      source_sha256: sourceManifestAfterSeed,
      rows: downResult.rows,
    });

    const downRerun = await down(cfg, pool);
    if (downRerun.status !== 'no-op') throw new Derr('identical down re-run was not a no-op', downRerun);
    record('identical down re-run is an explicit no-op', { status: downRerun.status });

    const finalSource = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
    const finalCandidate = await readManifest(pool2!, CANDIDATE_SCHEMA, 'candidate');
    const finalRestore = await readManifest(pool2!, RESTORE_SCHEMA, 'restore');
    evidence.final_manifests = {
      source: finalSource.sha256,
      candidate: finalCandidate.sha256,
      restore: finalRestore.sha256,
    };
    if (finalSource.sha256 !== sourceManifestAfterSeed || finalCandidate.sha256 !== candidateManifest
      || finalRestore.sha256 !== sourceManifestAfterSeed) {
      throw new Derr('final manifests are not the expected three-way result', evidence.final_manifests);
    }
    record('final state verified on the second connection: source intact, candidate copy, restore equal', evidence.final_manifests);
    }
  } catch (error) {
    const failure = error instanceof DrillError
      ? { reason: error.reason, message: error.message, detail: error.detail }
      : { reason: 'error', message: String((error as Error)?.message ?? error) };
    steps.push({ step: 'drill', status: 'FAIL', detail: failure });
    evidence.steps = steps;
    evidence.result = 'FAIL';
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stderr.write(`${JSON.stringify(evidence, null, 2)}\n`);
    process.exitCode = 1;
    return;
  } finally {
    await adapterPool?.end().catch(() => {});
    await faultWriter?.end().catch(() => {});
    await pool2?.end().catch(() => {});
    await pool.end().catch(() => {});
  }

  evidence.steps = steps;
  evidence.result = 'PASS';
  evidence.generated_at_finished = new Date().toISOString();
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
  }
  process.stdout.write(text);
}

class Derr extends Error {
  readonly detail: unknown;
  constructor(message: string, detail: unknown) {
    super(message);
    this.name = 'DrillError';
    this.detail = detail;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
