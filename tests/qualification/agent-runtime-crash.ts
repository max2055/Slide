import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { AgentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service.js';

if (!/^slide_runtime_[a-f0-9]{32}$/.test(process.env.DB_NAME ?? '')) throw new Error('Crash probe requires an isolated runtime schema');
if (!await dbConnection.initialize()) throw new Error('Crash probe database unavailable');
const pool = dbConnection.getPool()!;
const runId = process.env.QUALIFICATION_CRASH_RUN_ID!;
const actorId = Number(process.env.QUALIFICATION_CRASH_ACTOR_ID);
const sessionId = process.env.QUALIFICATION_CRASH_SESSION_ID!;
const service = new AgentRunService(() => ({
  query: pool.query.bind(pool),
  getConnection: async () => {
    const connection = await pool.getConnection();
    return {
      beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
      rollback: () => connection.rollback(), release: () => connection.release(),
      query: async (sql: string, values?: unknown[]) => {
        // Exit after the assistant INSERT, before the transaction's terminal UPDATE/COMMIT.
        // The database must roll back this connection while the staged intent survives.
        if (sql.includes("UPDATE agent_runs SET state = 'completed'")) process.exit(74);
        return connection.query(sql, values);
      },
    };
  },
}) as any);
const run = await service.getForActor(runId, actorId, sessionId);
if (!run) throw new Error('Crash probe run missing');
await service.complete(run, { type: 'complete', finalContent: '崩溃恢复结论' });
throw new Error('Crash injection did not fire');
