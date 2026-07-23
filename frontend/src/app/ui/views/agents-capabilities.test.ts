import { describe, expect, it } from 'vitest';
import { visibleAgentPanels } from './agents.ts';

describe('agent capability UI', () => {
  it('only exposes panels declared supported by the adapter', () => {
    expect(visibleAgentPanels({
      files: { state: 'unsupported' }, tools: { state: 'unsupported' }, skills: { state: 'unsupported' },
      cron: { state: 'unsupported' }, modelSelection: { state: 'unsupported' }, fallback: { state: 'unsupported' },
      reload: { state: 'unsupported' }, edit: { state: 'unsupported' }, sessions: { state: 'supported' },
    })).toEqual(['overview']);
  });
});
