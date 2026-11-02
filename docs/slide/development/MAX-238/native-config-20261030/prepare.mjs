/**
 * MAX238-NATIVE-CONFIGURATION-FLOW — one-off environment preparation.
 *
 * Reads the shared development database READ-ONLY for the managed instance row
 * (including its encrypted credential), the native template rows and the legacy
 * binding of `instance:1`, then copies them into the one-off platform database.
 * It also creates a test administrator, a local LLM provider row (so the API can
 * start; no model call is made) and nine empty + one draft template rows to
 * exercise catalog pagination and the draft explanation.
 *
 * Secrets are read from the source .env by dotenv and never printed. The target
 * is a throwaway database; the shared database is never written.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(`${fileURLToPath(new URL('../../../../../apps/db-ops-api', import.meta.url))}/package.json`);
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
dotenv.config({ path: process.env.MAX238_ENV_FILE });
const target = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MAX238_DBPORT), user: 'root',
  password: process.env.MAX238_DBPW, database: process.env.MAX238_DB });
const source = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'db_ops_ai' });

await target.query('SET FOREIGN_KEY_CHECKS=0');
const encode = value => value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)
  ? JSON.stringify(value) : value;
const copy = async (table, where = '') => {
  const [targetInfo] = await target.query(`SHOW COLUMNS FROM \`${table}\``);
  const targetColumns = new Set(targetInfo.map(row => row.Field));
  const [sourceInfo] = await source.query(`SHOW COLUMNS FROM \`${table}\``);
  const columns = sourceInfo.map(row => row.Field).filter(column => targetColumns.has(column));
  const [rows] = await source.query(`SELECT ${columns.map(column => `\`${column}\``).join(',')} FROM \`${table}\` ${where}`);
  if (!rows.length) return 0;
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  await target.query(`INSERT IGNORE INTO \`${table}\` (${columns.map(column => `\`${column}\``).join(',')})
    VALUES ${rows.map(() => placeholders).join(',')}`,
  rows.flatMap(row => columns.map(column => encode(row[column]))));
  return rows.length;
};
const copied = {};
for (const table of ['metric_templates_v2', 'metric_template_drafts', 'metric_template_versions',
  'metric_template_items', 'metric_template_item_versions']) copied[table] = await copy(table);
copied.database_instances = await copy('database_instances', 'WHERE id = 1');
copied.metric_policy_groups = await copy('metric_policy_groups');
copied.metric_policy_bindings = await copy('metric_policy_bindings', "WHERE resource_key = 'instance:1'");

const password = process.env.MAX238_ADMIN_PASSWORD;
if (!password) throw new Error('MAX238_ADMIN_PASSWORD is required');
const hash = bcrypt.hashSync(password, 10);
await target.execute(`INSERT INTO users (username, password_hash, email, status, session_version)
  VALUES ('e2e-admin', ?, 'e2e@example.invalid', 'active', 1)
  ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), status = 'active', session_version = 1`, [hash]);
const [user] = await target.execute("SELECT id FROM users WHERE username = 'e2e-admin'");
const [role] = await target.execute("SELECT id FROM roles WHERE name = 'admin'");
const [star] = await target.execute("SELECT id FROM permissions WHERE code = '*'");
await target.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [user[0].id, role[0].id]);
await target.execute('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [role[0].id, star[0].id]);
await target.execute(`INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, 1, 'admin')
  ON DUPLICATE KEY UPDATE access_level = 'admin'`, [user[0].id]);

const [providerColumns] = await target.query('SHOW COLUMNS FROM llm_providers');
const providerNames = new Set(providerColumns.map(row => row.Field));
const provider = { name: 'e2e-local', display_name: 'E2E Local', deployment_type: 'local',
  api_base_url: 'http://127.0.0.1:11434', default_model: 'e2e-model',
  models_supported: JSON.stringify([{ id: 'e2e-model', name: 'E2E' }]), enabled: 1, is_default: 1,
  supports_function_call: 1, supports_vision: 0, context_window: 8192, api_format: 'openai-completions' };
const providerKeys = Object.keys(provider).filter(key => providerNames.has(key));
await target.query(`INSERT INTO llm_providers (${providerKeys.map(key => `\`${key}\``).join(',')})
  VALUES (${providerKeys.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE
  ${providerKeys.filter(key => key !== 'name').map(key => `\`${key}\` = VALUES(\`${key}\`)`).join(',')}`,
providerKeys.map(key => provider[key]));

const at = '2026-10-29T00:00:00.000Z';
for (let index = 1; index <= 8; index++) {
  await target.query(`INSERT IGNORE INTO metric_templates_v2
    (template_id, name, status, current_published_version, revision, created_at, updated_at)
    VALUES (?, ?, 'active', NULL, 0, ?, ?)`, [`e2e-000${index}`, `分页测试模板 ${index}`, at, at]);
}
await target.query(`INSERT IGNORE INTO metric_templates_v2
  (template_id, name, status, current_published_version, revision, created_at, updated_at)
  VALUES ('e2e-draft', '草稿分页模板', 'draft', NULL, 0, ?, ?)`, [at, at]);
const [counts] = await target.query(`SELECT (SELECT COUNT(*) FROM metric_templates_v2) templates,
  (SELECT COUNT(*) FROM metric_policy_bindings) bindings, (SELECT COUNT(*) FROM users) users`);
console.log(JSON.stringify({ copied, counts: counts[0], admin_user_id: user[0].id }));
await source.end(); await target.end();
