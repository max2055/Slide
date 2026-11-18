import { ActorAuthenticationError, actorContextService, type ActorContext, type ActorContextService, type QueryExecutor } from './actor-context.js';
import { chatCredential } from './chat-credential.js';
import { hasPermission } from './require-permission.js';

export class ChatForbiddenError extends Error {
  readonly code = 'CHAT_FORBIDDEN';
  constructor() { super('权限不足'); }
}
export function assertChatPermission(actor: ActorContext): void {
  if (!hasPermission(new Set(actor.permissions), 'chat:view')) throw new ChatForbiddenError();
}
export function assertChatCredential(actor: ActorContext, required = false): void {
  const credential = chatCredential(actor);
  if (required && !credential || credential && credential.expiresAt <= Date.now()) throw new ActorAuthenticationError();
}
export class ChatAuthorization {
  constructor(readonly actors: Pick<ActorContextService, 'revalidateActor' | 'revalidateActorOn' | 'loadActiveActorOn'> = actorContextService) {}
  async require(actor: ActorContext, executor?: QueryExecutor): Promise<ActorContext> {
    assertChatCredential(actor);
    const current = executor ? await this.actors.revalidateActorOn(executor, actor) : await this.actors.revalidateActor(actor);
    assertChatPermission(current);
    assertChatCredential(actor);
    return current;
  }
  async ownerReadable(ownerId: number, executor: QueryExecutor): Promise<boolean> {
    try { assertChatPermission(await this.actors.loadActiveActorOn(executor, ownerId)); return true; }
    catch (error) {
      if (error instanceof ActorAuthenticationError || error instanceof ChatForbiddenError) return false;
      throw error;
    }
  }
}
export const chatAuthorization = new ChatAuthorization();
