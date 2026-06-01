/**
 * Simplified Gateway Protocol Types
 * For Slide frontend - only includes types needed for chat commands
 */

export type CommandEntry = {
  key: string;
  name: string;
  description: string;
  aliases?: string[];
  args?: Array<{
    name: string;
    required?: boolean;
    choices?: string[];
  }>;
  category?: string;
};

export type CommandsListResult = {
  commands: CommandEntry[];
};

// Re-export from schema
export type {
  ConnectParams,
  HelloOk,
  Request,
  Response,
  AgentEvent,
  ChatStreamEvent,
} from "./schema.js";

export {
  PROTOCOL_VERSION,
  isConnectMessage,
  isRequestMessage,
  createSuccessResponse,
  createErrorResponse,
} from "./schema.js";
