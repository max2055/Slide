# 数据库智能运维系统 - 数据库初始化指南

## 前提条件

1. MySQL 8.0+ 已安装并运行
2. 有 root 或具有 CREATE DATABASE 权限的账户

## 初始化步骤

### 1. 配置数据库连接

编辑 `apps/db-ops-api/.env` 文件，填写你的 MySQL 配置：

```bash
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=db_ops_ai
```

### 2. 执行初始化脚本

在项目根目录执行：

```bash
cd apps/db-ops-api
npm run init-db
```

或者手动执行 SQL：

```bash
mysql -u root -p < sql/schema.sql
```

### 3. 验证初始化

初始化成功后，会显示已创建的表列表：

```
✅ 数据库初始化完成！

📝 默认账户:
   管理员：admin / Tpam1234
   普通用户：user / user123
```

## 库表结构

### 核心表

| 表名 | 说明 |
|------|------|
| `users` | 用户账户 |
| `user_login_logs` | 用户登录日志 |
| `user_action_logs` | 用户操作日志 |
| `database_instances` | 数据库实例配置 |
| `instance_pool_stats` | 连接池状态 |
| `metrics_history` | 监控指标历史 |
| `health_check_history` | 健康检查历史 |
| `slow_queries` | 慢查询记录 |
| `slow_query_analysis` | 慢查询分析 |
| `alerts` | 告警记录 |
| `alert_rules` | 告警规则 |
| `fault_diagnoses` | 故障诊断 |
| `llm_providers` | LLM 提供商配置 |
| `ai_chat_history` | AI 对话历史 |
| `skills` | 技能配置 |
| `skill_executions` | 技能执行记录 |
| `reports` | 报告报表 |
| `system_config` | 系统配置 |

### 默认数据

初始化后会自动插入以下默认数据：

- **默认用户**: admin / Tpam1234, user / user123
- **LLM 提供商配置**: 阿里云、Ollama、Anthropic、OpenAI、DeepSeek
- **技能配置**: 7 个预定义技能
- **告警规则**: 6 个预定义告警规则
- **系统配置**: 系统名称、版本、JWT 配置等

## 启动服务

初始化完成后，启动后端服务：

```bash
# 方式 1：开发模式（热重载）
npm run dev

# 方式 2：生产模式
npm start
```

## 常见问题

### 1. 无法连接到 MySQL

```
❌ 数据库初始化失败：ECONNREFUSED
```

确保 MySQL 服务已启动：
```bash
# macOS
brew services list | grep mysql

# Linux
systemctl status mysql

# Windows
services.msc 中查找 MySQL 服务
```

### 2. 权限不足

```
❌ 数据库初始化失败：Access denied
```

使用具有 CREATE DATABASE 权限的账户，或手动创建数据库：

```sql
CREATE DATABASE db_ops_ai CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. 密码加密

生产环境请修改默认密码：

```sql
-- 修改 admin 密码
UPDATE users SET password_hash = SHA2('新密码', 256) WHERE username = 'admin';
```

## 数据备份

定期备份数据库：

```bash
mysqldump -u root -p db_ops_ai > backup_$(date +%Y%m%d).sql
```

恢复数据：

```bash
mysql -u root -p db_ops_ai < backup_20260409.sql
```

## 清理数据

如需重置所有数据：

```sql
DROP DATABASE db_ops_ai;
-- 然后重新运行 init-db 脚本
```
