import { dbConnection } from '../db-connection.js';

const CONFIG_KEY = 'agent_sandbox_enabled';
const CONFIG_DESCRIPTION = 'Enable Agent-generated Shell, Python, and Node execution through Sandbox Controller';

interface ConfigExecutor {
  execute(sql: string, values?: unknown[]): Promise<[any, unknown?]>;
}

export type AgentSandboxConfigReason =
  | 'SANDBOX_ENABLED'
  | 'SANDBOX_DISABLED'
  | 'SANDBOX_CONFIG_UNAVAILABLE';

export interface AgentSandboxConfigState {
  enabled: boolean;
  reasonCode: AgentSandboxConfigReason;
}

export class AgentSandboxConfigService {
  constructor(
    private readonly executorProvider: () => ConfigExecutor | null = () => dbConnection.getPool() as ConfigExecutor | null,
  ) {}

  async get(): Promise<AgentSandboxConfigState> {
    const executor = this.executorProvider();
    if (!executor) return { enabled: false, reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE' };
    try {
      const [rows] = await executor.execute(
        'SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1',
        [CONFIG_KEY],
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return { enabled: false, reasonCode: 'SANDBOX_DISABLED' };
      if (row.config_value === 'true') return { enabled: true, reasonCode: 'SANDBOX_ENABLED' };
      if (row.config_value === 'false') return { enabled: false, reasonCode: 'SANDBOX_DISABLED' };
      return { enabled: false, reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE' };
    } catch {
      return { enabled: false, reasonCode: 'SANDBOX_CONFIG_UNAVAILABLE' };
    }
  }

  async set(enabled: boolean, actorId: number): Promise<AgentSandboxConfigState> {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(actorId) || actorId <= 0) {
      throw new Error('SANDBOX_CONFIG_UPDATE_INVALID');
    }
    const executor = this.executorProvider();
    if (!executor) throw new Error('SANDBOX_CONFIG_UPDATE_FAILED');
    try {
      await executor.execute(
        `INSERT INTO system_config (config_key, config_value, value_type, description, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), value_type = VALUES(value_type),
           description = VALUES(description), updated_by = VALUES(updated_by)`,
        [CONFIG_KEY, String(enabled), 'boolean', CONFIG_DESCRIPTION, actorId],
      );
      return {
        enabled,
        reasonCode: enabled ? 'SANDBOX_ENABLED' : 'SANDBOX_DISABLED',
      };
    } catch {
      throw new Error('SANDBOX_CONFIG_UPDATE_FAILED');
    }
  }
}

export const agentSandboxConfigService = new AgentSandboxConfigService();
