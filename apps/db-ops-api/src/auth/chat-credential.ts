import { createHash } from 'node:crypto';
import type { ActorContext } from './actor-context.js';

export interface ChatCredential { readonly id: string; readonly expiresAt: number; }
// Authentication metadata is never part of a serialized actor or client input.
const credentials = new WeakMap<ActorContext, ChatCredential>();
export function recordVerifiedCredential(actor: ActorContext, token: string, exp: number): ActorContext {
  credentials.set(actor, Object.freeze({ id: createHash('sha256').update(token).digest('hex'), expiresAt: exp * 1000 }));
  return actor;
}
export function chatCredential(actor: ActorContext): ChatCredential | undefined { return credentials.get(actor); }
export function carryChatCredential(source: ActorContext, target: ActorContext): ActorContext {
  const credential = credentials.get(source);
  if (credential) credentials.set(target, credential);
  return target;
}
