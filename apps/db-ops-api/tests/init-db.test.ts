import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));

// #468: load the real entry with real process exit semantics, replacing only
// the connection and runner methods. No dotenv file or network is used.
function run(scenario: string, baseline = false) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const scenario = process.env.INIT_DB_SCENARIO;
    const trace = (event) => console.log('[fixture]' + event);
    process.on('unhandledRejection', (error) => {
      console.error('UNHANDLED', error.message);
      process.exitCode = 99;
    });
    require('mysql2/promise').createConnection = async () => {
      trace('connect');
      if (scenario === 'connect-fail') {
        throw Object.assign(new Error('controlled connect failure'), { code: 'ECONNREFUSED' });
      }
      if (scenario === 'access-denied') {
        throw Object.assign(new Error('controlled access failure'), { code: 'ER_ACCESS_DENIED_ERROR' });
      }
      return {
        query: async (sql) => {
          trace(sql);
          if (scenario === 'query-fail') throw new Error('controlled query failure');
          return [[{ Tables_in_isolated: 'controlled_table' }]];
        },
        end: async () => {
          trace('end-start');
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (scenario.includes('cleanup-fail')) throw new Error('controlled cleanup failure');
          trace('end-complete');
        },
      };
    };
    const { MigrationRunner } = await import('./src/migrations/runner.ts');
    MigrationRunner.prototype.run = async () => {
      trace('run');
      if (scenario.startsWith('migration-fail')) throw new Error('controlled migration failure');
    };
    MigrationRunner.prototype.baseline = async (actor, reason) => {
      trace('baseline:' + actor + ':' + reason);
    };
    if (${baseline}) process.argv.push('--baseline');
    await import('./init-db.ts');
  `], {
    cwd, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: '/dev/null',
      INIT_DB_SCENARIO: scenario,
      DB_HOST: 'isolated.invalid', DB_PORT: '3306', DB_USER: 'isolated',
      DB_PASSWORD: '', DB_NAME: 'isolated',
      MIGRATION_ACTOR: 'controlled-actor', MIGRATION_REASON: 'controlled-reason',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).not.toContain('UNHANDLED');
  return { ...result, trace: result.stdout.split('\n').filter((line) => line.startsWith('[fixture]')).map((line) => line.slice(9)) };
}

describe('init-db CLI cleanup and exit (#468)', () => {
  it.each(['query-fail', 'migration-fail'])('awaits connection cleanup after %s and exits 1', (scenario) => {
    const result = run(scenario);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`controlled ${scenario === 'query-fail' ? 'query' : 'migration'} failure`);
    expect(result.trace.slice(-2)).toEqual(['end-start', 'end-complete']);
    expect(result.trace.filter((event) => event === 'end-start')).toHaveLength(1);
    expect(result.stdout).not.toContain('数据库初始化完成');
  });

  it.each([
    ['connect-fail', '无法连接到 MySQL 服务器'],
    ['access-denied', '请检查用户名和密码'],
  ])('exits 1 without attempting cleanup for %s', (scenario, diagnostic) => {
    const result = run(scenario);
    expect(result.status).toBe(1);
    expect(result.trace).toEqual(['connect']);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain('数据库初始化失败');
  });

  it('reports cleanup failure separately while preserving the initialization error', () => {
    const result = run('migration-fail-cleanup-fail');
    expect(result.status).toBe(1);
    expect(result.trace.slice(-2)).toEqual(['run', 'end-start']);
    expect(result.stderr).toContain('数据库初始化失败: controlled migration failure');
    expect(result.stderr).toContain('数据库连接关闭失败: controlled cleanup failure');
    expect(result.stderr.indexOf('controlled migration failure')).toBeLessThan(result.stderr.indexOf('controlled cleanup failure'));
  });

  it('exits 1 when only cleanup fails, without an unhandled rejection', () => {
    const result = run('cleanup-fail');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('数据库初始化完成');
    expect(result.stderr).toContain('数据库连接关闭失败: controlled cleanup failure');
    expect(result.stderr).not.toContain('数据库初始化失败');
  });

  it.each([false, true])('keeps successful initialization and baseline=%s unchanged', (baseline) => {
    const result = run('success', baseline);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.trace).toEqual([
      'connect',
      'CREATE DATABASE IF NOT EXISTS `isolated` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      'USE `isolated`',
      baseline ? 'baseline:controlled-actor:controlled-reason' : 'run',
      'SHOW TABLES FROM `isolated`',
      'end-start', 'end-complete',
    ]);
    expect(result.stdout).toContain('controlled_table');
    expect(result.stdout).toContain('数据库初始化完成');
    expect(result.stdout).toContain('受控 bootstrap 流程');
  });
});
