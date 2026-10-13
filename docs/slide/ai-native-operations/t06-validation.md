# T06 前端工作空间验证与阻塞交接

日期：2026-10-13。任务 MAX-148，父任务 MAX-140。基线 `main` 为 `1d5ba7559ddd0dbb5fb1d0746daeac700a5e4c54`（T05 #158）；独立分支 `codex/MAX-148-workspace`。本次未修改后端、schema/auth/ledger/executor，不委派子代理，不新增外部模型请求。AGENTS 运行配置及 `.multica/` 私有材料不进入 PR。

## 实现与兼容

- 导航工作空间为关注事项、AI 工作空间、普通对话；资源菜单为数据库实例、服务器、网络设备。保留 dashboard/chat/资源/运维/治理/设置旧路由及用户既有默认首页，增加关注事项与调查作为可选首页。未来 V2/V3 页不作为可用入口。
- 关注事项读取现有聚合事件接口的最近 20 项活动事件，按严重度、更新时间、ID 确定排序，复用共享表格；可切换原资源概览、进入事件中心。未重写原告警业务页。
- 调查列表分页和 query/state/Profile/resource 筛选；创建、详情、三层状态、共享 Message Parts renderer、继续/取消、历史分页、结果版本和证据引用。取消仅标记等待后端确认；结果、Run 终态和业务恢复均由后端决定。
- 普通 Chat 保持直接输入，转换关联原 Session，不复制消息。使用现用 grouped renderer，不引入无生产引用的旧 chat-message-list。
- 真实 WS 观察使用 DirectGatewayClient 独立订阅；序号去重、缺口重新 snapshot、终态后帧不覆盖事实。断线/撤权清空内容；切换调查及撤权使旧响应失效；未知接受结果保留原 body/幂等键核对，不自动另建 Run。operator 拒绝不会删除仍有权限读取的内容。
- 有界 Review 修复并发 FileReader 附件覆盖/串 Session、旧身份 greeting 响应、退出/权限更新的 Chat view 缓存；附件回调捕获稳定 Session receiver。
- 1600 三列，1024 证据弹窗，390 单栏；共享 dialog 的 Escape/焦点恢复通过。截图发现移动端既有固定导航遮盖，本次仅在工作空间 shell 为导航栏预留空间，并加入实际边界断言。

## 当前验证

| 检查 | 当前结果 |
| --- | --- |
| `pnpm --filter slide-frontend test` | 97 文件、771 项通过，0 skip |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm --filter slide-frontend build` | 通过，CSP 检查通过；现有大 chunk 提示 |
| `pnpm lint` | 通过 |
| `pnpm contracts:check` | 通过；未改变公开契约 |
| `git diff --check` | 通过 |
| `T06_TEST_MYSQL_PORT=62480 pnpm --filter slide-frontend exec playwright test e2e/investigation-workspace.spec.ts --workers=1` | **10 通过、2 失败、0 skip/未运行**；未通过完整验收 |

真实验收用本次隔离 MySQL 8.4 容器、每个 fixture 独立 schema、正式 migrations、实时 JWT/主体/资源权限、Fastify HTTP、DirectAdapter WS、MysqlWorkflowStore/WorkerRuntime、正式 InvestigationExecutor。只有 Provider 输出与只读目标工具为合成数据；没有外部模型请求。fixture 退出回收服务并 DROP 自建 schema。本次测试容器 `slide-max148-mysql` 结束后停止，未动其他服务。实际 token/费用遥测不可用，不把合成 usage 数字当真实消耗。

已通过的真实浏览器场景：1600/1024/390 无页面横向溢出且内容不被导航遮盖、证据 dialog Escape 焦点；普通 Chat 直接发送、转换保留 Session/消息 ID、刷新；WS 1012 断线立即隐藏并从快照恢复且不新建执行；partial/outcome_unknown 不重发、不声称恢复；viewer 追加拒绝与同 JWT 资源 live 撤权清缓存；加载/空/错误/无权限深链；裸/agent:main: 前缀普通 Chat 的 Stop 均真实持久化 cancelled；205 条历史事实分页、刷新及消息 ID 不重复。

未通过：创建→真实工具→取消→新 Run→版本/刷新完整链路，在正常 owner 的第二次执行观察期间会触发下述后端冲突；另一个独立 A→B→A 重捕获探针稳定失败。早期曾出现 UI 断言全部通过但日志含错误的运行，已废弃其“完整通过”结论，并增加每个场景的 observationErrors 断言。

## 直接阻塞：后端 Parts 重捕获幂等冲突

正常 owner 未撤权的实际链路日志：`IDEMPOTENCY_PAYLOAD_MISMATCH` → WS 4001（reasonBytes=31）→ 前端按撤权安全清空内容，导致验收失败。诊断 wrapper 仅记录真实 replay 的异常，不修改或吞掉生产行为。

调用链：`InvestigationWatchService.tick` → `stream.replay/capture` → `captureCanonicalDocument` → `captureObservation` → `appendObservation`。

- `apps/db-ops-api/src/investigations/observation-db.ts:30` 比较重捕获事件，仅将事件外层 sequence 归零。
- 同文件 `:36` 对入库 Parts payload 内层 sequence 设置实际持久序号；重捕获输入的内层 sequence 为 0（`stream.ts:74`）。
- source checkpoint 被另一次内容捕获推进后再次遇到已有 payload hash，append 路径比较同 source key，因内层序号差异拒绝。实际事件诊断显示 source 后缀哈希等于将内部序号归零后的输入哈希，与原存储 payload 哈希不同。
- 独立真实 MySQL 探针：在授权 transaction 内，同一 canonical document 以 A 时间、B 时间、A 时间依次捕获，第三次稳定抛出上述错误；transaction rollback。没有模型调用，没有更改后端源码。
- `stream.ts:249` 的 tick catch 将这类存储错误关闭为撤权 4001，错误语义也需要后端所有者复核。

请父任务协调具备后端所有权的修复：幂等比较的规范化/检查点重捕获，及非授权存储失败的 WS 处理。随后以当前 PR 源码重跑完整 T06 浏览器验收。不得通过降低观察频率、吞错、跳过探针或把 4001 当网络重连掩盖。

另有需后端复核的顺序风险：`stream.ts:99` 按秒精度 created_at 和随机 Run ID 排序，`routes.ts:118` 以 at(-1) 派生无 active request 时的执行状态；同秒多 Run 的顺序不等同接受版本顺序。前端直接消费 derivedRunState，没有拿旧成果的 runId 冒充最新取消 Run。

## 未完成与交接条件

- 尚缺 Profiles 管理、调查策略及用量与成本的可接入设置页面。当前 settings-navigation 保留现有能力；公开 `/api/investigations/policies` 管理读写接口未找到，不能把未来演示页伪装成已完成。请父任务确认现有对应接口/页面或明确后续责任边界。
- 成果两版路径在早期运行可达，但最终完整链路被上述缺陷阻塞；超过默认页大小的成果版本浏览器分页未验收。证据过期展示已实现，但本轮未专门做真实到期浏览器场景。关注事项接口/排序为既有能力复用，本轮未做告警生产采集端到端。
- 新 spec 是显式本地真实验收，当前 CI 工作流未包含它；CI 绿不能代替本文件记录的失败。完整 T12/A01–A18 不在本次范围。
- 本次仅提供独立 draft PR 与证据，Issue 保持 blocked；父独立 Review、真实验收和当前 head required CI 全部齐备前不合并、不称完整 P1/V1。不标 done。修复后沿此分支继续，普通 merge 后核验 main 包含关系。

日志、三尺寸截图、错误哈希诊断通过 MAX-148 最终评论的附件交付；仓库源码对应哈希另见 `t06-source-hashes.json`。附件用于复核，不把工作目录路径作为已交付链接。
