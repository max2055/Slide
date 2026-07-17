#!/usr/bin/env node
/**
 * 数据库初始化脚本
 * Apply the authoritative migration ledger to an empty database.
 */

import 'dotenv/config';
import * as mysql from 'mysql2/promise';
import { MigrationRunner } from './src/migrations/runner.js';

// 数据库配置
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};
const databaseName = process.env.DB_NAME || 'db_ops_ai';

async function initializeDatabase() {
  console.log('🔧 开始初始化数据库...');
  console.log(`📍 连接目标：${config.host}:${config.port}`);

  let connection;

  try {
    // 首先连接到 MySQL（不指定数据库）
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
    });

    console.log('✅ MySQL 连接成功');
    if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error('DB_NAME must contain only letters, numbers, and underscores');
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.query(`USE \`${databaseName}\``);

    await new MigrationRunner({
      query: (sql, values) => connection.query(sql, values as any) as any,
      getConnection: async () => ({
        query: (sql, values) => connection.query(sql, values as any) as any,
        release: () => {},
      }),
    }).run();

    console.log('✅ 数据库 migrations 创建成功');

    // 验证表是否创建成功
    const [tables] = await connection.query(`SHOW TABLES FROM \`${databaseName}\``);
    console.log('📋 已创建的表:');
    const tablesArray = tables as any[];
    tablesArray.forEach((table: any) => {
      const tableName = Object.values(table)[0];
      console.log(`   - ${tableName}`);
    });

    console.log('\n✅ 数据库初始化完成！');
    console.log('\n📝 首个管理员须通过受控 bootstrap 流程创建。');

  } catch (error: any) {
    console.error('❌ 数据库初始化失败:', error.message);
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('   请检查用户名和密码是否正确');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   无法连接到 MySQL 服务器，请确保 MySQL 服务已启动');
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// 运行初始化
initializeDatabase();
