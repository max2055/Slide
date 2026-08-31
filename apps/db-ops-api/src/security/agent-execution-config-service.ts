import { dbConnection } from '../db-connection.js';

export const AGENT_EXECUTION_CONFIG_KEYS = Object.freeze({
  approvalEnabled: 'agent_tool_approval_enabled',
  restrictedNetworkEnabled: 'agent_sandbox_network_enabled',
});

const DESCRIPTIONS = Object.freeze({
  approvalEnabled: 'Require approval before Agent code execution and database network discovery',
  restrictedNetworkEnabled: 'Allow Agent code execution to request the dedicated restricted sandbox network',
});

interface ConfigExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export type AgentExecutionConfigReason =
  | 'EXECUTION_CONFIG_READY'
  | 'EXECUTION_CONFIG_UNAVAILABLE'
  | 'EXECUTION_CONFIG_UPDATED';

export interface AgentExecutionConfigState {
  approvalEnabled: boolean;
  restrictedNetworkEnabled: boolean;
  reasonCode: AgentExecutionConfigReason;
}

export interface AgentExecutionConfigUpdate {
  approvalEnabled?: boolean;
  restrictedNetworkEnabled?: boolean;
}

function strictBoolean(value: unknown): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export class AgentExecutionConfigService {
  constructor(
    private readonly executorProvider: () => ConfigExecutor | null = () => dbConnection.getPool() as ConfigExecutor | null,
  ) {}

  async get(): Promise<AgentExecutionConfigState> {
    const executor = this.executorProvider();
    if (!executor) return { approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_UNAVAILABLE' };
    try {
      const [rows] = await executor.execute(
        `SELECT config_key, config_value FROM system_config
         WHERE config_key IN (?, ?)`,
        [AGENT_EXECUTION_CONFIG_KEYS.approvalEnabled, AGENT_EXECUTION_CONFIG_KEYS.restrictedNetworkEnabled],
      );
      const values = new Map<string, boolean | undefined>();
      for (const row of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
        values.set(String(row.config_key), strictBoolean(row.config_value));
      }
      const approvalEnabled = values.get(AGENT_EXECUTION_CONFIG_KEYS.approvalEnabled);
      const restrictedNetworkEnabled = values.get(AGENT_EXECUTION_CONFIG_KEYS.restrictedNetworkEnabled);
      if (approvalEnabled === undefined || restrictedNetworkEnabled === undefined) {
        return {
          approvalEnabled: approvalEnabled ?? true,
          restrictedNetworkEnabled: restrictedNetworkEnabled ?? false,
          reasonCode: 'EXECUTION_CONFIG_UNAVAILABLE',
        };
      }
      return { approvalEnabled, restrictedNetworkEnabled, reasonCode: 'EXECUTION_CONFIG_READY' };
    } catch {
      return { approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_UNAVAILABLE' };
    }
  }

  async set(update: AgentExecutionConfigUpdate, actorId: number): Promise<AgentExecutionConfigState> {
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || (!Object.hasOwn(update, 'approvalEnabled') && !Object.hasOwn(update, 'restrictedNetworkEnabled'))
      || (Object.hasOwn(update, 'approvalEnabled') && typeof update.approvalEnabled !== 'boolean')
      || (Object.hasOwn(update, 'restrictedNetworkEnabled') && typeof update.restrictedNetworkEnabled !== 'boolean')
      || !Number.isSafeInteger(actorId) || actorId <= 0) {
      throw new Error('EXECUTION_CONFIG_UPDATE_INVALID');
    }
    const executor = this.executorProvider();
    if (!executor) throw new Error('EXECUTION_CONFIG_UPDATE_FAILED');
    const current = await this.get();
    const next = {
      approvalEnabled: update.approvalEnabled ?? current.approvalEnabled,
      restrictedNetworkEnabled: update.restrictedNetworkEnabled ?? current.restrictedNetworkEnabled,
    };
    try {
      for (const [key, value, description] of [
        [AGENT_EXECUTION_CONFIG_KEYS.approvalEnabled, update.approvalEnabled, DESCRIPTIONS.approvalEnabled],
        [AGENT_EXECUTION_CONFIG_KEYS.restrictedNetworkEnabled, update.restrictedNetworkEnabled, DESCRIPTIONS.restrictedNetworkEnabled],
      ] as const) {
        if (value === undefined) continue;
        await executor.execute(
          `INSERT INTO system_config (config_key, config_value, value_type, description, updated_by)
           VALUES (?, ?, 'boolean', ?, ?)
           ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = VALUES(value_type),
             description = VALUES(description), updated_by = VALUES(updated_by)`,
          [key, String(value), description, actorId],
        );
      }
      return { ...next, reasonCode: 'EXECUTION_CONFIG_UPDATED' };
    } catch {
      throw new Error('EXECUTION_CONFIG_UPDATE_FAILED');
    }
  }
}

export const agentExecutionConfigService = new AgentExecutionConfigService();
