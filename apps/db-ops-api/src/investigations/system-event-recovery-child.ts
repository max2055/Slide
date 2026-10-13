import mysql from 'mysql2/promise';
import { ActorContextService } from '../auth/actor-context.js';
import { InvestigationAuthorization } from './authorization.js';
import { MysqlSystemEventBridge } from './system-event-bridge.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import type { TriggerBinding } from './trigger-policy.js';
import { createSystemComposition } from './system-composition.js';
import { InvestigationExecutor } from './executor.js';
import { ToolRegistry } from '@slide/agent-core';

// Test-only independent process; fixture schema/identity passed by the owning
// integration test. No production environment/provider/model configuration.
const input = JSON.parse(process.env.SYSTEM_RECOVERY_FIXTURE!);
const pool = mysql.createPool({ host: '127.0.0.1', port: input.port, user: 'root', password: '', database: input.database, timezone: 'Z' });
try {
  const contexts = new ActorContextService(() => pool as never), authorization = new InvestigationAuthorization(contexts);
  const actor = { ...await contexts.loadInvestigationActorFrom(pool as never, input.serviceId, 'service', 1),
    resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } };
  if (input.composed) {
    const [rows] = await pool.query<any[]>('SELECT request_snapshot FROM investigation_requests WHERE investigation_id = ? ORDER BY created_at LIMIT 1', [input.investigationId]);
    const snapshot = typeof rows[0].request_snapshot === 'string' ? JSON.parse(rows[0].request_snapshot) : rows[0].request_snapshot;
    const composition = await createSystemComposition(() => pool, { contexts, configuration: { enabled: false, automatic: false, serviceUserId: 0 } });
    try {
      const result = await composition.toolsForInvestigation(actor, snapshot).get('get_platform_observations')!.execute({}) as any;
      const facts = result.data.facts;
      let recovery: Record<string, unknown> = {};
      if (input.execute) {
        const executor = new InvestigationExecutor({ pool: () => pool, authorization,
          systemToolsForInvestigation: composition.toolsForInvestigation, toolsForActor: () => new ToolRegistry(),
          providerForPurpose: async () => { throw new Error('RECOVERY_MUST_NOT_DISPATCH_PROVIDER'); },
          budget: { domain: 'system-test', policy: input.quota, reserveCostMicros: 100 } });
        const run = await executor.execute({ ...input.execute, context: { ...input.execute.context, signal: new AbortController().signal } });
        const [results] = await pool.query<any[]>('SELECT result_json FROM investigation_results WHERE investigation_id = ?', [input.investigationId]);
        const [evidence] = await pool.query<any[]>('SELECT id FROM investigation_evidence WHERE investigation_id = ?', [input.investigationId]);
        const [messages] = await pool.query<any[]>("SELECT message_id FROM agent_canonical_facts WHERE session_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(entry_json, '$.role')) = 'tool'", [run.sessionId]);
        recovery = { runId: run.id, state: run.state, results: results.length, evidence: evidence.length, toolMessages: messages.length };
      }
      process.stdout.write(JSON.stringify({ count: facts.length, sourceEventId: facts[0]?.event.sourceEventId,
        contentHash: facts[0]?.contentHash, observedFrom: result.data.observedFrom, observedTo: result.data.observedTo,
        receivedAt: result.data.receivedAt, gaps: result.data.gaps, ...recovery }));
    } finally { await composition.close(); }
  } else {
    const binding: TriggerBinding = { ...input.binding, policy: { ...input.binding.policy, actor } };
    const ledger = new MysqlInvestigationBudgetLedger(() => pool, input.quota);
    const bridge = new MysqlSystemEventBridge(() => pool, [binding], b => new MysqlOperationalEventIngest(() => pool, b, ledger, authorization), authorization);
    const facts = await bridge.readFacts(actor, input.investigationId, input.scope);
    process.stdout.write(JSON.stringify({ count: facts.length, sourceEventId: facts[0]?.event.sourceEventId, contentHash: facts[0]?.contentHash }));
  }
} finally { await pool.end(); }
