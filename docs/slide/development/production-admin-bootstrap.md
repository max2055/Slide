# 生产管理员初始化

生产启动和 `pnpm --filter slide-api init-db` 均通过 MigrationRunner 执行初始化；必须设置 `NODE_ENV=production`，以及现有安全配置要求的 JWT、加密密钥和 `INITIAL_ADMIN_USERNAME/PASSWORD`。用户名须非空、不含首尾空白且不超过 50 字符，密码去除首尾空白后至少 12 字符且原值不超过 72 UTF-8 字节。密码原值不做 trim。

生产基线执行时跳过历史固定账号 INSERT，SQL 原文和账本 checksum 不变。所有 schema 校验成功后，在迁移命名锁内以事务创建配置管理员，bcrypt cost 12，独立随机盐，并绑定 admin 角色；此步骤在认证监听启动前完成。无效配置或初始化失败拒绝启动。

升级会检查历史 admin/user 的口令是否仍为公开种子口令（包含首次登录迁移后的 bcrypt），将这些账号设为 inactive 并递增 session_version；不删除账号、业务历史和密码记录。已改密账号与其他身份保持原样。此处口令比较不发送至外部服务。

配置身份若已存在且为启用的 admin，重启不重置密码、不恢复状态、不重复授予权限。若配置身份与普通账号、禁用账号或被禁用的旧种子冲突，启动失败，须选择未使用的初始化身份；不会覆盖旧账号密码。配置新身份会创建一个管理员，因此升级时应沿用同一配置身份，避免无意增加管理员。

开发/测试环境保留历史基线种子；不得以非生产 NODE_ENV 启动生产服务。手工直接导入历史 SQL 绕过应用初始化不属于安全生产安装入口。更新前应备份数据库；旧版本不会撤销本版本的禁用状态，恢复账号应走现有受控账号管理流程。

回归命令（仅连接隔离测试 MySQL，测试创建并删除随机 max267_ schema）：

```bash
BOOTSTRAP_TEST_MYSQL_PORT=33367 pnpm --filter slide-api exec vitest run src/config/security-config.test.ts src/migrations/production-bootstrap.mysql.test.ts
```

有密码的测试实例同时设置 `BOOTSTRAP_TEST_MYSQL_PASSWORD`，不要在日志中打印值。CI 的 MySQL 集成门禁运行相同回归。
