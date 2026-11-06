/** #370: real MySQL atomicity rehearsal in an isolated, disposable database.
 * Run: pnpm --filter slide-api exec tsx scripts/verify-agent-execution-config.ts
 * MYSQL_TEST_CONTAINER defaults to slide-local-mysql-1; requires its root env credential.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import mysql from 'mysql2';
import { AgentExecutionConfigService } from '../src/security/agent-execution-config-service.js';

const container = process.env.MYSQL_TEST_CONTAINER || 'slide-local-mysql-1';
const database = `slide_370_${process.pid}_${Date.now()}`;
function sql(statement: string, useDatabase = true): string {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --batch --raw --skip-column-names',
  ], { input: `${useDatabase ? `USE ${database};` : ''}\n${statement}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
const executor = {
  async execute(statement: string, values?: unknown[]): Promise<[any]> {
    const output = sql(mysql.format(statement, values));
    return [statement.trimStart().startsWith('SELECT')
      ? output.split('\n').filter(Boolean).map(line => {
        const [config_key, config_value] = line.split('\t');
        return { config_key, config_value };
      }) : {}];
  },
};
const service = new AgentExecutionConfigService(() => executor);
const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')
  .match(/CREATE TABLE IF NOT EXISTS `system_config` \([\s\S]*?;/)![0];
try {
  console.log(`MySQL ${sql('SELECT VERSION();', false)}; isolated schema ${database}`);
  sql(`CREATE DATABASE ${database}`, false);
  sql(schema);
  const initial = { approvalEnabled: true, restrictedNetworkEnabled: false };
  const requested = { approvalEnabled: false, restrictedNetworkEnabled: true };
  for (const seeded of [false, true]) {
    sql('DELETE FROM system_config');
    if (seeded) await service.set(initial, 7);
    // The second requested row fails after the first row has been processed.
    sql("ALTER TABLE system_config ADD CONSTRAINT reject_network CHECK (config_key <> 'agent_sandbox_network_enabled' OR config_value = 'false')");
    await assert.rejects(service.set(requested, 7), /EXECUTION_CONFIG_UPDATE_FAILED/);
    const state = await service.get();
    assert.equal(state.approvalEnabled, true);
    assert.equal(state.restrictedNetworkEnabled, false);
    assert.equal(sql('SELECT COUNT(*) FROM system_config'), seeded ? '2' : '0');
    console.log(`PASS second row failure: ${seeded ? 'existing rows unchanged' : 'no inserted rows remain'}`);
    sql('ALTER TABLE system_config DROP CHECK reject_network');
  }
  for (const approvalEnabled of [false, true]) {
    for (const restrictedNetworkEnabled of [false, true]) {
      await service.set({ approvalEnabled, restrictedNetworkEnabled }, 7);
      assert.deepEqual(await service.get(), { approvalEnabled, restrictedNetworkEnabled, reasonCode: 'EXECUTION_CONFIG_READY' });
    }
  }
  console.log('PASS all four successful combinations persisted');
  await service.set(initial, 7);
  await service.set({ approvalEnabled: false }, 8);
  assert.deepEqual(await service.get(), { approvalEnabled: false, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
  await service.set({ restrictedNetworkEnabled: true }, 8);
  assert.deepEqual(await service.get(), { ...requested, reasonCode: 'EXECUTION_CONFIG_READY' });
  assert.equal(sql('SELECT COUNT(*) FROM system_config WHERE updated_by = 8 AND value_type = \'boolean\''), '2');
  console.log('PASS both single-field updates preserve the other control and metadata');
} finally {
  sql(`DROP DATABASE IF EXISTS ${database}`, false);
  console.log('Disposable schema removed; business data untouched');
}
