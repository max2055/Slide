import { databaseService } from '../../apps/db-ops-api/src/database-service.js';

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

  const metrics = await databaseService.getRealtimeMetrics(oracleId);
  if (!metrics || metrics.db_type !== 'oracle') throw new Error('Oracle metrics readback failed');
  console.log('oracle adapter UAT invariant valid: Oracle connected and returned native metrics');
} finally {
  await databaseService.removeConnection(oracleId);
}
