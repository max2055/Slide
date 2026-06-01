/**
 * 执行数据库迁移脚本
 * 添加 parent_id 字段到 chat_messages 表
 */

import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function runMigration() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'Tpam1234',
    database: process.env.DB_NAME || 'db_ops_ai',
    multipleStatements: true,
  });

  try {
    console.log('连接到数据库...');
    const connection = await pool.getConnection();
    console.log('数据库连接成功');

    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, './sql/migrations/001_add_parent_id_to_chat_messages.sql'),
      'utf-8'
    );

    console.log('执行迁移 SQL...');
    await connection.query(migrationSql);
    console.log('迁移执行成功');

    // 验证迁移结果
    const [rows] = await connection.query(`
      DESCRIBE chat_messages
    `);
    console.log('\nchat_messages 表结构:');
    console.table(rows);

    connection.release();
    console.log('\n迁移完成!');
  } catch (error) {
    console.error('迁移失败:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration().catch(console.error);
