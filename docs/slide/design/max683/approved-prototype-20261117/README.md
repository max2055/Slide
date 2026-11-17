# Slide 工作台 · 桌面设计评审

**打开 [index.html](index.html) 即可交互，无需安装或登录。** [截图索引](screenshots.html)包含三个桌面尺寸、长文本、列表、详情、两步确认和验证报告。右上角「演示设置」可切换角色、数据场景或重置。所有对象、采样、时间、权限与状态变更均为虚构；刷新页面即恢复初始业务数据。

## 设计主张

值班人员先读一句可检验的判断，再看建议、依据与唯一适用的下一步。例如「80% 的慢查询来自未命中索引的订单检索」针对慢日志中的 76/95 条记录；旁边的 P95 曲线说明响应时间的变化，不能单独证明因果。图注明确单位、阈值、窗口与采样范围。右侧对象关系把主库、调查、行动计划接在一起。

首页首项取当前演示页中可展示的一个下一步，不计算严重程度或全局优先级。其余事项以紧凑行展示；状态使用文字和色点，建议直接跟在结论后面。冷蓝只强调决策、选中导航和主操作。详情延续相同阅读顺序：调查展示请求与关联计划，行动展示不可互相替代的执行、验证、业务恢复三项判断。长结论和建议自然换行；证据默认先读三条事实及各自限制，再展开其余记录和原始资料。长文本场景提供九条依据。

**AIP 参考的转译。** 参考 Palantir [对象视图中的适用操作](https://www.palantir.com/docs/foundry/action-types/use-actions)与 [Action Log 对决策的记录](https://www.palantir.com/docs/foundry/action-types/action-log/index.html)。这里采用对象决定操作入口、证据和行动记录可追溯的组织方式；人工独立批准、显式执行、失败回执与恢复验证遵循 Slide 自身流程。页头字标为本轮构图示意，颜色与主按钮沿用仓库浅色 token 和共享按钮样式快照。为支持双击运行，演示使用静态 HTML、原生对话框和本地 JS，不新增 Lit 产品组件。

## 建议走查

| 看什么 | 怎么走 | 应看到什么 |
|---|---|---|
| 审批 ≠ 执行 | 首页 → 审阅行动计划 → 审阅审批条件 | 完整目标、参数、有效期、影响、风险、回退及证据限制；可取消、驳回、批准。批准后仍是「未执行」，单独确认执行后才进入等待回执。 |
| 同一调查多个计划 | 首页右侧「关联行动计划」 | INV-1701 下有 ACT-2041、ACT-2042，两份待批计划独立处理。 |
| 调查进行中 / 待继续 | 调查列表查 INV-1705 / INV-1704 | 前者等待已发出的请求；后者没有运行请求，补证并提交后回到同一调查，显示运行中。 |
| 通过 / 失败 / 不足 | 行动列表查 ACT-2030 / 2039 / 2038 → 验证报告 | 依次为窗口内恢复、仍未恢复、恢复未知；报告指明计划版本、执行、报告版本与观测范围。 |
| 执行中 / 不确定 | 行动列表查 ACT-2036 / 2035 | 进行中可看进展；回执未知时先对照原发送记录，不提供再次执行。 |
| 已关闭调查的历史 | 调查列表筛「已关闭」→ 商品查询延迟 | 同时保留已通过的 ACT-2030 和已过期的 ACT-2029，皆只读。 |
| 缺失与权限变化 | 演示设置 → 数据场景或角色；审批框 → 评审工具 | 区分无待办、加载失败和部分不可用；仅行动角色能看授权行动，不显示调查摘要。林舟不能批准自己写的 ACT-2041；确认前撤权会关闭对话框并清理内容。 |

## 首页的最小读取契约（拟议）

现状依据：仓库的 `apps/db-ops-api/src/operations/ui-integration.ts`、`frontend/src/app/ui/components/investigation-attention.ts` 和两个对象详情视图。现有工作台读取接口按授权和游标扫描 open/waiting 调查，每个调查最多返回一个当前下一步。无活动请求不等于调查正在运行。独立行动发现接口为 `/api/operations/actions/plans`，不能从首页推导全量行动。下列摘要、趋势和按报告状态搜索均为设计需求，不宣称接口已经提供。

| 字段 / 来源 | 用于何处 | 缺失、冲突或无权时 |
|---|---|---|
| 现有 investigationId / investigationVersion / scopeVersion、title、updatedAt、resultId / resultVersion | 来源调查标题、更新时间和绑定结果 | 不用调查时间填计划时间。无调查权限，不返回调查标题、详情、链接或按调查过滤的关联计数。 |
| 现有 kind、planId / planVersion / planHash、approvalId、executionId、reportId / reportVersion（按类型可空） | 打开精确对象，区分审批、执行、核查、验证与继续 | 必需绑定缺失 / 不匹配 → 回原记录核对，禁用写操作。 |
| **拟增** decisionSummary：conclusion、recommendation、asOf、sourceRef（对象/版本）、targetRef / displayName、impact、stage | 首页一句话判断、建议、目标和阶段；摘要由经授权的原记录投影 | 结论/建议/目标未提供时明示缺项，阶段未知；只给查看原记录，不从标题、kind 拼造结论。 |
| **拟增** evidence[]：ref、sourceType、fact、observedFrom/To、limitation、原资料权限；可选 metric、unit、samples、threshold、aggregation | 摘要出处或指标图；展开事实、时间和限制 | 不可用时保留局部提示，不画零值曲线；证据不足不能声称已恢复。 |
| **拟增或独立读取** planTitle、planUpdatedAt、expiresAt、风险和影响、参数、前置条件、停止/回退、验证约束、author、当前能力及禁止原因 | 区分计划自己的时钟；完整审阅与受限操作 | 无时间写「未提供」；缺关键条件、资格或过期时只读。最终授权与有效期需由服务端在提交时重新校验。 |
| **按版本读取** executionRef / receiptState、reportRef / verificationState、businessOutcome、expected / received / missing、failedSampleRefs、window | 三项判断、失败样本与缺样区间 | 没有确定回执 → 先核查；无报告 / 缺样 → 未验证或证据不足，业务恢复未知。 |
| **按调查读取** lifecycle、activeRequest、progress、waitingFor、结果版本及授权计划集合 | 区分进行中、无请求待继续、已关闭 | 无活动请求不画运行进度。无法读取关联数据时写「暂不可用」，不把缺失当作零。 |
| 现有 nextCursor、countScope、unavailable（行动列表另有 partial） | 当前页计数、翻页与局部错误 | 不推断全域总量、等待时长、严重级别或跨对象排序。演示列表的页码、自由搜索仅对内存快照有效；上线应以各自服务端游标和授权搜索为准。 |

## 链接、返回与验证边界

双击文件即可体验新界面。要核对旧路径，在本目录运行 `python3 serve.py --port 8765`，打开 [本地首页](http://127.0.0.1:8765/)。脚本仅绑定本机。示例：[旧调查链接](http://127.0.0.1:8765/investigations?investigation=INV-1704&attentionVersion=2)、[旧行动链接](http://127.0.0.1:8765/operations-actions?plan=ACT-2041&attentionPlanVersion=3&attentionPlanHash=demo-2041-v3&returnTo=/investigations)、[版本不符](http://127.0.0.1:8765/operations-actions?plan=ACT-2041&attentionPlanVersion=2)。外部 returnTo 不作为跳转目的地。历史入口按对象与版本核对，返回时优先恢复来源页、筛选、分页及触发控件。

[浏览器检查记录](verification.json)和[复核脚本](verify.cjs)针对本地 Chromium 与固定演示数据。覆盖三档尺寸、键盘焦点、权限和代表性业务分支；未接入 API、真实对象、身份鉴别、审计写入或执行系统。模拟权限不是安全边界。正式实现还需验证服务端实时鉴权、版本/内容绑定、并发与幂等、真实业务端到端；本轮不修改产品代码，也不做人工读屏验收。
