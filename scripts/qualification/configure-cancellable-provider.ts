import { dbConnection, encryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { configureQualificationProvider } from './configure-provider.js';

const port = Number(process.env.QUALIFICATION_CANCELLABLE_LLM_PORT || 28900);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid qualification provider port');

if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
try {
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('qualification database pool unavailable');
  await configureQualificationProvider(pool, {
    displayName: 'Qualification Cancellable',
    encryptedApiKey: encryptData('qualification-local-key-not-a-secret'),
    baseUrl: `http://127.0.0.1:${port}/v1`, model: 'qualification-cancellable',
  });
} finally {
  await dbConnection.close();
}
