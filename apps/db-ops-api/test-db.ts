#!/usr/bin/env node
/**
 * 数据库连接测试脚本
 * 测试 MySQL 连接并显示当前配置
 */

import { dbConnection } from './src/db-connection.js';

async function testConnection() {
  console.log('🔍 测试数据库连接...\n');
  console.log('当前配置:');
  console.log(`  DB_HOST: ${process.env.DB_HOST || 'localhost'}`);
  console.log(`  DB_PORT: ${process.env.DB_PORT || '3306'}`);
  console.log(`  DB_USER: ${process.env.DB_USER || 'root'}`);
  console.log(`  DB_NAME: ${process.env.DB_NAME || 'db_ops_ai'}\n`);

  try {
    const connected = await dbConnection.initialize();
    if (connected) {
      console.log('✅ 数据库连接成功！');

      // 尝试查询表
      try {
        const [tables] = await dbConnection.getPool()?.query('SHOW TABLES FROM db_ops_ai') || [];
        const tableList = Array.isArray(tables) ? Object.values(tables[0] || {}) : [];
        console.log(`\n📋 数据库中的表 (${tableList.length} 个):`);
        tableList.forEach(t => console.log(`   - ${t}`));
      } catch (e: any) {
        console.log('\n⚠️  数据库 db_ops_ai 不存在或无访问权限');
        console.log('请运行：npm run init-db');
      }

      await dbConnection.close();
    } else {
      console.log('❌ 数据库连接失败');
      console.log('\n请检查:');
      console.log('1. MySQL 服务是否已启动');
      console.log('2. .env 文件中的数据库配置是否正确');
    }
  } catch (error: any) {
    console.error('❌ 连接错误:', error.message);
    console.error('\n可能的原因:');
    if (error.code === 'ECONNREFUSED') {
      console.error('- MySQL 服务未启动');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('- 用户名或密码错误');
    } else if (error.code === 'ENOENT') {
      console.error('- 无法找到数据库文件');
    }
  }
}

testConnection();
