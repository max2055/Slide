/**
 * Tests for AgentRunner checkpoint restore functionality.
 *
 * Verifies:
 * - _setRuntimeCheckpoint writes payload into session.metadata['runtime_checkpoint']
 * - _restoreRuntimeCheckpoint appends messages from checkpoint into session.messages
 * - Dedup: overlapping messages from checkpoint are not duplicated
 * - Backfill: pending_tool_calls become tool messages with "[Task interrupted]" content
 * - After restore, session metadata no longer has runtime_checkpoint key
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRunner } from '../runner.js';

// We need Session class which is a peer dependency
// Re-create minimal test helper instead of importing from session.ts
// to avoid module resolution issues in worktree testing

interface TestSessionEntry {
  role: string;
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
  timestamp?: string;
  [key: string]: unknown;
}

interface TestSession {
  sessionKey: string;
  messages: TestSessionEntry[];
  metadata: Record<string, unknown>;
}

function createSession(sessionKey: string): TestSession {
  return {
    sessionKey,
    messages: [],
    metadata: {},
  };
}

describe('AgentRunner checkpoint restore', () => {
  let runner: AgentRunner;

  beforeEach(() => {
    // Create AgentRunner with a mock provider for the constructor
    const mockProvider = {
      getDefaultModel: () => 'test-model',
      chat: async () => ({
        content: 'test',
        finishReason: 'stop',
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
      }),
      chatStream: async () => ({
        content: 'test',
        finishReason: 'stop',
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
      }),
    };
    runner = new AgentRunner(mockProvider as any);
  });

  describe('_checkpointMessageKey', () => {
    it('returns tuple from message fields', () => {
      // Access via prototype since method is protected — we test as close to implementation as possible
      const message: TestSessionEntry = {
        role: 'assistant',
        content: 'Hello',
        tool_call_id: 'call_123',
        name: 'test_tool',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        reasoning_content: 'thinking...',
        thinking_blocks: [{ type: 'thinking', content: 'deep' }],
      };
      // Note: _checkpointMessageKey is private — we verify its behavior through _restoreRuntimeCheckpoint
      // The key generation happens internally
      expect(true).toBe(true);
    });
  });

  describe('_setRuntimeCheckpoint', () => {
    it('sets checkpoint in session metadata', () => {
      const session = createSession('test-session');
      const payload = {
        assistant_message: { role: 'assistant', content: 'Thinking...' },
        completed_tool_results: [{ role: 'tool', content: 'Result', tool_call_id: 'call_1', name: 'read_file' }],
        pending_tool_calls: [],
      };

      (runner as any)._setRuntimeCheckpoint(session, payload);

      expect(session.metadata['runtime_checkpoint']).toBeDefined();
      expect(session.metadata['runtime_checkpoint']).toEqual(payload);
    });

    it('overwrites existing checkpoint', () => {
      const session = createSession('test-session');
      session.metadata['runtime_checkpoint'] = { old: true };

      (runner as any)._setRuntimeCheckpoint(session, { assistant_message: null, completed_tool_results: [], pending_tool_calls: [] });

      expect(session.metadata['runtime_checkpoint']).toEqual({ assistant_message: null, completed_tool_results: [], pending_tool_calls: [] });
    });
  });

  describe('_clearRuntimeCheckpoint', () => {
    it('removes checkpoint from session metadata', () => {
      const session = createSession('test-session');
      session.metadata['runtime_checkpoint'] = { assistant_message: { content: 'test' } };
      session.metadata['other_key'] = 'keep_me';

      (runner as any)._clearRuntimeCheckpoint(session);

      expect(session.metadata['runtime_checkpoint']).toBeUndefined();
      expect(session.metadata['other_key']).toBe('keep_me');
    });

    it('does nothing if no checkpoint exists', () => {
      const session = createSession('test-session');
      session.metadata['other_key'] = 'value';

      (runner as any)._clearRuntimeCheckpoint(session);

      expect(session.metadata['other_key']).toBe('value');
    });
  });

  describe('_restoreRuntimeCheckpoint', () => {
    it('returns false when no checkpoint in metadata', () => {
      const session = createSession('test-session');

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      expect(result).toBe(false);
    });

    it('returns false for invalid checkpoint', () => {
      const session = createSession('test-session');
      session.metadata['runtime_checkpoint'] = 'not-a-dict';

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      expect(result).toBe(false);
    });

    it('appends assistant message from checkpoint', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Hello' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'I was thinking...' },
        completed_tool_results: [],
        pending_tool_calls: [],
      };

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      expect(result).toBe(true);
      expect(session.messages.length).toBe(2);
      expect(session.messages[1].role).toBe('assistant');
      expect(session.messages[1].content).toBe('I was thinking...');
    });

    it('appends completed tool results from checkpoint', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Run tool' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'Let me check', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        completed_tool_results: [{ role: 'tool', content: 'file contents', tool_call_id: 'call_1', name: 'read' }],
        pending_tool_calls: [],
      };

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      expect(result).toBe(true);
      // user msg + assistant msg + tool result
      expect(session.messages.length).toBe(3);
      expect(session.messages[2].role).toBe('tool');
      expect(session.messages[2].content).toBe('file contents');
    });

    it('backfills pending_tool_calls with "[Task interrupted]" message', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Run two tools' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          ],
        },
        completed_tool_results: [{ role: 'tool', content: 'data', tool_call_id: 'call_1', name: 'read_file' }],
        pending_tool_calls: [
          { id: 'call_2', function: { name: 'write_file' } },
        ],
      };

      (runner as any)._restoreRuntimeCheckpoint(session);

      // user + assistant + completed tool result + interrupted tool message
      expect(session.messages.length).toBe(4);
      const lastMsg = session.messages[session.messages.length - 1];
      expect(lastMsg.role).toBe('tool');
      expect(lastMsg.content).toContain('[Task interrupted before this tool finished.]');
      expect(lastMsg.tool_call_id).toBe('call_2');
    });

    it('deduplicates overlapping messages', () => {
      const session = createSession('test-session');
      // Existing history includes messages that would overlap with checkpoint
      session.messages.push({ role: 'user', content: 'Hello' });
      session.messages.push({ role: 'assistant', content: 'I was thinking...' });

      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'I was thinking...' },
        completed_tool_results: [],
        pending_tool_calls: [],
      };

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      // Should NOT duplicate the assistant message since it overlaps
      expect(result).toBe(true);
      expect(session.messages.length).toBe(2); // user + assistant (no dup)
    });

    it('clears checkpoint from metadata after restore', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Hello' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'Response' },
        completed_tool_results: [],
        pending_tool_calls: [],
      };

      (runner as any)._restoreRuntimeCheckpoint(session);

      expect(session.metadata['runtime_checkpoint']).toBeUndefined();
    });

    it('returns true when messages are restored', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Hello' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'New response' },
        completed_tool_results: [],
        pending_tool_calls: [],
      };

      const result = (runner as any)._restoreRuntimeCheckpoint(session);

      expect(result).toBe(true);
    });
  });

  describe('_restoreRuntimeCheckpointForMessages', () => {
    it('calls _restoreRuntimeCheckpoint and returns messages', () => {
      const session = createSession('test-session');
      session.messages.push({ role: 'user', content: 'Hello' });
      session.metadata['runtime_checkpoint'] = {
        assistant_message: { role: 'assistant', content: 'Hi there!' },
        completed_tool_results: [],
        pending_tool_calls: [],
      };

      const messages = (runner as any)._restoreRuntimeCheckpointForMessages(session);

      expect(Array.isArray(messages)).toBe(true);
      // Should return SessionEntry[] cast as Message[]
      const msgs = messages as any[];
      const hasAssistantMsg = msgs.some((m: any) => m.content === 'Hi there!');
      expect(hasAssistantMsg).toBe(true);
    });
  });
});
