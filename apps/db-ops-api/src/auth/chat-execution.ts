import { AsyncLocalStorage } from 'node:async_hooks';
import { ToolRegistry, type LLMCallOptions, type LLMProvider, type SummaryIdentity, type ToolSchema } from '@slide/agent-core';
import { ActorAuthenticationError, type ActorContext } from './actor-context.js';
import { chatCredential } from './chat-credential.js';
import { assertChatCredential } from './chat-authorization.js';

/** Only ordinary chat installs this context. Background delegates keep their
 * existing authorities. Async descendants retain the original credential. */
export class ChatExecution {
  readonly controller = new AbortController();
  readonly credential;
  private references = 1;
  private checking = false;
  private readonly monitor: ReturnType<typeof setInterval>;
  private readonly expiry: ReturnType<typeof setTimeout>;
  private readonly cancel = () => this.controller.abort(this.parentSignal?.reason);
  constructor(readonly actor: ActorContext, readonly sessionId: string, readonly runId: string,
    private readonly authorize: () => Promise<unknown>, private readonly parentSignal?: AbortSignal) {
    assertChatCredential(actor, true);
    this.credential = chatCredential(actor)!;
    this.expiry = setTimeout(() => this.controller.abort(new ActorAuthenticationError()), Math.max(0, this.credential.expiresAt - Date.now()));
    this.expiry.unref();
    this.monitor = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      void this.check().catch(() => undefined).finally(() => { this.checking = false; });
    }, 5000);
    this.monitor.unref();
    parentSignal?.addEventListener('abort', this.cancel, { once: true });
    if (parentSignal?.aborted) this.cancel();
  }
  async check(): Promise<void> {
    this.controller.signal.throwIfAborted();
    try {
      assertChatCredential(this.actor, true);
      await this.authorize();
      assertChatCredential(this.actor, true);
      this.controller.signal.throwIfAborted();
    } catch (error) { this.controller.abort(error); throw error; }
  }
  retain(): () => void {
    this.references++;
    let released = false;
    return () => { if (!released) { released = true; this.release(); } };
  }
  release(): void {
    if (--this.references !== 0) return;
    clearInterval(this.monitor); clearTimeout(this.expiry);
    this.parentSignal?.removeEventListener('abort', this.cancel);
  }
}
const execution = new AsyncLocalStorage<ChatExecution | undefined>();
export function currentChatExecution(): ChatExecution | undefined { return execution.getStore(); }
export function withChatExecution<T>(scope: ChatExecution, work: () => T): T { return execution.run(scope, work); }
export function withoutChatExecution<T>(work: () => T): T { return execution.run(undefined, work); }
export async function checkChatExecution(): Promise<void> { await execution.getStore()?.check(); }

/** Covers runtime retries, compression and child runners at the actual call. */
export function guardedChatProvider(provider: LLMProvider, beforeRequest?: (tools: ToolSchema[]) => Promise<void>): LLMProvider {
  const prepare = async (tools: ToolSchema[], options?: LLMCallOptions) => {
    const scope = execution.getStore();
    await scope?.check();
    // Internal context compaction uses an intentionally empty tool registry.
    const identity = (options as (LLMCallOptions & { requestIdentity?: SummaryIdentity }) | undefined)?.requestIdentity;
    const recordDiscovery = beforeRequest && identity?.purpose !== 'summary';
    if (recordDiscovery) await beforeRequest(tools);
    const signal = scope ? AbortSignal.any([scope.controller.signal, ...(options?.signal ? [options.signal] : [])]) : options?.signal;
    if (recordDiscovery) signal?.throwIfAborted();
    return { scope, signal };
  };
  return {
    getDefaultModel: () => provider.getDefaultModel(),
    ...(provider.projectMessages ? { projectMessages: provider.projectMessages.bind(provider) } : {}),
    ...(provider.countPromptTokens ? { countPromptTokens: provider.countPromptTokens.bind(provider) } : {}),
    ...(provider.getModelCapabilities ? { getModelCapabilities: provider.getModelCapabilities.bind(provider) } : {}),
    chat: async (messages, tools, options) => {
      const { signal } = await prepare(tools, options);
      return provider.chat(messages, tools, { ...options, signal });
    },
    chatStream: async (messages, tools, callbacks, options) => {
      const { scope, signal } = await prepare(tools, options);
      return provider.chatStream(messages, tools, {
        ...callbacks,
        onContentDelta: async delta => { await scope?.check(); await callbacks.onContentDelta(delta); },
        onThinkingDelta: async delta => { await scope?.check(); await callbacks.onThinkingDelta?.(delta); },
        onToolCallDelta: async delta => { await scope?.check(); await callbacks.onToolCallDelta?.(delta); },
      }, { ...options, signal });
    },
  };
}

export function guardedChatTools(tools: ToolRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of tools.toolNames) {
    const tool = tools.get(name)!;
    registry.register({ ...tool, execute: async (args, context) => {
      await checkChatExecution();
      const scope = currentChatExecution();
      return tool.execute(args, { ...context, signal: scope
        ? AbortSignal.any([scope.controller.signal, ...(context?.signal ? [context.signal] : [])]) : context?.signal });
    } });
  }
  return registry;
}
