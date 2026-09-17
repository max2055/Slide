import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('wires the execution context and drains the runtime during server shutdown', () => {
  const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  expect(server).toContain('workflowRegistry.execute(job, context)');
  expect(server).toContain('await workflowRuntime.shutdown()');
});
