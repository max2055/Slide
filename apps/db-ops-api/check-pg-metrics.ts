/**
 * 检查 PostgreSQL 指标采集
 */
import { dbConnection } from './src/db-connection.js';
import { instanceDatabaseService } from './src/instance-database-service.js';
import { databaseService } from './src/database-service.js';

async function check() {
  await dbConnection.initialize();

  // 获取所有实例
  const instances = await instanceDatabaseService.getAllInstances();
  console.log('实例列表:', instances.map(i => ({ id: i.id, name: i.name, db_type: i.db_type })));

  // 检查 databaseService 中的连接
  const connections = databaseService.getAllConnections();
  console.log('\n已建立的连接:');
  connections.forEach(c => {
    console.log(`  - ${c.name} (${c.db_type}): ${c.connected ? '已连接' : '未连接'}`);
  });

  // 手动获取 postgre-5432 的指标
  const pgInstance = instances.find(i => i.name === 'postgre-5432');
  if (pgInstance) {
    console.log('\n获取 PostgreSQL 指标...');
    const metrics = await databaseService.getRealtimeMetrics(pgInstance.id);
    console.log('指标:', JSON.stringify(metrics, null, 2));
  }

  // 手动检查健康状态
  console.log('\n执行健康检查...');
  const health = await databaseService.checkHealth(pgInstance?.id || 2);
  console.log('健康状态:', JSON.stringify(health, null, 2));

  await dbConnection.close();
}
check().catch(console.error);
