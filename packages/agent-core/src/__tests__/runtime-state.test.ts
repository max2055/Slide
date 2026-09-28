import { describe, expect, it } from 'vitest';
import { createTurnState, restoreTurnState, snapshotTurnState, transition } from '../runtime/turn-state.js';
import type { RuntimeStateSnapshot, RunControl } from '../runtime/contracts.js';

describe('runtime state invariants', () => {
  it('allows model/tool/candidate flow and rejects skipping execution or reopening a terminal state', () => {
    const initial = createTurnState();
    expect(() => transition(initial, 'response_ready')).toThrow('Illegal runtime transition');
    const model = transition(initial, 'model_running');
    expect(initial.phase).toBe('preparing');
    const tools = transition(model, 'tools_running');
    const candidate = transition(transition(tools, 'model_running'), 'candidate_final');
    const ready = transition(candidate, 'response_ready');
    expect(() => transition(ready, 'model_running')).toThrow();
    expect(() => transition(transition(model, 'terminal'), 'model_running')).toThrow();
  });

  it('roundtrips only whitelisted versioned structural state, without messages, credentials or handles', () => {
    const control: RunControl = { signal: new AbortController().signal, observeProviderRequest: () => {} };
    const state = {
      ...transition(createTurnState([{ role: 'user', content: 'private text' }]), 'model_running'),
      modelSteps: 3, providerAttempts: 4, toolCalls: 2,
      externalLookupCounts: { password: 123 }, control, apiKey: 'secret', pending: Promise.resolve(),
    };
    const encoded = JSON.stringify(snapshotTurnState(state));
    expect(encoded).not.toMatch(/private|password|secret|control|signal|pending|apiKey/);
    const restored = restoreTurnState(JSON.parse(encoded));
    expect(snapshotTurnState(restored)).toEqual(snapshotTurnState(state));
    expect(restored.messages).toEqual([]);
  });

  it.each(['modelSteps', 'providerAttempts', 'toolCalls'] as const)('rejects counter rollback for %s', key => {
    const current = { ...createTurnState(), modelSteps: 3, providerAttempts: 5, toolCalls: 7 };
    const snapshot = { ...snapshotTurnState(current), [key]: current[key] - 1 };
    expect(() => restoreTurnState(snapshot, current)).toThrow('counter decreased');
    expect(current[key]).toBeGreaterThan(snapshot[key]);
  });

  it.each([
    { schemaVersion: 2 }, { phase: 'unknown' }, { phase: '__proto__' },
    { modelSteps: -1 }, { providerAttempts: Infinity }, { toolCalls: 1.5 },
    { modelSteps: 2, providerAttempts: 1 },
  ])('rejects malformed snapshots: %j', patch => {
    expect(() => restoreTurnState({ ...snapshotTurnState(createTurnState()), ...patch } as RuntimeStateSnapshot)).toThrow();
  });

  it('does not share arrays or counters across runs', () => {
    const a = createTurnState();
    a.messages.push({ role: 'user', content: 'one' });
    a.modelSteps++;
    expect(createTurnState().messages).toEqual([]);
    expect(createTurnState().modelSteps).toBe(0);
  });
});
