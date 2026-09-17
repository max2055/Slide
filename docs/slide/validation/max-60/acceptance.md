# MAX-60 验收记录

2026-09-17，基于 origin/main `c53e137`（controller 与前次复核 `711f5cb` 一致）。

- `SANDBOX_MYSQL_INTEGRATION=1 pnpm --filter slide-sandbox-controller test`：6 文件 24 测试通过，含真实隔离 MySQL 8.4 + 两个独立 controller 进程的 4 项集成测试。
- 随后新增故障分类 focused tests：`pnpm --filter slide-sandbox-controller exec vitest run src/nonce-store.test.ts`，2 测试通过。业务代码未再变化，合计 26 测试。
- `pnpm --filter slide-sandbox-controller typecheck`：通过。
- `pnpm --filter slide-api exec vitest run src/security/sandbox-client.test.ts`：6 测试通过，签名协议兼容。
- `pnpm security:deployment`、`docker compose --env-file deploy/.env.production.example -f compose.production.yaml config --quiet`、`git diff --check`：通过。

集成证据：同请求双进程并发得到 200/401，顺序和 controller 重启后重放均 401，无害执行器计数仅增加一次；独立新请求 200。过期和篡改 401，status 已认领 nonce 在 network-scans 拒绝。数据库时间拒绝超窗请求；清理删除过期记录但保留活跃认领。测试数据库停止时三个入口均 503；数据库重启后仍在 freshness 窗口内的已认领请求 401，新请求 200。

测试只创建唯一命名临时 MySQL 容器，测试后删除容器及匿名卷；controller 使用临时 PATH 中无害 docker 替身计数，未连接实际 Docker socket。测试启动失败先后定位为 macOS 临时目录符号链接、Docker 动态映射端口重启变化；已修正测试路径/端口并复测通过。

未执行生产部署，真实生产副本/持久性参数仍由部署者核对。部署先执行 096 迁移并配置专用最小权限账号；恢复去重数据的停流/轮换要求见 `docs/slide/security/sandbox-nonce.md`。本变更不承诺数据库丢失已确认事务后的自动容灾。

硬预算未设定；实际 raw/cached/output token 和费用遥测不可用；子代理总数 0，深度 0，无代理并发。
