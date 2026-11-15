import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

for (const mode of ['unset', 'missing', 'unwritable', 'directory', 'after-collect']) {
  test(`MAX-590 D1: ${mode} destination preserves collect and exactly one RPC response`, () => {
    const result = spawnSync('python3', ['-c', String.raw`
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import sys

spec = importlib.util.spec_from_file_location('tracker', 'scripts/qualification/serve-e2e-tracker.py')
tracker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracker)
with tempfile.TemporaryDirectory(prefix='tracker-d1-') as work:
    base = Path(work)
    mode = sys.argv[1]
    target = base / mode
    if mode == 'unset':
        os.environ.pop('SERVE_E2E_DIAGNOSTICS_FILE', None)
    else:
        if mode == 'missing':
            target = target / 'missing' / 'lifecycle'
        elif mode == 'unwritable':
            target = Path('/dev/null/lifecycle')
        elif mode == 'directory':
            target.mkdir()
        else:
            target.touch()
        os.environ['SERVE_E2E_DIAGNOSTICS_FILE'] = str(target)

    class Collector:
        calls = 0
        def collect(self):
            self.calls += 1
            if mode == 'after-collect':
                # The received checkpoint could succeed, but the sent
                # checkpoint would fail after a successful response.
                target.unlink()
                target.mkdir()
            return [12345]

    collector = Collector()
    server, client = socket.socketpair()
    client.settimeout(2)
    try:
        client.sendall(b'{"op":"collect"}\n')
        tracker.handle_connection(collector, server)
        server.close()
        payload = b''
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            payload += chunk
        assert collector.calls == 1, (mode, collector.calls)
        assert payload.count(b'\n') == 1, (mode, payload)
        assert json.loads(payload) == {'ok': True, 'pids': [12345]}, (mode, payload)
        print('PASS', mode, 'collect_calls=1 responses=1')
    finally:
        server.close()
        client.close()
`, mode], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`PASS ${mode} collect_calls=1 responses=1`));
  });
}
