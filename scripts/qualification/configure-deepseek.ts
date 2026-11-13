import { dbConnection, encryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { configureQualificationProvider } from './configure-provider.js';

const apiKey = process.env.QUALIFICATION_DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('QUALIFICATION_DEEPSEEK_API_KEY is required');
if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');

try {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('qualification database pool unavailable');
  await configureQualificationProvider(pool, {
    displayName: 'Qualification DeepSeek', encryptedApiKey: encryptData(apiKey),
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
  });
  console.log('qualification DeepSeek provider configured');
} finally {
  await dbConnection.close();
}
