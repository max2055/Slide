/** Offline clone validation only. Never starts API/Worker or invokes a model.
 * Copy source rows at one consistent snapshot. Write only a new owned database.
 * Default-generated timestamps are ordinary stored data, not generated columns.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const tablePolicy = JSON.parse(readFileSync(new URL('./investigation-isolation-tables.json', import.meta.url), 'utf8'));
export const REQUIRED_COPY = Object.freeze(tablePolicy.copy);
export const EMPTY_TABLES = Object.freeze(tablePolicy.empty);
const quote = value => '`' + value.replaceAll('`', '``') + '`';

export function copyColumns(columns) {
  return columns.filter(column => !/\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(String(column.Extra))).map(column => column.Field);
}
export function tablePlan(names) {
  const missing = [...REQUIRED_COPY, ...EMPTY_TABLES].filter(name => !names.includes(name));
  if (missing.length) throw Error('ISOLATION_MISSING_TABLES:' + missing.join(','));
  const unknown = names.filter(name => !REQUIRED_COPY.includes(name) && !EMPTY_TABLES.includes(name));
  if (unknown.length) throw Error('ISOLATION_UNCLASSIFIED_TABLES:' + unknown.join(','));
  return names.slice().sort().map(name => ({ name, mode: REQUIRED_COPY.includes(name) ? 'copy' : 'empty',
    reason: REQUIRED_COPY.includes(name) ? 'Ops-v1 resource read context, configuration or metadata'
      : 'Intentionally empty run/intent/action/notification state or read context outside this Ops-v1 subject' }));
}
function stable(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
export function rowsDigest(rows) {
  // Order independent, multiplicity preserving. Row values never leave memory.
  const hashes = rows.map(row => createHash('sha256').update(JSON.stringify(stable(row))).digest('hex')).sort();
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
export function assertSameRows(expected, actual, table) {
  if (expected.length !== actual.length || rowsDigest(expected) !== rowsDigest(actual)) throw Error('ISOLATION_DATA_MISMATCH:' + table);
}
async function read(connection, sql, args, table) {
  try { return (await connection.query(sql, args))[0]; }
  catch { throw Error('ISOLATION_UNREADABLE_TABLE:' + table); }
}
export async function catalog(connection, source) {
  const tables = await read(connection, 'SHOW FULL TABLES FROM ' + quote(source), undefined, 'catalog');
  const names = tables.map(row => String(Object.values(row)[0]));
  if (tables.some(row => Object.values(row)[1] !== 'BASE TABLE')) throw Error('ISOLATION_UNSUPPORTED_TABLE_KIND');
  const plan = tablePlan(names), metadata = new Map();
  // Probe every table before creating/copying anything. No silent skips for
  // unreadable tables, missing time columns or unknown schema additions.
  for (const { name } of plan) {
    const columns = await read(connection, 'SHOW FULL COLUMNS FROM ' + quote(source) + '.' + quote(name), undefined, name);
    await read(connection, 'SELECT * FROM ' + quote(source) + '.' + quote(name) + ' LIMIT 0', undefined, name);
    if (!columns.length || !copyColumns(columns).length) throw Error('ISOLATION_NO_COPYABLE_COLUMNS:' + name);
    metadata.set(name, columns);
  }
  return { plan, metadata };
}
const REQUIRED_ENVIRONMENT = Object.freeze({
  INVESTIGATION_OPS_AUTO_ENABLED: 'false', INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false',
  INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false', INVESTIGATION_LEGACY_BRIDGE_ENABLED: 'false',
  PROMPT_HOT_RELOAD: 'false',
});
function expectedIsolationRows(table, rows) {
  return rows.map(row => {
    if (table === 'cron_jobs') return { ...row, enabled: 0 };
    if (table === 'database_instances' && Number(row.id) !== 1) return { ...row, status: 'inactive' };
    if (table === 'servers' && Number(row.id) !== 3) return { ...row, status: 'inactive' };
    return row;
  });
}
/** Always destroys this run's verified clone. A future runtime needs a fresh
 * preflight, explicit startup isolation and a separately authorized reservation.
 */
export async function validateIsolatedCopy(connection, source, target, outputDirectory, verifyRoute) {
  if (!/^slide_qualification_max222_[a-z0-9_]+$/.test(target) || target === source) throw Error('ISOLATION_TARGET_INVALID');
  // An existing target or output directory is never reused/overwritten.
  mkdirSync(outputDirectory, { recursive: false });
  const { plan, metadata } = await catalog(connection, source);
  const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), source, target,
    scope: tablePolicy.scope, modelCalls: 0, readyForModelSend: false, requiredEnvironment: REQUIRED_ENVIRONMENT,
    allowedDifferences: ['cron_jobs.enabled=0', 'database_instances.status=inactive for id<>1', 'servers.status=inactive for id<>3',
      'explicitly empty tables listed individually in inventory; clone has no triggers/events'],
    allOtherFieldsIncludingDefaultTimestampsMustMatch: true, inventory: [], verified: false, cleanup: 'not_created' };
  const save = () => writeFileSync(resolve(outputDirectory, 'isolation-preflight.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  save();
  let owned = false;
  try {
    await connection.query('CREATE DATABASE ' + quote(target) + ' DEFAULT CHARACTER SET utf8mb4'); owned = true;
    report.cleanup = 'pending';
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for (const { name } of plan) {
      const creates = await read(connection, 'SHOW CREATE TABLE ' + quote(source) + '.' + quote(name), undefined, name);
      const ddl = creates[0]['Create Table'];
      if (typeof ddl !== 'string' || !ddl.startsWith('CREATE TABLE ' + quote(name))) throw Error('ISOLATION_DDL_INVALID:' + name);
      await connection.query(ddl.replace('CREATE TABLE ' + quote(name), 'CREATE TABLE ' + quote(target) + '.' + quote(name)));
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    for (const item of plan) {
      const { name, mode } = item, columns = metadata.get(name), fields = copyColumns(columns);
      // Empty queues need a count, never their credentials, intent bodies or
      // historical payloads. Only reviewed read-context tables copy row data.
      const sourceCount = mode === 'empty' ? Number((await read(connection, 'SELECT COUNT(*) AS n FROM ' + quote(source) + '.' + quote(name), undefined, name))[0].n) : undefined;
      const sourceRows = mode === 'copy' ? await read(connection, 'SELECT * FROM ' + quote(source) + '.' + quote(name), undefined, name) : [];
      if (mode === 'copy') {
        // SELECT under the snapshot then INSERT values: INSERT SELECT can read
        // a different/current snapshot under InnoDB and race a live collector.
        for (let offset = 0; offset < sourceRows.length; offset += 100) {
          const batch = sourceRows.slice(offset, offset + 100);
          const args = batch.flatMap(row => fields.map(field => {
            const column = columns.find(c => c.Field === field);
            const value = row[field];
            return /^json$/i.test(column.Type) && value !== null && typeof value !== 'string' ? JSON.stringify(value) : value;
          }));
          const placeholders = batch.map(() => '(' + fields.map(() => '?').join(',') + ')').join(',');
          await connection.query('INSERT INTO ' + quote(target) + '.' + quote(name) + ' (' + fields.map(quote).join(',') + ') VALUES ' + placeholders, args);
        }
      }
      const copied = await read(connection, 'SELECT * FROM ' + quote(target) + '.' + quote(name), undefined, name);
      assertSameRows(mode === 'copy' ? sourceRows : [], copied, name);
      report.inventory.push({ ...item, sourceRows: sourceCount ?? sourceRows.length, copiedRows: copied.length, sourceSnapshotDigest: mode === 'copy' ? rowsDigest(sourceRows) : null,
        copiedDigest: rowsDigest(copied), copiedColumns: mode === 'copy' ? fields : [],
        defaultGeneratedColumnsPreserved: mode === 'copy' ? columns.filter(c => /DEFAULT_GENERATED/i.test(c.Extra)).map(c => c.Field) : [],
        actualGeneratedColumns: columns.filter(c => !fields.includes(c.Field)).map(c => c.Field), exactBeforeQuiescence: true });
      if (mode === 'copy') {
        // Preserve every timestamp during intentional quiescence, including
        // ON UPDATE timestamps; only the explicit fields above may differ.
        const timestamps = columns.filter(c => /timestamp|datetime/i.test(c.Type)).map(c => quote(c.Field) + '=' + quote(c.Field));
        const assignments = name === 'cron_jobs' ? ['enabled=0'] : ['database_instances', 'servers'].includes(name) ? ["status='inactive'"] : [];
        if (assignments.length) {
          const predicate = name === 'database_instances' ? ' WHERE id<>1' : name === 'servers' ? ' WHERE id<>3' : '';
          await connection.query('UPDATE ' + quote(target) + '.' + quote(name) + ' SET ' + [...assignments, ...timestamps].join(',') + predicate);
        }
        const final = await read(connection, 'SELECT * FROM ' + quote(target) + '.' + quote(name), undefined, name);
        assertSameRows(expectedIsolationRows(name, sourceRows), final, name + ':quiescence');
        report.inventory.at(-1).finalDigest = rowsDigest(final);
        report.inventory.at(-1).exactAfterAllowedDifferences = true;
      }
    }
    if (!verifyRoute) throw Error('ISOLATION_ROUTE_VERIFIER_REQUIRED');
    report.route = await verifyRoute(connection, source, target);
    await connection.commit();
    report.verified = true;
  } finally {
    try {
      if (owned) {
        await connection.rollback();
        await connection.query('DROP DATABASE ' + quote(target));
        report.cleanup = 'owned_clone_dropped';
      }
      await connection.query('SET FOREIGN_KEY_CHECKS=1');
    } finally {
      save();
    }
  }
  return report;
}
async function main() {
  const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
  if (!args.includes('--source-env') || !args.includes('--out')) throw Error('ISOLATION_REQUIRES_SOURCE_ENV_AND_NEW_OUTPUT');
  const req = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
  const env = req('dotenv').parse(readFileSync(resolve(option('--source-env'))));
  const mysql = req('mysql2/promise');
  const connection = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER,
    password: env.DB_PASSWORD, database: env.DB_NAME, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  try {
    const target = 'slide_qualification_max222_' + Date.now() + '_' + randomUUID().replaceAll('-', '').slice(0, 8);
    const { verifyIsolationRoute } = await import('./investigation-isolation-route.ts');
    const result = await validateIsolatedCopy(connection, env.DB_NAME, target, resolve(option('--out')), verifyIsolationRoute);
    console.log(JSON.stringify({ verified: result.verified, tables: result.inventory.length, modelCalls: 0, readyForModelSend: false, cleanup: result.cleanup }));
  } finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: /^ISOLATION_[A-Z_]+(?::[a-z0-9_,:]+)?$/.test(error.message) ? error.message : 'ISOLATION_VALIDATION_FAILED', code: error.code ?? null })); process.exitCode = 1; });
}
