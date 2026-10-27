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
  down, loadConfig, openPool, readCredentials, readManifest, rowCounts, seedSource, up, verifyLiveFixture,
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
  const cfg = loadConfig();
  const credentials = readCredentials(cfg);
  const env = { ...process.env, MAX237_T2B_STATE_DIR: cfg.stateDir };
  const startedAt = new Date().toISOString();
  const pool = openPool(cfg);
  let pool2: import('mysql2/promise').Pool | null = null;
  let adapterPool: import('mysql2/promise').Pool | null = null;
  const evidence: Record<string, unknown> = {
    task: 'MAX237-T2B',
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

    // --------------------------------------------------------------- seeding
    const seeded = await seedSource(pool);
    const sourceManifestAfterSeed = seeded.sha256;
    evidence.source_manifest = seeded;
    record('representative 140 source aggregate seeded', {
      sha256: seeded.sha256,
      rows: Object.fromEntries(COPY_ORDER.map(table => [table, seeded.tables[table].length])),
    });

    // ---------------------------------------------- failure-injected up trials
    for (const inject of ['after-parents', 'after-versions']) {
      const error = await expectDrillError('injected-failure', () => up(cfg, pool, inject));
      const fromA = await tableCounts(pool, CANDIDATE_SCHEMA);
      const fromB = await tableCounts(pool2!, CANDIDATE_SCHEMA);
      const sourceA = await readManifest(pool, SOURCE_SCHEMA, 'source');
      const sourceB = await readManifest(pool2!, SOURCE_SCHEMA, 'source');
      if (JSON.stringify(fromA) !== JSON.stringify(emptyCounts)
        || JSON.stringify(fromB) !== JSON.stringify(emptyCounts)) {
        throw new Derr(`target not empty after injected failure ${inject}`, { fromA, fromB });
      }
      if (sourceA.sha256 !== sourceManifestAfterSeed || sourceB.sha256 !== sourceManifestAfterSeed) {
        throw new Derr(`source changed after injected failure ${inject}`, {
          sourceA: sourceA.sha256, sourceB: sourceB.sha256, expected: sourceManifestAfterSeed,
        });
      }
      record(`up failure injected ${inject} leaves target empty and source unchanged`, {
        message: error.message, target: fromA, first_connection: fromA, second_connection: fromB,
        source_first: sourceA.sha256, source_second: sourceB.sha256,
      });
    }

    // -------------------------------------------------------------- real up
    const upResult = await up(cfg, pool);
    if (upResult.status !== 'copied') throw new Derr('first up was not a copy', upResult);
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

    // ------------------------------------- non-representable candidate → down refused
    const adapter2 = new MySqlTemplateRepository(adapterPool);
    await adapter2.create({
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
    await adapter2.putItemVersion({
      template_id: 't2b-edge-a', item_id: 'edge', display_name: 'Edge',
      canonical_metric: { id: longId, semantic_version: `${'1'.repeat(96)}.0.0` }, unit: 's', dimensions: {},
      collector_ref: { package_release: `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`, implementation_id: 'builtin:mysql.status.v1' },
      params_default: {}, source_chain: {
        actor_id: 1, request_id: 'req-edge', base: null, created_at: '0000-01-01T00:00:00.000Z',
        published_at: '0000-01-01T00:00:00.000Z', retired_at: null, migration_ref: null,
      },
    });
    const withEdge = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    const problems = checkDownRepresentable(withEdge);
    if (problems.length === 0) throw new Derr('non-representable candidate rows were not detected', withEdge);
    const downRefused = await expectDrillError('down-irreversible', () => down(cfg, pool));
    const afterRefuse = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    const sourceAfterRefuse = await readManifest(pool, SOURCE_SCHEMA, 'source');
    const restoreAfterRefuse = await tableCounts(pool, RESTORE_SCHEMA);
    if (afterRefuse.sha256 !== withEdge.sha256) throw new Derr('refused down changed the candidate', { withEdge, afterRefuse });
    if (sourceAfterRefuse.sha256 !== sourceManifestAfterSeed) throw new Derr('refused down changed the source', sourceAfterRefuse);
    if (JSON.stringify(restoreAfterRefuse) !== JSON.stringify(emptyCounts)) {
      throw new Derr('refused down wrote into the restore schema', restoreAfterRefuse);
    }
    record('candidate rows not representable in DDL 140 make down fail closed', {
      reason: downRefused.reason, problems, restore: restoreAfterRefuse, candidate: afterRefuse.sha256,
    });

    // Drill teardown of the injected edge fixture only (explicitly NOT a down/
    // rollback shortcut; the down path itself never deletes anything).
    for (const table of ['metric_template_item_versions', 'metric_template_items', 'metric_template_versions',
      'metric_template_drafts', 'metric_templates_v2']) {
      await pool.query(`DELETE FROM \`${CANDIDATE_SCHEMA}\`.\`${table}\` WHERE template_id LIKE 't2b-edge-%'`);
    }
    const cleaned = await readManifest(pool, CANDIDATE_SCHEMA, 'candidate');
    if (cleaned.sha256 !== candidateManifest) throw new Derr('edge fixture teardown did not restore the candidate', cleaned);
    record('injected edge fixture removed; candidate equals the up copy again', { sha256: cleaned.sha256 });

    // -------------------------------------------------------------- safe down
    const downResult = await down(cfg, pool);
    if (downResult.status !== 'copied') throw new Derr('first down was not a copy', downResult);
    if (downResult.observed.sha256 !== sourceManifestAfterSeed) {
      throw new Derr('down restore manifest differs from the source aggregate', {
        observed: downResult.observed.sha256, expected: sourceManifestAfterSeed,
      });
    }
    const candidateAfterDown = await pool2!.query(
      `SELECT COUNT(*) AS n FROM \`${CANDIDATE_SCHEMA}\`.metric_templates_v2`,
    );
    if (Number((candidateAfterDown as { n: number }[][])[0]![0]!.n) !== 2) {
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
