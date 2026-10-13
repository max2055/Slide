import { ToolRegistry, type Tool } from '@slide/agent-core';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { sourceManagementService } from '../platform/source-management-service.js';
import { SystemFailurePublisher, installSystemFailurePublisher } from '../platform/system-failure-publisher.js';
import { InvestigationAuthorization, freezeInvestigationCaller } from './authorization.js';
import { MysqlInvestigationBudgetLedger, type BudgetPrices } from './budget-ledger.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { MysqlSystemEventBridge, type SystemComponent } from './system-event-bridge.js';
import { createSystemTools, type SystemToolOptions } from './system-tools.js';
import type { TriggerBinding } from './trigger-policy.js';

export function systemInvestigationConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.INVESTIGATION_SYSTEM_EVENTS_ENABLED === 'true';
  const automatic = env.INVESTIGATION_SYSTEM_AUTO_ENABLED === 'true';
  const serviceUserId = Number(env.INVESTIGATION_SYSTEM_SERVICE_USER_ID);
  if (automatic && !enabled || enabled && (!Number.isSafeInteger(serviceUserId) || serviceUserId < 1))
    throw new Error('SYSTEM_CONFIGURATION_INVALID');
  return Object.freeze({ enabled, automatic, serviceUserId });
}

/** Same composition in the production root and qualification fixtures. No
 * provisioning, role mutation, model call or installation at construction. */
export async function createSystemComposition(poolProvider: () => Pool | null, options: {
  configuration?: ReturnType<typeof systemInvestigationConfiguration>;
  contexts?: ActorContextService;
  source?: SystemToolOptions['source'];
  budget?: ReturnType<typeof investigationBudgetConfiguration> & { prices?: BudgetPrices };
} = {}) {
  const config = options.configuration ?? systemInvestigationConfiguration();
  const contexts = options.contexts ?? new ActorContextService();
  const authorization = new InvestigationAuthorization(contexts);
  const budget: ReturnType<typeof investigationBudgetConfiguration> & { prices?: BudgetPrices } = options.budget ?? investigationBudgetConfiguration();
  const bindings: TriggerBinding[] = [];
  if (config.enabled) {
    const pool = poolProvider(); if (!pool) throw new Error('SYSTEM_STORE_UNAVAILABLE');
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT session_version FROM users WHERE id = ?', [config.serviceUserId]);
    const actor = await contexts.loadInvestigationActorFrom({ execute: (sql, values) => pool.execute(sql, values as never) },
      config.serviceUserId, 'service', Number(rows[0]?.session_version));
    if (!['chat:view', 'config:view'].every(p => actor.permissions.includes(p))) throw new Error('SYSTEM_IDENTITY_INVALID');
    // Hard ceiling remains exact even if the operator later changes its roles.
    const ceiling = freezeInvestigationCaller({ ...actor, roles: [], permissions: ['chat:view', 'config:view'], instanceScopes: {},
      resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } });
    for (const component of ['api', 'collector', 'queue', 'agent'] as const) bindings.push({
      source: `slide.system.${component}`, verified: config.automatic,
      allowedOrigins: ['user_operation', 'collector', 'workflow', 'investigation_engine'],
      policy: { id: `system-${component}`, version: 1, domain: budget.domain, actor: ceiling,
        profileId: 'system', profileVersion: 1, resources: [], component, kinds: ['system.failure'],
        threshold: 1, windowMs: 300_000, cooldownMs: 600_000, criticalSingle: true,
        reserveTokens: 32_000, reserveCostMicros: budget.reserveCostMicros, prices: budget.prices },
    });
  }
  const ledger = new MysqlInvestigationBudgetLedger(poolProvider, budget.policy);
  const bridge = new MysqlSystemEventBridge(poolProvider, bindings,
    b => new MysqlOperationalEventIngest(poolProvider, b, ledger, authorization), authorization);
  const publisher = config.enabled ? new SystemFailurePublisher(f => bridge.record(f)) : undefined;
  let uninstall: (() => void) | undefined;
  const source = options.source ?? sourceManagementService;
  return {
    bridge, publisher, enabled: config.enabled,
    install() { if (publisher && !uninstall) uninstall = installSystemFailurePublisher(publisher); },
    async close() {
      // Stop accepting before draining; no producer can extend shutdown.
      uninstall?.(); uninstall = undefined;
      await publisher?.drain();
    },
    toolsForInvestigation(actor: ActorContext, snapshot: Readonly<Record<string, any>>) {
      const context = snapshot.context;
      const registry = new ToolRegistry();
      if (snapshot.profileId !== 'system' || context?.subject?.kind !== 'platform'
        || !context.from || !context.to) return registry; // no invented window
      for (const tool of createSystemTools({ pool: poolProvider, caller: actor, bridge, source, authorization,
        scope: { investigationId: snapshot.id, component: context.subject.component as SystemComponent,
          from: context.from, to: context.to } })) registry.register({
        name: tool.name, description: tool.description, parameters: tool.parameters as Tool['parameters'],
        readOnly: true, requiresApproval: false, concurrencySafe: false, exclusive: true,
        execute: (args, ctx) => tool.handler(args, { signal: ctx?.signal }),
      });
      return registry;
    },
  };
}
export type SystemComposition = Awaited<ReturnType<typeof createSystemComposition>>;
