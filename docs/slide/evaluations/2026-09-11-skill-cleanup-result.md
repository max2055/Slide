# 技能清理执行结果

完成时间：2026-09-11T03:35:17.988793+00:00

依据：用户已批准按技能保留审计建议执行清理。原审计报告保留，未改写历史评估。

| 范围 | 清理前 | 清理后 | 归档 |
|---|---:|---:|---:|
| 项目 `.agents/skills` | 13 | 5 | 8 |
| 全局 `~/.agents/skills` | 169 | 149 | 20 |
| 合计 | 182 | 154 | 28 |

另外清理了 59 个空 GSD 目录和 8 个项目 `.claude/skills` 符号链接。修订 33 个建议保留项，修复 8 个保留技能的依赖/内容承接，共修改 41 个技能目录；其余 113 个保留技能的内容哈希未变化。

## 项目保留项

`brandkit`、`design-taste-frontend`、`image-to-code`、`imagegen-frontend-web`、`redesign-existing-projects`。

## 归档项

- **项目**：`design-taste-frontend-v1`、`full-output-enforcement`、`gpt-taste`、`high-end-visual-design`、`imagegen-frontend-mobile`、`industrial-brutalist-ui`、`minimalist-ui`、`stitch-design-taste`。
- **全局**：`agentic-engineering`、`ai-first-engineering`、`autonomous-loops`、`continuous-learning`、`gsd-ns-context`、`gsd-ns-ideate`、`gsd-ns-manage`、`gsd-ns-project`、`gsd-ns-review`、`gsd-ns-workflow`、`project-guidelines-example`、`source-command-code-review`、`strategic-compact`、`superpowers-subagent-driven-development`、`superpowers-test-driven-development`、`superpowers-verification-before-completion`、`team-builder`、`token-budget-advisor`、`using-superpowers`、`verification-loop`。

## 保留技能修订

| 技能 | 执行内容 |
|---|---|
| [image-to-code](/Users/max/Coding/40-Slide/.agents/skills/image-to-code/SKILL.md) | 截图还原有独特用途；应允许直接使用用户参考图，取消可选生图对实现的阻塞，并限定在截图还原任务中使用。 |
| [redesign-existing-projects](/Users/max/Coding/40-Slide/.agents/skills/redesign-existing-projects/SKILL.md) | 最贴近日常 UI 优化；保留先审查、复用现有栈的流程，删除随机化真实内容日期等建议，将颜色、间距和组件选择交给 Slide 规范。 |
| [ai-regression-testing](/Users/max/.agents/skills/ai-regression-testing/SKILL.md) | 针对共同假设、mock 与真实路径差异有价值；限定受影响行为，不能用无数据库的测试代替项目明确要求的真实同步 E2E。 |
| [autonomous-agent-harness](/Users/max/.agents/skills/autonomous-agent-harness/SKILL.md) | 连续运维场景有价值，但示例使用旧 scheduled-tasks 工具名称和路径；需适配当前原生自动化接口，不能因监控请求自行搭建整套框架。 |
| [browser-qa](/Users/max/.agents/skills/browser-qa/SKILL.md) | 对 Lit 前端验收很有价值；把泛化的 MCP/Puppeteer 路径适配到当前可用浏览器接口，避免新增工具前置要求。 |
| [canary-watch](/Users/max/.agents/skills/canary-watch/SKILL.md) | 有实际部署观察价值；改用原生定时监控和明确观察窗口，不能由普通部署请求自动推定无限期监控。 |
| [ck](/Users/max/.agents/skills/ck/SKILL.md) | 脚本确实存在于 .agents/skills/ck/commands，但文本指向不存在的 .Codex/skills 路径；修正路径并保留初始化和保存批准，与原生记忆择一维护。 |
| [claude-api](/Users/max/.agents/skills/claude-api/SKILL.md) | Slide 使用 Anthropic SDK；文本却混称 Anthropic 与 Codex，并给出 Codex-sonnet 等模型字符串，必须核对真实产品名、SDK 和模型 ID 后使用。 |
| [click-path-audit](/Users/max/.agents/skills/click-path-audit/SKILL.md) | 特别适合控制台状态竞争和按钮失效排查；保留状态序列检查，移除固定先后技能链及默认多代理流程。 |
| [coding-standards](/Users/max/.agents/skills/coding-standards/SKILL.md) | 可保留项目未覆盖的语言细节；让 lint、tsconfig、Lit 和 AGENTS.md 优先，避免套用 React 规则或泛化重构。 |
| [context-budget](/Users/max/.agents/skills/context-budget/SKILL.md) | 对当前技能膨胀问题有用；区分描述常驻与正文按需加载，估算不能伪装为实际 token 消耗。 |
| [cost-aware-llm-pipeline](/Users/max/.agents/skills/cost-aware-llm-pipeline/SKILL.md) | 直接关联多 LLM 后端的成本控制；示例模型 ID 含 Codex-sonnet 混称，改为有效的提供方配置，并区分应用费用与本次代理预算。 |
| [design-system](/Users/max/.agents/skills/design-system/SKILL.md) | 最适合补充现有共享组件规则；默认审计模式，禁止因单个 UI 任务重新生成或替换整套设计系统。 |
| [documentation-lookup](/Users/max/.agents/skills/documentation-lookup/SKILL.md) | 对 Lit、Fastify 和 SDK 实现有价值；先检查工具是否可用，允许官方文档路径，不能将 Context7 缺失视为整项任务阻塞。 |
| [product-lens](/Users/max/.agents/skills/product-lens/SKILL.md) | 产品探索有用，但“Before starting any feature”触发过宽；限定产品决策任务，普通实现不重新询问产品价值。 |
| [rules-distill](/Users/max/.agents/skills/rules-distill/SKILL.md) | 当前去重治理有价值，脚本存在但文档路径与实际安装不符；提取为建议后审阅，避免把案例升级成全局强制规则。 |
| [safety-guard](/Users/max/.agents/skills/safety-guard/SKILL.md) | 保障目的应保留；本目录只有说明文档，不能宣称 hook 已生效。需区分建议规则、真实已安装拦截和工具原生审批。 |
| [search-first](/Users/max/.agents/skills/search-first/SKILL.md) | 避免重复实现有价值，但与 AGENTS.md 的先查证原则重叠；保留针对性搜索，不默认派研究代理或全网调研。 |
| [skill-comply](/Users/max/.agents/skills/skill-comply/SKILL.md) | 改为可用工具下的有界行为评估流程；缺少独立运行器时明确只做静态评估，不虚构 scripts.run 或搭建额外框架。 |
| [skill-stocktake](/Users/max/.agents/skills/skill-stocktake/SKILL.md) | 适合当前治理；修复 .Codex/.claude/.agents 扫描路径不一致和缓存维度，保留删除/合并前的批准要求。 |
| [superpowers-brainstorming](/Users/max/.agents/skills/superpowers-brainstorming/SKILL.md) | 复杂需求探索有价值，但全任务强制审批易阻塞；保留明确审批，复用已有批准，若要缩小审批适用范围须另行授权。 |
| [superpowers-executing-plans](/Users/max/.agents/skills/superpowers-executing-plans/SKILL.md) | 有步骤追踪价值；普通缺依赖/测试失败先诊断修复，只暂停确实受阻的任务，停止重复询问已授权执行。 |
| [superpowers-finishing-a-development-branch](/Users/max/.agents/skills/superpowers-finishing-a-development-branch/SKILL.md) | 保留具体 Git 收尾和 discard 确认；复用已选的 PR/合并方式，统一创建 PR 后是否保留 worktree 的矛盾。 |
| [superpowers-receiving-code-review](/Users/max/.agents/skills/superpowers-receiving-code-review/SKILL.md) | 先核对反馈而非盲从有价值；一个模糊条目不应阻塞全部独立修复，保留与用户既有决策冲突时的讨论。 |
| [superpowers-requesting-code-review](/Users/max/.agents/skills/superpowers-requesting-code-review/SKILL.md) | 重要变更的审查模板有用；补齐当前缺少的 code-reviewer 模板依赖，并取消每个细小任务默认派审查代理。 |
| [superpowers-systematic-debugging](/Users/max/.agents/skills/superpowers-systematic-debugging/SKILL.md) | 与项目根因优先原则一致且方法具体；保留三次失败后的讨论保障，允许继续只读诊断，避免把所有失败扩大为架构重构。 |
| [superpowers-using-git-worktrees](/Users/max/.agents/skills/superpowers-using-git-worktrees/SKILL.md) | 采用项目约定或外部默认目录；先诊断、分类基线失败，复用已有同范围放行，但仍保留未解决基线失败须批准的明确要求。 |
| [superpowers-writing-plans](/Users/max/.agents/skills/superpowers-writing-plans/SKILL.md) | 复杂任务需要；按任务规模简化文档，不把保存计划后的执行方式询问变成已授权实施的停工点。 |
| [tdd-workflow](/Users/max/.agents/skills/tdd-workflow/SKILL.md) | 建议作为唯一 TDD 主入口；明确覆盖率范围与测试层级，保留必要业务回归和合并来的审批要求，不把所有微改都扩成全套 E2E。 |
| [deep-research](/Users/max/.agents/skills/deep-research/SKILL.md) | 研究任务有价值；依据已有信息决定是否澄清，工具发现后选可用检索方式，不强制重复询问或因单个 MCP 缺失停工。 |
| [save-to-obsidian](/Users/max/.agents/skills/save-to-obsidian/SKILL.md) | 包含你的专用笔记路径，具有个性化价值；触发不应扩展到所有文档，硬编码项目映射需核对，写入须有请求。 |
| [video-editing](/Users/max/.agents/skills/video-editing/SKILL.md) | 视频任务有用，但“Do not skip layers”会强制整套工具链；按交付选 FFmpeg/Remotion 等必要步骤即可。 |
| [visa-doc-translate](/Users/max/.agents/skills/visa-doc-translate/SKILL.md) | 翻译排版用途独特；第43行无条件添加 certified translation 声明不恰当，应仅在确有认证时标注，不能凭普通图片路径触发全流程。 |

依赖修复/内容承接：`configure-ecc`、`continuous-agent-loop`、`eval-harness`、`plankton-code-quality`、`prompt-optimizer`、`santa-method`、`superpowers-writing-skills`、`iterative-retrieval`。旧循环示例保存在 `continuous-agent-loop/references/legacy-loop-examples.md`，无新增 SKILL.md 入口；明确标注为历史参考。

## 批准边界

- 保留设计批准、书面方案批准、可视化 companion 同意、CK 初始化/保存/遗忘确认。
- 保留 TDD 例外批准（含原技能的原型、生成代码、配置文件例外），以及主分支实施同意、未解决的 worktree 基线失败放行。
- 保留第四次失败修复前的讨论、分支丢弃时输入 `discard`、破坏性操作和规则写入批准；独立审查要求和硬预算仍须遵守。
- 常规执行裁量有所增加：无需重复选择执行方式、默认 worktree 目录可按约定决定、普通故障先恢复、模糊条目不阻塞独立工作。已有批准仅在对象/内容/范围/副作用未变且无操作时重新确认要求时复用。
- 未授予新的对外发信、发布、生产修改、破坏性删除或绕过工具审批的权限；本次技能归档来自用户明确授权。

## 安装与升级

- 项目锁文件移除 8 个已归档技能；全局锁文件移除 `using-superpowers` 和空目录 `gsd-quick` 的旧条目。其他条目及上游哈希保留，未伪造自定义内容的上游校验值。
- 本机 Skills CLI 提供手动更新；本次没有运行任何上游更新或创建更新任务。此前检查未发现这些手动安装技能的自动更新任务。
- 直接修改的保留技能仍可能被后续升级/重装覆盖；这次的备份和差异补丁用于比较、选择性重施。全量重新安装上游包也可能重新引入已归档技能，更新锁文件不能阻止这种显式重装。
- 系统技能和插件技能不属于本次清理范围。当前任务已注入的旧技能列表不会即时消失；新建任务/重新加载后核对发现列表。

## 验证

- 本任务涉及的项目文件通过 `git diff --check`。
- 41 个修改技能通过官方 skill-creator quick_validate；将非标准顶层来源字段移入 metadata，并补齐 skill-stocktake 的 name。
- 12 项脚本行为检查通过：只统计入口、符号链接去重、空格路径、未知使用频率、只读扫描、mtime 不误判、资源/评估条件变化使缓存失效、删除检测、缓存替换及无效输入保护、规则目录扫描、CK 路径与语法。
- 实际扫描：项目 5、全局 149；28 份归档和原始备份哈希一致；113 个未修订保留技能哈希一致。
- 保留 SKILL.md 中无强制调用已归档入口的引用；旧循环名称仅剩迁移说明。此项不代表已验证全部按需技能的外部工具安装。
- 未运行项目业务测试：本次是技能文本、清单脚本与安装锁文件变更，已运行相应格式/脚本检查。
- 未完成独立代理行为实验（此前委派返回 429）；不把静态语义审阅或格式校验宣称为行为合规证明。
- 未设定硬预算；实际代理 token/费用遥测不可用，不报告虚构节省值。技能入口减少 15.4%；正文按需加载，不能把删除正文总量等同于每次任务的上下文节省。

## 恢复与审阅

- [恢复清单](/Users/max/.agents/skill-archive/20260911T032046Z-slide-cleanup/manifest.json)：源路径、原始备份、归档位置、删除的符号链接及锁条目、修改前后哈希。
- [全部文本差异补丁](/Users/max/.agents/skill-archive/20260911T032046Z-slide-cleanup/local-customizations.patch)：逐文件审阅本地修订。
- 原始目录备份：`/Users/max/.agents/skill-archive/20260911T032046Z-slide-cleanup/before/`；移出的完整目录：`/Users/max/.agents/skill-archive/20260911T032046Z-slide-cleanup/archived/`。
- 恢复某项时，按清单把对应归档复制回原路径；已有同名文件时先比较，不覆盖后续修改。恢复项目别名时使用清单记录的 link_target。
- 恢复修订项时从 before 选择单个文件比较恢复；锁文件只恢复对应条目，避免覆盖后来新增安装。恢复空目录可按清单逐个 mkdir；这不会补齐 GSD 缺失实现。
