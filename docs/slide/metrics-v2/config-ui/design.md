# MAX-74 配置界面设计草案 v1

状态：2026-09-18 用户批准推荐方案，2026-09-19 实施与验证。保留原方案及基线记录。

## 执行契约

范围沿 Issue 实施计划 v3：设置中心的指标目录、采集包、采集策略；实例、主机、网络设备详情的资源生效配置；选包→策略→权限/能力预检→有界试采→影响预览→发布。

排除 MAX-75 的评分、告警、Agent 和核心指标消费改造；不修改 Canonical 语义或 CoreProfile；不启用生产调度、不部署生产、不增加任意 SQL/Shell/OID 输入。

硬预算未设定。实际 input/cached input/output/费用遥测不可用；子代理 0，深度 0，并发峰值 1。停止条件：必需验收完成并交付 PR，或遇到需要明确批准的新设计、外部副作用或无法恢复的环境阻塞。无关缺陷不扩展范围。

## 已核实基线

隔离分支 `agent/15astra/max74-config` 从最新 `origin/main` 创建，HEAD 为 `1ac24d183f7242310a3541747c0601de1295586d`。原任务工作树已有 AGENTS.md 修改，未改动或搬移。

下列 PR 均为 MERGED，且 `git merge-base --is-ancestor <merge SHA> HEAD` 全部退出 0：

| 依赖 | PR | merge SHA |
| --- | --- | --- |
| MAX-69 | https://github.com/max2055/Slide/pull/82 | ee4485926083b6a525bfc7c440559c4f13132174 |
| MAX-71 | https://github.com/max2055/Slide/pull/84 | 222f577cca14099bfe9560ebdede95d78794803a |
| MAX-73 | https://github.com/max2055/Slide/pull/85 | 5b48e0f5813a4c306e753c53c0057f349d5c9ea1 |
| MAX-72 | https://github.com/max2055/Slide/pull/86 | 1ac24d183f7242310a3541747c0601de1295586d |

## 当前实现与直接缺口

- `frontend/src/app/ui/settings-navigation.ts` 已有 `/settings/monitoring/metrics` 与旧 `/metric-registry` 映射；`views/settings-shell.ts` 目前只挂载旧指标目录。
- `apps/db-ops-api/src/metrics-v2/policy/routes.ts` 已提供资源/组读取、preview、publish；`service.ts` 提供资源权限、expected_revision CAS 和配置来源。
- `packages/model.ts` 与 `packages/runner.ts` 提供不可变包和单次执行；配置 HTTP 尚未暴露包目录与有界试采。
- `scheduler/service.ts` 需要注入 CollectorAccess；当前未发现生产 CollectorAccess 接入方。Host 验收报告亦明确生命周期 epoch 由测试清单提供，不能把 fixture 当生产发现能力。
- 试采 HTTP、最近尝试读取及受权资源 transport 接线是本任务端到端验收的直接阻塞。补充范围必须限定在配置界面所需端点，不顺带启用正式采集循环。

## 方案比较与建议

1. 推荐：沿用设置路由和策略服务，增加一个三类资源共用的配置组件；补齐目录/最近尝试/单次试采端点，复用 runner 和现有资源凭据服务。兼容面最小，能满足真实 API 验收。
2. 只做前端并 mock 试采：修改较少，但无法满足真实 API 和凭据隔离验收，不作为交付方案。
3. 建立独立模板系统及新调度器：可独立演进，但重复已有 PackageRegistry/Worker，违反当前范围，不采用。

## 推荐方案细节

### 页面与共享组件

- 设置入口保持 `/settings/monitoring/metrics`，用现有 `view` 参数增加“指标目录 / 采集包 / 采集策略”页签；兼容旧路由，保留旧目录访问能力。
- 指标目录固定列：ID、Canonical/Extension、语义版本、单位、kind、资源范围。采集包固定列：ID、模板版本、资源类型、适用条件；详情显示固定采集器、所需权限和推荐策略。核心产品列不从包动态生成。
- 三类资源详情增加同一个“采集配置”组件，展示绑定 pin、published/applied revision、应用状态、每项生效值及来源、指标能力与判定依据/时间、最近正式尝试；试采结果与正式尝试区分。
- 资源和组覆盖采用 inherit/set 或 inherit/enable/disable，与现有后端完整替换 overrides 语义一致；编辑时保留未修改覆盖。升级仅选择同 ID 的不可变版本，保留覆盖，不提供 Canonical/CoreProfile 编辑器。
- 使用 app-card、app-form-field、app-data-table、app-badge、app-empty-state 和共享按钮/Toast。移动端表格在组件内部滚动，表单单列，无页面横向溢出。

### 后端补充边界

- 目录端点返回内置包和指标的非秘密元数据，采用现有权限；不返回 credential_ref、连接口令或原始远程异常。
- 最近尝试端点按已鉴权资源读取既有持久化尝试，限定条数，返回稳定状态、时间、revision 与错误码。
- 单次试采提交与 preview 相同的候选配置及 expected_revision，先进行资源管理权限、包 pin、策略、身份和 revision 校验，再解析该资源自己的 transport；客户端不能指定地址、凭据引用、命令或能力证据。
- 复用 PolicyService/resolvePolicy 和 compilePlan/runPackage。预检明确区分配置合法、资源能力证据和尚未实际验证的目标权限；不得把静态预览称为目标权限验证成功。
- 试采限制一次批次、平台超时/行数/系列数上限及并发；取消停止后续读取，迟到结果丢弃；在途操作未收敛时不得提前释放同资源占用。复用已有共享存储协调，不能仅靠浏览器禁用按钮防重入。
- 试采不发布配置、不写正式观测、不覆盖正式 Counter 基线、不启动周期采集；返回脱敏的能力、attempt 与样本结果。Counter 首次缺基线正常显示 unknown，不伪造速率。Host 缺权威 epoch 时明确 unknown，不生成虚假生命周期证据。
- 既有 publish 保持 CAS。候选配置变化立即使前端预检/试采/预览结果失效；409 提示重新加载、预览和试采，不自动覆盖他人配置。试采成功不等于发布或 applied 成功。

### 状态和安全

- unsupported 仅由资源/版本等证据判定；timeout 为尝试失败，不改为永久不支持。unknown、disabled、stale 与 failed 分开展示。
- 写操作仍由服务器资源权限和实例 scope 强制鉴权；前端只读模式隐藏或禁用修改入口。权限未加载时不开放编辑。
- 401、403、404、409、输入非法、暂时不可用分别有可理解反馈；接口错误仅展示允许的稳定错误码。

## 验收与验证计划（尚未运行）

1. 前端 focused tests：路由兼容、只读权限、覆盖完整替换、编辑使预览失效、409 不盲重试、超时/unsupported 区别、secret 不出现、异步资源切换不串数据。
2. 后端 focused tests：真实 Fastify 路由鉴权、恶意额外字段拒绝、目录脱敏、试采并发/超时/迟到结果、正式存储不被试采修改。
3. 隔离 MySQL + 真实 HTTP API：选包、继承预览、单次试采、发布、查询 pending/applied 区分；两个相同 expected_revision 并发写仅一个成功、另一个 409。生产数据库及既有服务不参与。
4. Playwright 在桌面及移动视口访问真实 API，验证路由、只读用户、能力依据、试采、预览、发布和 revision 冲突。fixture/模拟目标 transport 与真实隔离数据库/HTTP 分别标注，不能把 route mock 当真实 API。
5. 最终当前代码运行前端 typecheck/build、受影响后端 typecheck 与模块 gate；文档统一放 `docs/slide/metrics-v2/config-ui/`，运行 `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts`，以及相关包/schema 快照校验。
6. 交付 PR、commit、仓库相对证据路径、浏览器报告和回退说明。CI 当时状态单列，不将未完成 CI 或跳过测试称为通过。

## 回退

撤销新页签和新增配置端点接线，恢复原设置目录入口；保留已有策略、包、revision、正式观测和审计。任何为试采协调增加的状态只做增量迁移，不删除既有表或回退 revision。

## 设计批准记录

用户已批准推荐方案，包括目录、最近尝试和有界试采 HTTP 接线。范围未扩大；验收结果见 verification.md。

原草案作为 Issue 附件供审阅，本文件为获批方案的仓库记录。
