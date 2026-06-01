#!/usr/bin/env node
/**
 * 数据库初始化脚本
 * 执行 schema.sql 创建库表结构
 */

import 'dotenv/config';
import * as mysql from 'mysql2/promise';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// 数据库配置
const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
};

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
      multipleStatements: true, // 允许执行多条 SQL
    });

    console.log('✅ MySQL 连接成功');

    // 读取 schema.sql 文件
    const schemaPath = path.join(__dirname, 'sql', 'schema.sql');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

    console.log('📄 读取 schema.sql 文件');

    // 执行 schema
    await connection.query(schemaContent);

    console.log('✅ 数据库 schema 创建成功');

    // 验证表是否创建成功
    const [tables] = await connection.query('SHOW TABLES FROM db_ops_ai');
    console.log('📋 已创建的表:');
    const tablesArray = tables as any[];
    tablesArray.forEach((table: any) => {
      const tableName = Object.values(table)[0];
      console.log(`   - ${tableName}`);
    });

    console.log('\n✅ 数据库初始化完成！');
    console.log('\n📝 默认账户:');
    console.log('   管理员：admin / Tpam1234');
    console.log('   普通用户：user / user123');

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
