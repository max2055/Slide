/**
 * 执行数据库迁移脚本 - Migration 009
 * 创建 cron_jobs、cron_job_logs、cron_job_params 表并插入初始数据
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
      path.resolve(__dirname, './sql/migrations/009_add_cron_jobs_tables.sql'),
      'utf-8'
    );

    console.log('执行迁移 SQL...');
    await connection.query(migrationSql);
    console.log('迁移执行成功');

    // 验证迁移结果
    const [tables] = await connection.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = '${process.env.DB_NAME || 'db_ops_ai'}' AND TABLE_NAME IN ('cron_jobs', 'cron_job_logs', 'cron_job_params')
    `) as any;
    console.log('\n创建的表:', tables.map((t: any) => t.TABLE_NAME).join(', '));

    const [cronJobs] = await connection.query('SELECT COUNT(*) AS count FROM cron_jobs') as any;
    console.log(`cron_jobs 记录数: ${cronJobs[0].count}`);

    const [cronPermissions] = await connection.query(
      "SELECT COUNT(*) AS count FROM permissions WHERE code IN ('cron:view', 'cron:manage')"
    ) as any;
    console.log(`cron 权限记录数: ${cronPermissions[0].count}`);

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
