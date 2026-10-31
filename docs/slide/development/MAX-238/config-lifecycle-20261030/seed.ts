/**
 * MAX238-NATIVE-CONFIGURATION-FLOW-R1 — one-off environment for the complete
 * configuration lifecycle.
 *
 * Creates a throwaway platform schema on an isolated MySQL 8.4 server, runs the
 * real migrations, creates a test administrator, a read-only target schema and
 * two managed instances (one unbound, one with a real legacy single-package
 * binding), and publishes one real template version through the product's own
 * template service. Nothing here touches the shared development database.
 *
 * Ownership is strict: the run owns a random nonce, a handle naming the exact
 * server and schema is written *before* the schema exists, and a failure drops
 * only what that handle proves this run created. A fixed/`process.pid` name is
 * never dropped first.
 *
 * Run with tsx from the repository root:
 *   MAX238_RUN_NONCE=... MAX238_DBPORT=... MAX238_DBPW=... MAX238_ADMIN_PASSWORD=... \
 *   MAX238_TARGET_PASSWORD=... ENCRYPTION_KEY=... node --import tsx seed.ts
 *
 * A nonce is generated when omitted; the printed `database`/`nonce`/`handle`
 * identify the environment for the browser evidence run and for cleanup.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(`${fileURLToPath(new URL('../../../../../apps/db-ops-api', import.meta.url))}/package.json`);
const mysql = require('mysql2/promise');

const {
  MAX238_DBPORT, MAX238_DBPW, MAX238_ADMIN_PASSWORD, MAX238_TARGET_PASSWORD,
} = process.env;
if (!MAX238_DBPORT || !MAX238_DBPW || !MAX238_ADMIN_PASSWORD || !MAX238_TARGET_PASSWORD) {
  throw new Error('MAX238_* environment is required');
}
const port = Number(MAX238_DBPORT);
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3306) {
  throw new Error(`refusing non-isolated MySQL port ${MAX238_DBPORT}`);
}

const { MigrationRunner } = await import('../../../../../apps/db-ops-api/src/migrations/runner.js');
const { encryptData } = await import('../../../../../apps/db-ops-api/src/db-connection.js');
const { createConfigurationRegistry } = await import('../../../../../apps/db-ops-api/src/metrics/config/registry.js');
const { MySqlTemplateRepository } = await import('../../../../../apps/db-ops-api/src/metrics/templates/mysql-repository.js');
const { MetricTemplateService } = await import('../../../../../apps/db-ops-api/src/metrics/templates/service.js');
const { resolvePolicy } = await import('../../../../../apps/db-ops-api/src/metrics/policy/resolver.js');
const { createOwnedDatabase, dropOwnedDatabase, generateRunNonce } = await import('../../../../../apps/db-ops-api/src/testing/owned-fixture.js');
const bcrypt = require('bcrypt');

const nonce: string = process.env.MAX238_RUN_NONCE || generateRunNonce();
const handleDir = process.env.MAX238_HANDLE_DIR || `${process.cwd()}/.max238-handles`;
// MySQL caps user names at 32 characters; the nonce is folded into a short digest.
const targetUser = `max238_ro_${createHash('sha256').update(nonce).digest('hex').slice(0, 16)}`;

async function main(): Promise<void> {
  const root = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: MAX238_DBPW });
  let platform: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
  let target: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
  try {
    platform = await createOwnedDatabase(root, { nonce, purpose: 'flow', handleDir });
    target = await createOwnedDatabase(root, { nonce, purpose: 'target', handleDir });
    await root.query(`CREATE TABLE \`${target.database}\`.lifecycle_probe (id INT PRIMARY KEY, label VARCHAR(64))`);
    await root.query(`INSERT INTO \`${target.database}\`.lifecycle_probe VALUES (1, 'max238-lifecycle')`);
    // A nonce-named user; an existing one is a neighbour, not ours to reuse.
    await root.query(`CREATE USER '${targetUser}'@'%' IDENTIFIED BY ?`, [MAX238_TARGET_PASSWORD]);
    await root.query(`GRANT SELECT ON \`${target.database}\`.* TO '${targetUser}'@'%'`);
    await root.query(`GRANT PROCESS ON *.* TO '${targetUser}'@'%'`);
  } catch (error) {
    const errors: unknown[] = [];
    await root.query(`DROP USER IF EXISTS '${targetUser}'@'%'`).catch(problem => errors.push(problem));
    await target?.drop().catch(problem => errors.push(problem));
    await platform?.drop().catch(problem => errors.push(problem));
    await root.end().catch(problem => errors.push(problem));
    throw errors[0] ?? error;
  }
  await root.end();

  const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: MAX238_DBPW,
    database: platform.database, timezone: 'Z', multipleStatements: false });
  pool.on('connection', connection => connection.query("SET time_zone='+00:00'"));
  try {
    const runner = new MigrationRunner(pool as never);
    await runner.run();
    await runner.run();

    /* --- identity ------------------------------------------------------------ */
    const at = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(MAX238_ADMIN_PASSWORD, 10);
    await pool.execute(`INSERT INTO users (username, password_hash, email, status, session_version)
      VALUES ('life-admin', ?, 'life@example.invalid', 'active', 1)
      ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active', session_version = 1`, [passwordHash]);
    const [[admin]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM users WHERE username = 'life-admin'");
    const [[role]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM roles WHERE name = 'admin'");
    // A non-admin operator: real permissions, no implicit `*`. Only this identity can
    // demonstrate a resource-grant revocation while its session stays valid.
    const [[operatorRole]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM roles WHERE name = 'dba'");
    for (const code of ['instance:manage', 'instance:view', 'metric:manage', 'metric:view']) {
      await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?',
        [operatorRole.id, code]);
    }
    await pool.execute(`INSERT INTO users (username, password_hash, email, status, session_version)
      VALUES ('life-operator', ?, 'operator@example.invalid', 'active', 1)
      ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active', session_version = 1`,
    [bcrypt.hashSync(`${MAX238_ADMIN_PASSWORD}-operator`, 10)]);
    const [[operatorUser]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM users WHERE username = 'life-operator'");
    await pool.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [operatorUser.id, operatorRole.id]);
    const [[star]] = await pool.query<mysql.RowDataPacket[]>("SELECT id FROM permissions WHERE code = '*'");
    await pool.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [admin.id, role.id]);
    await pool.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, star.id]);

    /* --- a local LLM provider row so the API boots; no model call is made ------ */
    const [providerColumns] = await pool.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM llm_providers');
    const providerNames = new Set(providerColumns.map(row => String(row.Field)));
    const provider: Record<string, unknown> = { name: 'life-local', display_name: 'Lifecycle Local', deployment_type: 'local',
      api_base_url: 'http://127.0.0.1:11434', default_model: 'life-model',
      models_supported: JSON.stringify([{ id: 'life-model', name: 'Lifecycle' }]), enabled: 1, is_default: 1,
      supports_function_call: 1, supports_vision: 0, context_window: 8192, api_format: 'openai-completions' };
    const providerKeys = Object.keys(provider).filter(key => providerNames.has(key));
    await pool.query(`INSERT INTO llm_providers (${providerKeys.map(key => `\`${key}\``).join(',')})
      VALUES (${providerKeys.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE
      ${providerKeys.filter(key => key !== 'name').map(key => `\`${key}\` = VALUES(\`${key}\`)`).join(',')}`,
    providerKeys.map(key => provider[key]));

    /* --- two managed instances on the isolated target -------------------------- */
    const targetConfig = { host: '127.0.0.1', port, database: target.database, username: targetUser };
    const credential = encryptData(MAX238_TARGET_PASSWORD);
    const instanceRow = async (name: string) => {
      await pool.execute(`INSERT INTO database_instances
        (name, environment, db_type, host, port, username, password_encrypted, database_name, status, lifecycle_state,
         max_connections, connection_timeout_ms, created_by, created_at, updated_at)
        VALUES (?, 'testing', 'mysql', ?, ?, ?, ?, ?, 'active', 'available', 10, 5000, ?, ?, ?)`,
      [name, targetConfig.host, targetConfig.port, targetConfig.username, credential, targetConfig.database, admin.id,
        at.replace('T', ' ').replace('Z', ''), at.replace('T', ' ').replace('Z', '')]);
      const [[row]] = await pool.query<mysql.RowDataPacket[]>('SELECT id FROM database_instances WHERE name = ?', [name]);
      await pool.execute(`INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'admin')
        ON DUPLICATE KEY UPDATE access_level = 'admin'`, [admin.id, row.id]);
      return Number(row.id);
    };
    const unboundId = await instanceRow('life-unbound');
    // A second unbound resource for the browser case that must refuse a write
    // whose durable intent cannot be recorded.
    const unboundSecondId = await instanceRow('life-unbound-storage');
    const legacyId = await instanceRow('life-legacy');
    // A second legacy resource is left untouched by the API flow so the browser can
    // demonstrate the explicit entry and the lossless seeding of a package binding.
    const legacyUiId = await instanceRow('life-legacy-ui');
    await pool.execute(`INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, ?, 'admin')
      ON DUPLICATE KEY UPDATE access_level = 'admin'`, [operatorUser.id, legacyId]);

    /* --- a real legacy single-package binding for the conversion scenario ------ */
    const registry = createConfigurationRegistry();
    const packagePin = registry.list().map(entry => entry.package).find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
    const release = registry.get({ id: packagePin.id, version: packagePin.version, digest: packagePin.digest });
    const definitions = registry.catalog({ id: release.package.id, version: release.package.version, digest: release.package.digest });
    const capabilities = definitions.filter(definition => definition.id === 'mysql.processlist.count')
      .map(definition => ({
        resource_id: String(legacyId), metric: { id: definition.id, semantic_version: definition.semantic_version },
        method: 'sql' as const, status: 'supported' as const,
        basis: [{ kind: 'method' as const, evidence: 'lifecycle_fixture_real_read' }],
        evaluated_at: at, valid_until: new Date(Date.parse(at) + 86_400_000).toISOString(),
      }));
    const legacyOverrides = { interval_ms: { mode: 'set' as const, value: 45000 }, max_rows: { mode: 'set' as const, value: 50 } };
    const binding = { resource: { type: 'instance' as const, id: legacyId },
      package: { id: release.package.id, version: release.package.version, digest: release.package.digest },
      group_id: null, overrides: {}, revision: 3, template_pins: [] };
    const resource = { type: 'instance' as const, id: String(legacyId),
      attributes: { 'db.engine': { value: 'mysql', source: 'fixture', observed_at: at },
        'db.version': { value: '8.4', source: 'fixture', observed_at: at } } };
    const resolved = resolvePolicy(registry, binding, null, resource as never, capabilities, at);
    const published = { binding, resolved, published_at: at,
      application: { applied_revision: 3, reported_at: at, status: 'applied', error_code: null } };
    await pool.execute(`INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities)
      VALUES (?, NULL, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload), capabilities = VALUES(capabilities)`,
    [`instance:${legacyId}`, JSON.stringify(published), JSON.stringify(capabilities)]);
    {
      const uiBinding = { ...binding, resource: { type: 'instance' as const, id: legacyUiId }, overrides: legacyOverrides };
      const uiResource = { ...resource, id: String(legacyUiId) };
      const uiCapabilities = capabilities.map(entry => ({ ...entry, resource_id: String(legacyUiId) }));
      const uiResolved = resolvePolicy(registry, uiBinding, null, uiResource as never, uiCapabilities, at);
      const uiPublished = { binding: uiBinding, resolved: uiResolved, published_at: at,
        application: { applied_revision: 3, reported_at: at, status: 'applied', error_code: null } };
      await pool.execute(`INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities)
        VALUES (?, NULL, ?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload), capabilities = VALUES(capabilities)`,
      [`instance:${legacyUiId}`, JSON.stringify(uiPublished), JSON.stringify(uiCapabilities)]);
    }

    /* --- one published template version through the product's own service ------ */
    const actor = { userId: admin.id, username: 'life-admin', roles: ['admin'], permissions: ['*'],
      sessionVersion: 1, instanceScopes: {}, requestId: 'max238-life-seed' };
    const repository = new MySqlTemplateRepository(pool as never);
    const service = new MetricTemplateService(repository, registry);
    const template = await service.create(actor as never, { name: 'MAX238 lifecycle template' });
    const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
    const selected = await service.selectMetric(actor as never, template.template_id, { package: pin,
      metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' } });
    const draft = await repository.getDraft(template.template_id);
    const aggregate = structuredClone(draft!.aggregate) as Record<string, unknown>;
    aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
    await repository.updateDraft(template.template_id, draft!.revision,
      { aggregate: aggregate as never, updated_by: admin.id, updated_at: at });
    const draftAfter = await repository.getDraft(template.template_id);
    const publishedTemplate = await service.publish(actor as never, template.template_id,
      { expected_draft_revision: draftAfter!.revision, expected_revision: template.revision });
    // Publishing a version does not change the template's own status; activate it as
    // an operator would, so the catalog offers it instead of a draft.
    const publishedRecord = await repository.getTemplate(template.template_id);
    await repository.updateTemplate(template.template_id, publishedRecord!.revision,
      { status: 'active', updated_at: new Date(Date.parse(at) + 1000).toISOString() });
    const record = await repository.getTemplate(template.template_id);
    const version = await repository.getVersion(template.template_id, publishedTemplate.version);

    console.log(JSON.stringify({ database: platform.database, target_database: target.database,
      nonce, handle_dir: handleDir, target_user: targetUser,
      admin_user_id: admin.id, unbound_instance: unboundId, unbound_storage_instance: unboundSecondId, legacy_instance: legacyId,
      legacy_ui_instance: legacyUiId,
      template: { template_id: template.template_id, version: publishedTemplate.version,
        content_hash: publishedTemplate.content_hash, current: record?.current_published_version,
        items: version?.items.map(item => ({ item_id: item.item_id, metric: item.canonical_metric.id,
          release: item.collector_ref.package_release, implementation: item.collector_ref.implementation_id })) },
      capabilities_known: capabilities.length }, null, 1));
  } catch (error) {
    // The environment is unusable: drop only what the handles prove this run
    // created, and leave any unknown handle in place.
    const errors: unknown[] = [];
    await pool?.end().catch((problem: unknown) => errors.push(problem));
    const cleanup = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: MAX238_DBPW });
    await cleanup.query(`DROP USER IF EXISTS '${targetUser}'@'%'`).catch(problem => errors.push(problem));
    await dropOwnedDatabase(cleanup, { nonce, purpose: 'target', handleDir }).catch(problem => errors.push(problem));
    await dropOwnedDatabase(cleanup, { nonce, purpose: 'flow', handleDir }).catch(problem => errors.push(problem));
    await cleanup.end().catch(problem => errors.push(problem));
    throw errors[0] ?? error;
  }
  await pool.end();
}

await main();
