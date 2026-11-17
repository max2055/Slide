import { ChatExecution, withChatExecution } from '../auth/chat-execution.js';
import { recordVerifiedCredential } from '../auth/chat-credential.js';
import { SubagentManager } from './subagent-manager.js';

/** Unit lifecycle fixtures supply a server-owned parent without a database.
 * Production credential verification is exercised by chat-authorization.mysql. */
export class ChatBoundSubagentManager extends SubagentManager {
  override async spawn(...args: Parameters<SubagentManager['spawn']>) {
    const scope = new ChatExecution(recordVerifiedCredential(args[3]!, 'unit-token', Date.now() / 1000 + 3600), args[2], 'parent-run', async () => undefined);
    try { return await withChatExecution(scope, () => super.spawn(...args)); } finally { scope.release(); }
  }
  override async access(...args: Parameters<SubagentManager['access']>) {
    const scope = new ChatExecution(recordVerifiedCredential(args[1]!, 'unit-token', Date.now() / 1000 + 3600), 'parent-session', 'parent-run', async () => undefined);
    try { return await withChatExecution(scope, () => super.access(...args)); } finally { scope.release(); }
  }
}
