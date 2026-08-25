import { agentCodeExecutionService, type AgentCodeExecutionInput } from '../security/agent-code-execution-service.js';
import type { AnyAgentTool } from './types.js';

export const executeCodeTool: AnyAgentTool = {
  name: 'execute_code',
  description: 'Execute approved Shell, Python, or Node code in the isolated system sandbox',
  parameters: {
    type: 'object',
    properties: {
      runtime: {
        type: 'string',
        enum: ['shell', 'python', 'node'],
        description: 'Sandbox runtime',
      },
      code: {
        type: 'string',
        maxLength: 1024 * 1024,
        description: 'Source code to execute',
      },
      files: {
        type: 'array',
        maxItems: 64,
        description: 'Optional UTF-8 supporting files placed in the isolated workspace',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', maxLength: 240 },
            content: { type: 'string', maxLength: 1024 * 1024 },
          },
          required: ['path', 'content'],
        },
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        maximum: 120_000,
        default: 60_000,
        description: 'Execution timeout in milliseconds',
      },
      approvalId: {
        type: 'string',
        description: 'Optional server approval identifier returned after an approval request',
      },
    },
    required: ['runtime', 'code'],
  } as AnyAgentTool['parameters'],
  requiresApproval: true,
  dangerLevel: 5,
  readOnly: false,
  requiredPermissions: ['ai:execute'],
  group: 'agent_security',
  handler: async (args) => agentCodeExecutionService.execute({
    runtime: args.runtime as AgentCodeExecutionInput['runtime'],
    code: args.code as string,
    ...(args.files === undefined ? {} : { files: args.files as AgentCodeExecutionInput['files'] }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs as number }),
  }),
};
