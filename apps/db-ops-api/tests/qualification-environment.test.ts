import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Run the real qualification script with a deterministic MySQL startup/restart.
function runQualification(neverReady = false) {
  const directory = mkdtempSync(join(tmpdir(), 'slide-mysql-readiness-'));
  const executable = (name: string, body: string) =>
    writeFileSync(join(directory, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  try {
    executable('sleep', 'exit 0');
    executable('docker', `
case "$1" in
  run) exit 0 ;;
  port) echo '127.0.0.1:13306' ;;
  exec)
    # The initialization server answers once, then restarts.
    if [[ ! -f "$READINESS_FIXTURE/pinged" ]]; then
      touch "$READINESS_FIXTURE/pinged"
      exit 0
    fi
    exit 1 ;;
  rm) echo cleanup >> "$READINESS_FIXTURE/actions" ;;
  *) exit 64 ;;
esac`);
    executable('pnpm', `
if [[ "$4" == node ]]; then
  count=0
  [[ ! -f "$READINESS_FIXTURE/probes" ]] || count=$(cat "$READINESS_FIXTURE/probes")
  count=$((count + 1))
  echo "$count" > "$READINESS_FIXTURE/probes"
  [[ "$DB_HOST" == 127.0.0.1 && "$DB_PORT" == 13306 ]]
  [[ "$READINESS_NEVER_READY" != 1 ]] || exit 1
  # Interrupt two successful queries: initialization must wait for three new ones.
  [[ "$count" != 1 && "$count" != 4 ]] || exit 1
else
  echo "$4 $5 probes=$(cat "$READINESS_FIXTURE/probes")" >> "$READINESS_FIXTURE/actions"
fi`);
    const result = spawnSync('bash', [resolve('../../scripts/qualification/run-environment.sh'), 'bootstrap-upgrade'], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        READINESS_FIXTURE: directory,
        READINESS_NEVER_READY: neverReady ? '1' : '0',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      actions: readFileSync(join(directory, 'actions'), 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('qualification MySQL readiness', () => {
  it('survives the initialization restart and migrates only after consecutive published-port queries', () => {
    const result = runQualification();
    expect(result.status, result.stderr).toBe(0);
    expect(result.actions.match(/tsx init-db.ts probes=7/g)).toHaveLength(2);
    expect(result.actions).toContain('vitest run probes=7');
    expect(result.actions).toContain('tsx ../../tests/qualification/assert-bootstrap.ts probes=7');
    expect(result.actions).toContain('cleanup');
  });

  it('fails closed and cleans up when the published port never becomes ready', () => {
    const result = runQualification(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('qualification MySQL did not become stable on the published port');
    expect(result.actions).toBe('cleanup\n');
  });
});
