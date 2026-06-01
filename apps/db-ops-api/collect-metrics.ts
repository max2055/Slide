/**
 * 手动触发监控采集
 */
import { dbConnection } from './src/db-connection.js';
import { instanceDatabaseService } from './src/instance-database-service.js';
import { databaseService } from './src/database-service.js';
import { metricsDatabaseService } from './src/metrics-database-service.js';

async function collect() {
  await dbConnection.initialize();

  const instances = await instanceDatabaseService.getAllInstances();
  console.log('开始采集实例指标...');

  for (const instance of instances) {
    console.log(`\n采集 ${instance.name} (${instance.db_type})...`);

    try {
      // 获取实时指标
      const metrics = await databaseService.getRealtimeMetrics(instance.id);
      console.log('  指标:', metrics ? '成功' : '失败');

      // 执行健康检查
      const health = await databaseService.checkHealth(instance.id);
      console.log('  健康状态:', health?.status, '分数:', health?.health_score);

      // 更新实例健康状态
      if (health) {
        await instanceDatabaseService.updateHealthStatus(
          instance.id,
          health.health_score,
          health.status === 'healthy' ? 'healthy' : health.status === 'warning' ? 'warning' : 'critical'
        );
        console.log('  已更新健康状态');
      }
    } catch (e: any) {
      console.error('  采集失败:', e.message);
    }
  }

  // 再次获取实例列表验证
  console.log('\n\n验证实例状态:');
  const updatedInstances = await instanceDatabaseService.getAllInstances();
  updatedInstances.forEach(i => {
    console.log(`  ${i.name}: ${i.health_status} (${i.health_score})`);
  });

  await dbConnection.close();
}
collect().catch(console.error);
