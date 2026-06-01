/**
 * 验证数据库内容
 */
import { dbConnection } from './src/db-connection.js';
import { instanceDatabaseService } from './src/instance-database-service.js';

async function verify() {
  await dbConnection.initialize();

  // 验证所有实例（包括非 active 状态）
  const [allInstances] = await dbConnection.query('SELECT id, name, status FROM database_instances');
  console.log('📊 所有实例 (包括非 active):');
  console.log(JSON.stringify(allInstances, null, 2));

  // 验证 LLM providers
  const [llmProviders] = await dbConnection.query('SELECT id, name, display_name, enabled, is_default FROM llm_providers');
  console.log('\n🤖 LLM 提供商:');
  console.log(JSON.stringify(llmProviders, null, 2));

  // 验证 skills
  const [skills] = await dbConnection.query('SELECT id, name, display_name, enabled FROM skills');
  console.log('\n🛠️  Skills:');
  console.log(JSON.stringify(skills, null, 2));

  // 验证告警规则
  const [alertRules] = await dbConnection.query('SELECT id, name, metric_name, threshold, severity FROM alert_rules');
  console.log('\n📋 告警规则:');
  console.log(JSON.stringify(alertRules, null, 2));

  // 验证用户
  const [users] = await dbConnection.query('SELECT id, username, role, status FROM users');
  console.log('\n👥 用户:');
  console.log(JSON.stringify(users, null, 2));

  await dbConnection.close();
}
verify().catch(console.error);
