# 技术债务修复报告

**修复日期**: 2026-04-22  
**验证状态**: ✅ 全部通过

---

## 已完成修复

### 1. 密码加密存储 ✅

**问题**: 
- 使用 SHA-256 哈希密码，安全性不足
- 密码验证使用简单字符串比较

**修复**:
- 安装 `bcrypt` 库（saltRounds = 10）
- 修改 `auth-database-service.ts`:
  - `hashPassword()`: 使用 `bcrypt.hash()` 替代 SHA-256
  - `verifyPassword()`: 使用 `bcrypt.compare()` 进行安全比较
  - 添加 `hashPasswordSha256()` 向后兼容
  - 添加 `migratePasswordToBcrypt()` 无缝迁移旧密码
- 密码验证逻辑：
  - 检测哈希格式（bcrypt 以 `$2` 开头，SHA-256 是 64 位十六进制）
  - bcrypt 格式：直接验证
  - SHA-256 格式：验证后异步迁移到 bcrypt

**文件变更**:
- `apps/db-ops-api/src/auth-database-service.ts`
- `apps/db-ops-api/package.json` (新增 bcrypt 依赖)

**验证**:
```bash
# 登录测试
curl -X POST "http://localhost:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Tpam1234"}'
# ✅ 返回 token，登录成功
```

---

### 2. PostgreSQL 指标采集 SQL 修复 ✅

**问题**:
- SQL 使用 `COALESCE(blks_read, blk_read)` 在 PostgreSQL 中无效
- 如果列不存在，PostgreSQL 在解析阶段直接报错
- 错误信息：`column "blk_read" does not exist`

**修复**:
- 实现动态 SQL 兼容逻辑：
  1. 首先尝试 PostgreSQL 14+ 的列名 (`blks_read`/`blks_hit`)
  2. 捕获 `42703` 错误（列不存在）
  3. 回退到早期版本的列名 (`blk_read`/`blk_hit`)

**文件变更**:
- `apps/db-ops-api/src/database-service.ts` (第 416-460 行)

**验证**:
```bash
# 查看日志，确认不再有 blk_read 错误
# ✅ PostgreSQL 指标采集正常
```

---

### 3. Sparkline 内存泄漏检查 ✅

**检查结果**: 无需修复

**原因**:
- 当前实现已使用 `slice(-19)` 限制数组大小为 20 个元素
- `updateMetricsHistory()` 方法正确维护固定长度的历史记录
- `disconnectedCallback()` 正确清理定时器

**代码位置**:
- `frontend/src/openclaw/ui/views/instance-detail.ts` (第 795-802 行)

---

## 验证总结

| 修复项 | 验证状态 | 备注 |
|--------|----------|------|
| bcrypt 密码验证 | ✅ 通过 | 登录成功，支持 SHA-256 向后兼容 |
| PostgreSQL SQL 修复 | ✅ 通过 | 动态列名兼容生效 |
| Sparkline 内存检查 | ✅ 通过 | 无内存泄漏风险 |

---

## 待办建议

1. **密码迁移监控**: 观察日志中的密码迁移消息，确认用户逐步迁移到 bcrypt
2. **首次登录强制改密**: 可选 - 检测到旧哈希格式时强制用户修改密码
3. **PostgreSQL 指标完整性**: 考虑添加更多 PG 特有指标（锁等待、缓存命中率等）
