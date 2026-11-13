# AGENTS.md

Slide：智能基础设施运维平台。本文记录当前架构和全仓执行规则；尚未实施的方案不能作为已有能力描述。

## 1. 当前架构与专项规则

- **前端**：Lit 3.3 + Vite（Web Components）。
- **后端**：Fastify + TypeScript。
- **Agent**：`@slide/agent-core`；DirectAdapter 自管理 WebSocket，不依赖外部 Gateway。
- **平台存储**：MySQL 持久化平台业务数据；Agent Session/Checkpoint 还涉及文件存储，按现有实现处理。
- **纳管对象**：数据库、服务器、网络设备。数据库类型包含 MySQL、PostgreSQL、Oracle、达梦、MongoDB、Redis、Elasticsearch；实际能力以 capability registry 为准。
- **认证与模型**：JWT + 实时权限校验；模型通过 Provider 配置和场景路由选择，复用现有 Anthropic / OpenAI 兼容 / Ollama 接入。

按任务范围读取以下专项规则，根规则继续适用：

| 任务 | 必须读取 |
|---|---|
| 前端修改，或复用前端组件制作原型 | [frontend/AGENTS.md](frontend/AGENTS.md) |
| 产品设计、实施计划、原型与验收 | [当前版本项目范围](docs/slide/requirements/current-version-scope.md) |
| 源码同步、版本快照、源码访问及相关 UI/故障排查 | [源码同步规则](docs/slide/development/source-sync.md) |

## 2. 标准命令与环境

使用仓库 `package.json` 声明的 pnpm 版本。以下命令从仓库根目录执行；前后端分别在独立终端启动：

```bash
pnpm --filter slide-api dev
pnpm --filter slide-frontend dev

# 存活与就绪探针；不能代替业务验收
curl http://localhost:3000/api/health
curl http://localhost:3000/api/health/ready

# 常用检查；按改动范围选择
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm ci:source-policy # 检查相对 HEAD 的已暂存、未暂存和未跟踪代码
```

- 默认前端地址 `http://localhost:5173`、后端地址 `http://localhost:3000`、Agent WebSocket 地址 `ws://127.0.0.1:28888/ws`；实际地址以运行配置为准。
- 后端环境从 `apps/db-ops-api/.env` 加载。数据库连接以 [db-connection.ts](apps/db-ops-api/src/db-connection.ts) 为准；JWT、加密密钥及生产初始化管理员要求以 [security-config.ts](apps/db-ops-api/src/config/security-config.ts) 为准。真实密码或密钥不得写入规则、任务、日志或版本库。
- 模型配置以 [llm-provider-factory.ts](apps/db-ops-api/src/adapter/llm-provider-factory.ts) 和场景路由为准，不通过旧环境变量绕过已停用的 Provider。配置示例与实际加载、校验代码冲突时以代码为准。
- 排查运行行为或停止服务前，核对 **PID → 端口 → cwd → 启动命令 → 分支/Commit → 日志文件**。确认进程属于当前任务后优先优雅停止，不按端口直接强杀其他工作树的服务。

### 2.1 共享测试资源与认证（2026-11-10）

以下地址以运行 Multica 的本机宿主环境为基准；容器或异机执行时需核对网络可达性。资源按本节约定使用，开工前检查当前状态及其他任务占用。

| 用途 | 地址 | 容器 / 服务 | 认证账号与数据库 | 凭据引用 |
|---|---|---|---|---|
| Linux 测试 VM | `172.16.51.128:22` | VMware NAT 虚拟机 | SSH 用户 `root`，密码认证 | 下述 VM 密码文件 |
| Slide 自身 MySQL | `127.0.0.1:3306` | `mysql` | `root`，数据库 `db_ops_ai` | `slide-platform` |
| MySQL 测试库 | `127.0.0.1:3308` | `mysql3308` | `root`，按任务使用独立测试库 | `mysql-test` |
| PostgreSQL 测试库 | `127.0.0.1:5432` | `slide-pg-test` | `slide_test`，数据库 `slide_test` | `pg-test` |
| Oracle 测试库 | `127.0.0.1:1521` | `oracle19c` | `SYSTEM`，服务名 `ORCLPDB1` | `oracle-test` |
| 达梦测试库 | `127.0.0.1:5236` | `dameng` | `SYSDBA` | `dameng-test` |

- 数据库认证信息保存在 `/Users/max/.config/slide-test-access/connection-profiles.json`（权限 `0600`）。表中凭据引用对应 JSON 顶层键，包含实际主机、端口、用户、密码及适用的数据库或服务名。执行者按键读取，禁止打印完整文件、密码或带密码的连接串。
- VM 密码保存在 `/Users/max/.config/slide-test-access/linux-192.168.49.130.password`（权限 `0600`）；文件名沿用历史地址，当前连接地址使用 `172.16.51.128`。该地址来自 DHCP，连接前核实当前租约。已于 2026-11-10 从本机宿主环境通过 SSH 密码认证成功登录，执行 `hostname`、`id`、`uname -m` 和网卡地址查询，确认 `uid=0(root)`、`aarch64` 及当前地址。外部 SSH 登录验证通过。
- 上述凭据路径位于仓库外，仅供获授权的本机执行者读取；异机执行需由资源负责人安全交接。真实密码、密钥不复制进规则、任务、日志、附件或版本库。
- `3306` 用于 Slide 自身持久化与配置，按应用运行需要保持可用。数据库开发测试使用 `3308`，并与 PG、Oracle、达梦一起按需启停。先检查任务占用与容器身份，再按目标执行 `docker start <容器名>` 或 `docker stop <容器名>`；测试清理只处理本任务对象，保留共享配置及其他任务数据。
- 四种测试库及 Slide `3306` 已于 2026-11-10 从宿主机通过项目实际驱动完成认证和只读 SQL 查询。后续验收仍需覆盖各任务要求的事务、权限、采集或恢复场景。
- 网络设备按用户决定继续使用受控 SNMP/SSH 协议端点和测试样本，当前批次免除真实设备测试。证据注明协议端点与样本范围；厂商实机兼容性结论须有对应实测依据。

### 2.2 LLM 测试入口与累计预算（2026-11-10）

| 配置项 | 已验证值 |
|---|---|
| 配置来源 | Slide `3306/db_ops_ai` 的 `llm_providers`，Provider `deepseek`（ID `5`） |
| 模型 | `deepseek-flash` |
| 协议与地址 | `openai-completions`，Base URL `https://api.deepseek.com/v1`，生成接口 `POST /chat/completions` |
| 路由 | 核验时为启用的全局默认，`llm_scene_bindings` 为空；执行时重新读取实际场景绑定和默认配置 |
| 认证引用 | `llm_providers.api_key_encrypted`，通过 `llmDatabaseService.getProviderApiKey(provider.name, provider)` 读取；解密使用后端 `.env` 中的 `ENCRYPTION_KEY` |
| 验证结果 | 凭据和 `GET /models` 通过；一次非流式文本生成返回 `OK`，服务端 usage 为输入 `34`、输出 `11`，合计 `45` token |

- 正常 Agent 调用沿用 `createConfiguredAgentProvider(llmDatabaseService, purpose)` 和场景路由。单独连接测试复用 `resolveSceneModel`、上述凭据读取方法及 `createServiceProviderClient(provider, apiKey, true)`，通过返回的 OpenAI SDK client 调用 `chat.completions.create`；明确限制输出，关闭自动重试，不把结果未知的请求重发。API Key 仅在内存中使用，禁止另写明文配置或输出到日志。
- 本次验证覆盖认证、模型存在及短文本生成；流式、工具调用等能力仍按各任务验收。其他 Provider 按当前配置及相应任务另行核验。
- 用户确认本批此前已用、预留和未结算 token 均为零，并授权沿用累计 **10,000,000** token 总额度。共享账本位于 `/Users/max/Coding/40-Slide/outputs/llm-test-budget/ledger.json`，全部父子任务、worktree、场景、重试和恢复共用，禁止按任务重新清零或另开额度；Multica 编码消耗单独核算。本文记录的首次测试已结算 `45` token，后续余额以账本实时值为准。
- 每次发送前独占创建同目录 `ledger.lock`，核对 `usedTokens + reservedTokens` 与剩余额度，记录唯一请求条目并预留输入和最大输出；按服务端实际 usage 结算，更新账本采用临时文件原子替换。输入含缓存部分只计一次，输出含推理 token 时也只计一次；缓存子项分别留存用于核对。缺失 usage、超时或未知回执保留预留，先对账再恢复，不自动重放；账本或锁异常时先核实归属与未决请求。
- 累计达到额度的 50% 时报告，80% 时收敛，达到上限停发并保留检查点；追加预算需用户批准。初次调用证据位于 `outputs/llm-readiness-2026-11-10/deepseek-generation.json`。

## 3. 执行、澄清与授权

- 实施前明确目标、排除项、关键假设、可验证验收、测试层级及停止条件；多步骤任务简述计划并逐项验证，无需新增批准步骤。
- 用户已请求实施时，持续完成范围内的开发、验证和必要修复；只请求分析、计划或审阅时，以对应交付物为终点。
- 先检查代码、文档和当前会话，遇到问题先定位根因。只有未解决的歧义实质影响目标、兼容性、数据安全、外部副作用或授权边界时才询问；可逆的常规选择说明必要依据，遵循现有模式继续执行。
- 缺依赖、测试失败等可恢复问题先诊断处理。需要用户决定时，仅暂停受影响步骤，继续独立工作。
- 保留适用规则中的明确批准要求、操作时确认和工具拒绝。已有批准仅覆盖同一对象、版本、范围和副作用；无需操作时重确认的事项不重复索取批准。
- 必须请求批准或用户处理时，先完成独立调查、草稿和验证，说明具体阻塞、已尝试方法、最小输入及要求来源；附带流程不得阻塞主任务。
- 交付按验收报告证据和未完成项；长内容提供完整文件与链接，不要求用户发送“继续”。

## 4. 范围与委派

- 当前版本面向桌面浏览器、中文和浅色界面；产品及验收边界以[当前版本项目范围](docs/slide/requirements/current-version-scope.md)为准，通用技能清单不能扩大范围。纳管对象采用无 Agent 采集，此处的采集 Agent 与 Slide AI Agent 运行时不同。
- 选择满足验收的最简单实现，只改必要内容并匹配现有模式；不添加额外功能、不为一次性代码创建通用抽象、不顺手重构或调整无关格式。发现更简单的可行方案时说明取舍。
- 新发现工作仅在直接阻塞验收、存在确认的数据损坏风险，或属于本次变更引入/触达的确认安全漏洞时进入当前范围。无关测试失败、架构优化和文档补全记录为 backlog；扩展范围前说明与验收的直接关系，保留历史范围与决策。
- 委派须符合当前平台和会话授权，仅用于边界清晰、可独立并行且能缩短关键路径的任务。明确文件所有权、最小上下文和可验证交付物；默认不传递完整对话历史。
- 默认最大代理深度 `1`、并发不超过 `4`、单个 Goal（无 Goal 时为本次任务）累计子代理不超过 `8`。突破项目上限前记录必要性和收益，不绕过平台硬限制或明确审批。
- 子代理默认不得继续派生代理；同一问题不重复实现或审查，除非明确要求独立交叉验证。不因技能模板机械增加委派，保留用户要求的独立审查。

## 5. 验证要求

- 开发阶段运行与改动直接相关的检查；阶段边界运行受影响模块测试；最终集成候选统一运行完整 gate。
- 验证证据对应当前代码、配置和相关环境。未变化时复用结果；变化后重跑受影响检查和最终必要回归，不因汇报或固定时间间隔重复全量测试。
- 失败先分类为本次引入、相关既有、无关既有或环境问题，再按首个有效错误区分业务断言、初始化、外部依赖、观测采集、清理或汇总门禁；按[质量门规则](docs/slide/development/quality-gates.md)归并根因、修复和交接，不能绕过合并/发布门禁。
- 健康探针、单测和 mock 不能替代要求的真实业务端到端验收；必要验证未完成时明确标注，不宣称通过。
- 前端遵循前端专项规则；公开契约变更运行契约检查，权限及发布变更完成对应安全门禁。
- 安全、凭据、备份/恢复、权限、审计、发布脚本及跨模块改动，按[质量门与独立复核规则](docs/slide/development/quality-gates.md)执行独立复核并留存证据包。

## 6. 外部任务建单与交接

- 用户未指定平台时，“提交 issue / 建 issue”均指当前仓库的 GitHub Issue。
- 任务正文只记录长期有效的问题、范围、验收、依赖和已有兼容决定；当次操作说明留在交付回复中。
- 建单不等于授权启动执行。按用户授权设置状态和分配对象，避免意外触发；建单或更新后回读正文、状态及执行情况。
- 任务应引用可供执行环境访问的方案和验收材料，不能只依赖当前聊天历史。

## 7. 发布与产物

- 镜像、代码发布包、校验和和发布说明统一存放在 `/Users/max/Coding/40-Slide/outputs`，即使从其他 worktree 构建也使用此目录；构建时显式设置 `RELEASE_OUTPUT_DIR`，不能依赖脚本的 `.artifacts` 默认值。
- 单个 tar 包（包括 `.tar.gz`、`.tgz`）不得超过 **300,000,000 字节**。超限优先拆成可独立使用的包；交付前逐个检查实际大小并生成校验和。

## 8. 编码标准

- 编码前将需求转成可验证结果；修复先复现，重构验证行为保持一致。假设、歧义与更简单的方案按第 3、4 节处理。
- 只修改能追溯到需求的内容，匹配现有风格；删除本次修改造成的孤儿代码，不清理未触达的旧代码或格式。
- 自动测试使用注入配置和任务独占资源，不依赖开发者目录、私有凭据文件或默认共享数据库；本机验收资源按第 2.1 节显式选择，不因凭据缺失在默认测试收集时失败。
- 迁移、共享接口、权限兼容、并发与测试生命周期的具体约束统一见[质量门规则第 4 节](docs/slide/development/quality-gates.md#4-分层验证)。提交前运行 `pnpm ci:source-policy`；此增量检查不能替代真实业务验收和最终 gate。
