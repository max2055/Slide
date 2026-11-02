# MAX-240 完整历史流程 Implementation Plan

> **Execution:** 在既有授权和仓库规则内顺序执行，不委派。

**Goal:** 用正式来源保全历史窗口、身份、停用解绑后的授权读取和当时阈值/事件，测量650资源规模。

**Architecture:** 合并已接受 MAX-239/238 依赖，保留 RAW-PAGE 实现。读取继续要求 publication 与精确观测身份一致；历史额外接受不可变 source acceptance 的 revision/generation，而最新值与正式采集仍使用当前围栏。阈值只引用样本修订对应不可变 snapshot，事件使用现有 episode，不实现第二个 writer。

**Tech Stack:** Fastify、TypeScript、MySQL、Lit、Vitest、Playwright。

### 1. 整合契约
- 合并 `0a9eec2e13b03c7665c025080fce799f769247fe`，只解决公共契约冲突，生成 OpenAPI/TS，保留 observations 路由。
- `pnpm contracts:generate` 后运行 `pnpm contracts:check`，不切换分支。

### 2. 历史读取
- 修改 `metrics/rollout/formal-store.ts` 的历史 readWindow/readObservationPage/dimensions；最新值、baseline 与 queryWindow 原当前围栏保留。
- 修改 `metrics/consumers/service.ts`：显式窗口不因当前停用/缺模板拒绝，定义从安装的固定版本目录并集读取；同 id 不同 semantic_version 返回独立 series，不拼接；默认当前查询维持既有行为。
- 扩充 MySQL 历史测试，证明已接受旧 revision/generation、停用解绑、改名后保留，shadow/未接受 revision/撤权拒绝不变。

### 3. 当时阈值与事件
- 新增读侧 `metrics/consumers/history-context.ts`：按窗口正式样本修订找 immutable trigger snapshots；按现有 episode 时段筛选，限制数量并显式拒绝超限。
- 接到 query 响应，前端语义组件展示当时规则、事件和同窗口链接；明确未能证明的配置生效区间，不拿当前阈值回填。
- 显示实际配置保留策略与执行开关；保留策略不是已有数据覆盖承诺。

### 4. 验证和交付
- focused：consumer/query/observations/formal MySQL、语义组件和历史 context 测试。
- 受控非3306一次性 MySQL：1440槽首尾、分页、缺口峰值、授权/撤权、快照不变。
- 用500服务器/100数据库/50网络设备、每资源1指标、60秒、24h假设生成936000条正式行，记录真实HTTP延迟、截断/错误数量和环境；不宣称SLO。
- 重跑受影响模块、前后端类型/构建、契约；浏览器1440/1366/1920及权限负例。
- 提交当前分支并更新现有PR568；交给Chief独立复核，不合并部署。若内部生产契约仍缺，给出准确owner/文件/签名及已完成部分，不以整单done等待。

### 5. Chief 复核后接续（起点 29a2029ea）
- 已接受 1440/分页/权限、受控解绑、冻结阈值和容量证据复用。维护历史生产者改归 P2/MAX-244，不要求 MAX-239 重做。
- 准确失败 job `124708649600` / run `41259145415` 的 V23_SOURCE_EXACT_ALERT_REQUIRED 在本地按 `bash scripts/qualification/run-v23-source.sh` 复现：55 passed / 1 failed。
- 根因链：29a2029ea 为共享 runtime consumer 注入用户实时复验；既有 `operational.ts` 使用资源限定的内部 actor（userId/sessionVersion=0）；复验拒绝后 catch 返回 unknown，故没有告警。源码包 runtime 本身无本轮差异，属于本次引入，不能当成旧测试失败跳过。
- 最小修复：保留内部调用使用的既有 consumer，HTTP 默认入口单独使用带实时复验的 consumer；不按传入的 actor 字段绕过认证。原真实库测试补充 HTTP 对内部 actor 拒绝的断言，证明内部评估修复不会削弱历史入口。
- RED/GREEN 使用同一原门禁命令，之后检查受影响 consumers、HTTP 权限、类型/契约；共享配置与历史未变时复用已接受容量/浏览器证据。
- 只消费 238/242 实际交付契约；结束前作一次有界核对，未交付则交具体 checkpoint，不等待工具、不新建回调或触发运行。

本轮 9b6 复核接续：默认用户读与显式内部读已分离；消费已接受238历史配置和实际交付242上下文候选，生产者文件未重做。真实旧HTTP等待中撤权/会话失效、内部报告、配置变化旧窗口不变及调查facts回归完成；当前门禁与容量测量见 MAX-240 交付报告。维护持久区段归244，242独立接受与PR门禁由Chief验收，不能宣称整单done。
