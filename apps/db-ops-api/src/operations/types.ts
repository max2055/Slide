export type OperationState = 'queued' | 'waiting_approval' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type OperationRisk = 'low' | 'medium' | 'high' | 'critical';

export interface Operation {
  id: string;
  actorId: number;
  origin: string;
  resource: { type: string; id: string };
  commandType: string;
  risk: OperationRisk;
  idempotencyKey: string;
  correlationId: string;
  state: OperationState;
  attempt: number;
  approvalId?: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  finishedAt?: Date;
}

export interface OperationEvent {
  operationId: string;
  fromState: OperationState | null;
  toState: OperationState;
  reasonCode: string;
  actorId?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}
