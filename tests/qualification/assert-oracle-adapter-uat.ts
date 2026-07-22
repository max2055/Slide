import { databaseService } from '../../apps/db-ops-api/src/database-service.js';
import { sqlExecutor } from '../../apps/db-ops-api/src/sql-executor.js';

const user = process.env.QUALIFICATION_ORACLE_USER;
const password = process.env.QUALIFICATION_ORACLE_PASSWORD;
if (!user || !password) {
  throw new Error('QUALIFICATION_ORACLE_USER and QUALIFICATION_ORACLE_PASSWORD are required');
}

const oracleId = 991_003;

try {
  const connected = await databaseService.addConnection(oracleId, 'qualification-oracle', {
    host: process.env.QUALIFICATION_ORACLE_HOST ?? '127.0.0.1',
    port: Number(process.env.QUALIFICATION_ORACLE_PORT ?? '1521'),
    user,
    password,
    database: process.env.QUALIFICATION_ORACLE_DATABASE ?? 'ORCLCDB',
    db_type: 'oracle',
  });
  if (!connected) throw new Error('Oracle adapter connection failed');

  if (!await databaseService.ensureConnectionAlive(oracleId)) throw new Error('Oracle health probe failed');
  const query = await sqlExecutor.executeSql(oracleId, 'SELECT 1 AS qualification_value FROM dual');
  if (!query.success || query.rowCount !== 1) {
    throw new Error(`Oracle read query failed: success=${query.success} rowCount=${query.rowCount ?? 'missing'} error=${query.error ?? 'none'}`);
  }

  const metrics = await databaseService.getRealtimeMetrics(oracleId);
  if (!metrics || metrics.db_type !== 'oracle') throw new Error('Oracle metrics readback failed');
  await databaseService.removeConnection(oracleId);
  if (databaseService.getConnection(oracleId)) throw new Error('Oracle disconnect failed');
  const recovered = await databaseService.addConnection(oracleId, 'qualification-oracle-recovered', {
    host: process.env.QUALIFICATION_ORACLE_HOST ?? '127.0.0.1', port: Number(process.env.QUALIFICATION_ORACLE_PORT ?? '1521'),
    user, password, database: process.env.QUALIFICATION_ORACLE_DATABASE ?? 'ORCLCDB', db_type: 'oracle',
  });
  if (!recovered) throw new Error('Oracle recovery failed');
  console.log('oracle adapter UAT invariant valid: Oracle connection, health, query, metrics, disconnect, and recovery passed');
} finally {
  await databaseService.removeConnection(oracleId);
}
