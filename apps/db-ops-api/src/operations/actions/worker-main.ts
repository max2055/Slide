/** Independent process: never imports server/AgentEngine or a model provider. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { dbConnection } from '../../db-connection.js';
import { loadSecurityConfig } from '../../config/security-config.js';
import { createOperationsComposition } from '../composition.js';
import { MysqlWorkflowStore } from '../../workflows/worker-runtime.js';
import { createActionWorker } from './worker.js';

const security = loadSecurityConfig(process.env);
if (!security.jwtSecret || security.jwtSecret.length < 32) throw new Error('OPERATIONS_CURSOR_SECRET_INVALID');
if (!await dbConnection.initialize()) throw new Error('OPERATIONS_DEPENDENCY_UNAVAILABLE');
const composition = createOperationsComposition(() => dbConnection.getPool(), { jwtSecret: security.jwtSecret });
const worker = createActionWorker(composition, new MysqlWorkflowStore(() => dbConnection.getPool() as never), randomUUID());
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log('OPERATIONS_ACTION_WORKER_READY');
try {
  while (!stopping) {
    await worker.runOnce();
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await worker.shutdown(); await dbConnection.close(); }
