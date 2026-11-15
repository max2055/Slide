import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Explicit opt-in only. Credentials remain in memory and child environment.
if (!process.env.MAX671_ACCESS_PROFILES || !process.env.MAX671_OUTPUT_DIR) {
  throw new Error('Set MAX671_ACCESS_PROFILES and MAX671_OUTPUT_DIR for real acceptance');
}
const profile = JSON.parse(readFileSync(process.env.MAX671_ACCESS_PROFILES, 'utf8'))['mysql-test'];
if (Number(profile.port) !== 3308) throw new Error('This acceptance requires the authorized MySQL test port 3308');
const output = resolve(process.env.MAX671_OUTPUT_DIR);
mkdirSync(output, { recursive: true });
const args = ['pnpm', '--filter', 'slide-frontend', 'exec', 'playwright', 'test', '--config', 'playwright.branding-session.config.ts'];
const result = spawnSync('corepack', args, {
  env: { ...process.env, MAX671_OUTPUT_DIR: output, MAX671_TEST_MYSQL_HOST: profile.host,
    MAX671_TEST_MYSQL_PORT: String(profile.port), MAX671_TEST_MYSQL_USER: profile.user,
    MAX671_TEST_MYSQL_PASSWORD: profile.password },
  encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
writeFileSync(resolve(output, 'browser.log'), (result.stdout ?? '') + (result.stderr ?? ''));
console.log(result.stdout ?? '');
if (result.stderr) console.error(result.stderr);
writeFileSync(resolve(output, 'browser-exit.json'), JSON.stringify({ command: 'corepack ' + args.join(' '), exitCode: result.status, error: result.error?.message ?? null }));
process.exitCode = result.status ?? 1;
