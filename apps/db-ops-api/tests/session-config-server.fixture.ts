// Test-only selective fault injection; all other SQL and the complete server remain real.
import { existsSync } from 'node:fs';
import { dbConnection } from '../src/db-connection.js';
import { SESSION_IDLE_TIMEOUT_CONFIG_KEY } from '../src/auth/session-config.js';

const initialize = dbConnection.initialize.bind(dbConnection);
dbConnection.initialize = async () => {
  const initialized = await initialize();
  const pool = dbConnection.getPool();
  if (pool) {
    const execute = pool.execute.bind(pool);
    pool.execute = ((sql: string, values?: unknown[]) => {
      if (process.env.SESSION_CONFIG_FAULT_FILE && existsSync(process.env.SESSION_CONFIG_FAULT_FILE)
        && sql.startsWith('SELECT config_value FROM system_config')
        && values?.[0] === SESSION_IDLE_TIMEOUT_CONFIG_KEY) {
        throw new Error('MAX270_PRIVATE_DRIVER_SENTINEL');
      }
      return execute(sql, values);
    }) as typeof pool.execute;
  }
  return initialized;
};
await import('../server.js');
