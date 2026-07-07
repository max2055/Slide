/**
 * 数据完整性检查脚本
 *
 * 检查 RBAC 相关数据一致性：
 * 1. 活跃用户是否缺少角色分配
 * 2. user_roles 中是否有悬空记录（对应 user 已删除）
 * 3. role_permissions 中是否有悬空记录
 *
 * 用法:
 *   npx tsx check-data-integrity.ts
 *   npx tsx check-data-integrity.ts --fix    # 自动清理悬空记录
 *
 * 可集成到 CI/CD 或 cron 定时任务。
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';

interface IntegrityIssue {
  table: string;
  id: number | string;
  description: string;
}

async function getPool(): Promise<mysql.Pool> {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '3306', 10);
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'db_ops_ai';

  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 2,
  });
}

async function checkUsersWithoutRoles(pool: mysql.Pool): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.status
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     WHERE ur.user_id IS NULL AND u.status = 'active'`
  ) as any;

  for (const row of rows) {
    issues.push({
      table: 'users',
      id: row.id,
      description: `活跃用户 "${row.username}" (id=${row.id}) 没有任何角色分配`,
    });
  }
  return issues;
}

async function checkDanglingUserRoles(pool: mysql.Pool): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const [rows] = await pool.execute(
    `SELECT ur.id, ur.user_id, ur.role_id
     FROM user_roles ur
     LEFT JOIN users u ON ur.user_id = u.id
     WHERE u.id IS NULL`
  ) as any;

  for (const row of rows) {
    issues.push({
      table: 'user_roles',
      id: row.id,
      description: `悬空的 user_roles 记录 (id=${row.id}): user_id=${row.user_id} 对应的用户不存在`,
    });
  }
  return issues;
}

async function checkDanglingRolePermissions(pool: mysql.Pool): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const [rows] = await pool.execute(
    `SELECT rp.id, rp.role_id, rp.permission_id
     FROM role_permissions rp
     LEFT JOIN roles r ON rp.role_id = r.id
     WHERE r.id IS NULL`
  ) as any;

  for (const row of rows) {
    issues.push({
      table: 'role_permissions',
      id: row.id,
      description: `悬空的 role_permissions 记录 (id=${row.id}): role_id=${row.role_id} 对应的角色不存在`,
    });
  }
  return issues;
}

async function checkAllUsersHaveAtLeastOneRole(pool: mysql.Pool): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.status
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     WHERE ur.user_id IS NULL`
  ) as any;

  for (const row of rows) {
    const statusLabel = row.status === 'inactive' ? ' (已停用)' : row.status === 'locked' ? ' (已锁定)' : '';
    issues.push({
      table: 'users',
      id: row.id,
      description: `用户 "${row.username}" (id=${row.id}, status=${row.status})${statusLabel} 没有任何角色分配`,
    });
  }
  return issues;
}

async function fixDanglingRecords(pool: mysql.Pool): Promise<number> {
  let deleted = 0;
  // Clean user_roles with missing users
  const [urResult] = await pool.execute(
    `DELETE ur FROM user_roles ur
     LEFT JOIN users u ON ur.user_id = u.id
     WHERE u.id IS NULL`
  ) as any;
  deleted += urResult.affectedRows || 0;

  // Clean role_permissions with missing roles
  const [rpResult] = await pool.execute(
    `DELETE rp FROM role_permissions rp
     LEFT JOIN roles r ON rp.role_id = r.id
     WHERE r.id IS NULL`
  ) as any;
  deleted += rpResult.affectedRows || 0;

  return deleted;
}

async function main() {
  const fixMode = process.argv.includes('--fix');
  console.log(`🔍 Slide 数据完整性检查${fixMode ? ' (--fix 模式)' : ''}\n`);

  let pool: mysql.Pool | null = null;
  try {
    pool = await getPool();
  } catch (err: any) {
    console.error('❌ 无法连接数据库:', err.message);
    process.exit(1);
  }

  const allIssues: IntegrityIssue[] = [];

  // 1. Active users without roles (critical)
  const noRoles = await checkUsersWithoutRoles(pool);
  allIssues.push(...noRoles);
  for (const issue of noRoles) {
    console.log(`⚠️  [users] ${issue.description}`);
  }

  // 2. All users without roles (including inactive/locked)
  const allNoRoles = await checkAllUsersHaveAtLeastOneRole(pool);
  for (const issue of allNoRoles) {
    if (!noRoles.find(r => r.id === issue.id)) {
      console.log(`ℹ️  [users] ${issue.description}`);
    }
  }

  // 3. Dangling user_roles
  const danglingUserRoles = await checkDanglingUserRoles(pool);
  allIssues.push(...danglingUserRoles);
  for (const issue of danglingUserRoles) {
    console.log(`🔴 [user_roles] ${issue.description}`);
  }

  // 4. Dangling role_permissions
  const danglingRolePerms = await checkDanglingRolePermissions(pool);
  allIssues.push(...danglingRolePerms);
  for (const issue of danglingRolePerms) {
    console.log(`🔴 [role_permissions] ${issue.description}`);
  }

  // Summary
  const criticalCount = noRoles.length + danglingUserRoles.length + danglingRolePerms.length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`检查完毕。活跃用户无角色: ${noRoles.length}, 悬空记录: ${danglingUserRoles.length + danglingRolePerms.length}`);

  if (fixMode && allIssues.length > 0) {
    const danglingCount = danglingUserRoles.length + danglingRolePerms.length;
    if (danglingCount > 0) {
      const deleted = await fixDanglingRecords(pool);
      console.log(`✅ 已清理 ${deleted} 条悬空记录`);
    }
  }

  if (criticalCount > 0) {
    console.log(`\n⚠️  发现 ${criticalCount} 个需要关注的问题`);
    if (!fixMode) {
      console.log('💡 使用 --fix 参数自动清理悬空记录');
    }
  } else {
    console.log('\n✅ 数据完整性检查通过');
  }

  await pool.end();
  process.exit(criticalCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('检查失败:', err);
  process.exit(2);
});
