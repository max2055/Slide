import { randomUUID } from 'node:crypto';
import type { Operation, OperationEvent, OperationState } from './types.js';

const TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ['waiting_approval', 'claimed', 'cancelled', 'failed'],
  waiting_approval: ['claimed', 'cancelled'],
  claimed: ['running', 'queued', 'unknown', 'cancelled'],
  running: ['succeeded', 'failed', 'unknown'],
  succeeded: [], failed: [], cancelled: [], unknown: [],
};

function bounded(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const text = JSON.stringify(value);
  return text.length <= 16_384 ? JSON.parse(text) : { truncated: true };
}

export class OperationService {
  private readonly operations = new Map<string, Operation>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly events = new Map<string, OperationEvent[]>();

  create(input: Omit<Operation, 'id' | 'state' | 'attempt' | 'createdAt' | 'updatedAt'>): Operation {
    const key = `${input.actorId}:${input.idempotencyKey}`;
    const existing = this.byIdempotency.get(key);
    if (existing) return this.require(existing);
    const now = new Date();
    const operation: Operation = { ...input, id: randomUUID(), state: 'queued', attempt: 1, createdAt: now, updatedAt: now };
    this.operations.set(operation.id, operation);
    this.byIdempotency.set(key, operation.id);
    this.append(operation, null, 'queued', 'CREATED', operation.actorId);
    return operation;
  }

  transition(id: string, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): Operation {
    const operation = this.require(id);
    if (!TRANSITIONS[operation.state].includes(toState)) throw new Error(`Illegal operation transition ${operation.state} -> ${toState}`);
    const fromState = operation.state;
    operation.state = toState;
    operation.updatedAt = new Date();
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(toState)) operation.finishedAt = operation.updatedAt;
    this.append(operation, fromState, toState, reasonCode, actorId, metadata);
    return operation;
  }

  claim(id: string, owner: string, leaseMs: number, actorId?: number): Operation | null {
    const operation = this.require(id);
    if (!['queued', 'waiting_approval'].includes(operation.state)) return null;
    this.transition(id, 'claimed', 'CLAIMED', actorId);
    operation.leaseOwner = owner;
    operation.leaseExpiresAt = new Date(Date.now() + leaseMs);
    return operation;
  }

  expireLease(id: string, now = new Date()): Operation | null {
    const operation = this.require(id);
    if (operation.state !== 'claimed' || !operation.leaseExpiresAt || operation.leaseExpiresAt > now) return null;
    return this.transition(id, 'unknown', 'LEASE_EXPIRED');
  }

  eventsFor(id: string): readonly OperationEvent[] { return this.events.get(id) ?? []; }
  private require(id: string): Operation { const operation = this.operations.get(id); if (!operation) throw new Error('Operation not found'); return operation; }
  private append(operation: Operation, fromState: OperationState | null, toState: OperationState, reasonCode: string, actorId?: number, metadata?: Record<string, unknown>): void {
    const list = this.events.get(operation.id) ?? [];
    list.push({ operationId: operation.id, fromState, toState, reasonCode, actorId, metadata: bounded(metadata), createdAt: new Date() });
    this.events.set(operation.id, list);
  }
}
