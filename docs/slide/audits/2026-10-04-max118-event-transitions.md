# MAX-118 / W10 验收证据

实施基线：`main@561d0cdd95ddf042f047a51c0780c92d808b3b47`（前置 MAX-117 / PR #122 已合并）。范围 v1：事件调查、解决、人工确认、关闭的事务与审计；直接涉及的既有自动解决与启动历史补录边界；生成契约、界面含义、回归与 CI 接线。排除自动恢复引擎、生产数据修改、一般架构重构。无数据库迁移。

## 最终行为与兼容决定（供 MAX-107 与后继任务使用）

- 流转在同一 connection 上 `BEGIN → SELECT ... FOR UPDATE → 状态/日志/关联告警更新 → COMMIT`；日志或关联更新失败，整个事务回滚。调查仅接受 open，解决仅接受 open/investigating/handled，关闭仍必须 resolved 且 verification_passed_at 非空。
- 调查、解决、确认、关闭重复请求明确返回 HTTP 409，不覆盖首次依据、actor、时间或追加重复日志。四条路由传递当前登录 userId；备注与复盘也保留 actor。旧权限和实例访问检查不变。
- `POST /api/alerts/events/:id/verify-recovery` 为人工确认。reason 必须为非空白字符串，长度不超过 1024（JS UTF-16 长度），trim 后同时用于字段与日志。非字符串/空白/过长返回 400，不再截断依据。日志 action 字段仍为 status_changed，details.action 为 manual_recovery_confirmed，confirmation_type 为 manual。
- 继续读取旧 verification_passed_at / verification_actor_id / verification_reason；旧确认可满足原关闭条件，不伪造缺失历史 actor。界面显示人工确认时间、人 ID、依据，未知历史信息明确显示“历史记录未提供”；说明人工确认不代表客观指标观察窗验证通过。
- 既有自动 resolve 在锁后复核状态及关联告警；迟到执行无法将 closed 改回 resolved。系统日志 actor 为 null；自动 resolve 不提供人工确认，也不能直接关闭。
- 启动 `retroactiveResolve()` 改为只读检查，最多列出 200 个候选 ID，保留 resolved: 0 返回字段。当前告警均已解决不能证明历史解决时间，因此不再启动批量补录。
- 完整历史审计查询：`apps/db-ops-api/sql/audits/max118-alert-events-dry-run.sql`。列出缺确认、缺关闭/解决日志、确认日志与依据/actor 不一致、仍有活动成员、当前成员均解决但历史未知，以及孤立关联。仅输出 ID、状态与问题类别，不输出用户依据原文。它不是修复指令；逐项结合原始日志与外部事实人工审阅，无可靠事实时保留原记录。本次未读取或修正生产历史。

## RED → GREEN 与验收

环境：macOS 本地隔离 worktree，Node v24.18.0、pnpm 11.19.0、MySQL 8.4 临时容器，镜像 digest `mysql@sha256:c592c15aaf4a1961e15d82eb31ea5987dda862d1c4b1e93424438c0e91dc1f8d`。使用空假凭证、动态 localhost 端口、临时数据库与完整迁移链；不读取应用 .env、不触碰用户服务或数据库。测试结束清理数据库、容器。

初始 RED：真实 MySQL 24 个用例中 20 个失败、4 个通过；前端 2 个用例失败。故障证明日志失败保留了已更新事件、关联更新失败保留了状态/日志、并发重复动作同时成功、确认被覆盖、迟到自动解决重开 closed、启动补录倒推历史。另一个契约 RED 为 1 失败、8 通过。首次 RED commit 的提交说明误写 21 失败，GREEN commit 已更正为实际 20。

最终结果：

| 命令 | 结果 |
|---|---|
| `bash scripts/qualification/run-alert-event-transitions.sh` | 28/28 通过、0 skipped；真实 MySQL，全新容器自动清理；已接入 recovery-qualification CI |
| focused MySQL + event-service + public-api | 51/51 通过（当时为 28 + 14 + 9）；日志/关联更新故障回滚、并发首次胜者、409、关闭条件、actor/依据、迟到自动流转、legacy、只读清单 |
| `pnpm -r typecheck` | 四个模块全部通过 |
| `pnpm -r test` | API 2983 通过 / 242 环境用例跳过；frontend 568 通过；agent-core 654 通过；sandbox 22 通过 / 4 环境用例跳过。本任务 28 个 MySQL 用例另由上述脚本全部实际执行 |
| `pnpm --filter slide-frontend test:browser` | 48/48 通过；事件确认含义另由前端 DOM 测试覆盖，不将通用 browser gate 冒称生产确认 E2E |
| `pnpm build` | 通过，CSP 检查通过；既有大 chunk 警告 |
| `pnpm lint` | 0 errors，260 warnings（未做无关清理） |
| `pnpm contracts:check` / `pnpm qualification:matrix` | 通过；OpenAPI 与客户端类型已生成，37/37 finding 映射通过 |
| `pnpm security:audit` / `pnpm security:scan` | 无已知依赖漏洞 / secret scan 通过 |
| `git diff --check` | 通过 |

HTTP 测试运行 server.ts 中实际路由注册和服务/真实 MySQL；仅替换认证与实例授权 guard 以隔离其他启动服务，验证路由转发 actor 和 HTTP 返回，不等同于真实 JWT/生产部署 E2E。故障注入只在临时库创建 trigger。生产规模、真实历史审阅、生产发布未执行；CI 八个 job 由父任务针对精确 PR head 核验后合并。

## 回滚与资源

无 DDL、无历史删除、无生产修复操作。应用回滚保留已有事件/日志与 verification_* 数据，仍须保留关闭前确认条件；不要因回滚重新启用历史批量补录。停用新 CI 测试不改变数据库。历史问题只交付 dry-run 查询，不能用当前告警状态批量倒推修复。

硬预算未设定；raw input / cached input / output / 实际费用遥测不可用，不用内部预算代替实测。子代理 0、最大子代理深度 0、并发代理峰值 1。只创建任务范围内隔离 worktree、临时测试容器、PR 与验收文档；未调用付费模型。
