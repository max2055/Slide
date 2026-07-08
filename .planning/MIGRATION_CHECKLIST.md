# 数据库迁移检查清单

破坏性迁移（DROP COLUMN、RENAME、改类型等）的验证清单。

适用场景：
- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... RENAME COLUMN`
- 改变列类型（如 ENUM → VARCHAR）
- 删除表
- 修改外键关系

## 迁移前

### 1. 确认全仓引用

```bash
# 搜索字段名在前后端代码中的引用
grep -r "\.role\b" apps/ frontend/ --include="*.ts" --include="*.tsx"

# 搜索 SQL 文件中的引用
grep -r "role" apps/db-ops-api/sql/ --include="*.sql"
```

### 2. 确认 API 合约

- [ ] `GET` 端点返回的 JSON 对象中是否包含此字段
- [ ] `POST`/`PUT` 请求体是否接受此字段
- [ ] 前端 `apiClient.get<T>()` 的类型 T 是否引用此字段
- [ ] 前端渲染模板是否读取此字段

### 3. 确认前端状态

```bash
# 搜索前端 interface/type 定义
grep -rn "interface.*User\|type.*User" frontend/src/

# 搜索前端渲染引用
grep -rn "\.role\b" frontend/src/app/ui/ --include="*.ts"
```

### 4. 检查项清单

| 检查项 | 命令/方法 |
|--------|-----------|
| 后端 TypeScript 类型定义 | 检查 `interface` 中的字段名 |
| 后端 SQL 查询 | `grep -r "SELECT.*role" apps/db-ops-api/src/` |
| 前端 Interface | `grep -rn "role:" frontend/src/` |
| 前端 render 引用 | `grep -rn "\.role\b" frontend/src/app/ui/` |
| 前端 form 提交 | 检查 create/edit 函数发送的 body |
| 前端 API 调用 | `grep -rn "apiClient" frontend/src/app/ui/` (查看调用该端点的组件) |
| E2E 测试 | 检查是否有测试覆盖相关用户流程 |

## 迁移中

### 5. 迁移脚本要求

```sql
-- ✅ 好的迁移：有注释说明影响
-- Phase XX: 迁移 roles 列到 user_roles 表
-- 影响：frontend/src/app/ui/views/users-management.ts (UserInfo.role)
--       frontend/src/app/ui/views/rbac-page.ts (role badge)
-- 替代 API: GET /api/v1/rbac/users/:userId/roles
ALTER TABLE users DROP COLUMN role;
```

### 6. 兼容过渡策略

- [ ] 是否需要保留旧列一段时间作为过渡
- [ ] 前端是否需要同时支持新旧两种方式
- [ ] 是否需要数据迁移脚本

## 迁移后

### 7. 验证命令

```bash
# 1. 类型检查
cd frontend && npx tsc --noEmit

# 2. 搜索残留引用
grep -rn "\.role\b" frontend/src/ | grep -v "user_roles\|role_name\|role_id\|formRole"

# 3. 后端编译
cd apps/db-ops-api && npx tsc --noEmit

# 4. 运行数据完整性检查
cd apps/db-ops-api && npx tsx check-data-integrity.ts

# 5. 运行测试
cd apps/db-ops-api && npm test
```

### 8. 手动验证

- [ ] 创建用户的完整流程
- [ ] 编辑用户的完整流程
- [ ] 相关页面的数据显示
- [ ] 新/旧数据兼容

---

## 历史教训

### Phase 84: `users.role` → `user_roles` 表迁移

**做了什么**: 将角色从 `users.role` ENUM 列迁移到 RBAC `user_roles` 关联表。

**漏了什么**:
1. 前端 `UserInfo.role: string` 未更新 → 显示为空
2. 前端创建/编辑用户仍发送 `role` → 后端静默忽略
3. 前端 `_loadUserRoles()` 获取了正确数据但渲染时未使用
4. 硬编码的角色下拉列表与数据库不同步
5. `_removeRole` 用错了 id 字段

**如何发现**: 用户手动测试 + 代码审查

**修复日期**: 2026-06-11
