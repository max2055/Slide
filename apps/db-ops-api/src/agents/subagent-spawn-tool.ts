/**
 * DB-Ops 子 Agent Spawn 工具
 *
 * 复用上游 sessions-spawn-tool 机制
 */

import type { AnyAgentTool } from '../tools/types.js';
import type { Tool, ToolRegistry } from '@slide/agent-core';
import { SubagentManager } from './subagent-manager.js';
import {
  generateSubagentSessionKey,
  resolveSubagentCapabilities,
  type SubagentSessionRole,
} from './subagent-capabilities.js';
import {
  createSessionEntry,
  saveSessionStore,
  resolveStorePath,
  type SessionStore,
} from './session-store.js';
import { subagentRegistry, registerSubagentRun } from './subagent-registry.js';

// ============== 工具参数类型 ==============

export interface SpawnSubagentParams {
  /** 任务描述 */
  task: string;
  /** 任务标签 */
  label?: string;
  /** Agent ID */
  agentId?: string;
  /** 使用的模型 */
  model?: string;
  /** 思考模式 */
  thinking?: 'low' | 'medium' | 'high';
  /** 运行超时（秒） */
  runTimeoutSeconds?: number;
  /** 是否线程绑定 */
  thread?: boolean;
  /** 模式：run=单次运行，session=保持会话 */
  mode?: 'run' | 'session';
  /** 清理策略 */
  cleanup?: 'delete' | 'keep';
  /** 轻量级上下文 */
  lightContext?: boolean;
}

// ============== Spawn SubAgent 工具 ==============

/**
 * 创建 spawn 子 Agent 工具
 */
export function createSpawnSubagentTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a subagent to handle a task independently. Subagents run asynchronously and report back when completed.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task description for the subagent to complete',
        },
        label: {
          type: 'string',
          description: 'Optional label for this subagent task',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent ID override',
        },
        model: {
          type: 'string',
          description: 'Model to use for the subagent',
        },
        thinking: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Thinking mode',
        },
        runTimeoutSeconds: {
          type: 'number',
          description: 'Timeout in seconds',
        },
        thread: {
          type: 'boolean',
          description: 'Whether to keep the session thread-bound',
        },
        mode: {
          type: 'string',
          enum: ['run', 'session'],
          description: 'Execution mode',
        },
        cleanup: {
          type: 'string',
          enum: ['delete', 'keep'],
          description: 'Cleanup strategy after completion',
        },
        lightContext: {
          type: 'boolean',
          description: 'Use lightweight bootstrap context',
        },
      },
      required: ['task'],
    },
    handler: async (args: Record<string, unknown>) => {
      const params = args as unknown as SpawnSubagentParams;

      if (!params.task || typeof params.task !== 'string') {
        return {
          success: false,
          error: 'Missing required parameter: task',
          errorCode: 'INVALID_PARAMS',
        };
      }

      // 生成子 Agent 会话 Key
      const parentSessionKey = opts?.agentSessionKey || 'agent:slide:default:main';
      const childSessionKey = generateSubagentSessionKey(parentSessionKey);

      // 计算深度和能力
      const depth = calculateDepthFromSessionKey(parentSessionKey);
      const capabilities = resolveSubagentCapabilities({
        depth: depth + 1,
        maxSpawnDepth: 3,
      });

      // 检查是否允许创建子 Agent
      if (!capabilities.canSpawn) {
        return {
          success: false,
          error: `Cannot spawn subagent: role '${capabilities.role}' is not allowed to create children`,
          errorCode: 'SPAWN_FORBIDDEN',
        };
      }

      // 解析参数
      const agentId = params.agentId || opts?.agentId || 'slide-default';
      const storePath = resolveStorePath(undefined, { agentId });

      // 创建会话存储条目
      const sessionEntry = createSessionEntry({
        sessionId: childSessionKey,
        spawnDepth: depth + 1,
        spawnedBy: parentSessionKey,
        subagentRole: capabilities.role,
        subagentControlScope: capabilities.controlScope,
        model: params.model,
      });

      // 保存到会话存储
      try {
        const store: SessionStore = { [childSessionKey]: sessionEntry };
        await saveSessionStore(storePath, store);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `Failed to save session store: ${errorMessage}`,
          errorCode: 'STORE_ERROR',
        };
      }

      // 注册运行记录
      const run = registerSubagentRun({
        sessionKey: childSessionKey,
        task: params.task,
        label: params.label,
        parentSessionKey,
      });

      // 返回结果
      return {
        success: true,
        data: {
          status: 'accepted',
          childSessionKey,
          runId: run.runId,
          mode: params.mode || 'run',
          role: capabilities.role,
          depth: depth + 1,
          note:
            capabilities.role === 'leaf'
              ? 'Leaf agents cannot spawn children'
              : 'Subagent will report back upon completion',
        },
        summary: `Spawned subagent (role: ${capabilities.role}, depth: ${depth + 1}) to handle: ${params.task}`,
      };
    },
  } as AnyAgentTool;
}

/**
 * 从会话 Key 计算深度
 */
function calculateDepthFromSessionKey(sessionKey: string): number {
  // 子 Agent 会话 Key 格式：agent:<agentId>:<sessionId> 或 parent.child
  const parts = sessionKey.split('.');
  return parts.length;
}

/**
 * 创建子 Agent 访问工具
 */
export function createSubagentAccessTool(): AnyAgentTool {
  return {
    name: 'access_subagent',
    description: 'Access subagent status and results',
    parameters: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'The subagent session key',
        },
      },
      required: ['sessionKey'],
    },
    handler: async (args: Record<string, unknown>) => {
      const params = args as { sessionKey: string };

      const session = subagentRegistry.getSession(params.sessionKey);
      if (!session) {
        return {
          success: false,
          error: `Subagent session not found: ${params.sessionKey}`,
          errorCode: 'SESSION_NOT_FOUND',
        };
      }

      const activeRuns = session.runs.filter((r) => r.status === 'running').length;
      const completedRuns = session.runs.filter((r) => r.status === 'completed').length;

      return {
        success: true,
        data: {
          sessionKey: session.sessionKey,
          parentSessionKey: session.parentSessionKey,
          activeRuns,
          completedRuns,
          totalRuns: session.runs.length,
          runs: session.runs.map((r) => ({
            runId: r.runId,
            task: r.task,
            status: r.status,
            label: r.label,
          })),
        },
        summary: `Subagent ${session.sessionKey}: ${activeRuns} running, ${completedRuns} completed`,
      };
    },
  } as AnyAgentTool;
}

// ============== 导出工具数组 ==============

export const generatedTools: AnyAgentTool[] = [];

// 延迟初始化工具
let _tools: AnyAgentTool[] | null = null;

export function getSubagentTools(): AnyAgentTool[] {
  if (!_tools) {
    _tools = [createSpawnSubagentTool(), createSubagentAccessTool()];
  }
  return _tools;
}

// ============== Agent-Core Tool Registration ==============

/**
 * Create an agent-core Tool-compatible spawn_subagent tool.
 * This is the new registration path via ToolRegistry (D-19).
 */
export function createSpawnSubagentCoreTool(subagentManager: SubagentManager): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Spawn a subagent to handle a task independently. Subagents run asynchronously and report back when completed.',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID for the subagent',
        },
        task: {
          type: 'string',
          description: 'The task description for the subagent to complete',
        },
      },
      required: ['task'],
    },
    readOnly: false,
    concurrencySafe: true,
    exclusive: false,
    async execute(params: Record<string, unknown>): Promise<unknown> {
      const task = params['task'] as string | undefined;
      const agentId = (params['agentId'] as string) || 'slide-default';
      const sessionKey = (params['sessionKey'] as string) || `agent:slide:default:${Date.now()}`;

      if (!task) {
        return { success: false, error: 'Missing required parameter: task' };
      }

      const runId = await subagentManager.spawn(agentId, task, sessionKey);
      return {
        success: true,
        data: {
          status: 'accepted',
          runId,
          note: 'Subagent will execute in background.',
        },
        summary: `Spawned subagent (runId: ${runId}) to handle: ${task}`,
      };
    },
  };
}

/**
 * Create an agent-core Tool-compatible access_subagent tool.
 */
export function createAccessSubagentCoreTool(subagentManager: SubagentManager): Tool {
  return {
    name: 'access_subagent',
    description: 'Access subagent status and results by runId.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The subagent run ID to check',
        },
      },
      required: ['runId'],
    },
    readOnly: false,
    concurrencySafe: true,
    exclusive: false,
    async execute(params: Record<string, unknown>): Promise<unknown> {
      const runId = params['runId'] as string | undefined;
      if (!runId) {
        return { success: false, error: 'Missing required parameter: runId' };
      }

      const result = await subagentManager.access(runId);
      return {
        success: result.status !== 'failed',
        data: result,
        summary: `Subagent ${runId}: ${result.status}`,
      };
    },
  };
}

/**
 * Register subagent tools into an agent-core ToolRegistry.
 */
export function registerSubagentTools(
  registry: ToolRegistry,
  subagentManager: SubagentManager,
): void {
  registry.register(createSpawnSubagentCoreTool(subagentManager));
  registry.register(createAccessSubagentCoreTool(subagentManager));
}
