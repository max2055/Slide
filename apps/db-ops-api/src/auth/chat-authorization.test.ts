import { describe, it, expect, vi } from 'vitest';
import { ChatAuthorization, assertChatCredential, assertChatPermission } from './chat-authorization.js';
import { ActorAuthenticationError, type ActorContext } from './actor-context.js';
import { chatCredential, recordVerifiedCredential, carryChatCredential } from './chat-credential.js';
import { ChatExecution, guardedChatProvider, withChatExecution } from './chat-execution.js';
import { PlatformUnavailableError } from '../lifecycle/platform-unavailable.js';
import { BoundedSocketWriter } from '../adapter/bounded-socket-writer.js';

const actor = (permissions: string[] = ['chat:view']): ActorContext => Object.freeze({ userId: 7, username: 'fixture', roles: [], permissions,
  sessionVersion: 1, instanceScopes: {}, requestId: 'fixture' });
describe('MAX-684 ordinary chat boundaries', () => {
  it.each(['chat:view', 'chat:*', '*:view', '*'])('honors live permission %s', permission => expect(() => assertChatPermission(actor([permission]))).not.toThrow());
  it('denies unrelated permission and an unverified caller-supplied expiry', () => {
    expect(() => assertChatPermission(actor(['operations:actions:view']))).toThrow('权限不足');
    expect(() => assertChatCredential({ ...actor(), expiresAt: Date.now() + 10000 } as ActorContext, true)).toThrow(ActorAuthenticationError);
  });
  it('keeps the original credential out of serialization and across live revalidation', () => {
    const original = actor(); recordVerifiedCredential(original, 'fixture-raw-token', Date.now() / 1000 + 60);
    const current = carryChatCredential(original, actor());
    expect(chatCredential(current)).toBe(chatCredential(original));
    expect(JSON.stringify(current)).not.toContain('fixture-raw-token');
    expect(JSON.stringify(current)).not.toContain('expiresAt');
  });
  it('classifies unavailable authority separately from revoked owner and never fails open', async () => {
    const unavailable = new PlatformUnavailableError();
    const access = new ChatAuthorization({ revalidateActor: async () => { throw unavailable; }, revalidateActorOn: async () => { throw unavailable; }, loadActiveActorOn: async () => { throw unavailable; } });
    await expect(access.require(actor())).rejects.toBe(unavailable);
    await expect(access.ownerReadable(7, { execute: vi.fn() })).rejects.toBe(unavailable);
  });
  it('aborts an admitted scope on revocation, suppressing later model requests', async () => {
    let allowed = true;
    const a = recordVerifiedCredential(actor(), 'fixture', Date.now() / 1000 + 60);
    const scope = new ChatExecution(a, 'session', 'run', async () => { if (!allowed) throw new Error('revoked'); });
    const chat = vi.fn(async () => ({ content: 'fixture', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: {} }));
    const provider = guardedChatProvider({ chat, chatStream: vi.fn(), getDefaultModel: () => 'fixture' });
    try {
      await withChatExecution(scope, () => provider.chat([], [])); allowed = false;
      await expect(withChatExecution(scope, () => provider.chat([], []))).rejects.toThrow('revoked');
      expect(chat).toHaveBeenCalledTimes(1); expect(scope.controller.signal.aborted).toBe(true);
    } finally { scope.release(); }
  });
  it('rechecks a queued WS body at dispatch and discards it after withdrawal', async () => {
    let release!: () => void;
    let allowed = true;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const ws = { readyState: 1, bufferedAmount: 0, once: vi.fn(), send: vi.fn(), close: vi.fn() } as any;
    const writer = new BoundedSocketWriter();
    writer.setGuard(ws, async () => { await wait; return allowed; });
    writer.send(ws, JSON.stringify({ type: 'complete', finalContent: 'PRIVATE_BUFFER' }));
    allowed = false; release();
    await vi.waitFor(() => expect((writer as any).queued.get(ws).events).toBe(0));
    expect(ws.send).not.toHaveBeenCalled();
  });
});
