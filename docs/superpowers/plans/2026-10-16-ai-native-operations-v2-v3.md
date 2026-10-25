# Slide AI-Native Operations V2＋V3 合批功能开发方案

> **Execution:** Max于2026-10-16明确授权：结合最新PR及Multica运行任务复核后创建主子任务并启动，每小时检查并解决范围内阻塞。按本文当前修订实施、Review、CI、合并与验收；具体行动仍须逐计划审批，不授权生产部署。历史规划记录保持可追溯。

**Goal:** 在 V1 只读调查之上，同批交付可信案例、资源关系、行为基线、可解释关注事项，以及“计划—人工审批—受控执行—效果验证”的闭环。

**Architecture:** 延续 Investigation / Session / Run、现有 MySQL、Metrics V2 语义查询、ResourceRelation、Workflow 与工具审批。V2 为调查提供经过权限过滤的上下文；V3 使用独立行动执行路径，不给原有只读调查执行器增加变更权限。代码同批实施，真实数据准入和行动启用分门禁验收。

**Tech Stack:** Lit 3.3、Vite、Fastify、TypeScript、MySQL、现有 Agent Core / Workflow / Provider 与安全执行基础；沿仓库 pnpm 版本。

**版本：** 2026-10-16 / implementation-1.2（用户授权启动；已复核PR196～200及MAX-188～192）。本批替代旧V2自动接续；用户授权实施不等于替用户批准具体产品行动或其他任务尚待确认的UI。V1历史规则、验收与预算记录不重写。

---

## 1. 已核实的起点

首次规划核验来源为 GitHub PR 元数据、远端源码、Multica 主子任务及最终验收附件；历史基线为 `4c00819a9a28306b938e5042c6d753e532fe9682`（PR194），当时本地 HEAD 为 `3ca5c6fb`。2026-10-16 按 Max 请求复核新增 PR189/195：当前 HEAD、本地 main、origin/main 和 GitHub main 均为 `47f8f4f1f185b03cbbd5b9a1d73825d2428245d7`，本文集成基线更新至该提交。未覆盖用户工作区。下表 V1 任务状态和验收保留首次核验时点，本轮未重查 Multica。

| 范围 | 核验结果 | 本批处理 |
|---|---|---|
| V1 调度 | MAX-141～153 共 13 个子任务均 done；MAX-140 为 in_review，等待 Max 最终接受 | 不擅自把主任务改 done；代码规划可继续 |
| System 调查 | [PR165](https://github.com/max2055/Slide/pull/165) merged，准确 head 八项检查成功 | 复用持久事实、源码版本绑定、恢复与预算机制 |
| 反馈与关闭验证 | [PR164](https://github.com/max2055/Slide/pull/164) merged，准确 head 八项检查成功 | 复用结果版本绑定和关闭校验，不重做反馈系统 |
| 三类资源入口 | [PR167](https://github.com/max2055/Slide/pull/167) merged，准确 head 八项检查成功 | 保留事件→调查→证据→资源的同对象往返 |
| V1 最终工程门禁 | [PR168](https://github.com/max2055/Slide/pull/168) merged，head `84cbed44` 九项成功，merge `8bdd8a3c` | A01～A18 是回归基线，不重复实现 |
| 最新 UI | [PR170](https://github.com/max2055/Slide/pull/170)、173～188 中相关修复及186～188、190～193已合并 | 采用当前导航、审批详情、表单和工作空间风格，不重新做全站换肤 |
| 资源页面基线 | [PR189](https://github.com/max2055/Slide/pull/189) merged，head `0976c674`，merge `e2d13657`；14项检查成功，含ci-gate | 直接继承R1.1资源页、证据上下文和调度/时间修复；无需再等待该PR合并 |
| HTTPS/WSS | [PR195](https://github.com/max2055/Slide/pull/195) merged，head `5a58cf51`，merge `47f8f4f1`；14项检查成功，含ci-gate | 复用同源WSS及切换手册；回显实验不等于受影响Edge/真实Agent已恢复，具体环境切换仍沿Max的原安排 |
| CI | [PR194](https://github.com/max2055/Slide/pull/194) merged，当前 head 15 项成功 | 采用分层选择＋最终 ci-gate；不沿用“固定八项绿”等过时规则 |

V1 最终附件记录：完整 API 4018 pass / 0 fail / 27 skip（逐项分类），调查 SQL 575/575、Chromium 60/60、真实 rootless 安全门禁和产物回退通过。这是历史候选的工程证据，本次未重跑全套测试，不能作为新代码或当前运行服务全部通过的证明。

必须保留的边界：

- T11 已获 Max 真人**定性接受**，无需重新要求补评分才能开始本批。七维数值仍 unscored、DB06/NW05 原失败、80%/90%软目标和盲评未测均保留；这些不是 30 个真实可信案例。
- 列表三样本 P95 5414.93ms 未达到原 500ms 提案；本批新增聚合不能放大该瓶颈，须测量、分析权限查询并完成直接相关优化，不能放宽权限换速度。
- 原产品结果中部分 provenance / toolVersions 为 unavailable。新增案例和行动要求的版本链缺失时，阻止发布或执行；不倒填历史事实。
- 未核实真实试点可用案例数与连续观测时长，均记为 **unknown**；不得推断为 0，也不能推断已满足门槛。
- PR 合并、工程验收、Max 接受 V1、数据准入、生产启用是不同事实。本方案确认不自动修改旧任务状态或授权生产部署。

依据：原方案 `docs/superpowers/plans/2026-10-11-ai-native-operations.md` 第15节；主干 `docs/slide/ai-native-operations/implementation-baseline.md`、`t12-validation.md`、`t12-runbook.md`；MAX-140 最终附件 `01a13a1d-a1bd-7e43-ad43-dceb3976c1c9`。本次附件副本在 `.multica/v23-plan-2026-10-16/evidence/v1-final-acceptance.md`。

### 1.1 PR189/195 合入后的兼容性约束

结论：无核心范围、存储契约或审批/执行架构冲突；旧基线说明和资源页接入位置需要更新。详细核对见 `docs/reviews/2026-10-16-v23-pr189-pr195-compatibility.md`。

- **P09 页面接入**：资源概览保留“状态—风险—缺口—下一步”，关联调查保持紧凑行。基线进入已有“指标与趋势”；服务器/网络关系扩展已有“关联资源”，数据库关系以概览内按需展开的共享上下文接入。原型 `#context` 是内容组合示意，不新增一级菜单，也不替换三类资源详情壳。后续确认资源接入设计时补三类真实页签内对照。
- **P04/P10 数据语义**：沿用PR189停用revision经fenced worker首次应用后停止周期入队的行为，不为积累基线擅自重启采集。停用/缺测时保留质量与新鲜度判断。Date→ISO修复仅保证合法时间可持久化，不能把legacy connections、V2 uptime或短时演练当作同一序列、已完成cutover或14/28天资格。
- **P03/P08/P09 证据与权限**：保留partial/truncated、观测时间、分页窗口、资源切换/撤权后的迟到响应防护。服务器诊断由显式POST采集；页面刷新、查看案例/关系/验证报告不隐式触发采集或行动。
- **P10/P11 联调**：使用现有同源 `/agent-ws` 与HTTPS→WSS选择，不新建硬编码明文连接。PR195只新增指南和隔离代理验证；在已获授权的联调环境验证认证、真实消息和断线恢复。受影响共享环境的证书/切换与Edge验证仍由Max按原安排执行；其未验收不应阻塞独立代码，也不在本批自动扩为生产部署。
- 这两项PR不改变≥30真实案例、14/28天有效数据、双人审批、单次批准和unknown不重发门槛，本次启动授权见第1.2节；具体设计确认及产品行动批准按各自范围核验。

### 1.2 本次启动前复核与实际接续（2026-10-16）

本次HEAD/main/origin/main及GitHub main为 `acd0e1b0d3414bdaa6dc65a71adc8ad4d77065ae`。新增已合并PR198（工作空间与偏好）、197（模型配置布局）、199（默认文字蓝#265F99）、196（总览与共享控件）。所有新页面继承最新 `frontend/AGENTS.md`、`shared-btn-styles.css`、密度/外观token和已有用户偏好；R1表达信息层级，不将其旧按钮尺寸/颜色覆盖回产品。

Multica已有MAX-188主任务统筹唯一指标整改，MAX-189后端正在运行，MAX-190前端blocked且PR200草稿；MAX-191批量、MAX-192最终真实验收尚待直接前置。PR200 head `61e1920a` 为9项成功/5项失败，未合并；缺后端新路径、正式状态500及真实三周期未完成均由原owner处理。本批不接管、不重复修复该家族，不把其原型待确认状态改为已确认。

- **唯一指标体系是外部前置**：后续接中性 `metrics/`、`/api/metrics`、`metric_*` 及MAX-189审定契约；当前main仍有历史metrics-v2路径，实施时取真实集成结果，禁止另外维持旧新双读/双采集或硬编码尚未合入接口。P04须MAX-189审定合入且正式查询证据通过；P09须MAX-190及MAX-191审定合入、文件归属释放；P12最终数据资格须MAX-192真实来源/迁移证据通过。
- **P01独立出口与共享写锁**：P01先交operations内部契约、授权/flags和本域表结构SQL草案（`operations/schema/*.sql`）、隔离SQL/权限测试，不修改MAX-189拥有的公开契约/生成类型、server及既有指标目录，不抢正式迁移编号。P10在MAX-189审定合入后统一分配正式增量迁移编号，装配公开契约/生成类型/server及回退验证。领域测试使用P01schema和自身composition，不把测试composition当生产装配。
- **资源页与视觉**：P09沿R1及第1.1节接入三类资源真实页签；资源挂载的补充设计先提供原型和截图供Max审阅。现有R1/后续确认版本应记录hash，实质设计变更及视觉合并须有对应确认依据；后端/契约/非视觉实现继续。不得把本次启动授权用来解开MAX-190/191属于另一批次的人工设计阻塞。
- **运行资源**：15astra平台 `max_concurrent_tasks=3`，是本批“最多3实施＋1协调”之上的实际更紧上限，统计其他家族同agent运行及queued/dispatched/waiting_local_directory。首批本父任务短时协调＋P01，外部MAX-189继续；父任务无即时工作应交付并让出位，按运行/文件锁与直接依赖接续，不排队整批。全批12包因独立风险/验收/回退及文件归属保留，不创建更深代理或额外重复评审任务。
- **监控与阻塞处理**：本会话每小时检查真实任务/run/PR准确head与CI/审查/merge/验收；有直接因果的代码、CI、冲突、派发、资料/可访问附件问题可在本授权内处理，优先原owner。不取消其他家族、不绕过人工批准或数据门槛。只有影响范围、安全、授权的未决选择询问Max；全部验收后暂停本自动跟进。

## 2. 实施路线与本批范围

| 路线 | 优点 | 代价 / 结论 |
|---|---|---|
| **同批开发、按依赖合并、分别准入（推荐）** | 统一证据/权限契约，V3 基础不用等案例积累；支持真实试点后逐项启用 | 必须区分工程完成和数据/行动准入；本方案采用 |
| V2 全部完成后才开发 V3 | 顺序简单 | 真实数据观察期会无谓阻塞独立的审批/执行开发，不符合本次合批目标 |
| 全部功能一次合并并同时启用 | 表面统一 | PR过大、回退困难，数据和安全资格未完成就暴露行动；不采用 |

本批包含：

1. **V2-A 可信案例**：候选整理、脱敏、人审、发布、版本、权限/过期过滤、结构化及文本检索、调查引用。
2. **V2-B 资源关系**：扩展现有关系的版本、证据来源、确认/失效与受限影响范围查询。
3. **V2-C 行为基线**：接入真实语义指标、按时段建模、数据质量准入、偏离解释及静态阈值对照。
4. **V2-D 关注事项增强**：多事件关联、确定性评分、可解释排序、人工拆分/关联和案例引用。
5. **V3-A 计划与审批**：不可变计划版本、参数/对象/前置/验证器绑定、职责分离、过期/失效。
6. **V3-B 受控执行**：独立执行器、实时授权、单次批准消费、持久意图、未知结果、人类接管。
7. **V3-C 效果验证**：执行前后证据、预注册观察窗口、负面影响、结论与人工关闭。

本批不包含：重建 CMDB、默认向量数据库、任意命令生成并执行、无人审批自动修复、自主多代理协作、生产部署、生产重启/数据库写入/网络配置变更、无关页面全站重设计。支持更多变更工具在首个试点评审后另立范围；数据库和网络本批继续享有 V2 调查增强，不能宣称已有写操作适配器。

## 3. 用户流程与页面

### 3.1 一条完整业务路径

关注事项看到“数据库响应慢、宿主机资源异常、相关网络事件” → 展开关联理由与缺失数据 → 进入原 Investigation → 检索已审核案例并查看适用条件/反例 → 生成行动草案 → 人工编辑后提交准确版本 → 另一位有权限的人员审批 → 操作者显式执行 → 查看执行回执与观察结果 → 人工确认问题是否解决 → 将有效调查整理为新的待审案例。

每一步都保留原事件、调查、Run、结果版本、案例版本、关系快照和行动版本的引用。相似案例只能作为参考，不能冒充当前故障的事实证据；关联也不等于根因。

### 3.2 信息架构

| 入口 | 首屏内容 / 主要操作 | 详细内容 |
|---|---|---|
| 关注事项 | 当前优先级、受影响资源、数据新鲜度、关联理由；打开原调查 | 评分分项、规则版本、事件时间线、关系路径、人工拆分 |
| AI 工作空间 | 当前结论、案例参考、行动草案与执行/验证状态 | 证据、反证、案例适用性、计划版本差异、原始回执 |
| 资源详情 | 沿R1.1概览与紧凑调查入口；关系进入已有关系区，基线进入指标与趋势 | 关系历史与来源、训练窗口、有效样本与缺口；不把所有面板堆入概览 |
| 运维作业 → 可信运维知识 | 搜索、适用资源/版本、有效期；候选审核 | 原调查/结果版本、脱敏差异、审核记录、撤回原因 |
| 治理 → 行动中心 | 待审、可执行、执行中、待验证、需人工处理 | 计划/审批/执行/验证统一时间线，风险与不可回退说明 |
| 既有审批入口 | 展示行动计划类型和准确差异；批准/拒绝 | 复用审批组件及审计，不另造一套审批历史 |
| 设置 | 已启用能力、试点范围、规则版本、数据准入状态 | 权限、过期、预算和运行策略；没有资格时说明缺口 |

复用现有 Lit 和共享组件、明暗主题及 R2/R1.1 已接受风格。首先在一个真实调查上完成“案例→计划→审批→执行→验证”代表页面对照，再推广。1600/1024/390、键盘/焦点、长文本、加载/空/错误/撤权/过期/unknown 都纳入验收。技术 ID/hash 留在证据详情，主流程用可读资源名和时间。

状态分层继续保持：**调查状态、执行状态、问题状态分别显示**。行动执行成功不能自动把问题标成 resolved；案例发布也不能自动授予行动权限。

### 3.3 新增页面原型与设计确认

2026-10-16 已制作页面原型 R1，状态为**待 Max 确认**：

- 可交互原型：`outputs/2026-10-16-v23-prototype/prototype.html`；本机预览 `http://localhost:4196/prototype.html`。
- 四个主要界面截图总览：同目录 `review.html`；案例详情、调查衔接、资源关系/基线、关注事项解释均有独立可访问页面。
- 页面目标、视觉规范、布局和状态要求：同目录 `UI-DESIGN.md`；运行方式与审阅路径：`README.md`。
- 源文件为 `prototype.js`、`style.css`、`index.html`、`build.mjs`；复用仓库 Lit 组件，后续实施需复用已确认版本的布局/组件及交互，避免仅凭截图重新猜测。
- 截图和交互检查在 `screens/`、`verification.json`。全部为演示数据；30例、观测周数、审批/行动回执不是实际准入证据。

**页面设计确认是相应视觉定稿与合并的前置；独立后端、契约及非视觉工作继续。** 用户审阅原型后记录确认版本/hash和修改意见；若有修改，更新原型和设计说明再确认实际变更。任务附件必须携带离线HTML、设计说明、关键截图和源码位置，不能只依赖本机URL。P09先完成一条真实业务流与原型对照，再推广其他页面；实现偏离已确认层级、文案、操作位置或核心流程时须说明并处理。

## 4. 现有能力复用与实际开发缺口

| 现有源码入口 | 已有能力 | 本批新增内容 |
|---|---|---|
| `apps/db-ops-api/src/investigations/{store,authorization,evidence-store,result-schema,feedback}.ts` | 持久调查、动态授权、证据与结果版本、反馈 | 增加引用与服务适配，不修改既有历史结果的含义 |
| `apps/db-ops-api/src/resources/{types,resource-service}.ts` | 六类关系声明、source/target、provenance、有效期、双端读取过滤 | 版本、审核/撤回、证据绑定、冲突与有界遍历；已有过滤不可退化 |
| `apps/db-ops-api/src/baseline-calculator.ts` | legacy `metrics_history`，默认7天、最少10样本、均值/标准差 | 当前对 Metrics V2 返回 `METRIC_V2_BASELINE_UNAVAILABLE`，必须新建语义指标适配；不能直接把7天旧算法当2～4周行为基线 |
| `apps/db-ops-api/src/metrics-v2/{query,consumers/service,consumers/runtime}.ts` | 单位、dimensions、coverage、freshness、counter reset和source版本 | 从当前正式来源取可比时间序列，沿用质量语义 |
| `apps/db-ops-api/src/security/agent-tool-approval-{service,execution}.ts` | HMAC工具绑定、审批、消费与持久dispatch intent | 行动版本全字段绑定、职责分离、结果/验证生命周期。现有on-risk可忽略参数的绑定不能用于本批行动 |
| `apps/db-ops-api/src/security/approval-execution-authorizer.ts` | SQL审批绑定 | 仅作兼容回归；不将SQL审批token直接当通用行动授权 |
| `apps/db-ops-api/src/workflows/{worker-runtime,register-workflow-handlers}.ts` | 持久任务与Worker接续 | 行动/验证 handler、取消与崩溃恢复接入 |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/server_tools.ts` | 服务器只读诊断 | 不是变更工具；新增专用受限行动适配器，保留原只读工具边界 |
| `frontend/src/app/ui/views/{investigation-detail,approval-dashboard}.ts` | 调查和审批界面 | 行动/案例上下文及可回溯详情 |

## 5. V2 功能设计

### 5.1 可信案例：先治理，再检索

- 从已关闭调查的**确定结果版本**生成候选；人必须确认适用条件、已证实原因、操作与实际效果、反例、产品/资源版本、必要证据。关闭本身不等于可信。
- 生命周期 `draft → pending_review → published → expired/withdrawn`；被拒候选回到新草稿。发布版本不可原地改写，修改生成新版本并重新审核。
- 审核者不同于作者；保存身份、时间、脱敏策略版本、内容hash、来源调查/结果/证据引用、适用范围和有效期。
- 默认保留源资源权限约束。脱敏不等于可公开；本批不提供一键扩大跨资源分享。权限收回、来源删除/失效、案例过期后，从搜索、摘要、数量、缓存、Agent工具、已打开详情中同步去除内容。历史留受权限保护的tombstone。
- 检索先按可见性、状态、有效期、适用版本过滤，再匹配故障类型、症状、资源类型和文本。中文分词可采用当前MySQL能力支持的ngram全文索引；不支持时使用独立受限token索引表，不能以无法分词为由引入向量库或先全量加载后过滤。
- 分页、计数、排序和建议词均在授权范围内计算；最终返回/模型出站前再次核验。权限版本变化清除缓存；分页稳定游标不能泄漏隐藏案例的排序位置。
- `case_references` 与当前 `evidence` 分开。注入模型的案例明确为非可信参考材料，不能携带指令覆盖系统策略或触发工具变更。
- 不足30个真实可信案例时，候选管理、审核、检索实现和标注测试可交付；面向真实故障的推荐资格保持 `not_qualified`，不填充虚构案例凑数。

### 5.2 资源关系：现有关系的可信扩展

- 沿用 `ResourceRef` 与 `runs_on/hosts/replicates_to/depends_on/connected_to/serves`；现有 `hosts` 为反向视图约束保持，不开放矛盾双写。
- 为规范方向关系增加不可变 revision、证据来源引用、观察/确认时间、有效期、确认人、撤回原因；历史provenance字符串保持兼容，不能把无证据旧记录标为新机制已验证。
- 人工录入和已有采集事实可提交候选；模型推测仅标 `suggested`，人工确认前不进入事实影响评分或行动前置。
- 双端读取和管理权限服务端检查；遍历逐节点/边过滤，限2跳、最多100条边，循环截断，截断或隐藏部分显示 `partial`，不显示隐含节点名称或数量。
- 删除资源、关系过期、来源撤回和冲突触发新revision/失效。关系派生的影响评分及计划前置随之重新评估，不能复用旧批准继续执行。
- 关系展示不构成完整CMDB，也不承诺自动发现全部依赖。

### 5.3 行为基线：语义指标与质量门禁

- 系列身份固定资源、metric定义/单位、canonical dimensions、正式source/binding、配置/转换版本。不同单位、counter epoch或配置版本不混算；counter先经已有语义查询转rate。
- 首批处理可解释的标量gauge/rate：按资源实际capability选择CPU、内存、延迟或错误率；不硬称全部数据库/服务器/网络类型支持同一指标。histogram只有已有语义分位数可用时才能转标量；不支持返回原因。
- 使用按小时/时段的中位数和分位区间作为稳健参考，与原静态阈值并行比较。保存方法版本、训练/验证窗口、样本数、覆盖率、异常排除依据；检测规则不得用事后标签污染训练。
- **建议本批准入值**：日内模式至少14天有效观测；周模式至少28天，最后7天只作时间外验证；整体有效覆盖≥90%，用于比较的时段必须有足够重复周期（日内至少7个不同日期、周模式至少3个训练周期）。不足时该时段 `unknown`，不以插值制造有效样本。
- 长间断、未来时间、过期数据、单位改变、资源更换或严重漂移使版本退出qualified；恢复需重新累积有效数据。保留静态阈值，不在本批自动重写告警规则。
- 输出偏离幅度、参考区间、质量与“不足以判断”的理由。无基线≠正常；在关注事项中不把缺数据事项悄悄降为低风险。

### 5.4 多事件关联与排序

- 在既有 operational event / admission / Investigation 之上建关联快照，不再造第二套事件真相源或改变历史owner。
- 先用确定性规则：同资源时间邻近、有效依赖关系路径、相同已知故障签名。初始窗口15分钟、最大2跳/100边；规则版本化，所有关联保存理由和证据窗口。仅相似文本或模型猜测不得标为事实因果。
- 人工合并/拆分作为可审计override，保留原事件和调查ID；迟到事件产生新快照，不改写旧结果。时间窗口锚定原观测时间，沿用V1积压/未来时钟保护。
- 默认排序先保留现有严重度分层，再在同严重度内用可解释分数：严重度50、已确认影响20、持续性15、有效基线偏离15，各分项归一到对应权重；同分按最早事件时间和稳定ID排序。没有业务重要度事实时不虚构业务损失。
- 缺失分项提供上下界和coverage，不重新分配权重伪造满分；不因缺数据跨严重度降级。展示“已知影响”和“完整影响未知”。
- 关联与排序默认零新增模型调用；已有调查请求可按既有预算调用，不为每条事件派生LLM打分或递归调查。

## 6. V3 功能设计与首批工具

### 6.1 行动计划和批准

计划包含：`id/version/investigationId/resultVersion`、单一目标ResourceRef、工具及版本、规范化参数hash、证据与关系/基线引用、前置条件、风险/影响、有效期、verifier定义及版本、回退能力说明、创建主体和内容hash。

- 模型只生成草稿或解释；服务端验证并固化版本。工具名、目标、参数、观察窗口、负面影响阈值、回退声明均由服务端schema与allowlist约束。
- `draft → pending_approval → approved/rejected/expired/superseded`。修改任何已审批相关字段，生成新版本；旧批准只留审计，不能自动迁移。
- 复用工具审批与审计存储/路由，增加行动绑定适配；批准必须是 `once`，不得继承session/window授权或on-risk宽绑定。
- 绑定计划全部实质字段hash和适用策略版本；执行前比较原结果版本、资源身份、工具实现版本、权限、证据新鲜度和前置。有效期默认15分钟，可缩短；初版上限30分钟。
- 作者/请求人与审批人分离，审批人必须具有相应审批权限及目标资源管理权限。仅有管理员身份也不能绕过“不同人员”规则。自动服务身份不能自批，不能把本次开发方案确认当成任何具体行动批准。
- 现有按工具批量批准入口对行动计划必须逐计划执行同一绑定/职责分离校验；不能通过旧审批路由绕过。首批UI不提供行动批量批准。
- 审批和执行均校验当前主体权限；计划可见性、列表/详情/导出/WS都受当前资源权限约束，撤权清理迟到UI结果。

### 6.2 独立执行与未知结果

- 执行请求以 `planId + version + approvalId` 产生唯一持久execution；另保存request idempotency key和payload hash，重复key不同payload返回409。
- 在同一MySQL事务中锁定计划和批准、再次验证状态、消费一次批准、写execution intent/outbox。动作worker沿现有lease/fence运行，独立于只读调查worker。
- 分开记录 `queued/prechecking/dispatching/succeeded/failed/outcome_unknown/cancelled` 与验证状态。只有能证明尚未发送到外部目标时，才允许按既有规则释放或重试；进入不确定发送窗口后批准不退款、不能自动重发。
- 断网、SSH超时、目标返回丢失、平台完成回执写入失败：先查目标端操作ID/回执并做只读核对。无法证明动作未执行则 `outcome_unknown`，转人工；不宣称跨数据库与远程主机的绝对exactly-once。
- 在发送前校验 live auth、目标host key、允许环境/资源/工具、前置、并发锁、工具hash。发送后撤权/取消不能伪称撤销已发生操作：阻止后续动作，保存真实状态并继续必要只读核验或交给有权限人员。
- 每资源同时最多1个行动；默认全局写行动并发1。平台停用开关仅停止新派发，不清除在途意图/审计/未知结果。不给本批行动配置自动重试循环。
- 新行动adapter仅接受执行器签发、绑定execution/planVersion/target/toolHash的内部调用上下文；普通Chat、只读调查和直接工具调用均不得绕过计划执行。通用工具审批token不能替代此上下文。
- 人工接管提供独立核对操作：上传或读取目标operationId对应的可信回执并审计确认，才能把unknown归为已执行/确定未执行；只有人工文字说明时继续保留unknown。重试必须新计划、新批准且原未知动作已完成核对，不能重新使用原execution ID。
- 审计保存谁提议/批准/执行、版本hash、时间和脱敏回执；凭据只经现有引用获取，禁止写入计划、模型上下文和日志。

### 6.3 推荐首批试点：专用演练服务重启

新增工具适配器 `restart_demo_service`，仅适用于隔离调试VM上预先登记、签名配置的 **`slide-action-demo.service`**。这是提案中的新能力，不是当前已经实现的工具。

- 环境使用既定 VMware Fusion VM `192.168.49.130`；实施时先核对该机及目标专属于调试范围。SSH运维入口可以用已授权root凭据完成准备，但产品执行账户只获目标服务的受限权限。
- 参数只有纳管serverId、计划绑定的unit和operationId，不接受用户/模型提供shell命令、任意unit、路径或URL；不能重启Slide、数据库、SSH、网络或虚拟机本身。
- 部署受限远端helper：校验unit配置hash、目标allowlist和operationId，在磁盘先记intent后执行；相同operationId查回执，进入未知窗口不再次restart。sudo规则只允许固定helper，host key严格核验。
- 通过真实目标进程的启动标识/计数、健康端点和故障注入验证。目标配置、helper版本或unit内容变化均使旧计划失效。
- 服务重启**无法回滚到原进程内存状态**；计划明确 `rollbackCapability=none`。重新重启不是回退；恢复动作若需要，必须新计划和新批准。本批不增加自动补偿执行。
- 方案确认包含此试点的开发与隔离演练范围；具体产品行动仍经过逐计划审批。无资格的工具/生产资源返回明确拒绝，而不是通用执行器兜底。

### 6.4 效果验证与人工结案

- 提交审批时就固定验证器及窗口，执行成功后不能改指标阈值使其“通过”。
- 试点验证：行动前保存至少2分钟健康/启动标识快照；行动后等待最多60秒就绪，接着观察5分钟，每10秒记录一次。健康检查全部成功且启动标识符合一次重启、没有额外重启/新崩溃为通过；任何观测缺失标inconclusive，不补成成功。此验证可独立于2～4周行为基线完成。
- 对已具备基线资格的目标可附带基线比较，未具备则明示不适用，不能让V3底座依赖全部V2真实数据准入。
- 验证状态 `pending/observing/passed/failed/inconclusive`；运行超时、指标变坏、样本缺口分别记录理由。执行成功但效果失败，问题仍未解决；不自动再次执行。
- 人工结案调用现有反馈/关闭校验，绑定当前调查结果和验证报告版本。重新调查、新Run或过期证据使旧关闭依据失效，已有V1规则保留。
- 验证报告通过专用证据适配器引用，不伪装成原调查Run的工具证据。服务端校验report→execution→planVersion→investigation/resultVersion完整链与实时权限；跨调查、旧结果、失败/不确定报告不能作为resolved依据。需要重新调查采证时新建原调查的后续Run，保留各自来源。
- 显示效果与行动的时间相关性，不宣称仅凭前后变化证明因果。外部人工处置可以记录，但不能冒充本平台执行回执。

## 7. 数据、API 与事件契约

下列名称为**拟新增**，P01固定schema后成为各工作包接口；复用既有存储，不建立第二份资源、用户、事件或模型配置库。

| 数据对象 | 必要内容 / 约束 |
|---|---|
| `trusted_cases`、`trusted_case_versions`、`trusted_case_reviews` | 来源调查/结果版本、权限资源集合、脱敏内容hash、适用版本、审核/发布/有效期；版本唯一；检索索引只来自有效published版本 |
| `resource_relation_revisions` | 既有规范关系的version、provenance引用、status、validFrom/Until、审核人；旧API兼容投影 |
| `behavior_baseline_versions` | 系列身份hash、source版本、算法/时间段、训练/验证窗口、coverage、状态/失效理由；旧metric_baselines不强行改义 |
| `attention_correlation_snapshots` | 原事件/调查集合、关系/基线版本、规则版本、分项分数/上下界、人工override；不写回原owner |
| `action_plans`、`action_plan_versions` | 计划身份、不可变版本、审批hash、目标与precondition/verifier；不存凭据 |
| `action_executions` | approval/planVersion唯一绑定、目标operationId、lease/fence、发送状态、回执hash、未知结果；引用既有approval/intent |
| `action_verification_reports` | execution/version、预注册指标、时间窗、样本/缺口、前后证据、结论、人工关闭关联 |

所有可编辑入口使用expectedVersion或等价乐观锁；跨批准/执行转换使用事务和唯一约束。客户端时间不能作为有效期判定源；服务端UTC，用户按本地时区展示。索引覆盖权限过滤、状态/时间、系列身份和稳定分页，不依赖无界JSON全扫描。

拟定HTTP命名空间：

- `/api/operations/cases`：候选/版本/提交审核；`/:id/versions/:version/review`、`/publish`、`/withdraw`，发布仅在独立审核通过后。
- `/api/operations/cases/search`：只读检索；查询和计数经同一授权过滤。
- `/api/resources/.../relations`：沿已存在资源路由增量提供版本/来源；统一读模型在新增relation服务中实现，避免三处复制。
- `/api/operations/baselines`：版本、质量、区间和准入状态；计算由受限后台作业触发，不在列表GET中隐式运行。
- `/api/operations/attention`：关联快照、排序解释及审计化人工override。
- `/api/operations/action-plans`：草稿、版本、提交审批、状态/差异；审批决定走既有agent-tool审批系统的行动适配入口。
- `/api/operations/action-plans/:id/versions/:version/execute`：仅显式POST产生execution；GET、刷新、WS重连不得触发。
- `/api/operations/action-executions/:id` 及 `/verification`：真实状态/回执；cancel仅作请求，不能自行断言已取消。

新增错误至少区分403权限拒绝、404不可见/不存在、409版本/幂等冲突、410过期、422前置/准入不满足、503依赖不可用。`outcome_unknown`作为业务事实返回，不能包装为可安全重试的普通500。

事件沿已有事务outbox/WS通道：案例版本发布/撤回、关系失效、基线资格变化、关联快照更新、计划失效、execution与verification状态。带事件ID、对象版本和occurredAt；乱序/重复消费不覆盖新版本，重连从持久状态恢复，授权变更清缓存。

## 8. 威胁与故障设计

| 风险/触发 | 必需措施 | 验收反例 |
|---|---|---|
| 案例含提示注入/秘密 | 脱敏、人审、参考材料隔离，模型输出不直接成为行动 | 案例要求“忽略审批”仍不能产生执行；secret canary不进入出站 |
| 检索数量/图谱路径泄漏 | SQL授权过滤、逐边过滤、出站复核、缓存按权限失效 | 两种角色搜索/分页/WS/原链接均无隐藏资源内容或计数泄漏 |
| 批准后换参数/工具/资源/验证器 | 不可变version与完整bindingHash、实时前置检查 | 改任意绑定字段即拒绝，原批准不转移 |
| 审批角色串通/自批 | 作者与审批人分离，服务主体不可自批 | 同人不同登录会话、管理员自批均拒绝 |
| 双worker/重启/回执丢失 | 单次消费、唯一execution、lease/fence、远端intent/receipt | 双派发仅一动作；未知发送窗口不重复动作 |
| 撤权/取消与发送竞态 | 发送前检查；发送后保留真实结果并阻止后续写动作 | 不伪称已撤销外部动作；撤权用户看不到迟到敏感回执 |
| 基线污染/关系推断成事实 | 数据版本、有效期、质量门禁、建议态隔离 | 缺数据/单位变化/counter reset/过期关系不给正常或可靠影响结论 |
| 执行成功但无改善 | 预注册verifier、负面指标、人工结案 | exit0但健康失败不能resolved，不能自动循环重启 |
| 日志/预算失联 | 持久审计失败关闭、预算原子预留/实测结算 | 无审计批准不发；unknown usage不重放或记零 |

独立安全审查必须覆盖V3工具和上述威胁，由非该实现作者进行；这是未来实施阶段的Review要求，本次没有派生代理。不能用单元mock代替真实崩溃窗口/远端回执演练。

## 9. 工作包、文件所有权与直接依赖

拟采用1个主调度＋12个工作包；不是12个强制大PR。一个工作包可有多个可独立审查PR，但未完整验收时不能因首个PR合并自动done。所有拟建任务默认15astra；调度、实现和独立审查按运行隔离，不再派生更深代理。全家族最多3个实施active/queued（含恢复），另保留1个协调位。

`apps/db-ops-api/src/operations/`是本批拟新增领域目录；下表列出的新路径须在实施开始时对最新main再次查重。已有路径已按本次基线核对。P01仅固定本域schema与后缀；P10在MAX-189审定合入后统一分配正式迁移编号，不抢并发项目编号，序号按最新迁移表递增。

| ID / 工作包 | 所有权与交付物 | 直接前置 | 完整出口 |
|---|---|---|---|
| P01 统一契约、权限、迁移与flags | 新增`operations/contracts.ts`、`operations/authorization.ts`、`operations/feature-flags.ts`、`operations/schema/*.sql`；本域版本/错误/权限及隔离SQL测试；公开契约/生成类型与正式迁移由P10统一装配 | 用户已授权；核对最新main及外部文件锁 | 内部契约/schema独立可测；权限负例/flags、旧数据兼容和迁移重入/保留回退设计通过；未抢共享迁移/契约 |
| P02 资源关系可信化 | 修改`resources/types.ts`、`resources/resource-service.ts`；新增`operations/relations/{service,store,routes}.ts`及同名测试 | P01合并 | 双端权限、revision、冲突、有效期、2跳上限及旧hosts兼容真实SQL通过 |
| P03 案例治理与检索 | 新增`operations/knowledge/{service,store,search,routes}.ts`及测试；通过适配读取既有调查证据 | P01合并 | 人审/脱敏/发布/撤回、中文检索、权限计数与出站过滤通过；未满足30例明示未准入 |
| P04 语义行为基线 | 新增`operations/baselines/{source-adapter,calculator,store,routes}.ts`及测试；复用Metrics V2查询，不抢改其采集调度 | P01合并；MAX-189审定合入及正式查询证据通过 | 真实唯一来源适配、14/28天门禁、质量/漂移/单位/counter反例及时间外对照报告 |
| P05 多事件关联与排序 | 新增`operations/attention/{correlator,scoring,store,routes}.ts`及测试；只读消费现有event/admission | P02、P04合并 | 零额外LLM、确定性解释、缺数据上下界、late event/拆分/稳定分页通过 |
| P06 计划版本与审批适配 | 新增`operations/actions/{plan-service,plan-store,approval-binding,routes}.ts`及测试；最小扩展`security/agent-tool-approval-service.ts` | P01合并 | 全字段hash、单次批准、自批拒绝、版本失效与SQL/旧工具审批兼容 |
| P07 独立执行与试点工具 | 新增`operations/actions/{executor,execution-store,workflow-handler}.ts`、`operations/actions/adapters/restart-demo-service.ts`、`scripts/qualification/action-demo-helper.sh`及测试；扩展`security/agent-tool-approval-execution.ts` | P06合并；工具威胁评审完成 | 正式SQL与远端helper协议、双worker/崩溃/取消/未知不重发；不调用只读调查写工具 |
| P08 效果验证与结案衔接 | 新增`operations/actions/{verification-service,verification-store,verification-handler,evidence-adapter}.ts`及测试；最小修改`investigations/{feedback,feedback-contracts,feedback-types}.ts`，公共导出由P01/P10统一装配 | P07合并 | 预注册窗口、成功/无改善/恶化/缺数据、跨调查引用拒绝、重开失效、版本化报告通过 |
| P09 真实页面与导航集成 | 新增`frontend/src/app/ui/views/operations-{knowledge,actions}.ts`、`components/investigation-operation-context.ts`、`controllers/operations-api.ts`；修改既有investigation-detail、approval-dashboard、investigations、navigation、app-render及三类resource detail的最小挂载点；按需扩展semantic-metrics由P09独占 | P02～P08合并；第3.3节原型设计已确认；MAX-190/MAX-191审定合入及共享UI文件释放 | 代表页面先对照，全部正常业务及状态/主题/屏宽真实浏览器验收；保留旧路由 |
| P10 跨域装配、性能与全量回归 | 独占共享`server.ts`、`workflows/register-workflow-handlers.ts`、`tools/catalog.ts`、`tools/security-catalog.ts`、公共契约汇总/生成类型、正式增量迁移编号与CI矩阵；新增`operations/composition.ts`和集成测试 | P02～P08、MAX-189审定合入；最终回归等P09 | 正式server/worker/工具装配；权限分页与排序性能报告；新旧功能gate、迁移/回退通过 |
| P11 真实行动演练及独立安全验收 | 新增`scripts/qualification/run-operations-actions.sh`、`tests/qualification/operations-actions.ts`、`docs/slide/ai-native-operations/v23-action-runbook.md` | P09、P10合并；隔离目标/双人测试身份就绪 | 真VM专用服务成功、失败、未知、撤权、重复及效果验证；独立Review通过；仅测试范围qualified |
| P12 真实数据资格与最终汇总 | 新增`tests/qualification/operations-readiness.ts`、`docs/slide/ai-native-operations/v23-data-readiness.md`；整理有权限的真实案例与指标报告 | P03、P04、P05合并；最终资格等MAX-192；最终汇总等P11 | ≥30可信真实案例、2～4周有效数据、质量对照、所有门禁/缺口、准确合并与最终接受 |

P01确定迁移及接口后，领域任务自带独立可运行测试composition；P10对正式server的最终装配在其后，不形成“领域等装配、装配等领域”的循环。测试composition不算真实产品链路，最终由P10/P11补齐。

共享文件只能由明确owner提交；领域任务通过小型export/注册说明交接给P10。若早期需要内部契约增补，由P01原owner作有界补丁并回读依赖；公开契约/生成类型由P10在外部共享锁释放后装配，不能多个任务同时改生成文件。P07/P08对action目录子文件各自独占，禁止整目录格式化。PR189已合并，P09从新基线在三类资源详情页作最小挂载，保持第1.1节页签职责与迟到响应保护；若建单时另有并行UI owner，再协调当时实际写锁。

### 每个工作包的执行步骤

1. 从直接前置已Review且已合并的main提交开始；核对新变更、同文件owner、任务和run，记录准确基线。
2. 为上表行为出口及第11节对应反例写focused测试，保存失败原因；涉及权限/幂等/恢复必须有确认能失败的反例，不编造运行结果。
3. 实现本包文件和最小适配；运行focused checks和受影响模块测试。环境失败与产品失败分开处理。
4. 交付真实SQL/HTTP/浏览器/远端或模型证据中适用部分，绑定源码/配置hash、数据来源、时间和可复现命令；无关或未完成部分标明。
5. 创建PR、跟踪当前head CI、修复范围内审查/冲突；独立审查和必要门禁通过后正常合并，记录merge SHA与main包含性。只完成部分时维持任务未完成并指出下一owner。

### 建议调度次序

- P01先行；随后P02/P03/P04最多3个并行。
- 任一空位释放即可调度P06（只依赖P01）；P05等P02/P04，P07等P06，P08等P07。不等待“V2整阶段全部done”才启动V3。
- P09/P10在领域出口后并行，分别拥有前端与共享后端；需要API变更时通过统一契约owner合并。
- P12的真实数据盘点/整理在P03/P04出口后就开始，观察时长不足保持数据资格blocked，不阻止P06～P11。不得把仍在等待真实数据的P12标done。
- P11与P12完成后由主任务汇总最终交付。工程代码全部合并但P12仍等待数据时，报告“工程完成、真实数据准入未完成”，不能宣称整批全部完成。

## 10. 数据迁移、开关与回退

- 新表/列只做增量迁移；新模块默认关闭，既有只读调查和审批继续工作。首次迁移、重复执行、旧数据空值、新旧服务并存都需演练。
- 不自动将历史调查批量发布为可信案例；历史关系可进入兼容读投影，但缺证据/确认就保持unknown/unverified。
- 拟定能力开关：`operations.knowledge`、`operations.context`、`operations.baselines`、`operations.attention`、`operations.actionPlans`、`operations.actionExecution`。作用域包括环境和明确资源allowlist；禁用后直接API也拒绝，不只隐藏菜单。
- 工程功能开关与数据qualification分别存储：开启管理页不代表30例/28天资格通过；开启计划页也不代表可以执行。
- 回退先停止新行动派发、冻结新批准消费、记录在途/未知execution并完成只读核对，再回退应用。旧版本不认识新execution时不可直接丢弃worker或自动退款。
- 已写数据采用保留式回退：撤回新入口/worker，保留案例、版本、审计、execution/verification；不在回退脚本DROP表。恢复版本时复核schema与fence，不重放已发送动作。
- 测试产物和报告统一在仓库`outputs/2026-10-16-v23/`或该批版本子目录，包单个小于300,000,000字节并附hash；不执行生产发布。

## 11. 验收矩阵与质量门槛

| 编号 | 必测行为与成功标准 | 主要owner / 证据 |
|---|---|---|
| B01 | 作者不可自批案例；版本更新不沿用审核；secret canary不出现在发布文本/模型payload | P03，SQL/API/出站截获 |
| B02 | 撤权/过期/撤回的案例不出现在搜索、计数、缓存、WS、深链和Agent工具；迟到响应不回填 | P03/P09，双角色真实业务 |
| B03 | 案例固定来源与适用版本，引用与事实分离；来源缺失保留tombstone | P03，结果引用回放 |
| B04 | ≥30个不同真实调查产生的人审案例；版本/近重复不凑数；标注查询集precision@5≥0.80、recall@5≥0.80，结果与人工检索对照 | P12，真人确认与冻结集；数值为本提案准入目标 |
| B05 | 关系双端权限、过期/循环/2跳/100边截断、旧hosts语义，推测不变成事实 | P02，SQL/API/图遍历反例 |
| B06 | baseline来自正式source，单位/dimension/reset不混用；14/28天和coverage不够必unknown | P04，语义数据与边界测试 |
| B07 | 真数据时间外对照：同事件标注集误报率不高于静态基线，已标记重要异常不得新增漏报；无标注不能声称改善 | P12，周期/标签/两算法版本报告 |
| B08 | 关联解释可回放、拆分保留历史；同输入输出同分；unknown不跨严重度降级；默认模型调用增量0 | P05，事件回放/预算回执 |
| B09 | 改目标/参数/工具版本/验证器/前置任一字段使批准失效；自批/过期/撤权/越界全部拒绝 | P06，真实SQL/JWT/API |
| B10 | 并发execute、重复队列/worker、重启各仅消费一次批准；远端计数证明确切动作数量 | P07/P11，SQL＋真实helper回执 |
| B11 | 发送前失败可安全停；发送后失联/落库失败保留unknown，零自动重发；恢复不退款已使用批准 | P07/P11，故障注入和新进程恢复 |
| B12 | 取消/撤权与发送竞态不伪造cancelled；停用开关阻止新写、保留审计 | P07/P11，两个时序窗口 |
| B13 | exit0但未改善/恶化/缺样本不判resolved；验证标准不得执行后篡改；重开调查失效旧关闭依据 | P08/P11，真实状态与反馈链 |
| B14 | 专用VM/固定unit/helper之外全部拒绝；禁止任意shell、服务/host替换、路径注入；旧批量审批与普通Chat/直接工具入口不能绕过行动绑定 | P06/P07/P11，独立工具安全Review |
| B15 | UI真实数据设计对照、四个核心入口互通、1600/1024/390、明暗、键盘/焦点及全状态 | P09，截图/浏览器/正式API |
| B16 | 新增权限分页/聚合避免N+1放大；在相同硬件/角色/数据量下P95不劣于同次V1测量，目标≤500ms；未达目标需显式评审，不能默改阈值 | P10，1万调查/10万事件、30冷＋100暖样本/角色、SQL计数/分布 |
| B17 | 增量迁移/回退保留历史，动作在途不重复；V1 A01～A18与旧审批/Chat/SQL回归，保留PR189停用调度/时间/撤权隔离及PR195同源WSS行为 | P10，真实MySQL＋恢复/浏览器 |
| B18 | 真实Provider可读取受限案例/上下文并输出可审阅草案；不能直接执行/跳审批；token统一记账、unknown不重放 | P10/P11，原始usage＋工具/HTTP/SQL链 |

B04/B07质量数值需按本方案确认后固定。冻结真实案例集合、真实查询/标签、版本、权限角色和时间外验证窗口；关联同一事故的近重复案例分组，避免训练/验证泄漏。可使用fixture验证协议和反例，但单列为synthetic，不得计入真实样本数或观察周数。人工检索/判断对照由有权限操作者提供，代理不得代签。

工程校验按每包改动运行，命令入口：

```bash
# 域内focused tests（新增目录交付后存在）
pnpm --filter slide-api exec vitest run src/operations/knowledge
pnpm --filter slide-api exec vitest run src/operations/relations
pnpm --filter slide-api exec vitest run src/operations/baselines
pnpm --filter slide-api exec vitest run src/operations/attention
pnpm --filter slide-api exec vitest run src/operations/actions

# 既有兼容/安全与静态门禁
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend test
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm qualification:matrix
pnpm security:agent

# 最终真实SQL、恢复与Linux安全候选
bash scripts/qualification/run-investigation-rollout.sh --api
bash scripts/qualification/run-investigation-rollout.sh --integration
bash scripts/qualification/run-rootless-sandbox.sh

# 本批新增：P11交付后才可执行，必须显式提供隔离目标配置
bash scripts/qualification/run-operations-actions.sh
```

预期：选中检查全通过，必要SQL/浏览器/动作资格不得skip；未选中CI按PR194计划合法跳过，不能据此绕过最终集成候选。rootless脚本仅在符合其规则的一次性Linux runner运行。完整gate复用未变有效证据，源码/配置/目标改变后重跑受影响部分。当前仓库保护是否强制ci-gate须在实施时核验；不能把检查名称出现等同于保护已配置。

新增动作资格脚本默认无真实写入配置即fail closed，不能默连默认服务器并restart；运行时验证目标身份、allowlist、计划批准和helper版本。测试账号/审批身份隔离，不借生产admin token完成反例。

## 12. 调试环境、模型预算与后续建单要求

- 本次规划零产品模型调用、零远端登录或变更。后续默认调试VM为`root@192.168.49.130`；凭据按`docs/slide/development/debug-task-defaults.md`定向传入受控主任务，不写入本方案、子任务、脚本或日志。实际产品执行使用受限账户。
- 产品模型使用`mysql-3306`现有配置的`deepseek-flash`，保持Provider/场景路由；不复制API密钥、绕过停用配置或静默换模型。
- 同一合批验收目标由主任务及全部子任务共享10,000,000输入＋输出token，缓存输入不重复计；调用次数和单次输入输出不另设审批次数限制，仍受模型技术/产品运行限制。
- 建单前登记唯一持久批次指针及账本，建议批次名`AI-Operations-V23`。只有确属新的V2/V3验收目标才建新账本；重跑V1验收继续原批次，不因重新建单清零。沿当前`real-provider-budget.ts`已实现机制，跨worker发送前原子预留、按usage结算；未知发送先核查不得重放。
- 历史V1附件累计214,644token/153请求仅作该时点历史证据，不推断当前余额。50%报告、80%收敛、100%停止新发送并保存检查点；不能可靠计量只阻塞受预算调用，不阻塞独立代码/文档。
- 建单时再次搜索同名/同范围任务，复用已存在项，逐项保存UUID与真实依赖，全部回读正文/父子关系/负责人/run。计划编号P01～P12不是已存在的Multica任务ID。
- 每个实施任务对自己的PR负责：创建/推送后设置当前PR checks完成条件（30分钟超时唤醒，实际owner和交付线程），主动核验当前head，失败修复后续设；父任务在子任务in_review时即Review，不等全部done。
- 派发前核验active/queued/dispatched/waiting_local_directory及文件owner，评论可能触发run时再次查询；不能仅改in_progress就宣称运行，也不能为尚未起跑的queued重复rerun。
- 主任务负责准确head CI、功能/视觉/安全/真实证据、合并SHA与后续派发；直接前置未合并或缺必要资格时明确blocked原因。数据等待不阻塞独立工作；人工批准不能由状态自动替代。

## 13. 交付与确认点

最终交付包含：新功能源代码与正常合并PR、契约/迁移、真实服务与浏览器证据、独立安全Review、行动恢复/未知结果手册、数据准入报告、操作说明、版本化回退与未满足项清单。

本方案请求确认的产品决定是：

1. V2四项与V3三项作为一个批次开发，按依赖逐包合并；工程与真实数据/行动准入分别记录。
2. V3首批限定“专用调试VM服务重启”一个工具，逐计划双人职责分离审批；没有任意Shell、无人批准或生产行动。
3. 保留30个真实可信案例、14/28天有效指标、权限/过期/unknown语义；不足部分保持准入blocked，继续独立开发。
4. 新功能沿最新已合并UI与技术栈实现；拟1主＋12工作包、默认15astra、最多3实施＋1协调，后续建单再按真实依赖/共享文件状态确认粒度。

Max已于2026-10-16授权复核后建单启动，进入正常实施接续；不新增“仅建单、另等启动”限制。生产部署与生产行动仍不在本批范围内。

## 14. 本次方案自检

- 原第15节V2-A/B/C/D、V3-A/B/C全部映射到功能设计、文件owner和B01～B18。
- 已区分现有能力与拟新增能力；Metrics V2 baseline和行动adapter明确为缺口。
- 依赖无环；V3底座不等待30例/28天；界面和正式装配的真实资格另列。
- 没有将40个历史fixture、已关闭调查、绿色CI、merged或工程验收替代真实准入；T11已有定性接受不重复阻塞。
- 规划阶段仅更新方案/证据文件；后续按用户请求新增第3.3节离线演示原型及本机静态预览。未修改产品源码、任务状态、产品运行服务、Provider、凭据或生产配置。

## 修订记录

- proposal-1 / proposal-1.1：历史规划与PR189/195兼容复核，保留于planning-evidence及兼容报告。
- implementation-1.2：按最新用户实施授权，复核PR196～200和MAX-188～192，增加唯一指标外部依赖、共享文件避让、实际agent并发及每小时阻塞处理。核心V2/V3范围和B01～B18门槛未降低。
