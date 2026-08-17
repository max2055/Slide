/**
 * DB-Ops 子 Agent Spawn 工具
 *
 * 复用上游 sessions-spawn-tool 机制
 */

import type { AnyAgentTool } from '../tools/types.js';
import type { Tool, ToolRegistry } from '@slide/agent-core';
import { SubagentManager } from './subagent-manager.js';

// ── Module-level SubagentManager ref (set by DirectAdapter.start()) ──

let _subagentManager: SubagentManager | null = null;

/**
 * Set the SubagentManager to use for spawn_subagent tool execution.
 * Called by DirectAdapter.start() once the AgentRunner is available.
 */
export function setSubagentManager(manager: SubagentManager): void {
  _subagentManager = manager;
}

// ============== 工具参数类型 ==============

export interface SpawnSubagentParams {
  /** 任务描述 */
  task: string;
  /** Agent ID */
  agentId?: string;
}

// ============== Spawn SubAgent 工具 ==============

/**
 * 创建 spawn 子 Agent 工具
 */
export function createSpawnSubagentTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    name: 'spawn_subagent',
    scope: ['core'], // Prevent recursive subagent spawning (nanobot: SpawnTool._scopes = {"core"})
    description:
      'Spawn a subagent to handle a task independently. Subagents run asynchronously and report back when completed.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task description for the subagent to complete',
        },
        agentId: {
          type: 'string',
          description: 'Optional agent ID override',
        },
      },
      required: ['task'],
    },
    handler: async (args: Record<string, unknown>, context) => {
      const params = args as unknown as SpawnSubagentParams;

      if (!params.task || typeof params.task !== 'string') {
        return {
          success: false,
          error: 'Missing required parameter: task',
          errorCode: 'INVALID_PARAMS',
        };
      }
      if (!context?.actor) {
        return { success: false, error: 'Authenticated parent actor required', errorCode: 'SUBAGENT_ACTOR_REQUIRED' };
      }
      if (!_subagentManager) {
        return { success: false, error: 'Subagent runtime unavailable', errorCode: 'SUBAGENT_RUNTIME_UNAVAILABLE' };
      }
      const parentSessionKey = opts?.agentSessionKey || 'agent:slide:default:main';
      const agentId = params.agentId || opts?.agentId || 'slide-default';
      try {
        const runId = await _subagentManager.spawn(agentId, params.task, parentSessionKey, context.actor);
        return {
          success: true,
          data: { status: 'accepted', runId },
          summary: `Spawned subagent to handle: ${params.task}`,
        };
      } catch (error: unknown) {
        return {
          success: false,
          error: 'Subagent spawn denied',
          errorCode: error instanceof Error ? error.message : 'SUBAGENT_SPAWN_FAILED',
        };
      }
    },
  } as AnyAgentTool;
}

/**
 * 创建子 Agent 访问工具
 */
export function createSubagentAccessTool(): AnyAgentTool {
  return {
    name: 'access_subagent',
    scope: ['core'], // Prevent recursive subagent access
    description: 'Access subagent status and results',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The subagent run ID returned by spawn_subagent',
        },
      },
      required: ['runId'],
    },
    handler: async (args: Record<string, unknown>, context) => {
      const params = args as { runId: string };
      if (!context?.actor) {
        return { success: false, error: 'Authenticated parent actor required', errorCode: 'SUBAGENT_ACTOR_REQUIRED' };
      }
      if (!_subagentManager) {
        return { success: false, error: 'Subagent runtime unavailable', errorCode: 'SUBAGENT_RUNTIME_UNAVAILABLE' };
      }
      const result = await _subagentManager.access(params.runId, context.actor);
      if (result.error) return { success: false, error: result.error, errorCode: 'SUBAGENT_NOT_FOUND' };
      return {
        success: true,
        data: { runId: params.runId, ...result },
        summary: `Subagent ${params.runId}: ${result.status}`,
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
export function createSpawnSubagentCoreTool(_subagentManager: SubagentManager): Tool {
  return {
    name: 'spawn_subagent',
    scope: ['core'], // Prevent recursive subagent spawning
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
      if (!task) {
        return { success: false, error: 'Missing required parameter: task' };
      }
      return { success: false, error: 'SUBAGENT_ACTOR_REQUIRED' };
    },
  };
}

/**
 * Create an agent-core Tool-compatible access_subagent tool.
 */
export function createAccessSubagentCoreTool(_subagentManager: SubagentManager): Tool {
  return {
    name: 'access_subagent',
    scope: ['core'], // Prevent recursive subagent access
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

      return { success: false, error: 'SUBAGENT_ACTOR_REQUIRED' };
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
