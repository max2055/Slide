import { dbConnection, encryptData } from '../../apps/db-ops-api/src/db-connection.js';

const apiKey = process.env.QUALIFICATION_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('QUALIFICATION_DEEPSEEK_API_KEY is required');
if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');

try {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('qualification database pool unavailable');
  await pool.execute('UPDATE llm_providers SET enabled = 0, is_default = 0');
  await pool.execute(
    `UPDATE llm_providers
     SET display_name = 'Qualification DeepSeek', api_key_encrypted = ?, api_base_url = 'https://api.deepseek.com/v1',
         default_model = 'deepseek-chat', enabled = 1, is_default = 1, deployment_type = 'api',
         api_format = 'openai-completions'
     WHERE name = 'deepseek'`,
    [encryptData(apiKey)],
  );
  console.log('qualification DeepSeek provider configured');
} finally {
  await dbConnection.close();
}
