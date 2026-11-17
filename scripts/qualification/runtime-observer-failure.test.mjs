import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from './runtime-browser-evidence.mjs';
import { runtimeEvidence } from '../../frontend/e2e/runtime-evidence.ts';

for (const businessExit of [0, 9]) {
  test(`MF-R2 lost failure marker EIO remains failed closed (business=${businessExit})`, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'observer-eio-'));
    const input = join(root, 'input'); const oldEnv = process.env.RUNTIME_EVIDENCE_FILE;
    const append = fs.appendFileSync;
    try {
      process.env.RUNTIME_EVIDENCE_FILE = input;
      fs.writeFileSync(input, ['length', 'reject'].map(scenario => JSON.stringify({ scenario, kind: 'result', status: 'passed', collectionFailed: false, dropped: 0, wallBefore: 1, mono: 1, wallAfter: 1 })).join('\n') + '\n');
      fs.appendFileSync = (path, data, ...args) => {
        if (JSON.parse(String(data)).kind === 'collection') { const error = new Error('controlled EIO'); error.code='EIO'; throw error; }
        return append(path, data, ...args);
      };
      syncBuiltinESMExports();
      const evidence = runtimeEvidence(new EventEmitter(), 'recovery', { status: 'passed' });
      evidence.fail(); await evidence.finish();
      assert.equal(collect(input, join(root, 'output'), businessExit, { requireProducerLatch: true }), businessExit || 2);
      const report = JSON.parse(fs.readFileSync(join(root, 'output')));
      assert.equal(report.collection, 'failed'); assert.equal(report.dropped, 2);
    } finally {
      fs.appendFileSync=append; syncBuiltinESMExports();
      if (oldEnv === undefined) delete process.env.RUNTIME_EVIDENCE_FILE; else process.env.RUNTIME_EVIDENCE_FILE=oldEnv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
