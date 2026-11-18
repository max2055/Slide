import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('MAX-681 deep smoke rejects missing credentials before fetch and forwards explicit credentials', () => {
  for (const configured of [false, true]) {
    const env: NodeJS.ProcessEnv = { ...process.env, SMOKE_BASE_URL: 'http://isolated.invalid:3210', SMOKE_USER: 'fixture-user' };
    delete env.SMOKE_PASS;
    if (configured) env.SMOKE_PASS = 'explicit-fixture-value';
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const entry = './tests/deep-smoke.ts';
      process.argv[1] = entry;
      globalThis.fetch = async (url, options) => {
        if (!process.env.SMOKE_PASS) throw new Error('FETCH_BEFORE_CREDENTIAL_GUARD');
        const body = JSON.parse(options.body);
        if (url !== process.env.SMOKE_BASE_URL + '/api/auth/login'
          || body.username !== process.env.SMOKE_USER || body.password !== process.env.SMOKE_PASS) process.exit(93);
        process.exit(0);
      };
      await import(entry);
    `], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(configured ? 0 : 1);
    if (!configured) {
      expect(result.stdout + result.stderr).toContain('SMOKE_PASS must be explicitly injected');
      expect(result.stdout + result.stderr).not.toContain('FETCH_BEFORE_CREDENTIAL_GUARD');
    }
  }
});
