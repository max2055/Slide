/**
 * MAX-237 / T3 — one-shot evidence CLI (not mounted, not imported by any
 * route, process or scheduler).
 *
 * Default is a dry run: it verifies the pinned Zabbix checkout, converts the
 * three fixed official templates and writes the conversion report. `--apply`
 * additionally uses the application's existing `dbConnection` pool to
 *  1. verify `database_instances.id = 1` is `mysql3306:3306` (read-only),
 *  2. create only the missing T2B tables from the accepted candidate DDL with
 *     `CREATE TABLE IF NOT EXISTS`,
 *  3. import the three templates through `MySqlTemplateRepository`, and
 *  4. re-read them by upstream uuid and compare the item counts.
 *
 * No credential, password, DSN or connection string is printed or written.
 *
 * Usage (cwd `apps/db-ops-api`, so dotenv reads that package's own `.env`):
 *   tsx src/metrics/templates/max237-zabbix-import-cli.ts \
 *     --zabbix-ref /path/to/zabbix --repo-root ../.. \
 *     --out ../../docs/slide/development/MAX-237/t3/evidence [--apply]
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dbConnection } from '../../db-connection.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { createSnmpPackage } from '../snmp/package.js';
import { MySqlTemplateRepository, type TemplateSqlPool } from './mysql-repository.js';
import {
  OFFICIAL_SOURCES, ZABBIX_REFERENCE, convertOfficialTemplate, parseOfficialExport,
  type ConvertedTemplate, type OfficialSource,
} from './zabbix-official-templates.js';
import { importConvertedTemplate, type ImportResult } from './zabbix-template-import.js';

interface Args {
  zabbixRef: string;
  repoRoot: string;
  out: string;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const zabbixRef = get('--zabbix-ref');
  const out = get('--out');
  if (!zabbixRef || !out) throw new Error('USAGE: --zabbix-ref <dir> --out <dir> [--repo-root <dir>] [--apply]');
  return {
    zabbixRef: resolve(zabbixRef),
    repoRoot: resolve(get('--repo-root') ?? resolve(process.cwd(), '../..')),
    out: resolve(out),
    apply: argv.includes('--apply'),
  };
}

const registryFor = (source: OfficialSource) =>
  source.packageRoot === 'snmp' ? createSnmpPackage().registry : createBuiltinRegistry();

const loadConversions = (args: Args): { converted: ConvertedTemplate[]; head: string } => {
  const head = execFileSync('git', ['-C', args.zabbixRef, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== ZABBIX_REFERENCE.commit) throw new Error(`ZABBIX_COMMIT_MISMATCH:${head}`);
  const converted = OFFICIAL_SOURCES.map(source => {
    const text = readFileSync(join(args.zabbixRef, source.path), 'utf8');
    return convertOfficialTemplate(parseOfficialExport(text), source, registryFor(source));
  });
  return { converted, head };
};

const conversionReport = (converted: ConvertedTemplate[], head: string) => ({
  zabbix_reference: { ...ZABBIX_REFERENCE, head },
  templates: converted.map(template => ({
    category: template.category,
    source: template.source,
    template_id: template.template_id,
    name: template.name,
    interval_ms: template.interval_ms,
    parameters: template.parameters,
    converted_item_count: template.items.length,
    items: template.items,
    unsupported_count: template.unsupported.length,
    unsupported: template.unsupported,
    triggers: template.triggers,
    credential_macros_dropped: template.credential_macros_dropped,
    graphs_not_converted: template.graphs_not_converted,
    verified_objects: 'none',
    note: 'converted from the fixed official source; no real device/database was collected against',
  })),
});

const EXPECTED_TABLES = [
  'metric_templates_v2',
  'metric_template_drafts',
  'metric_template_versions',
  'metric_template_items',
  'metric_template_item_versions',
] as const;
const BUSINESS_TABLES = ['users', 'database_instances', 'servers'] as const;

const countRows = async (query: (sql: string, values?: unknown[]) => Promise<any>, table: string): Promise<number> => {
  const [rows] = await query(`SELECT COUNT(*) AS c FROM \`${table}\``);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return Number(row?.c ?? 0);
};

async function applyToDatabase(args: Args, converted: ConvertedTemplate[]) {
  let pool = dbConnection.getPool();
  if (!pool) {
    const ready = await dbConnection.initialize();
    pool = dbConnection.getPool();
    if (!ready || !pool) throw new Error('APP_POOL_UNAVAILABLE');
  }
  const query = async (sql: string, values?: unknown[]) => pool.query(sql, values as any) as Promise<[any, any]>;

  // 1. Read-only target check before any write.
  const [instances] = await query(
    'SELECT id, name, db_type, host, port, database_name, status FROM database_instances WHERE id = 1',
  );
  const instance = Array.isArray(instances) ? instances[0] : undefined;
  if (!instance || instance.name !== 'mysql3306' || Number(instance.port) !== 3306) {
    throw new Error(`TARGET_INSTANCE_MISMATCH:${JSON.stringify(instance ?? null)}`);
  }

  const before: Record<string, number> = {};
  for (const table of [...BUSINESS_TABLES, 'metric_templates']) before[table] = await countRows(query, table);

  // 2. Create only the missing accepted tables.
  const [existingRows] = await query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'metric_template%'",
  );
  const existing = new Set<string>((Array.isArray(existingRows) ? existingRows : []).map((row: any) => String(row.name)));
  const ddlPath = join(args.repoRoot, 'docs/slide/development/MAX-237/t2b/sql/t2b_metric_template_aggregate.sql');
  const ddl = readFileSync(ddlPath, 'utf8').split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  const created: string[] = [];
  for (const statement of ddl.split(';').map(part => part.trim()).filter(Boolean)) {
    const match = /^CREATE TABLE\s+([A-Za-z0-9_]+)/.exec(statement);
    if (!match) continue;
    const table = match[1]!;
    if (existing.has(table)) continue;
    await pool.query(statement.replace(/^CREATE TABLE\s+/, 'CREATE TABLE IF NOT EXISTS '));
    created.push(table);
  }
  const [afterCreateRows] = await query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'metric_template%'",
  );
  const afterCreate = new Set<string>((Array.isArray(afterCreateRows) ? afterCreateRows : []).map((row: any) => String(row.name)));
  const missing = EXPECTED_TABLES.filter(table => !afterCreate.has(table));
  if (missing.length) throw new Error(`T2B_TABLES_MISSING:${missing.join(',')}`);

  // 3. Import through the accepted repository.
  const repository = new MySqlTemplateRepository(pool as unknown as TemplateSqlPool);
  const now = new Date().toISOString();
  const imports: ImportResult[] = [];
  for (const template of converted) {
    imports.push(await importConvertedTemplate(repository, registryFor(OFFICIAL_SOURCES.find(source =>
      source.template_uuid === template.template_id)!), template, {
      now,
      request_id: `max237-t3:${template.source.template_uuid}`,
      migration_ref: `zabbix-${ZABBIX_REFERENCE.version}@${ZABBIX_REFERENCE.commit.slice(0, 8)}:${template.source.template_uuid}`,
    }));
  }

  // 4. Re-read by upstream uuid and compare the conversion report's item count.
  const readback = [];
  for (const [index, template] of converted.entries()) {
    const imported = imports[index]!;
    const record = await repository.getTemplate(template.template_id);
    const current = record?.current_published_version === null || record?.current_published_version === undefined
      ? null : await repository.getVersion(template.template_id, record.current_published_version);
    const items = await repository.latestItemVersions(template.template_id);
    const expected = template.items.map(item => item.item_id).sort();
    const actual = items.map(item => item.item_id).sort();
    const itemCountMatches = actual.length === expected.length && actual.every((id, position) => id === expected[position]);
    readback.push({
      template_id: template.template_id,
      name: template.name,
      status: record?.status ?? null,
      current_published_version: record?.current_published_version ?? null,
      content_hash: current?.content_hash ?? null,
      expected_item_count: expected.length,
      actual_item_count: actual.length,
      item_count_matches: itemCountMatches,
      item_ids: actual,
      version: current?.version ?? null,
      action: imported.action,
    });
    if (!itemCountMatches) throw new Error(`IMPORT_READBACK_MISMATCH:${template.template_id}`);
  }

  const after: Record<string, number> = {};
  for (const table of Object.keys(before)) after[table] = await countRows(query, table);
  const countsPreserved = Object.keys(before).every(table => before[table] === after[table]);

  return {
    target: {
      instance_id: instance.id,
      name: instance.name,
      db_type: instance.db_type,
      port: Number(instance.port),
      // Host and database name are intentionally not echoed beyond the local check.
      instance_matches: true,
    },
    tables: {
      expected: [...EXPECTED_TABLES],
      existed_before: [...existing].filter(name => EXPECTED_TABLES.includes(name as any)),
      created,
      missing_after: missing,
    },
    business_counts: { before, after, preserved: countsPreserved },
    imports: imports.map(result => ({
      template_id: result.template_id,
      action: result.action,
      version: result.version,
      content_hash: result.content_hash,
      item_count: result.item_count,
      mapping_trace: result.mapping_trace,
    })),
    readback,
    applied_at: now,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { converted, head } = loadConversions(args);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 't3-conversion.json'), `${JSON.stringify(conversionReport(converted, head), null, 2)}\n`);
  if (!args.apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      head,
      templates: converted.map(template => ({
        template_id: template.template_id,
        converted: template.items.length,
        unsupported: template.unsupported.length,
        triggers: template.triggers.length,
      })),
    }, null, 2));
    return;
  }
  const evidence = await applyToDatabase(args, converted);
  writeFileSync(join(args.out, 't3-import.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: 'apply',
    created_tables: evidence.tables.created,
    counts_preserved: evidence.business_counts.preserved,
    readback: evidence.readback.map(row => ({
      template_id: row.template_id,
      items: row.actual_item_count,
      status: row.status,
      current_published_version: row.current_published_version,
    })),
  }, null, 2));
}

main().catch(error => {
  console.error(`MAX237_T3_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
