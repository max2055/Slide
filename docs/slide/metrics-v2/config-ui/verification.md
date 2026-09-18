# MAX-74 验收记录

日期：2026-09-19。分支 `agent/15astra/max74-config`，基线 `1ac24d183f7242310a3541747c0601de1295586d`；实现和证据随同一 PR 提交。设计批准见 MAX-74 2026-09-18 的“批准”回复。

## 交付与证据

- 设置中心新增指标目录、采集包、采集策略；`/metric-registry` 映射旧目录，不替换原功能。固定列展示 Canonical/Extension、语义版本、单位、kind、资源范围；包无权重排核心页面。
- 数据库实例、主机、网络设备详情复用 `metric-configuration`。显示绑定版本、published/applied revision、来源、能力依据和正式尝试。数值及指标覆盖完整保留，候选修改使预览和试采失效。
- `config/catalog`、资源 `access/attempts/trial` 接线现有 JWT 与资源权限；试采沿 PolicyService 校验 pin、revision、策略和权限，禁止客户端 target/credential/命令。
- `MysqlScheduleStore.reserve` 提供跨进程资源互斥及平台槽位。试采限一次执行；超时后不再发起读取，不接受迟到结果，等待在途 IO 收敛后才释放占用。SQL 用专用会话，SSH 失败关闭连接，SNMP 使用现有固定请求及目标授权。
- 试采不发布策略、不写正式观测或 Counter 基线。缺少生命周期证据保持 unknown；timeout 是尝试失败，不是永久 unsupported。发布为 pending，不伪报 applied。

## 必需验收

`apps/db-ops-api/src/metrics-v2/config/flow.mysql.test.ts` 使用真实 Fastify HTTP、隔离 MySQL、生产 PolicyStore/TrialStore 和 Chromium；通过 Vite 代理访问真实端点，无 Playwright route mock。

- 选包 → 组继承预览 → 有界试采 → 发布 → pending；两个同 revision 写入只有一个成功，另一个 409。
- 数据库确认试采后正式 observations/attempts 表仍为空。
- 写入正式 timeout 尝试后真实 API 返回该资源最多 20 条，跨资源读取 403。
- 1440px/375px 页面完成预览、试采与发布；展示 group 来源和能力依据，无页面级横向溢出，无凭据 canary。
- 浏览器预检后由另一个 HTTP 写入者推进 revision；页面发布冲突、清空旧依据、禁用再次发布，重新加载后展示新 revision，无盲重试。
- 只读主体无修改入口；设置页包目录可用。旧路由及详情入口另由前端 focused tests 覆盖。

截图：`screenshots/1440.png`、`screenshots/375.png`。

### Fixture 边界

身份由测试 preHandler 注入管理员/只读 ActorContext；生产注册仍使用既有 verifyToken。本验收不声称覆盖真实登录或 JWT 签发。
资源 inventory 与远程 MySQL transport 是固定模拟目标；HTTP、策略持久化、reservation、CAS、最近尝试查询和浏览器组件为真实实现。未使用生产数据库或生产设备。
MySQL 使用已有隔离容器 `max74-config-mysql`，仅发布 `127.0.0.1:33374`。每个测试自行创建并删除独立数据库；HTTP/Vite/Chromium 在测试结束时关闭。

## 验证命令

均从仓库根目录运行：

```bash
# 安装仓库依赖和 Chromium 后，指定无密码 root 的一次性本机 MySQL 测试端口。
METRICS_V2_TEST_MYSQL_PORT=33374 pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2/contracts.test.ts tests/phase-94-docs-structure.test.ts --maxWorkers=1
pnpm --filter slide-frontend exec vitest run src/app/ui/components/metric-configuration.test.ts src/app/ui/views/settings-shell-security.test.ts src/app/ui/views/instance-detail-diagnosis.test.ts src/app/ui/views/server-detail-hosted-instances.test.ts src/app/ui/views/network-device-detail.test.ts
pnpm --filter slide-frontend typecheck
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend build
```

前端 focused：5 文件、23 项通过。前后端 typecheck 通过；Vite build/CSP 通过，保留现有动态导入及大 chunk 警告。

首次并发指标模块回归：289 通过，1 失败，1 跳过。失败为既有 `policy/store.mysql.test.ts` 的迁移重跑检查超默认 5 秒；未改测试/迁移逻辑，单 worker 复核该文件 9/9 通过。归类为并发数据库负载下的时限波动。最终单 worker 门禁：20 个文件通过、1 个文件跳过；350 项通过、1 项跳过，耗时 25.54 秒。包含本项 3 项真实 HTTP/MySQL/浏览器验收、4 项路由边界测试及完整 metrics-v2 契约/schema 校验。

Host SSH 实机资格测试需要独立 SSH 地址/凭据，本次未提供，属已有采集器可选实机验证，不替代本项真实 HTTP 配置闭环。生产采集调度与生产发布不在范围内。

## 回退与剩余限制

撤销本 PR 恢复旧设置入口及原 policy registry/接线；无新增迁移，无需删表或回退 revision。已有包绑定、正式观测和审计保留。已绑定新增包的资源需要先停用或保留对应 registry 支持，避免旧版本不能解析 pin。

CI 状态以 PR head 对应检查为准；本地结果不代表 CI 已通过。无生产发布、无合并动作。
硬预算未设定；raw input/cached input/output/费用实际遥测不可用。子代理 0、最大深度 0、并发代理峰值 1。
