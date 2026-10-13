import mysql from 'mysql2/promise';
import { ActorContextService } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { MysqlSystemEventBridge } from './system-event-bridge.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import type { TriggerBinding } from './trigger-policy.js';

// Test-only independent process; fixture schema/identity passed by the owning
// integration test. No production environment/provider/model configuration.
const input = JSON.parse(process.env.SYSTEM_RECOVERY_FIXTURE!);
const pool = mysql.createPool({ host: '127.0.0.1', port: input.port, user: 'root', password: '', database: input.database, timezone: 'Z' });
try {
  const contexts = new ActorContextService(() => pool as never), authorization = new InvestigationAuthorization(contexts);
  const actor = { ...await contexts.loadInvestigationActorFrom(pool as never, input.serviceId, 'service', 1),
    resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
  const binding: TriggerBinding = { ...input.binding, policy: { ...input.binding.policy, actor } };
  const ledger = new MysqlInvestigationBudgetLedger(() => pool, input.quota);
  const bridge = new MysqlSystemEventBridge(() => pool, [binding], b => new MysqlOperationalEventIngest(() => pool, b, ledger, authorization), authorization);
  const facts = await bridge.readFacts(actor, input.investigationId, input.scope);
  process.stdout.write(JSON.stringify({ count: facts.length, sourceEventId: facts[0]?.event.sourceEventId, contentHash: facts[0]?.contentHash }));
} finally { await pool.end(); }
