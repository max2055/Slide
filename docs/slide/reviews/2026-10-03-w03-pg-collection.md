# MAX-110 / W03：PG 凭证与临时连接验收

## 执行契约

范围版本沿用主任务 v2 / W03，仅修改 Schema/索引 PG 采集器、直接回归测试和隔离验收脚本。目标为 legacy CBC/v2 统一读取、损坏密文明确失败、discovery/单库客户端异常释放。无数据库迁移、密钥轮换、既有密文批量更新、实际服务配置修改或生产故障实验。

基线为 `origin/main@403e1f1fa829413db92b11bb6cb60c9189b3f866`，包含前项 MAX-108 合并 PR #112。实施分支 `codex/MAX-110-pg-credentials`，未带入工作区其他人的修改。

测试层级为调用方回归、真实 PG/MySQL 集成、最终本地集成门禁；完成条件为上述证据与 main PR 交付，合并由主任务核验八项 CI 后串行执行。硬预算未设定；实际 input/cached-input/output/费用遥测不可用，无虚构估算。子代理 0、最大深度 0、代理并发峰值 1。

## 根因和兼容决定

- 两个局部解密器只识别 `iv:ciphertext`；v2 五段 envelope 静默返回空密码。新代码在创建客户端前调用现有 `decryptData` 一次，错误统一为“实例密码解密失败，请检查密文和 ENCRYPTION_KEY”，不记录密文/明文/密钥。不使用会触发 lazy migration 的实例解密读取方法。
- 核对历史 `c8469ef` 的实例凭证 writer：CBC 从 `ENCRYPTION_KEY` 文本 `padEnd(32, '0').slice(0, 32)` 构造 UTF-8 key。当前统一解密保留该算法；hex/base64 文本在 CBC 路径仍取文本前 32 字符，v2 则按其编码解码。测试覆盖 32 字节 UTF-8、64 位 hex、32 字节 base64 三种配置。
- 历史 writer 未配置 key 时曾使用 `default-encryption-key-change-in-production`；局部采集器却使用不同默认值 `change-this-to-a-random-32-char-key`。统一接口现有安全规则要求有效配置，禁止恢复硬编码默认 key 或空密码降级。未配置 key 的历史默认密文明确报错，不自动猜测、修改或重加密。
- discovery 的连接、查询和解析在 `try/finally` 中；每个单库客户端同样受保护。关闭失败仅记录固定提示，不覆盖连接/查询/解析原错误，也不使成功采集变成失败。
- 单库失败仍允许继续采集其他库。所有索引库均失败时，错误现在保留各库原因，与 Schema 采集行为一致；返回 JSON 结构不变，生成契约检查通过。

## RED → GREEN

RED checkpoint：`83d63fd`。同一指定命令实际执行，32 失败、14 通过；六个 v2 调用方断言拿到 `['', '', '']`，异常连接 `end()` 为 0 次，另有关闭错误覆盖查询/解析错误的断言失败。

最小修复 GREEN checkpoint：`65da2ccf941cebf8601f2a9bd03e61584d13fadf`，同一命令 46/46 通过。最终补充默认数据库缺省场景后为 48/48 通过：

```bash
pnpm --filter slide-api exec vitest run src/db-connection-encryption.test.ts src/schema-service.pg.test.ts src/index-service.pg.test.ts
```

两个调用方各覆盖 v2/CBC 三类 key、空凭证、损坏 envelope/GCM tag、错误/缺失 key、禁用历史默认 key、discovery/单库 connect/query/parse 失败、cleanup 双故障、部分库失败继续、保存失败，以及无默认库时经 postgres 发现。这里的 48 是测试断言场景数量，不宣称为代码覆盖率百分比。

## 真实隔离 PG 验收

执行时间：2026-10-03，命令：

```bash
bash scripts/qualification/run-pg-collection.sh
```

结果：7/7 通过，退出码 0。地址类别为 Docker 临时容器的动态 `127.0.0.1` 映射端口，不使用开发/生产库；PG 镜像 `postgres:16-alpine`，实际版本 **PostgreSQL 16.14 / aarch64-unknown-linux-musl / Alpine 15.2.0**；元数据库为临时 `mysql:8.4`，由权威 migrations 初始化。仅使用测试假凭证，无持久 volumes，退出 trap 清理；回读确认不存在 `slide-w03-*` 运行容器。

测试 fixture 仅为注册本机临时实例显式开放测试中的 managed-loopback 策略选项；保留真实策略其余校验，不修改生产代码/配置。实例 writer、MySQL 持久化、统一解密、基础 PG 连接、两库采集与快照读取均使用真实实现/驱动。

- 真实 `createInstance` 保存 v2 到临时 MySQL；读取解密后基础 PG 连接成功；Schema 落库并回读 2 表/4 列，索引落库并回读 2 表/4 索引。采集前后原密文相同。
- `w03_reader` 为有密码的非超级用户；host 认证为 SCRAM-SHA-256。实际错密码连接返回 PG `28P01`，排除 trust 认证导致的假通过。
- 保存按历史文本 key 生成的 CBC 密文，重复 Schema/索引采集成功；采集前后 CBC 密文不变。
- discovery、表查询、列查询、索引查询四处分别改发真实 `SELECT 1 / 0`，服务器返回 division-by-zero；调用方保留错误。每次使用 admin 查询 `pg_stat_activity`，reader 会话只剩 1 条原有 managed 连接，临时连接均消失。

## 最终本地门禁（当前生产代码）

环境：macOS arm64、Node v24.18.0、pnpm 11.19.0、Vitest 4.1.8。依赖按 frozen lockfile 安装，未修改 lockfile。

| 命令 | 结果 |
| --- | --- |
| 上述指定 focused tests | 3 文件、48 测试通过 |
| 指定 focused tests + instance-database-service 两个现有测试文件 | 首次 87 测试通过；此后仅新增两个缺省库测试，最终均纳入全仓 gate |
| `pnpm -r typecheck` | 4 包通过 |
| `pnpm -r test` | API 2914 通过/136 跳过；前端 554 通过；agent-core 635 通过；sandbox-controller 22 通过/4 跳过 |
| `pnpm lint` | 0 错误、262 警告 |
| `pnpm build` | 成功，production CSP 检查通过；有既有大 chunk 提示 |
| `pnpm contracts:check` | 通过，契约无需更新 |
| `pnpm qualification:matrix` | 37/37 映射通过 |
| `pnpm security:scan` | 通过 |
| `bash -n scripts/qualification/run-pg-collection.sh` / `git diff --check` | 通过 |

全仓 gate 只在最终代码候选运行一次；环境门控测试的跳过不算通过，本次 PG 集成文件在普通全仓 suite 中门控跳过，已由上面的隔离命令单独实跑。未运行生产库或其他 PG 大版本验证，未把本地门禁代替 PR 的八项 CI/主任务审查。

## 回滚

本任务不改变存储格式、密钥或元数据 schema。可撤回两个采集器的代码变更；无需数据回滚或凭证重写。统一 decoder 和 legacy 读取能力未修改。回滚会恢复旧的 v2/连接泄漏缺陷，不能以关闭凭证错误处理作为兼容方案。
