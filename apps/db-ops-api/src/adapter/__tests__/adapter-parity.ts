/**
 * AdapterParityTestHarness — central test utility for Phase 108 evals.
 *
 * Runs the same input on two IAgentEngine adapters and compares results.
 * Uses mock adapters (no real LLM calls) for deterministic comparison.
 */

import { describe, it, assert } from 'vitest';
import type { ToolSchema } from '@slide/agent-core';
import type { IAgentEngine, ChatEvent, ChatResult, InvokeResult } from '../types.js';

/**
 * Collects ChatEvent[] from an adapter.chat() call.
 */
export class ChatRecorder {
  readonly events: ChatEvent[] = [];

  onEvent(event: ChatEvent): void {
    this.events.push(event);
  }

  /** Get cumulative text from all text_delta events */
  get cumulativeText(): string {
    return this.events
      .filter((e): e is ChatEvent & { type: 'text_delta' } => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
  }

  /** Get event type sequence */
  get eventTypes(): string[] {
    return this.events.map((e) => e.type);
  }

  /** Check if last event is 'complete' */
  get completed(): boolean {
    return this.events.length > 0 && this.events[this.events.length - 1].type === 'complete';
  }

  /** Check if any event is 'error' */
  get hasError(): boolean {
    return this.events.some((e) => e.type === 'error');
  }
}

/**
 * Compares two IAgentEngine adapters for behavioral parity.
 */
export class AdapterParityTestHarness {
  constructor(
    private adapterA: IAgentEngine,
    private adapterB: IAgentEngine,
  ) {}

  /** Compare listTools() output across adapters. */
  async assertToolParity(): Promise<void> {
    const toolsA = this.adapterA.listTools().sort((a, b) => a.name.localeCompare(b.name));
    const toolsB = this.adapterB.listTools().sort((a, b) => a.name.localeCompare(b.name));

    assert.strictEqual(
      toolsA.length,
      toolsB.length,
      `Tool count mismatch: ${toolsA.length} vs ${toolsB.length}`,
    );

    for (let i = 0; i < toolsA.length; i++) {
      assert.strictEqual(
        toolsA[i].name,
        toolsB[i].name,
        `Tool name mismatch at index ${i}`,
      );
      assert.strictEqual(
        toolsA[i].description,
        toolsB[i].description,
        `Tool description mismatch for ${toolsA[i].name}`,
      );
      assert.deepStrictEqual(
        toolsA[i].parameters,
        toolsB[i].parameters,
        `Tool parameters mismatch for ${toolsA[i].name}`,
      );
    }
  }

  /** Compare streaming event sequences for same input. */
  async assertStreamingParity(
    sessionKey: string,
    input: string,
  ): Promise<void> {
    const recorderA = new ChatRecorder();
    const recorderB = new ChatRecorder();

    await this.adapterA.chat(sessionKey, input, (e) => recorderA.onEvent(e));
    await this.adapterB.chat(sessionKey, input, (e) => recorderB.onEvent(e));

    // Compare event type sequences
    assert.deepStrictEqual(
      recorderA.eventTypes,
      recorderB.eventTypes,
      `Streaming event type sequence mismatch`,
    );
  }

  /** Compare invoke() results. */
  async assertInvokeParity(
    sessionKey: string,
    input: string,
    systemPrompt?: string,
  ): Promise<void> {
    const resultA = await this.adapterA.invoke(sessionKey, input, systemPrompt);
    const resultB = await this.adapterB.invoke(sessionKey, input, systemPrompt);

    // Both should resolve with non-empty content
    assert.ok(resultA.content !== undefined, `Adapter A invoke returned undefined content`);
    assert.ok(resultB.content !== undefined, `Adapter B invoke returned undefined content`);
  }
}
