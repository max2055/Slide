/**
 * 数据库连接测试脚本
 */

import { dbConnection } from './src/db-connection.js';
import { instanceDatabaseService } from './src/instance-database-service.js';

async function testDatabase() {
  console.log('🔍 开始测试数据库连接...');

  // 测试连接
  const connected = await dbConnection.initialize();
  console.log(`数据库连接状态：${connected ? '✅ 成功' : '❌ 失败'}`);

  if (!connected) {
    console.log('\n⚠️  数据库未连接，可能原因：');
    console.log('   1. MySQL 服务未启动');
    console.log('   2. 数据库尚未初始化');
    console.log('   3. 数据库配置不正确');
    console.log('\n💡 建议操作：');
    console.log('   1. 安装并启动 MySQL 服务');
    console.log('   2. 运行：npm run init-db 初始化数据库');
    console.log('   3. 检查 .env 文件中的数据库配置');
    return;
  }

  // 测试获取实例
  const instances = await instanceDatabaseService.getAllInstances();
  console.log(`\n📊 数据库实例数量：${instances.length}`);

  if (instances.length > 0) {
    console.log('实例列表:');
    instances.forEach(inst => {
      console.log(`   - ${inst.name} (${inst.db_type}) @ ${inst.host}:${inst.port}`);
    });
  } else {
    console.log('\n⚠️  没有数据库实例');
    console.log('可能原因：');
    console.log('   1. 数据库刚刚初始化，还没有添加实例');
    console.log('   2. 所有实例状态都不是 active');
    console.log('\n💡 可以通过 API 添加实例：');
    console.log('   POST /api/database/instances');
  }

  // 测试获取用户
  const users = await dbConnection.query('SELECT id, username, role, status FROM users');
  console.log(`\n👥 用户数量：${(users as any[]).length}`);
  (users as any[]).forEach(u => {
    console.log(`   - ${u.username} (${u.role}, ${u.status})`);
  });

  await dbConnection.close();
}

testDatabase().catch(console.error);
