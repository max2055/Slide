import { dbConnection, encryptData } from '../../apps/db-ops-api/src/db-connection.js';

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
try {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('qualification database pool unavailable');
  await pool.execute('UPDATE llm_providers SET enabled = 0, is_default = 0');
  await pool.execute(
    `UPDATE llm_providers
     SET display_name = 'Qualification Cancellable', api_key_encrypted = ?,
         api_base_url = 'http://127.0.0.1:28900/v1', default_model = 'qualification-cancellable',
         enabled = 1, is_default = 1, deployment_type = 'api', api_format = 'openai-completions'
     WHERE name = 'deepseek'`,
    [encryptData('qualification-local-key-not-a-secret')],
  );
} finally {
  await dbConnection.close();
}
