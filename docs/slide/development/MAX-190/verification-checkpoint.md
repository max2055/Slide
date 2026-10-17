# MAX-190 R1 实施检查点

更新：2026-10-17（本地时间）。这是可接续的开发检查点，**不是完整业务验收交付**。唯一草稿 PR：<https://github.com/max2055/Slide/pull/200>；开发分支 `codex/max-190-unified-collection`。不使用含用户修改的平台基线分支作 PR 祖先。

## 当前有效设计依据

用户确认 R1：“OK，没问题，继续推进”。MAX-188 / MAX-190 的 `metadata.designReview.status=approved`；确认附件 `APPROVAL.md` 覆盖冻结包中历史“待审核”文字。

- 冻结附件：`unified-collection-prototype-R1.zip`。
- SHA-256：`ab49721cb37448222295b526cd6c1744b94e2b5b546596c5f2f0ad4416ae6074`，下载后实测一致。
- 确认依据：MAX-190 交付线程成员评论 `01a1456e-58c1-7ea5-aef3-0fd4f67d53ec`，2026-10-16 15:57:02 UTC；`APPROVAL.md` 附件 `01a1456c-8def-79df-ab5e-b5a1954f0b20`。
- 已解除视觉待审限制。Chief 合并视觉范围前仍须核对该版本及真实业务证据。不新增全批启动门槛，不暂停 MAX-189。

## 本次实现与证据边界

| 范围 | 本次实现 | 证据／剩余验收 |
|---|---|---|
| MySQL 代表编辑入口 | 页内基本信息／监控与采集页签；候选配置主列＋当前状态侧栏；模板推荐、缺口、对象开关、间隔、策略组搜索和高级覆盖 | 产品组件、受控接口桌面1440／窄屏390、明暗截图；真实 MySQL 正常链路待 A 审定集成 |
| 连续启用流程 | 同一共享弹窗检查→试采→发布→应用／正式数据；保留停用发布、全局阻塞、权限、CAS、样本检查和有界刷新 | 受控交互通过，不把本次试采或应用成功解释为正式可见 |
| 连接与候选保护 | 页签切换保留候选；保存连接并继续配置不卸载既有候选；连接变化与重复预检均清除旧试采；普通保存／返回／详情导航保留未保存确认 | 覆盖隐藏页签对话框、继续／放弃、Shadow DOM 焦点恢复、提交期间禁止退出、关联失败仅重试关联 |
| 详情 | 三列当前事实、覆盖／质量与真实配置事件；未知与错误单独表达；MySQL 编辑入口回同一页内编辑器 | 受控正常／空／加载／失败／权限／部分／未知／全局关闭矩阵；真实列表／详情／设置一致性待验收 |
| 全局模板 | 共享表格与模板详情弹窗；保留名称／ID／资源类型筛选、权限、发现方式、原始定义与版本；既有策略组编辑功能保留 | R1 模板表／详情／空结果／Escape 焦点通过；无绑定对象统计契约，未复制原型演示计数 |
| 服务器、网络设备 | 继续复用唯一采集编辑器、状态摘要和既有资源入口 | 按用户要求，在 MySQL 真实对照通过后再推广页内宿主；本次未宣称这一步完成 |

R1 外层设计审阅壳不是产品导航。截图直接挂载实际产品组件，**API 响应受控**，不是部署截图或真实采集验收。页面数据由契约驱动，没有复制演示凭据、模板绑定数、正式值或资源版本。视觉对照说明见 `r1-visual-comparison.md`。

## 当前验证

- 完整前端单测：133 文件、1,161 项通过。
- 前端 typecheck：通过。
- 前端 build／CSP：通过，保留既有大 chunk 提示。
- 当前分支 `contracts:check`：通过；A 尚未集成，不能替代新后端最终契约门禁。
- `playwright.max190.config.ts`：16 项通过（R1 8 项＋摘要／审计异常矩阵8项）。
- `playwright.resource-metrics.config.ts resource-metrics.spec.ts`：8 项通过（三类列表、试采失败／空样本／候选失效／发布／应用、空资源）。
- `metric-settings.spec.ts` 已适配表格与详情弹窗；生产目录数据测试仍依赖 A 的 `src/metrics`，当前分支缺该实现，未在本次单独运行；不补双目录 fallback。
- `git diff --check`：通过；活动前端未发现 `metrics-v2`／`MetricsV2`／`metric_v2` 残留。

## 真实业务及集成仍未完成

MAX-189 已提交草稿 PR #202；本轮准确候选为 `8208d1d2ee939d9f0bcd7d8471461f1afea535ea`。Chief 完整审查尚未通过，无 merge SHA。允许隔离组合验证前端兼容；组合候选不等于审定集成，A 提交不混入 B 交付分支。此前隔离 MySQL 9.6 提前联调止于 status HTTP 500、新实例 `db_version=null`；没有发布／三周期／唯一正式值，也未替代指定 mysql3306 验收。未改 A 源码或共享服务。

PR 旧 head `61e1920a` CI 已结束：frontend/backend/security 等通过；browser 与 browser-qualification 缺后端新路径 `src/metrics/config/registry.js`，investigation-api-qualification 的旧后端 flow 测试仍按旧界面操作；release-artifact / ci-gate 连带失败。原 run：<https://github.com/max2055/Slide/actions/runs/38923371822>。这些依赖在 A 审定集成后复验，不保留双 API 或伪填资源版本绕过。

接续：读取 A 实际 PR/head、Chief 独立审查及实际 merge SHA，整合审定提交，运行新契约／受影响 gate，以 mysql3306 完成真实 UI 检查→试采→发布→应用→至少三周期→正式查询值与列表／详情／设置一致性；对照批准 R1 后推广其余资源入口。完整证据前保持草稿，不置 in_review。每次 push 配置当前子任务 checks / 30m / on-timeout wake，目标15astra，交付线程不变。

## 独立 fixture 兼容修复（2026-10-17）

- `max157-business` 保留旧 history 中的 92.4 作为反例，验证真实 JWT/SQL/HTTP evidence API 返回无正式事实和明确缺口，UI 显示暂无证据且不回读旧值；没有伪填 publication 或来源门禁。
- 三个正式观测 fixture 的读取模式、发布 ticket source 对齐 A 的 `semantic` 契约；保留真实 publication store 写入／读取路径。`metric-settings` 按多个不可变 PostgreSQL 版本验证搜索，不再假定名称唯一。
- 隔离候选为 A `8208d1d2` 加本 B 前端；MySQL 8.4 单独容器、随机 schema、回环临时端口。修复前已复现旧值断言、旧读取模式及单版本假设失败；修复后 max157 7项、详情观测4项、查询5项、模板11项、列表/流程8项及网络2项通过（37个不同用例，复用未变用例结果）。B typecheck、diff check 通过。两份 MAX-175 实采脚本仅发现3项，未重试VM或宣称实采通过。
- A 所有的 `flow.mysql.test.ts` 仍需传入新 `ConfigurationReader`（当前构造省略第五参数，status/recommendations 会503），并按 R1 先打开连续弹窗、展开技术证据、使用模板表格/详情及五层状态断言。只读入口应验证禁用，不能用旧布局倒逼修改产品。该文件未在本轮修改。
- 详细组合 SHA、环境和日志随本轮 Issue 附件交付；这些受控/隔离验证不替代指定 mysql3306 三周期与实服务 R1 验收。

## 历史记录与产物

[原型实施前检查点](verification-checkpoint-pre-r1.md) 保留此前实现、1,159项单测、21项未审定组合 E2E 和真实失败环境；只作为历史，涉及旧弹窗和旧截图的描述已由上方覆盖，不能自动恢复为当前设计依据。

本轮截图、测试日志、批准依据摘要、源码散列与对照 HTML 存在统一 outputs/MAX-190/r1-checkpoint，并以 Issue 附件交付。没有产品 LLM 调用、子代理或本轮常驻服务；编码代理实测 token／费用遥测不可用。
