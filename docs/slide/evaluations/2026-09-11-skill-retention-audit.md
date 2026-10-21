# Slide 技能保留评估（2026-09-11）

本轮仅评估，不修改、删除、移动、禁用或升级技能，也不修改 AGENTS.md。两个指定目录共发现 182 个 SKILL.md：项目 13 个、全局 169 个。全局另有 59 个空 GSD 目录，不计作可执行技能。

评估基准：Slide 的 Lit 3 / Vite / Fastify / TypeScript / agent-core，以及 MySQL、Elasticsearch、MongoDB、Redis、JWT、Anthropic/OpenAI/Ollama 集成。用户尚未指定其他常用技术栈，因此对其他语言、行业和个人工具采用“按需保留”，不直接建议删除。

## 结论口径

| 建议 | 含义 |
|---|---|
| 保留 | 与当前工作直接相关，保留其专业能力；不意味着每次任务都必须调用。 |
| 修订后保留 | 具有独特价值，但路径、触发条件、执行流程或示例需修正。当前问题不应被忽略。 |
| 按需保留 | 特定技术栈、业务或工具才需要；可作为专用技能库保留，不自动增加当前任务流程。 |
| 建议移出 | 建议退出当前默认发现范围，通常保留备份或转入专用项目；不是本轮删除指令。部分项目技能移出后仍可在其他项目使用。 |

## 数量与优先顺序

| 范围 | 保留 | 修订后保留 | 按需保留 | 建议移出 | 总数 |
|---|---:|---:|---:|---:|---:|
| 项目 | 0 | 2 | 3 | 8 | 13 |
| 全局 | 18 | 31 | 100 | 20 | 169 |

优先处理强制加载/重复验证/固定多代理流程，其次修复本地 GSD 路由和缺失模板，最后才考虑整理低频语言和行业技能。技能数量本身不等于全部正文同时进入上下文：主要问题是名称/描述开销、误触发和加载后的互相冲突。本轮未测得实际 token 或费用节省，不能据此报告节省百分比。

项目 UI 建议以现有 AGENTS.md 和共享组件为基础，用修订后的 redesign-existing-projects、全局 design-system 和 browser-qa 做针对性改进；image-to-code 仅用于明确的参考图实现任务。官网/品牌生图技能与控制台开发分开选择。

## 项目内全部 13 个技能

以下名称使用实际目录名。来源记录显示这 13 个技能均来自 Leonxlnx/taste-skill；上游更新可能覆盖本地修订。

| 技能（点击查看原文件） | 用途 | 建议 | 理由及必要处理 |
|---|---|---|---|
| [brandkit](/Users/max/Coding/40-Slide/.agents/skills/brandkit/SKILL.md:3) | 品牌标识与品牌规范视觉板 | **按需保留** | 做 Slide 品牌升级、Logo 或宣传材料时有独特价值；不应参与日常数据库管理界面的实现。 |
| [design-taste-frontend](/Users/max/Coding/40-Slide/.agents/skills/design-taste-frontend/SKILL.md:3) | 官网、作品集与营销页面设计 | **按需保留** | 正文明确排除 dashboard、数据表及多步骤产品 UI；适合官网，不能作为 Slide 控制台的默认设计规则。 |
| [design-taste-frontend-v1](/Users/max/Coding/40-Slide/.agents/skills/design-taste-frontend-v1/SKILL.md:3) | 旧版前端视觉与动效规则 | **建议移出** | 仅在需要精确旧版行为时有保留理由；与新版重叠，且强制 React/Framer Motion 卡片动画，不适配 Lit 控制台。留备份即可。 |
| [full-output-enforcement](/Users/max/Coding/40-Slide/.agents/skills/full-output-enforcement/SKILL.md:3) | 完整输出与长回复分段 | **建议移出** | 接近输出上限要求用户发送 continue，与完成任务目标冲突；完整交付及文件链接规则已进入 AGENTS.md。 |
| [gpt-taste](/Users/max/Coding/40-Slide/.agents/skills/gpt-taste/SKILL.md:3) | 随机布局与 GSAP 营销动效 | **建议移出** | 强制模拟随机选择、AIDA 页面结构与大间距；不适合稳定、可预测的数据操作界面，也与其他设计技能重叠。 |
| [high-end-visual-design](/Users/max/Coding/40-Slide/.agents/skills/high-end-visual-design/SKILL.md:3) | 固定字体、间距和动效的视觉风格 | **建议移出** | 属于审美预设而非 Slide 必需能力；硬编码视觉规范与项目 token 和共享组件重叠，可在明确选择该风格的独立项目使用。 |
| [image-to-code](/Users/max/Coding/40-Slide/.agents/skills/image-to-code/SKILL.md:3) | 根据视觉参考实现网页 | **修订后保留** | 截图还原有独特用途；应允许直接使用用户参考图，取消可选生图对实现的阻塞，并限定在截图还原任务中使用。 |
| [imagegen-frontend-mobile](/Users/max/Coding/40-Slide/.agents/skills/imagegen-frontend-mobile/SKILL.md:3) | 移动端界面概念图和流程 | **建议移出** | 专用于 iOS、Android 和移动产品概念设计，当前项目是桌面优先数据库管理平台；转入移动设计项目，不建议永久删除资产。 |
| [imagegen-frontend-web](/Users/max/Coding/40-Slide/.agents/skills/imagegen-frontend-web/SKILL.md:3) | 网页分区视觉参考图 | **按需保留** | 官网或新视觉方向探索时有价值；逐区强制生成图片成本高，使用前应按所需交付范围收敛，避免与 image-to-code 重复生成。 |
| [industrial-brutalist-ui](/Users/max/Coding/40-Slide/.agents/skills/industrial-brutalist-ui/SKILL.md:3) | 工业、军事终端式视觉风格 | **建议移出** | 强制直角、特定色盘及装饰纹理，与 Slide 已有圆角和色彩 token 不一致；作为独立风格素材保存更合适。 |
| [minimalist-ui](/Users/max/Coding/40-Slide/.agents/skills/minimalist-ui/SKILL.md:3) | 暖色极简与编辑式布局 | **建议移出** | 是另一套固定视觉预设，含硬编码颜色、圆角和间距；与现有组件规范及其他设计技能重叠。 |
| [redesign-existing-projects](/Users/max/Coding/40-Slide/.agents/skills/redesign-existing-projects/SKILL.md:3) | 审查并改进既有 UI | **修订后保留** | 最贴近日常 UI 优化；保留先审查、复用现有栈的流程，删除随机化真实内容日期等建议，将颜色、间距和组件选择交给 Slide 规范。 |
| [stitch-design-taste](/Users/max/Coding/40-Slide/.agents/skills/stitch-design-taste/SKILL.md:3) | Google Stitch 设计系统描述 | **建议移出** | 面向 Google Stitch 和 DESIGN.md 工作流；未见 Slide 使用该工作流的必要性，有 Stitch 任务时再从专用工具集中使用。 |

## 全局全部 169 个技能

全局技能可能服务于其他项目。下表是保留必要性与安装完整性评估，不是对所有 SDK 示例正确性、法规时效性或性能收益的认证。未获得可靠的 7/30 天使用频次，所有技能的使用频次均为未知。

### 工程与 Agent（89 个）

| 技能（点击查看原文件） | 用途 | 建议 | 理由及必要处理 |
|---|---|---|---|
| [agent-eval](/Users/max/.agents/skills/agent-eval/SKILL.md:3) | 比较不同编程代理的质量和成本 | **按需保留** | 选模型或更换代理前有用；属于评测任务，不能成为每次开发的前置流程，外部评测工具需另核实。 |
| [agent-harness-construction](/Users/max/.agents/skills/agent-harness-construction/SKILL.md:3) | Agent 工具、观察和恢复机制设计 | **保留** | 直接关联 agent-core 的工具接口、错误恢复和完成率，且比泛化的工作流宣言更具体。 |
| [agent-payment-x402](/Users/max/.agents/skills/agent-payment-x402/SKILL.md:3) | Agent 钱包和 x402 支付接入 | **按需保留** | 仅用于明确的付费 API 或钱包功能；Slide 当前需求未包含此能力，支付权限不能从技能描述推定。 |
| [agentic-engineering](/Users/max/.agents/skills/agentic-engineering/SKILL.md:3) | 以验收和评测组织 Agent 开发 | **建议移出** | 通用原则与 AGENTS.md 的验收、拆分、预算治理及 eval-harness 重叠；保留独特评测细节到 eval-harness 后减少一个常驻流程入口。 |
| [ai-first-engineering](/Users/max/.agents/skills/ai-first-engineering/SKILL.md:3) | AI 开发团队流程与架构原则 | **建议移出** | 主要为团队级原则，与 agentic-engineering、AGENTS.md 重叠；适合团队参考文档，不需作为日常技能入口。 |
| [ai-regression-testing](/Users/max/.agents/skills/ai-regression-testing/SKILL.md:3) | AI 改码后的行为回归设计 | **修订后保留** | 针对共同假设、mock 与真实路径差异有价值；限定受影响行为，不能用无数据库的测试代替项目明确要求的真实同步 E2E。 |
| [api-design](/Users/max/.agents/skills/api-design/SKILL.md:3) | REST API 契约、错误和分页 | **保留** | 直接服务 Fastify API 设计；使用协议原则，代码示例须适配 Fastify。 |
| [architecture-decision-records](/Users/max/.agents/skills/architecture-decision-records/SKILL.md:3) | 记录和查询架构决策 | **按需保留** | 具有独立的长期决策记录价值；保留写入批准，仅在需要 ADR 时使用，不阻塞业务开发。 |
| [autonomous-agent-harness](/Users/max/.agents/skills/autonomous-agent-harness/SKILL.md:3) | 持久 Agent、定时任务和任务队列 | **修订后保留** | 连续运维场景有价值，但示例使用旧 scheduled-tasks 工具名称和路径；需适配当前原生自动化接口，不能因监控请求自行搭建整套框架。 |
| [autonomous-loops](/Users/max/.agents/skills/autonomous-loops/SKILL.md:3) | 旧版自主循环架构参考 | **建议移出** | 文件自述已由 continuous-agent-loop 接替；先保留旧文中独特的参考示例及被引用内容，再退出默认技能发现，避免破坏兼容调用。 |
| [backend-patterns](/Users/max/.agents/skills/backend-patterns/SKILL.md:3) | Node 服务分层、缓存和数据库访问 | **保留** | 与 Fastify 后端、Redis 缓存和数据库访问直接相关；Express/Next 示例仅作模式参考，不迁移框架。 |
| [benchmark](/Users/max/.agents/skills/benchmark/SKILL.md:3) | 性能基线与回归测量 | **保留** | 数据库管理界面和后端性能任务可用，有明确的前后对照价值；仅在性能相关变更运行。 |
| [blueprint](/Users/max/.agents/skills/blueprint/SKILL.md:3) | 跨会话、多 PR 的大型实施计划 | **按需保留** | 自身明确排除小任务，冷启动上下文和依赖计划有独特价值；大型工程才启用，并遵守代理预算。 |
| [browser-qa](/Users/max/.agents/skills/browser-qa/SKILL.md:3) | 浏览器视觉和交互验收 | **修订后保留** | 对 Lit 前端验收很有价值；把泛化的 MCP/Puppeteer 路径适配到当前可用浏览器接口，避免新增工具前置要求。 |
| [canary-watch](/Users/max/.agents/skills/canary-watch/SKILL.md:3) | 发布后 URL 回归监控 | **修订后保留** | 有实际部署观察价值；改用原生定时监控和明确观察窗口，不能由普通部署请求自动推定无限期监控。 |
| [ck](/Users/max/.agents/skills/ck/SKILL.md:3) | 项目持久上下文与会话保存 | **修订后保留** | 脚本确实存在于 .agents/skills/ck/commands，但文本指向不存在的 .Codex/skills 路径；修正路径并保留初始化和保存批准，与原生记忆择一维护。 |
| [claude-api](/Users/max/.agents/skills/claude-api/SKILL.md:3)；调用名 `Codex-api` | Anthropic Messages、流式和工具调用 | **修订后保留** | Slide 使用 Anthropic SDK；文本却混称 Anthropic 与 Codex，并给出 Codex-sonnet 等模型字符串，必须核对真实产品名、SDK 和模型 ID 后使用。 |
| [claude-devfleet](/Users/max/.agents/skills/claude-devfleet/SKILL.md:3)；调用名 `Codex-devfleet` | 通过 DevFleet MCP 编排代理 | **按需保留** | 只在实际维护 DevFleet 系统时使用；当前原生子代理可完成日常委派，不应为了普通任务另起 MCP 编排服务。 |
| [click-path-audit](/Users/max/.agents/skills/click-path-audit/SKILL.md:3) | 追踪按钮到最终状态的完整路径 | **修订后保留** | 特别适合控制台状态竞争和按钮失效排查；保留状态序列检查，移除固定先后技能链及默认多代理流程。 |
| [codebase-onboarding](/Users/max/.agents/skills/codebase-onboarding/SKILL.md:3) | 代码库架构与入口导览 | **按需保留** | 新仓库和新人入门有价值；已熟悉的 Slide 不需每次重新生成导览或 AGENTS.md。 |
| [coding-standards](/Users/max/.agents/skills/coding-standards/SKILL.md:3) | TypeScript、JavaScript 和 Node 通用规范 | **修订后保留** | 可保留项目未覆盖的语言细节；让 lint、tsconfig、Lit 和 AGENTS.md 优先，避免套用 React 规则或泛化重构。 |
| [configure-ecc](/Users/max/.agents/skills/configure-ecc/SKILL.md:3) | 安装和配置 ECC 技能集合 | **按需保留** | 只用于明确的 ECC 安装维护；不应因优化技能就自动运行交互安装向导，升级路径需核对实际环境。 |
| [content-hash-cache-pattern](/Users/max/.agents/skills/content-hash-cache-pattern/SKILL.md:3) | 按内容哈希缓存昂贵文件处理 | **按需保留** | 外部同步扫描、文件解析重复计算时有独特价值；不能把缓存模式强加给实时数据库状态。 |
| [context-budget](/Users/max/.agents/skills/context-budget/SKILL.md:3) | 审计技能与上下文开销 | **修订后保留** | 对当前技能膨胀问题有用；区分描述常驻与正文按需加载，估算不能伪装为实际 token 消耗。 |
| [continuous-agent-loop](/Users/max/.agents/skills/continuous-agent-loop/SKILL.md:3) | 有界循环与恢复控制 | **按需保留** | 是自主循环系列的规范入口；仅在实现持续执行机制时使用，非每个任务都需要另建循环框架。 |
| [continuous-learning](/Users/max/.agents/skills/continuous-learning/SKILL.md:3) | 旧版会话经验自动提取 | **建议移出** | 与 v2 的观测、规则提取重叠；若有旧 hook 依赖先迁移，不能直接删其脚本。只保留一套经验学习机制。 |
| [continuous-learning-v2](/Users/max/.agents/skills/continuous-learning-v2/SKILL.md:3) | 通过 hooks 提取项目级经验规则 | **按需保留** | 项目隔离经验有价值，但需要真实 hook 配置和维护；没有启用证据时不能宣称它在自动学习，不作为日常前置步骤。 |
| [cost-aware-llm-pipeline](/Users/max/.agents/skills/cost-aware-llm-pipeline/SKILL.md:3) | LLM 路由、缓存与成本控制 | **修订后保留** | 直接关联多 LLM 后端的成本控制；示例模型 ID 含 Codex-sonnet 混称，改为有效的提供方配置，并区分应用费用与本次代理预算。 |
| [database-migrations](/Users/max/.agents/skills/database-migrations/SKILL.md:3) | 数据库迁移、回填和零停机变更 | **保留** | 直接契合数据库运维平台；保留数据安全与生产迁移保障，按 MySQL 等实际引擎选择示例。 |
| [deployment-patterns](/Users/max/.agents/skills/deployment-patterns/SKILL.md:3) | 部署、回滚、健康检查和 CI | **保留** | 适用于 API、前端与 Agent 服务部署；选用现有部署方案，不默认引入 Kubernetes 或蓝绿设施。 |
| [design-system](/Users/max/.agents/skills/design-system/SKILL.md:3) | 审查视觉 token 与组件一致性 | **修订后保留** | 最适合补充现有共享组件规则；默认审计模式，禁止因单个 UI 任务重新生成或替换整套设计系统。 |
| [dmux-workflows](/Users/max/.agents/skills/dmux-workflows/SKILL.md:3) | 通过 tmux/dmux 组织多代理 | **按需保留** | 独立的终端编排工具说明；只在使用 dmux 时需要，普通并行任务优先当前原生代理能力。 |
| [docker-patterns](/Users/max/.agents/skills/docker-patterns/SKILL.md:3) | Docker、Compose、网络和卷 | **保留** | 适合本项目多服务、多数据库开发部署与容器排障。 |
| [documentation-lookup](/Users/max/.agents/skills/documentation-lookup/SKILL.md:3) | 通过 Context7 查找框架文档 | **修订后保留** | 对 Lit、Fastify 和 SDK 实现有价值；先检查工具是否可用，允许官方文档路径，不能将 Context7 缺失视为整项任务阻塞。 |
| [e2e-testing](/Users/max/.agents/skills/e2e-testing/SKILL.md:3) | Playwright 端到端测试与稳定性 | **保留** | 可覆盖登录、数据库操作和控制台核心流程；与临时 browser-qa 验证互补，遵守分层门禁。 |
| [enterprise-agent-ops](/Users/max/.agents/skills/enterprise-agent-ops/SKILL.md:3) | 长期运行 Agent 的运维治理 | **保留** | 生命周期、超时、凭证隔离与审计适合 agent-core 的生产运维设计。 |
| [eval-harness](/Users/max/.agents/skills/eval-harness/SKILL.md:3) | Agent 行为和可靠性的正式评测 | **保留** | agent-core 的能力、回归和模型升级验收有独特价值；不把普通静态修改强制转成模型评测。 |
| [frontend-patterns](/Users/max/.agents/skills/frontend-patterns/SKILL.md:3) | React/Next 的组件、状态和性能 | **按需保留** | 是 React 技能而非 Lit 技能；其他 React 项目可用，在 Slide 中不作为实现模板。 |
| [gan-style-harness](/Users/max/.agents/skills/gan-style-harness/SKILL.md:3) | 生成器和评估器的循环开发 | **按需保留** | 适用于明确的自主生成实验，已有预算限制；与 santa-method 等只择一种工作流，不叠加默认多轮评审。 |
| [git-workflow](/Users/max/.agents/skills/git-workflow/SKILL.md:3) | 分支、提交、冲突和 PR 协作 | **保留** | Git 操作直接适用；保护未提交内容，遵守 codex/ 分支和现有授权，不照搬示例替换团队流程。 |
| [gsd-ns-context](/Users/max/.agents/skills/gsd-ns-context/SKILL.md:3) | GSD 代码库分析路由 | **建议移出** | 路由指向的 gsd-map-codebase、gsd-graphify 等本地目录为空；当前只是不可执行的路由入口。需要 GSD 时先修复完整安装。 |
| [gsd-ns-ideate](/Users/max/.agents/skills/gsd-ns-ideate/SKILL.md:3) | GSD 探索、草图和规格路由 | **建议移出** | 目标 gsd-explore、gsd-sketch、gsd-spike 等目录为空，无法仅凭本入口完成工作；一般探索可直接完成。 |
| [gsd-ns-manage](/Users/max/.agents/skills/gsd-ns-manage/SKILL.md:3) | GSD 配置、工作区和发布路由 | **建议移出** | 除独立 workstreams 入口外，多数目标为空目录；入口不能代表完整管理功能已安装。需要时整套修复。 |
| [gsd-ns-project](/Users/max/.agents/skills/gsd-ns-project/SKILL.md:3) | GSD 项目与里程碑路由 | **建议移出** | 目标 new-project、new-milestone、audit 等目录为空；当前本地路由链不完整。 |
| [gsd-ns-review](/Users/max/.agents/skills/gsd-ns-review/SKILL.md:3) | GSD 审查、调试和安全路由 | **建议移出** | 目标 code-review、debug、secure-phase 等目录为空；可用具体审查技能替代日常需求，GSD 专有功能需修复安装。 |
| [gsd-ns-workflow](/Users/max/.agents/skills/gsd-ns-workflow/SKILL.md:3) | GSD 阶段计划、执行和验证路由 | **建议移出** | discuss/plan/execute/verify 的目标目录为空；不应保留为看似可执行的流程入口。 |
| [gsd-review-backlog](/Users/max/.agents/skills/gsd-review-backlog/SKILL.md:3) | 整理 GSD 999.x 待办阶段 | **按需保留** | 本文件包含直接操作步骤，有 GSD ROADMAP/阶段目录时有用；不应强制普通项目采用 999.x 格式。 |
| [gsd-workstreams](/Users/max/.agents/skills/gsd-workstreams/SKILL.md:3) | 通过 gsd-sdk 管理工作流 | **按需保留** | 具有独立的 gsd-sdk query 流程；当前 shell 未找到 gsd-sdk，使用前需恢复运行依赖，并确认项目采用 GSD，不能把其他空目录当作完整安装。 |
| [hexagonal-architecture](/Users/max/.agents/skills/hexagonal-architecture/SKILL.md:3) | Ports/Adapters 架构边界 | **保留** | 适合 Agent 传输、LLM 与数据库适配器设计；只在边界相关任务应用，不强制重构既有模块。 |
| [iterative-retrieval](/Users/max/.agents/skills/iterative-retrieval/SKILL.md:3) | 渐进检索上下文 | **保留** | 对 Agent 工具检索与有限上下文委派有直接价值，强调检索必要证据而非全量灌入。 |
| [mcp-server-patterns](/Users/max/.agents/skills/mcp-server-patterns/SKILL.md:3) | TypeScript MCP 服务和传输 | **保留** | Agent 扩展与工具服务开发可用；自身要求按安装的 SDK 版本查阅官方接口。 |
| [nanoclaw-repl](/Users/max/.agents/skills/nanoclaw-repl/SKILL.md:3) | NanoClaw REPL 使用和扩展 | **按需保留** | 专门服务 scripts/claw.js；不同于本项目 TS agent-core，仅实际使用 NanoClaw 时保留入口。 |
| [opensource-pipeline](/Users/max/.agents/skills/opensource-pipeline/SKILL.md:3) | 私有项目开源前清理和打包 | **按需保留** | 开源准备有独特敏感信息清理价值；仅在明确开源任务使用，固定三代理可按预算调整，发布仍需相应授权。 |
| [plankton-code-quality](/Users/max/.agents/skills/plankton-code-quality/SKILL.md:3) | 通过 hooks 自动 lint 与代理修复 | **按需保留** | 实际部署 Plankton 才有价值；技能文本不等于 hook 已安装，逐文件派代理会增加开销，优先已有 lint/CI。 |
| [product-lens](/Users/max/.agents/skills/product-lens/SKILL.md:3) | 产品问题、MVP 和优先级诊断 | **修订后保留** | 产品探索有用，但“Before starting any feature”触发过宽；限定产品决策任务，普通实现不重新询问产品价值。 |
| [project-guidelines-example](/Users/max/.agents/skills/project-guidelines-example/SKILL.md:3) | 其他产品的 AGENTS 模板 | **建议移出** | 示例项目是 Zenith，技术栈为 Next/FastAPI/Supabase；已有 Slide AGENTS.md，模板留在参考库即可。 |
| [prompt-optimizer](/Users/max/.agents/skills/prompt-optimizer/SKILL.md:3) | 优化任务提示词 | **按需保留** | 本身明确只提供提示词建议而不执行；用户要求优化 prompt 时有用，不能劫持普通实施请求。 |
| [ralphinho-rfc-pipeline](/Users/max/.agents/skills/ralphinho-rfc-pipeline/SKILL.md:3) | RFC 任务 DAG 和合并队列 | **按需保留** | 跨工作单元的大型实施有价值；与 blueprint/continuous-agent-loop 组合需去重，不用于普通修复。 |
| [regex-vs-llm-structured-text](/Users/max/.agents/skills/regex-vs-llm-structured-text/SKILL.md:3) | 规则解析与 LLM 解析的选择 | **保留** | 可用于 SQL/日志/同步文本的可测解析策略；保留低置信度回退，不将示例收益当项目实测。 |
| [repo-scan](/Users/max/.agents/skills/repo-scan/SKILL.md:3) | 源代码资产、第三方库和结构审计 | **按需保留** | 明确全仓资产审计时有用；与 onboarding 不同，需独立工具及审计范围，不把每次改码升级为全仓扫描。 |
| [rules-distill](/Users/max/.agents/skills/rules-distill/SKILL.md:3) | 提取技能中的共同规则 | **修订后保留** | 当前去重治理有价值，脚本存在但文档路径与实际安装不符；提取为建议后审阅，避免把案例升级成全局强制规则。 |
| [safety-guard](/Users/max/.agents/skills/safety-guard/SKILL.md:3) | 破坏性命令与目录边界保护 | **修订后保留** | 保障目的应保留；本目录只有说明文档，不能宣称 hook 已生效。需区分建议规则、真实已安装拦截和工具原生审批。 |
| [santa-method](/Users/max/.agents/skills/santa-method/SKILL.md:3) | 双独立审查的收敛验证 | **按需保留** | 用户明确需要独立交叉验证时有用；成本高，不能附加到每次交付，严格受预算和审查范围约束。 |
| [search-first](/Users/max/.agents/skills/search-first/SKILL.md:3) | 编码前检索已有实现和依赖 | **修订后保留** | 避免重复实现有价值，但与 AGENTS.md 的先查证原则重叠；保留针对性搜索，不默认派研究代理或全网调研。 |
| [security-review](/Users/max/.agents/skills/security-review/SKILL.md:3) | 鉴权、输入、凭证和安全审查 | **保留** | JWT、数据库连接和 LLM 密钥处理直接需要；聚焦当前触达范围，不顺带进行全仓安全重构。 |
| [security-scan](/Users/max/.agents/skills/security-scan/SKILL.md:3) | 扫描 Agent 配置和 hooks 安全 | **按需保留** | 与业务代码 security-review 不同，配置审计时有独特价值；需要 AgentShield，不能声称未运行的工具已经提供保护。 |
| [skill-comply](/Users/max/.agents/skills/skill-comply/SKILL.md:3) | 实测技能是否被代理遵循 | **修订后保留** | 本轮静态评估之后做行为实验有价值；当前目录只有说明，示例 scripts.run 不随技能安装，需要补齐运行器并设置有限样本和预算。 |
| [skill-stocktake](/Users/max/.agents/skills/skill-stocktake/SKILL.md:3) | 盘点技能并评估重叠和价值 | **修订后保留** | 适合当前治理；修复 .Codex/.claude/.agents 扫描路径不一致和缓存维度，保留删除/合并前的批准要求。 |
| [source-command-code-review](/Users/max/.agents/skills/source-command-code-review/SKILL.md:3) | 多代理 PR 审查流程 | **建议移出** | 强制三轮预备代理加五名并行审查，再逐问题派代理；与项目最多四并发及八名累计默认限制冲突。用有界审查流程替代，外部评论仍需授权。 |
| [strategic-compact](/Users/max/.agents/skills/strategic-compact/SKILL.md:3) | 手动上下文压缩提醒 | **建议移出** | 基于固定调用次数提醒容易干扰连续执行；保留有用的检查点原则到 AGENTS.md，通常依赖原生压缩即可，已部署 hook 要先解耦。 |
| [superpowers-brainstorming](/Users/max/.agents/skills/superpowers-brainstorming/SKILL.md:3)；调用名 `brainstorming` | 交互设计探索与设计批准 | **修订后保留** | 复杂需求探索有价值，但全任务强制审批易阻塞；保留明确审批，复用已有批准，若要缩小审批适用范围须另行授权。 |
| [superpowers-dispatching-parallel-agents](/Users/max/.agents/skills/superpowers-dispatching-parallel-agents/SKILL.md:3)；调用名 `dispatching-parallel-agents` | 独立任务的并行委派 | **按需保留** | 并行边界指南可用；项目已有代理治理，只有明确独立任务和实际并发收益时应用，不再附加委派入口。 |
| [superpowers-executing-plans](/Users/max/.agents/skills/superpowers-executing-plans/SKILL.md:3)；调用名 `executing-plans` | 执行书面实施计划 | **修订后保留** | 有步骤追踪价值；普通缺依赖/测试失败先诊断修复，只暂停确实受阻的任务，停止重复询问已授权执行。 |
| [superpowers-finishing-a-development-branch](/Users/max/.agents/skills/superpowers-finishing-a-development-branch/SKILL.md:3)；调用名 `finishing-a-development-branch` | 测试后集成分支与清理 | **修订后保留** | 保留具体 Git 收尾和 discard 确认；复用已选的 PR/合并方式，统一创建 PR 后是否保留 worktree 的矛盾。 |
| [superpowers-receiving-code-review](/Users/max/.agents/skills/superpowers-receiving-code-review/SKILL.md:3)；调用名 `receiving-code-review` | 核验并落实审查反馈 | **修订后保留** | 先核对反馈而非盲从有价值；一个模糊条目不应阻塞全部独立修复，保留与用户既有决策冲突时的讨论。 |
| [superpowers-requesting-code-review](/Users/max/.agents/skills/superpowers-requesting-code-review/SKILL.md:3)；调用名 `requesting-code-review` | 请求独立代码审查 | **修订后保留** | 重要变更的审查模板有用；补齐当前缺少的 code-reviewer 模板依赖，并取消每个细小任务默认派审查代理。 |
| [superpowers-subagent-driven-development](/Users/max/.agents/skills/superpowers-subagent-driven-development/SKILL.md:3)；调用名 `subagent-driven-development` | 每任务实现与两轮代理审查 | **建议移出** | 固定多代理和禁止主线程修复增加停工风险，且引用的三个本地 prompt 文件未安装；用原生委派与项目代理治理替代，保留用户要求的独立审查。 |
| [superpowers-systematic-debugging](/Users/max/.agents/skills/superpowers-systematic-debugging/SKILL.md:3)；调用名 `systematic-debugging` | 根因分析与假设验证 | **修订后保留** | 与项目根因优先原则一致且方法具体；保留三次失败后的讨论保障，允许继续只读诊断，避免把所有失败扩大为架构重构。 |
| [superpowers-test-driven-development](/Users/max/.agents/skills/superpowers-test-driven-development/SKILL.md:3)；调用名 `test-driven-development` | 严格测试先行流程 | **建议移出** | 与 tdd-workflow 高度重叠；先将独特回归验证及明确例外批准要求整合到保留版本，再退出默认发现，不能直接取消审批或删除现有实现。 |
| [superpowers-using-git-worktrees](/Users/max/.agents/skills/superpowers-using-git-worktrees/SKILL.md:3)；调用名 `using-git-worktrees` | 隔离工作区创建与检查 | **修订后保留** | 隔离工作价值明确；目录选择采用项目约定，基线失败先分类，不因无关既有失败重复求批，保护已有修改。 |
| [superpowers-verification-before-completion](/Users/max/.agents/skills/superpowers-verification-before-completion/SKILL.md:3)；调用名 `verification-before-completion` | 以验证证据支持完成声明 | **建议移出** | 核心保障已进入 AGENTS.md，逐消息重跑验证与证据复用冲突；保留必要验收保障后减少重复流程入口。 |
| [superpowers-writing-plans](/Users/max/.agents/skills/superpowers-writing-plans/SKILL.md:3)；调用名 `writing-plans` | 详尽可执行实施计划 | **修订后保留** | 复杂任务需要；按任务规模简化文档，不把保存计划后的执行方式询问变成已授权实施的停工点。 |
| [superpowers-writing-skills](/Users/max/.agents/skills/superpowers-writing-skills/SKILL.md:3)；调用名 `writing-skills` | 用行为测试编写技能 | **按需保留** | 对高影响规则的压力测试有价值；普通技能创建优先系统 skill-creator，避免每次文字修改都进入大量代理测试。 |
| [tdd-workflow](/Users/max/.agents/skills/tdd-workflow/SKILL.md:3) | 业务逻辑 RED/GREEN 回归流程 | **修订后保留** | 建议作为唯一 TDD 主入口；明确覆盖率范围与测试层级，保留必要业务回归和合并来的审批要求，不把所有微改都扩成全套 E2E。 |
| [team-builder](/Users/max/.agents/skills/team-builder/SKILL.md:3) | 交互选择代理团队 | **建议移出** | 默认五名上限与项目四并发不一致，交互选择和旧命令不适合常规任务；用当前原生代理和明确分工替代。 |
| [token-budget-advisor](/Users/max/.agents/skills/token-budget-advisor/SKILL.md:3) | 让用户选择回答深度 | **建议移出** | 与直接遵守用户长度偏好和项目预算治理重叠；附加深度菜单及未验证的估算精度没有必要常驻。 |
| [ui-ux-pro-max-skill](/Users/max/.agents/skills/ui-ux-pro-max-skill/SKILL.md:3) | UI 设计规则、色盘和生成器说明 | **按需保留** | 涵盖多平台，可用于设计探索；当前仅有 SKILL.md，文中生成器并未随目录安装，不应作为现成可运行工具。Slide 日常优先 design-system。 |
| [using-superpowers](/Users/max/.agents/skills/using-superpowers/SKILL.md:3) | 强制全局技能加载流程 | **建议移出** | 1%相关即调用、技能覆盖系统等规则过宽或错误；当前原生技能发现和 AGENTS.md 已覆盖必要行为。 |
| [verification-loop](/Users/max/.agents/skills/verification-loop/SKILL.md:3) | 构建、类型、lint、测试检查串联 | **建议移出** | 与项目分层 gate 及验收证据规则重叠，固定15分钟重跑和任何构建失败全局停工不合适；用仓库实际 gate 替代。 |

### 其他语言、框架与数据库（46 个）

| 技能（点击查看原文件） | 用途 | 建议 | 理由及必要处理 |
|---|---|---|---|
| [android-clean-architecture](/Users/max/.agents/skills/android-clean-architecture/SKILL.md:3) | Android/KMP 模块和依赖分层 | **按需保留** | Android/KMP 模块和依赖分层有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [bun-runtime](/Users/max/.agents/skills/bun-runtime/SKILL.md:3) | Bun 运行时和迁移 | **按需保留** | 评估或使用 Bun 时有价值；项目现有 Node/Vite 工作流不因安装此技能而需要迁移运行时。 |
| [clickhouse-io](/Users/max/.agents/skills/clickhouse-io/SKILL.md:3) | ClickHouse 查询与分析库优化 | **按需保留** | 适用于该数据库的查询、索引和运维；当前已声明的主库是 MySQL，不能混用方言。实现此类数据源支持时有保留价值。 |
| [compose-multiplatform-patterns](/Users/max/.agents/skills/compose-multiplatform-patterns/SKILL.md:3) | Compose/KMP 状态与导航 | **按需保留** | Compose/KMP 状态与导航有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [cpp-coding-standards](/Users/max/.agents/skills/cpp-coding-standards/SKILL.md:3) | C++ Core Guidelines 编码规范 | **按需保留** | C++ Core Guidelines 编码规范有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [cpp-testing](/Users/max/.agents/skills/cpp-testing/SKILL.md:3) | GoogleTest/CMake 测试 | **按需保留** | GoogleTest/CMake 测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [django-patterns](/Users/max/.agents/skills/django-patterns/SKILL.md:3) | Django 项目和 ORM 模式 | **按需保留** | Django 项目和 ORM 模式有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [django-security](/Users/max/.agents/skills/django-security/SKILL.md:3) | Django 安全配置 | **按需保留** | Django 安全配置有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [django-tdd](/Users/max/.agents/skills/django-tdd/SKILL.md:3) | Django pytest/TDD | **按需保留** | Django pytest/TDD有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [django-verification](/Users/max/.agents/skills/django-verification/SKILL.md:3) | Django 验证门禁 | **按需保留** | Django 验证门禁有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [flutter-dart-code-review](/Users/max/.agents/skills/flutter-dart-code-review/SKILL.md:3) | Flutter/Dart 代码审查 | **按需保留** | Flutter/Dart 代码审查有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [foundation-models-on-device](/Users/max/.agents/skills/foundation-models-on-device/SKILL.md:3) | Apple 本地基础模型接口 | **按需保留** | Apple 本地基础模型接口有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [golang-patterns](/Users/max/.agents/skills/golang-patterns/SKILL.md:3) | Go 错误处理和并发模式 | **按需保留** | Go 错误处理和并发模式有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [golang-testing](/Users/max/.agents/skills/golang-testing/SKILL.md:3) | Go 表驱动测试与模糊测试 | **按需保留** | Go 表驱动测试与模糊测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [java-coding-standards](/Users/max/.agents/skills/java-coding-standards/SKILL.md:3) | Java/Spring 编码约定 | **按需保留** | Java/Spring 编码约定有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [jpa-patterns](/Users/max/.agents/skills/jpa-patterns/SKILL.md:3) | JPA/Hibernate 查询与事务 | **按需保留** | JPA/Hibernate 查询与事务有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [kotlin-coroutines-flows](/Users/max/.agents/skills/kotlin-coroutines-flows/SKILL.md:3) | Kotlin 协程和 Flow | **按需保留** | Kotlin 协程和 Flow有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [kotlin-exposed-patterns](/Users/max/.agents/skills/kotlin-exposed-patterns/SKILL.md:3) | Kotlin Exposed 数据访问 | **按需保留** | Kotlin Exposed 数据访问有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [kotlin-ktor-patterns](/Users/max/.agents/skills/kotlin-ktor-patterns/SKILL.md:3) | Ktor 路由、插件与服务 | **按需保留** | Ktor 路由、插件与服务有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [kotlin-patterns](/Users/max/.agents/skills/kotlin-patterns/SKILL.md:3) | Kotlin 语言惯用法 | **按需保留** | Kotlin 语言惯用法有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [kotlin-testing](/Users/max/.agents/skills/kotlin-testing/SKILL.md:3) | Kotest/MockK 与协程测试 | **按需保留** | Kotest/MockK 与协程测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [laravel-patterns](/Users/max/.agents/skills/laravel-patterns/SKILL.md:3) | Laravel/Eloquent 应用模式 | **按需保留** | Laravel/Eloquent 应用模式有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [laravel-plugin-discovery](/Users/max/.agents/skills/laravel-plugin-discovery/SKILL.md:3) | Laravel 插件搜索与比较 | **按需保留** | Laravel 插件选型有专门用途且依赖对应 MCP；与 Slide 无关，只有 PHP/Laravel 项目需要。 |
| [laravel-security](/Users/max/.agents/skills/laravel-security/SKILL.md:3) | Laravel 认证与安全 | **按需保留** | Laravel 认证与安全有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [laravel-tdd](/Users/max/.agents/skills/laravel-tdd/SKILL.md:3) | Laravel PHPUnit/Pest 测试 | **按需保留** | Laravel PHPUnit/Pest 测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [laravel-verification](/Users/max/.agents/skills/laravel-verification/SKILL.md:3) | Laravel 验证与发布检查 | **按需保留** | Laravel 验证与发布检查有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [liquid-glass-design](/Users/max/.agents/skills/liquid-glass-design/SKILL.md:3) | Apple Liquid Glass 视觉实现 | **按需保留** | Apple Liquid Glass 视觉实现有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [nextjs-turbopack](/Users/max/.agents/skills/nextjs-turbopack/SKILL.md:3) | Next.js/Turbopack 构建 | **按需保留** | Next.js/Turbopack 构建有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [nuxt4-patterns](/Users/max/.agents/skills/nuxt4-patterns/SKILL.md:3) | Nuxt 4 SSR 与数据获取 | **按需保留** | Nuxt 4 SSR 与数据获取有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [perl-patterns](/Users/max/.agents/skills/perl-patterns/SKILL.md:3) | Perl 语言和模块模式 | **按需保留** | Perl 语言和模块模式有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [perl-security](/Users/max/.agents/skills/perl-security/SKILL.md:3) | Perl 污点与输入安全 | **按需保留** | Perl 污点与输入安全有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [perl-testing](/Users/max/.agents/skills/perl-testing/SKILL.md:3) | Perl Test2/Test::More | **按需保留** | Perl Test2/Test::More有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [postgres-patterns](/Users/max/.agents/skills/postgres-patterns/SKILL.md:3) | PostgreSQL/Supabase 数据库模式 | **按需保留** | 适用于该数据库的查询、索引和运维；当前已声明的主库是 MySQL，不能混用方言。实现此类数据源支持时有保留价值。 |
| [python-patterns](/Users/max/.agents/skills/python-patterns/SKILL.md:3) | Python 语言、类型和工程模式 | **保留** | 本地脚本、审计与文档处理可使用 Python；作为全局辅助开发技能有价值，但不据此将 Slide 的 TS Agent 核心迁回 Python。 |
| [python-testing](/Users/max/.agents/skills/python-testing/SKILL.md:3) | pytest、fixture 与测试组织 | **保留** | 本地脚本、审计与文档处理可使用 Python；作为全局辅助开发技能有价值，但不据此将 Slide 的 TS Agent 核心迁回 Python。 |
| [pytorch-patterns](/Users/max/.agents/skills/pytorch-patterns/SKILL.md:3) | PyTorch 模型和训练流程 | **按需保留** | 训练或运行 PyTorch 模型时有价值；仅调用 Anthropic/OpenAI/Ollama API 不需要引入训练框架。 |
| [rust-patterns](/Users/max/.agents/skills/rust-patterns/SKILL.md:3) | Rust 所有权、错误与并发 | **按需保留** | Rust 所有权、错误与并发有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [rust-testing](/Users/max/.agents/skills/rust-testing/SKILL.md:3) | Rust 单元、集成与异步测试 | **按需保留** | Rust 单元、集成与异步测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [springboot-patterns](/Users/max/.agents/skills/springboot-patterns/SKILL.md:3) | Spring Boot 服务架构 | **按需保留** | Spring Boot 服务架构有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [springboot-security](/Users/max/.agents/skills/springboot-security/SKILL.md:3) | Spring Security 认证与防护 | **按需保留** | Spring Security 认证与防护有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [springboot-tdd](/Users/max/.agents/skills/springboot-tdd/SKILL.md:3) | Spring Boot JUnit/Mockito 测试 | **按需保留** | Spring Boot JUnit/Mockito 测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [springboot-verification](/Users/max/.agents/skills/springboot-verification/SKILL.md:3) | Spring Boot 完整验证门禁 | **按需保留** | Spring Boot 完整验证门禁有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [swift-actor-persistence](/Users/max/.agents/skills/swift-actor-persistence/SKILL.md:3) | Swift actor 持久化 | **按需保留** | Swift actor 持久化有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [swift-concurrency-6-2](/Users/max/.agents/skills/swift-concurrency-6-2/SKILL.md:3) | Swift 6.2 并发与隔离 | **按需保留** | Swift 6.2 并发与隔离有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [swift-protocol-di-testing](/Users/max/.agents/skills/swift-protocol-di-testing/SKILL.md:3) | Swift 协议依赖注入与测试 | **按需保留** | Swift 协议依赖注入与测试有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |
| [swiftui-patterns](/Users/max/.agents/skills/swiftui-patterns/SKILL.md:3) | SwiftUI 状态与视图结构 | **按需保留** | SwiftUI 状态与视图结构有专门领域价值；Slide 当前使用 Lit/Fastify/TypeScript，不应自动采用该栈的实现或门禁。在对应语言/平台项目中保留。 |

### 研究、内容与个人工具（34 个）

| 技能（点击查看原文件） | 用途 | 建议 | 理由及必要处理 |
|---|---|---|---|
| [article-writing](/Users/max/.agents/skills/article-writing/SKILL.md:3) | 长文、教程和品牌文案 | **按需保留** | 写文档或文章时有独特的结构与文风指导；不是代码实施流程。 |
| [carrier-relationship-management](/Users/max/.agents/skills/carrier-relationship-management/SKILL.md:3) | 承运商关系和运价管理 | **按需保留** | 专业物流业务参考，与 Slide 开发无关；仅相关业务项目需要，不因领域不同判定质量低。 |
| [content-engine](/Users/max/.agents/skills/content-engine/SKILL.md:3) | 多平台内容策划和复用 | **按需保留** | 用于营销内容生产，和 article-writing 的长文写作不同；未指定发布时只产出草稿。 |
| [crosspost](/Users/max/.agents/skills/crosspost/SKILL.md:3) | 跨平台内容适配与分发 | **按需保留** | 有社媒运营时使用；与 content-engine 的内容生产互补，实际发送/发布需明确授权。 |
| [customs-trade-compliance](/Users/max/.agents/skills/customs-trade-compliance/SKILL.md:3) | 海关与贸易合规参考 | **按需保留** | 仅贸易业务需要；具有专业判断框架，不能将技能示例当作实际法务结论。 |
| [data-scraper-agent](/Users/max/.agents/skills/data-scraper-agent/SKILL.md:3) | 自动采集与结构化数据管道 | **按需保留** | 资料采集项目可用；不是 Slide 数据库连接或业务查询的默认实现方式。 |
| [deep-research](/Users/max/.agents/skills/deep-research/SKILL.md:3) | 多来源深度研究 | **修订后保留** | 研究任务有价值；依据已有信息决定是否澄清，工具发现后选可用检索方式，不强制重复询问或因单个 MCP 缺失停工。 |
| [defuddle](/Users/max/.agents/skills/defuddle/SKILL.md:3) | 网页正文转干净 Markdown | **按需保留** | 网页研究和资料保存有明确工具价值；需要可用 CLI，不必与每个研究技能一起触发。 |
| [energy-procurement](/Users/max/.agents/skills/energy-procurement/SKILL.md:3) | 电力和天然气采购 | **按需保留** | 专业能源采购参考，与当前开发无关；可放在行业项目技能集合中。 |
| [exa-search](/Users/max/.agents/skills/exa-search/SKILL.md:3) | Exa 搜索接口和用法 | **按需保留** | 实际接入 Exa 时有用；和通用研究策略不同，未提供该 MCP 时不能假装可调用。 |
| [fal-ai-media](/Users/max/.agents/skills/fal-ai-media/SKILL.md:3) | fal.ai 图像、视频和音频生成 | **按需保留** | 需要 fal.ai 媒体服务时有价值；与已有图像能力有部分重叠，按所需媒体选择，保留付费和外部操作边界。 |
| [frontend-slides](/Users/max/.agents/skills/frontend-slides/SKILL.md:3) | HTML 演示文稿 | **按需保留** | 交互 HTML 幻灯片不同于 PowerPoint，可用于产品演示；普通文稿不强制三款预览和二次选型。 |
| [inventory-demand-planning](/Users/max/.agents/skills/inventory-demand-planning/SKILL.md:3) | 库存需求与补货规划 | **按需保留** | 专业供应链参考，当前无直接需求；相关业务项目再启用。 |
| [investor-materials](/Users/max/.agents/skills/investor-materials/SKILL.md:3) | 融资材料、路演和财务叙事 | **按需保留** | 产品融资时有独特价值；与普通文档排版技能互补，数字冲突仍必须查证。 |
| [investor-outreach](/Users/max/.agents/skills/investor-outreach/SKILL.md:3) | 投资人外联文案 | **按需保留** | 有融资外联任务才需要；撰写不等于授权发送。 |
| [json-canvas](/Users/max/.agents/skills/json-canvas/SKILL.md:3) | Obsidian JSON Canvas 文件 | **按需保留** | 可视化笔记专用格式，和普通 Markdown 不重叠；使用 Canvas 时保留。 |
| [lead-intelligence](/Users/max/.agents/skills/lead-intelligence/SKILL.md:3) | 线索研究、评分和外联路径 | **按需保留** | 销售或融资拓展时有用，通常依赖搜索服务；不参与 Slide 日常研发。 |
| [logistics-exception-management](/Users/max/.agents/skills/logistics-exception-management/SKILL.md:3) | 运输异常、延误与索赔 | **按需保留** | 领域知识独立，与数据库平台开发无关；有物流业务才需要。 |
| [market-research](/Users/max/.agents/skills/market-research/SKILL.md:3) | 市场、竞品和技术商业研究 | **按需保留** | 产品规划时有价值；关注证据与决策，和通用 deep-research 可共用检索方法而保留领域标准。 |
| [nutrient-document-processing](/Users/max/.agents/skills/nutrient-document-processing/SKILL.md:3) | Nutrient 文档处理 API | **按需保留** | 仅接入该服务或需要其特定 OCR/处理能力时保留；普通 PDF/DOCX 优先已有文档插件，避免不必要的外部上传和付费。 |
| [obsidian-bases](/Users/max/.agents/skills/obsidian-bases/SKILL.md:3) | Obsidian Bases 数据视图 | **按需保留** | 有 Bases 工作流时有独特格式知识；不替代 Slide 数据库能力。 |
| [obsidian-cli](/Users/max/.agents/skills/obsidian-cli/SKILL.md:3) | 操作 Obsidian 笔记与插件 | **按需保留** | 实际使用 Obsidian 时有用；只读和写入按用户请求区分。 |
| [obsidian-markdown](/Users/max/.agents/skills/obsidian-markdown/SKILL.md:3) | Obsidian 链接、嵌入和笔记格式 | **按需保留** | 笔记格式专用知识，与 CLI 操作互补；普通仓库 Markdown 不自动采用该格式。 |
| [openclaw-persona-forge](/Users/max/.agents/skills/openclaw-persona-forge/SKILL.md:3) | OpenClaw 角色和人格设定 | **按需保留** | 仅角色化 OpenClaw 任务有用，技能本身排除纯工具型 Agent；不适用于 Slide agent-core 的运维逻辑。 |
| [production-scheduling](/Users/max/.agents/skills/production-scheduling/SKILL.md:3) | 制造业生产排程 | **按需保留** | 专业制造领域参考，与当前项目无直接关系；有排程业务项目再使用。 |
| [quality-nonconformance](/Users/max/.agents/skills/quality-nonconformance/SKILL.md:3) | 质量异常、CAPA 和根因流程 | **按需保留** | 制造业质量治理参考，与软件系统调试不是同一流程，不默认套用。 |
| [remotion-video-creation](/Users/max/.agents/skills/remotion-video-creation/SKILL.md:3) | Remotion 程序化视频 | **按需保留** | 规则文件存在，做代码驱动视频有独特用途；Slide 名称不表示项目需要视频框架。 |
| [returns-reverse-logistics](/Users/max/.agents/skills/returns-reverse-logistics/SKILL.md:3) | 退货、逆向物流与售后 | **按需保留** | 特定业务领域参考；没有相关需求时可保存在行业技能库。 |
| [save-to-obsidian](/Users/max/.agents/skills/save-to-obsidian/SKILL.md:3) | 按个人目录规则保存笔记 | **修订后保留** | 包含你的专用笔记路径，具有个性化价值；触发不应扩展到所有文档，硬编码项目映射需核对，写入须有请求。 |
| [video-editing](/Users/max/.agents/skills/video-editing/SKILL.md:3) | 剪辑、字幕、配音与媒体流程 | **修订后保留** | 视频任务有用，但“Do not skip layers”会强制整套工具链；按交付选 FFmpeg/Remotion 等必要步骤即可。 |
| [videodb](/Users/max/.agents/skills/videodb/SKILL.md:3) | 视频索引、时间线和实时流处理 | **按需保留** | 需要视频检索、监控或处理服务时有独特价值；保留数据上传、桌面采集和外部服务授权边界。 |
| [visa-doc-translate](/Users/max/.agents/skills/visa-doc-translate/SKILL.md:3) | 签证文件 OCR 与双语 PDF | **修订后保留** | 翻译排版用途独特；第43行无条件添加 certified translation 声明不恰当，应仅在确有认证时标注，不能凭普通图片路径触发全流程。 |
| [weread-skills](/Users/max/.agents/skills/weread-skills/SKILL.md:3) | 微信读书书架、笔记和统计 | **按需保留** | 用途清晰且有对应参考文档；作为个人工具可保留，不能仅因与 Slide 无关而删除。 |
| [x-api](/Users/max/.agents/skills/x-api/SKILL.md:3) | X/Twitter API 集成 | **按需保留** | 仅有程序化社交媒体任务时需要；保留实际发送和发布授权，凭证能力需另验证。 |

## 高影响建议的原文证据

以下仅引用影响保留决策的代表性规则。完整清单的文件链接可直接核对触发范围与专有内容。

- **官网设计技能本身排除控制台**：[文件第 8 行](/Users/max/Coding/40-Slide/.agents/skills/design-taste-frontend/SKILL.md:8)。原文：> Landing pages, portfolios, and redesigns. Not dashboards, not data tables, not multi-step product UI.
- **随机营销布局不应成为数据库控制台规范**：[文件第 14 行](/Users/max/Coding/40-Slide/.agents/skills/gpt-taste/SKILL.md:14)。原文：LLMs are inherently lazy and always pick the first layout option. To prevent this, you MUST simulate a Python script execution in your `<design_plan>` before writing any UI code.
- **完整输出技能要求用户继续**：[文件第 38 行](/Users/max/Coding/40-Slide/.agents/skills/full-output-enforcement/SKILL.md:38)。原文：[PAUSED — X of Y complete. Send "continue" to resume from: next section name]
- **既有 UI 优化混入了编造日期建议**：[文件第 86 行](/Users/max/Coding/40-Slide/.agents/skills/redesign-existing-projects/SKILL.md:86)。原文：- **All blog post dates identical.** Randomize dates to appear real.
- **强制技能加载范围过宽**：[文件第 11 行](/Users/max/.agents/skills/using-superpowers/SKILL.md:11)。原文：If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.
- **逐消息重跑验证与项目证据复用冲突**：[文件第 22 行](/Users/max/.agents/skills/superpowers-verification-before-completion/SKILL.md:22)。原文：If you haven't run the verification command in this message, you cannot claim it passes.
- **默认五名并行审查超过项目四并发**：[文件第 19 行](/Users/max/.agents/skills/source-command-code-review/SKILL.md:19)。原文：4. Then, launch 5 parallel Sonnet agents to independently code review the change. The agents should do the following, then return a list of issues and the reason each issue was flagged (eg. AGENTS.md adherence, bug, historical git context, etc.):
- **自主循环旧入口明确标记继任者**：[文件第 10 行](/Users/max/.agents/skills/autonomous-loops/SKILL.md:10)。原文：> The canonical skill name is now `continuous-agent-loop`. New loop guidance
- **旧目录路径让已安装 CK 脚本无法按说明找到**：[文件第 14 行](/Users/max/.agents/skills/ck/SKILL.md:14)。原文：Scripts live at: `~/.Codex/skills/ck/commands/` (expand `~` with `$HOME`).
- **普通翻译不能自动声明经过认证**：[文件第 43 行](/Users/max/.agents/skills/visa-doc-translate/SKILL.md:43)。原文：- Add a note at the bottom: "This is a certified English translation of the original document"
- **GSD 入口路由到本地空目标目录**：[文件第 20 行](/Users/max/.agents/skills/gsd-ns-workflow/SKILL.md:20)。原文：| Execute plans in a phase | gsd-execute-phase |
- **Anthropic 技能混入 Codex 型号命名**：[文件第 24 行](/Users/max/.agents/skills/claude-api/SKILL.md:24)。原文：| Sonnet 4 | `Codex-sonnet-4-0` | Balanced coding, most development tasks |

## 重叠组的处理建议

| 重叠组 | 建议保留的入口 | 整理原则 |
|---|---|---|
| TDD 两套流程 | 修订后的 tdd-workflow | 迁入 superpowers-test-driven-development 的独特回归方法及明确例外审批；不通过移出技能取消测试要求。 |
| 完成证据与完整 gate | AGENTS.md + 仓库真实测试命令 | 保留“有证据才宣称通过”，去掉逐消息/固定时间重复跑全套验证。 |
| Agent 工程原则 | AGENTS.md + agent-harness-construction + eval-harness | 通用宣言转为参考，保留专业设计及评测能力。 |
| 自主执行循环 | continuous-agent-loop | autonomous-loops 的独特示例可保留为参考；先检查旧入口引用后再移出。 |
| 自动学习 | continuous-learning-v2 或当前实际使用的记忆机制 | 不建议两套 hook 并行维护；没有真实启用证据不宣称已运行。 |
| 视觉风格 | 项目设计规范 + design-system + 按任务选一套参考 | 不同时叠加随机 GSAP、工业风、暖极简和新版营销规范。 |
| 多代理评审 | 当前原生代理 + 项目资源治理 | santa-method 等只用于明确要求独立交叉验证的任务，避免层层套娃。 |

## 空 GSD 目录与缺失依赖

以下 59 个目录在本次扫描时确认为空；它们不是另有 59 个可用技能。空目录本身通常不增加技能元数据，真正的问题是现存的六个 gsd-ns 路由指向这些空目标。这里仅核对两个用户指定目录及少量明确引用路径，未穷尽其他远端或未加载插件中的 GSD 能力。

`gsd-add-tests`, `gsd-ai-integration-phase`, `gsd-audit-fix`, `gsd-audit-milestone`, `gsd-audit-uat`, `gsd-autonomous`, `gsd-capture`, `gsd-cleanup`, `gsd-code-review`, `gsd-complete-milestone`, `gsd-config`, `gsd-debug`, `gsd-discuss-phase`, `gsd-docs-update`, `gsd-eval-review`, `gsd-execute-phase`, `gsd-explore`, `gsd-extract-learnings`, `gsd-fast`, `gsd-forensics`, `gsd-graphify`, `gsd-health`, `gsd-help`, `gsd-import`, `gsd-inbox`, `gsd-ingest-docs`, `gsd-manager`, `gsd-map-codebase`, `gsd-milestone-summary`, `gsd-mvp-phase`, `gsd-new-milestone`, `gsd-new-project`, `gsd-pause-work`, `gsd-phase`, `gsd-plan-phase`, `gsd-plan-review-convergence`, `gsd-pr-branch`, `gsd-profile-user`, `gsd-progress`, `gsd-quick`, `gsd-resume-work`, `gsd-review`, `gsd-secure-phase`, `gsd-settings`, `gsd-ship`, `gsd-sketch`, `gsd-spec-phase`, `gsd-spike`, `gsd-stats`, `gsd-surface`, `gsd-thread`, `gsd-ui-phase`, `gsd-ui-review`, `gsd-ultraplan-phase`, `gsd-undo`, `gsd-update`, `gsd-validate-phase`, `gsd-verify-work`, `gsd-workspace`

其他已核对的问题：CK 的命令脚本在 ~/.agents/skills/ck/commands 存在，说明中的 ~/.Codex/skills/ck/commands 不存在；superpowers-subagent-driven-development 目录没有所引用的三个 prompt 文件；superpowers-requesting-code-review 缺少随技能引用的 code-reviewer.md；ui-ux-pro-max-skill 当前目录仅有说明文件，未附带它所展示的生成器。工具本体可能在别处安装，本轮不据此断言整台电脑都没有它们。

## 授权与变更边界

- 本报告不授权移动、删除、禁用、合并或更新任何技能。原始技能文件没有被修改。
- 明确批准要求应先识别并保留。将审批型技能移出发现范围可能改变未来行为；若要实施，应把仍需保留的批准要求迁入适当的维护源，并单独确认任何权限扩张。
- 特别保留预算追加批准、破坏性丢弃确认、ADR/记忆写入批准、生产/发布门禁，以及明确要求的独立审查；不把“减少技能”解释为取消这些保障。
- 移出旧版本前检查 hooks、脚本、其他技能及已有计划的引用。带安装锁文件的第三方技能优先在上游 fork/自有维护源修改，避免后续更新覆盖。
- 仅凭与 Slide 无关不建议永久删除全局技能；其他语言、行业、Obsidian、微信读书和媒体技能的最终保留取决于你的真实用途。

## 方法与限制

对 182 个 SKILL.md 做了名称、描述、章节、触发条件及流程规则的定向扫描；重点核读高影响冲突，并检查明确的本地依赖。未逐个执行技能，未逐行验证所有技术示例，未对技术版本/商业数据/法规时效性做联网认证。专业语言或行业技能的“按需保留”表示能力范围有价值，不是对每个示例的正确性担保。

清单覆盖与去重通过机械校验：项目 13/13，全局 169/169，无漏项、无重复；报告中的代表性原文引用按行号核对。实际使用频次、模型 token 和费用遥测不可用。尝试的三个子代理均遇到服务限流，没有采用其未完成结果，本报告由主线程完成。
