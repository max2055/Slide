# MAX-190 前端验证检查点

日期：2026-10-16。依据：已批准 R2 `2026-10-16-unified-metrics-plan.md`、MAX-189 先行契约 `baef0f44`。本记录是可继续执行的检查点，尚非完整业务验收交付。

## 已实施与边界

| 验收 | 当前实现／证据 | 尚待完成 |
|---|---|---|
| 三类资源唯一配置入口 | 新增／编辑保存连接后打开共享 `resource-collection-section` → `metric-configuration` 弹窗；详情展示共享摘要，设置资源策略复用摘要 | A 审定集成后的真实三类资源对照 |
| 兼容推荐、覆盖保护 | 推荐来自服务；不兼容选项禁用并解释；保留原模板、完整 overrides、组继承和 CAS；候选变化清除试采 | 正式 MySQL 代表路径 |
| 连续操作与五层状态 | 预检→试采→activate；发布／应用 revision、绑定／有效开关／执行／正式可见／覆盖独立；最多 15 次、间隔 2 秒的状态刷新，不覆盖候选 | 真正发布、应用和正式出数的 UI 证据 |
| 列表真实语义 | 绑定独立读取；linux-basic 核心列缺失不改变绑定；容量依据兼容证据单独表示版本不支持；失败／权限／未知不转未绑定 | 真实 MySQL 9.6 列表与正式值一致性 |
| 设置与中性命名 | 指标／包／组／资源审计；策略组服务端搜索；活动前端 API 为 `/api/metrics`；移除旧目录实现 | A 改名后的最终集成回归 |
| 主题、键盘、特殊状态 | 受控浏览器矩阵桌面 1440、窄屏 390、明暗；8 个采集状态；审计正常／空／403；Escape 未保存确认、继续／放弃、焦点恢复 | 真实服务正常业务截图对照 |

详情的编辑按钮直接打开同一共享弹窗，保留当前详情上下文。连接保存与采集发布分别反馈。共享 `app-dialog-close` 改为可取消事件，供所有者完成未保存确认；未取消时仍关闭。

权限事件及 401／403／404 刷新拒绝会清除旧值／证明。列表丢弃旧请求响应；设置审计和策略组同样有代次保护。状态接口失败时保留可核实的指标历史，但当前采集状态标为暂不可用。

## 已通过检查

- `pnpm --filter slide-frontend test`：133 文件、1,159 项通过。
- `pnpm --filter slide-frontend typecheck`：通过。
- `pnpm --filter slide-frontend build`：通过；CSP 检查通过，仅有既有大 chunk 提示。
- `pnpm contracts:check`：当前分支已有契约通过；此结果不能替代 A 集成后的新契约检查。
- `pnpm --filter slide-frontend exec playwright test --config playwright.max190.config.ts`：8 组通过，全部为明确标注的受控状态。
- 组合快照中 `playwright.resource-metrics.config.ts`：21 项通过；包含三类列表、设置、试采失效、发布、应用与网络设备设置。该快照使用本任务前端及 A 未审定后端，非最终合入候选。
- `git diff --check`：通过。

## 真实联调未通过及准确环境

为避免改动共享 mysql3306／主目录服务，提前联调使用任务专有 MySQL 9.6 容器、完整 Fastify／JWT 和调度器；不 mock HTTP，不调用产品 LLM。它只验证隔离环境，不能替代 R2 要求的指定 mysql3306 最终验收。

后端快照标识 `preliminary-20261016-2302`；快照内容摘要 SHA-256 为 `52d3cef58bde054315e1215478a70e2cf499287bd749385d163b95ab9f11a9fc`，基于 A 工作树的未审定实现；公开契约源为 `baef0f44`。源码和前端测试摘要、PID／cwd／命令、请求状态、截图及清理结果随证据包提供。日志中可能含敏感信息的 `*.private.log` 不进入证据包。

- 隔离目标：`192.168.1.30:23390`，镜像 `mysql:9.6`；API `127.0.0.1:3190`，Vite `127.0.0.1:5196`，Agent WS `29990`。
- 新建连接通过 UI 保存成功，并打开共享采集编辑器。`GET /api/metrics/config/resources/instance/1/status` 返回 **500**，因此编辑器保留错误并禁止发布，没有显示成未绑定或成功。
- `GET /api/database/instances` 中新实例 `db_version` 为 **null**；不能伪填为 9.6 绕过兼容检查。A 必须确认新资源版本发现与推荐初始化的正常路径，随后由 UI 复验。
- catalog／access／recommendations／groups／attempts 均返回 200；资源无策略时 policy 返回明确 `404 POLICY_NOT_FOUND`。失败止于状态加载，未执行发布或得到 3 周期正式出数，**这些验收仍未完成**。
- 首次脚本曾因 Shadow DOM slot 定位错误超时，已修正；后续记录中的 500 是真实 API 响应。审计夹具曾误拦截源码模块请求，修正后浏览器矩阵通过。
- 自有测试进程优雅退出，容器删除。未停止主目录 5173／3000 服务，未触碰 A 的容器与源码，未改共享开关／Provider。

## 接续与兼容引用

保留草稿 PR，当前不申请完整验收。等待 MAX-189 完整审查和实际合入后，记录其 PR/head、review、merge SHA，整合对应提交，再运行公开契约／受影响 E2E 和真实正常业务链路，确认至少 3 周期及唯一正式查询值、列表／详情／设置一致。必要修复仍放本任务唯一主要 PR；每次 push 更新本 Issue 的 checks 监听。

前端 E2E 已随活动命名改用 A 的 `src/metrics`、`contracts/metrics`、`metric_*` 和 `METRICS_COLLECTION_ENABLED`。A 尚未集成到本分支时，依赖这些后端文件的测试只能在组合快照运行，不能称本分支单独已能完成最终后端 gate。

活动源码扫描未发现 `metrics-v2`／`MetricsV2`／`metric_v2` 残留。保留 `/metric-registry` 及对应内部路由标识仅作旧链接到统一 catalog 的兼容映射；退出条件是旧链接迁移完成并经过调用审计。采集包语义版本和 revision 继续保留。历史文档及 schema migration ID 不重写。

完整截图／日志／摘要及校验和通过 Issue 附件交付；产物目录遵循仓库统一 outputs 规则。未调用产品 LLM；编码代理实测 token／费用遥测不可用，未派子代理。
