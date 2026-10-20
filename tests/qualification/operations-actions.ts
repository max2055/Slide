/** P11 controlled gate. Caller must provide a task-owned MySQL, never shared 3308. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT);
if (!Number.isInteger(port) || port <= 0 || [3306, 3308].includes(port)) throw new Error('TASK_OWNED_MYSQL_PORT_REQUIRED');
function run(args: string[], env = process.env) {
  const result = spawnSync('pnpm', args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['--filter', 'slide-api', 'exec', 'vitest', 'run', 'src/operations', 'src/contracts/public-api.test.ts', '--maxWorkers=1']);
run(['contracts:check']);
run(['--filter', 'slide-frontend', 'exec', 'playwright', 'test', '--config', 'playwright.operations.config.ts'], {
  ...process.env, MAX202_MYSQL_PORT: String(port),
  T11_TEST_MYSQL_PASSWORD: process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? '',
});
