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
