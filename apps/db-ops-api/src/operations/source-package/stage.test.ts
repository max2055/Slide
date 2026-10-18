import { describe, expect, it } from 'vitest';
import { runSourceStage } from './stage.js';

describe('one lifecycle for an entire reviewed source stage', () => {
  it('retains source after collect authorization consumption and reinspects every later phase', async () => {
    let running = true, inspect = 0, stopped = 0;
    const events: string[] = [];
    await runSourceStage({
      inspect: async () => { expect(running).toBe(true); inspect++; return { port: 55000 + inspect }; },
      phases: ['collect', 'evaluate', 'investigate'].map(name => async binding => { events.push(name); expect(binding.port).toBe(55000 + inspect); expect(stopped).toBe(0); }),
      restore: async () => { events.push('restore'); expect(running).toBe(true); },
      close: async () => { events.push('close'); },
      stop: async () => { stopped++; running = false; },
    });
    expect(events).toEqual(['collect', 'evaluate', 'investigate', 'restore', 'close']);
    expect(inspect).toBe(3); expect(stopped).toBe(1);
  });
  it('collects cleanup even when a phase or restoration fails, and never retries', async () => {
    const events: string[] = [];
    await expect(runSourceStage({ inspect: async () => ({}),
      phases: [async () => { events.push('sent'); throw new Error('unknown'); }, async () => { events.push('must-not-send'); }],
      restore: async () => { events.push('restore'); throw new Error('restore'); },
      close: async () => { events.push('close'); }, stop: async () => { events.push('stop'); },
    })).rejects.toThrow();
    expect(events).toEqual(['sent','restore','close','stop']);
  });
});
