> **历史审计提示（2026-10-15 更新）：** 本文保留 main `8bdd8a3c` 的审计事实。MAX-157 已通过 PR #170 合入，当前 main 为 `3ca5c6fb9357`；已完成范围已从 [后续完善方案](/Users/max/Coding/40-Slide/docs/slide/reviews/2026-10-15-ui-improvement-plan-after-max157.md) 的待办中剔除。当前去重范围与建单/原型策略以该方案为准。

# Slide 整体 UI 与美感设计审计

2026-10-15 · main `8bdd8a3c09ae` · 按已讨论的 UI 与美感标准复审

**整体判断：组件与主题基础较好，页面设计完成度不均；尚未达到“专业、清爽、克制，有细节和质感”的统一交付标准。** 主要差距在任务层级、页面构图与细节秩序。配色已相对协调，继续增加阴影、渐变或装饰不会解决当前主要问题。

本次整理 **12 个整体设计问题**（5 个高优先、7 个中优先），它们是跨页面设计主题，**不能与前次 22 个缺陷相加当成 34 个独立问题**。每项明确涉及页面、视觉原因、改进方向与验收条件。已批准的 MAX-157 方案继续作为基准，不重新更改方案、不重复建单。

## 证据与覆盖

- 代码基线：`8bdd8a3c09ae5d9f5e5436f6f26153bdcddb6737`；本轮确认 `frontend/src` 相对 HEAD 无差异，与前次审计版本相同。运行页面可见行为用于视觉判断，不将本地 HEAD 单独作为已部署版本证明。
- 复用前次 39 个顶层路由、29 个旧设置别名、17 个设置节点的盘点，保留 94 行覆盖清单；增加 7 行原先排除的 MAX-157 相关页面，合计 **101 行覆盖记录**。记录包含页签、别名、弹窗及受限项，并非 101 个独立完整验收的页面。
- 已复核前次 7 张总览联系图，并查看代表页面原图；复用 81 张桌面和 6 张窄屏截图及对应 DOM。另复核你提供的 6 张深色验收截图、R2 的 9 张代表截图。
- 你重新登录后，本轮补查 **14 个桌面视图**：关注事项、资源概览、AI 工作空间、数据库列表、数据库指标/日志、品牌、模型配置、源码仓库、Profiles、调查策略、有效预算、用量与成本、跨资源诊断。证据为截图与可见 DOM；源码快照另有滚动截屏。
- 本轮截图主要为 1702×986，部分 1696×983；前次为 1702×943，窄屏为 390×844。浅色、用户强调色为靛蓝；用户深色截图和原型的主题/视口/数据与实页不同，仅比较信息结构，不做逐像素优劣判断。
- 当前实页仍是原有布局：源码快照长清单、治理字段平铺、诊断各区纵向累积；导航仍为数据库→服务器→网络设备、“普通对话”、资源概览位于关注事项子页。说明已批准布局**尚未体现于当前运行页面**，不据此断言开发分支是否完成或任务最新状态。

完整范围、每行方法与限制见 [覆盖清单](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/coverage.md)；机器可读结果见 [审计数据](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/audit-data.json)。前次功能/可用性报告见 [前次 UI 审计](/Users/max/Coding/40-Slide/docs/slide/reviews/2026-10-15-ui-audit.md)。

## 按设计标准评价

评价是基于证据的定性判断，不给“美感”编造分数。较好表示有可复用基础，需统一表示局部成熟但系统性不足，明显不足表示已有清晰视觉/任务证据，证据不足表示不能判断完整体验。

| 维度 | 判断 | 主要证据与含义 |
| --- | --- | --- |
| 概览与调查的引导性 | 完成度不均 | 资源概览能把风险与状态并列；AI 工作空间空态焦点弱；诊断纵向堆叠，R2 已给出更清楚的工作区 |
| 指标与日志的效率 | 明显不足 | 大块公共调查空区在筛选/数据前占用首屏；数据查看与调查入口的权重没有分开 |
| 构图与主次关系 | 需统一 | 同等卡片、长字段和空区决定视觉重量；首屏没有稳定的“先看什么、再做什么” |
| 字体与阅读层级 | 需统一 | 字体体系存在，但同类标题、表头和技术文本的角色使用不统一 |
| 间距、对齐与内容宽度 | 需统一 | 设置限制宽度合理，但分组/共同轴线/页面节奏不统一；留白有时有焦点、有时只是空容器 |
| 配色、表面与图标 | 基础较好，应用需统一 | 中性色、语义色、线性图标与主题 token 可复用；问题在强调权重与重复容器，而非主色选择 |
| 表格、表单与内容细节 | 明显不足 | JSON/Hash/路径/AI 长文主导列表，模型长表单缺分层，品牌表单按字段拆卡 |
| 状态、响应式与交付韧性 | 状态不足；完整适配证据不足 | 关注事项异常与空态同时出现；六个移动样本不足以证明全站适配，真实填充/深色/权限等覆盖仍缺 |

## 值得保留的设计基础

主题 token 已覆盖字体、间距、圆角、状态色、焦点和动效；共享卡片、表格、字段、弹窗、空状态与徽章已经存在。建议先统一使用方式，保持 Lit 和现有组件，不更换框架或为了风格更换字体库。

资源概览的“风险队列＋运行状态分布＋采集质量”构图较好：异常有优先次序，证据入口与资源入口直接可达，未知/过期有独立表达。它可以作为概览页的参考；详细数据列表不必照搬概览卡片。

SQL 工作台保留编辑器、结构/历史与快捷操作的工具式布局，方向符合效率目标。浅色外壳中的深色代码编辑器有明确阅读用途，不作为主题混乱处理。当前未执行 SQL、查看有结果的完整工作流，不能宣称全部交互已通过。

R2 源码、治理和诊断原型的优势是摘要/详情分离、表格有浏览边界、标题和操作位置稳定、状态与下一步能一起读懂。优点来自信息组织和节奏；深色外观与示例数据不是生产完成度证据。

## 代表证据

![工作空间构图与日志空间分配](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/composition-board.jpg)

上图橙框为审计标注。左侧复用同版本截图以看清构图，右侧为本轮日志实页；重点是次要信息占用的空间，不依据过渡截图判断字体对比度。

![设置分组与技术字段问题](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/settings-board.jpg)

同版本设置实装：重复卡片不等于明确分组，整段 JSON 不等于有效摘要。

![源码实装与已批准设计基准](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/approved-direction-board.jpg)

左为用户验收截图，右为已批准 R2 **演示原型**。两者数据/尺寸不同，仅对照“长清单平铺”与“摘要＋按需浏览”的结构，不表示右侧已实装。

## 12 个整体设计问题

### VIS-01 · AI 工作空间空态缺少主视觉与起步路径（高优先）

**范围：** AI 工作空间；其他引导型空页面。

**观察：** 0 项调查时仍展示三列：左侧四个筛选字段，中间“选择一个调查”，右侧两块空成果；主要创建入口孤立在右上角。

**为什么显得粗糙：** 视觉重量落在无数据的筛选器和边栏，中间大面积留白没有承载任务引导。空白本身可以保留，但需要明确焦点。

**改进方向：** 没有调查时让主工作区承担起步说明和“创建手动调查”入口；筛选与空证据区域降级或按需出现。已有调查时保留导航、协作、证据三种职责。

**视觉验收：** 空列表与筛选无匹配分别表达；用户从首屏能找到起步操作及所需信息；已填充调查不牺牲证据和协作能力。

**证据：** [fresh-investigations](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-investigations.jpg) · [02-investigations](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/02-investigations.jpg)；源码：[investigations.ts:95](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:95) · [investigations.ts:120](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:120) · [investigation-detail.ts:21](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigation-detail.ts:21)。

**已有工作关系：** 整体构图补充；资源选择效率与原报告 UI-022 相关。不是 MAX-157 已批准的跨资源诊断布局。

### VIS-02 · 指标与日志的首屏被公共调查区占用（高优先）

**范围：** 数据库、服务器详情中的指标、日志及其他效率型页签。

**观察：** 数据库日志页在页签与筛选栏之前放置一个约 240px 高的“暂无可访问的调查”卡片；相同模块放在详情页公共外壳中。

**为什么显得粗糙：** 次要空信息占据首屏显著面积，工作区被上下切割；数据工具像被嵌在概览页底部，降低扫描效率。

**改进方向：** 把调查关系压缩为资源头部的数量/状态与入口，详情按需展开；效率页优先展示对象、时间范围、筛选与数据。资源概览可以保留更完整的调查摘要。

**视觉验收：** 1702px 桌面和窄屏下，进入指标/日志即能看到上下文和核心筛选；无调查不出现大空卡；有调查仍可追溯。

**证据：** [fresh-db-logs](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-db-logs.jpg) · [fresh-db-metrics](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-db-metrics.jpg) · [60-server-metrics](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/60-server-metrics.jpg)；源码：[instance-detail.ts:343](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/instance-detail.ts:343) · [server-detail.ts:413](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/server-detail.ts:413) · [resource-investigation-links.ts:49](/Users/max/Coding/40-Slide/frontend/src/app/ui/components/resource-investigation-links.ts:49)。

**已有工作关系：** 本轮新增的页面角色与空间分配结论；并非删除调查能力。

### VIS-03 · 技术字段和完整标识压过用户关心的摘要（高优先）

**范围：** Agent 工具/技能/会话；审批历史；源码及调查治理页。

**观察：** 工具表直接显示 metadata JSON；审批历史逐条显示完整 SQL、AI 说明和错误；Profiles 首屏铺 Hash、工具名及预算原值；源码展开显示大量路径。

**为什么显得粗糙：** 长文本决定行高和卡片高度，关键名称、状态、摘要与操作失去固定位置，整体像技术输出而不是工作台。

**改进方向：** 先展示名称/职责、状态、关键限制与摘要，完整 Hash、路径、参数、SQL、推理与原始结果放在可查找的详情中；保留复制和追溯能力。源码和治理页采用已批准 R2。

**视觉验收：** 主列表在长内容下仍可扫描比较；展开能读取完整内容；不会为了美观隐藏未知、失败或权限事实。

**证据：** [33-tools](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/33-tools.jpg) · [43-approval-history](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/43-approval-history.jpg) · [fresh-profiles](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-profiles.jpg) · [fresh-source-snapshot](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-source-snapshot.jpg)；源码：[agent-tools.ts:76](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/agent-tools.ts:76) · [investigation-profiles.ts:85](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigation-profiles.ts:85) · [source-manifest.ts:53](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/source-manifest.ts:53)。

**已有工作关系：** 汇总 UI-006/007/008/009/010；源码与治理页已归 MAX-157，不重复建单。

### VIS-04 · 标题与正文缺少统一的角色尺度（中优先）

**范围：** AI 工作空间、调查治理、平台状态、设置、自动化任务。

**观察：** 同为页面主标题，工作空间与治理页使用 18px，品牌/模型配置/平台自检使用 22px；定时任务表头为 10px，共享表头为 12px。

**为什么显得粗糙：** 相邻页面的重要性看起来随实现变化；小字号与长字段并列时，精致感变成拥挤感。Inter 和紧凑字号本身不是缺陷。

**改进方向：** 明确主标题、区块标题、表格正文、辅助信息、技术文本五种角色，再映射已有 token。先统一相同角色，不整体放大全部表格。

**视觉验收：** 相同页面角色有同一标题/行高/字重规则；关键内容清晰，辅助文本保持可读；长中文名称与数字不挤压主要操作。

**证据：** [fresh-investigations](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-investigations.jpg) · [fresh-branding](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-branding.jpg) · [08-cron](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/08-cron.jpg)；源码：[tokens.css:99](/Users/max/Coding/40-Slide/frontend/src/app/styles/tokens.css:99) · [investigations.ts:99](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:99) · [branding-settings.ts:29](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:29) · [cron-jobs-settings.ts:203](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/cron-jobs-settings.ts:203)。

**已有工作关系：** 本轮整体视觉一致性结论；未进行字体对比度测量。

### VIS-05 · 内容宽度与留白没有统一按任务分配（中优先）

**范围：** 平台自检、品牌/分析设置、模型配置、调查工作区。

**观察：** 品牌和平台自检限制到 800px 并靠左，模型详情内部限制 560px，其他页面铺满剩余宽度；留白位置与正文密度的变化较大。

**为什么显得粗糙：** 宽度限制对表单是合理的，但同类页缺少共同轴线和分组节奏，页面切换时主体位置与视觉重心漂移。

**改进方向：** 定义三种布局规则：概览/调查按主次区分配宽度；数据工作区利用可用宽度；设置表单限制阅读宽度、稳定对齐。大屏留白承载焦点，小屏按内容收拢。

**视觉验收：** 同类页面共享起始轴线与边距；长字段不会无限横向拉伸；窄屏不把主要操作挤出视区。布局差异能解释为任务差异。

**证据：** [fresh-branding](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-branding.jpg) · [fresh-providers](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-providers.jpg) · [12-health](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/12-health.jpg)；源码：[branding-settings.ts:27](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:27) · [health-center.ts:81](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/health-center.ts:81) · [llm-config.ts:201](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:201) · [settings-shell.ts:142](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/settings-shell.ts:142)。

**已有工作关系：** 整体布局规范补充；800px/560px 不是单独的缺陷证据。

### VIS-06 · 卡片按字段拆分，削弱分组与表面层级（中优先）

**范围：** 品牌设置、资源详情空区、调查治理、平台状态。

**观察：** 品牌四个输入各占一个带标题/分隔线/边框的卡片，卡片几乎贴在一起；调查空区和治理字段重复使用相近容器权重。

**为什么显得粗糙：** 重复边框和标题占据注意力，却没有增加业务分组；页面显得既空又碎，重要区块和辅助区块一样重。

**改进方向：** 卡片对应独立任务或信息组，同组输入放在一个分区内；组间靠留白和标题建立层级，组内用轻分隔。沿用现有共享组件及表面 token。

**视觉验收：** 每个独立容器都能说明其业务分组理由；同一表单的输入与保存位置明确；不会形成多重嵌套框。

**证据：** [fresh-branding](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-branding.jpg) · [fresh-budget](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-budget.jpg)；源码：[branding-settings.ts:168](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:168) · [branding-settings.ts:181](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:181) · [branding-settings.ts:193](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:193) · [branding-settings.ts:206](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/branding-settings.ts:206)。

**已有工作关系：** 本轮美感问题；不同于“共享组件不能使用”的判断。

### VIS-07 · 表格细节缺少统一的扫描和操作秩序（中优先）

**范围：** 资源列表、自动化任务、Agent 表格、审计/权限/报表列表。

**观察：** 数据库每行并列详情/编辑/测试/删除；定时任务使用专用小字号布局；工具长元数据导致不等行高。各处列表边界和详情入口处理不同。

**为什么显得粗糙：** 操作重复占宽，主要列被压缩；长文本与数字无法形成稳定扫描节奏。紧凑密度可以保留，但需有秩序。

**改进方向：** 统一名称/状态/时间/数值/操作列的规则；数字按比较需求对齐并采用等宽数字；低频操作可收纳，常用操作直接可达；长列表使用符合现有接口的分页或受控浏览。

**视觉验收：** 典型长名称和多行数据下可快速比较；详情明确可达；表格局部滚动不带动整页溢出；不把高频操作强制藏到多层菜单。

**证据：** [fresh-databases](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-databases.jpg) · [08-cron](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/08-cron.jpg) · [33-tools](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/33-tools.jpg) · [m-33-tools](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/m-33-tools.jpg)；源码：[app-data-table.ts:83](/Users/max/Coding/40-Slide/frontend/src/app/ui/components/app-data-table.ts:83) · [cron-jobs-settings.ts:203](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/cron-jobs-settings.ts:203) · [cron-jobs-settings.ts:220](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/cron-jobs-settings.ts:220)。

**已有工作关系：** 视觉规则补充；长列表缺少边界沿用 UI-010。数据库大小说明去冗余已在 MAX-157。

### VIS-08 · 设置表单没有把基础配置与高级配置分层（高优先）

**范围：** 模型配置；长配置表单与复杂资源编辑。

**观察：** 模型配置首屏同时出现连接信息、兼容格式、供应商参数目录、模型选择、上下文和输出上限，后续又逐模型重复高级字段，保存操作位于长表单尾部。

**为什么显得粗糙：** 页面一直以相近字号和权重追加字段，缺少完成一个配置任务的停顿点与明确提交区域。

**改进方向：** 按连接设置、模型管理、高级参数分组；列表管理模型、详情编辑单个模型；保持标签与帮助文案对齐，验证与保存反馈靠近相关操作。

**视觉验收：** 用户可完成基础连接配置而不逐项阅读全部高级参数；高级设置完整可达；新增/编辑/错误/未保存状态均有明确反馈。

**证据：** [fresh-providers](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-providers.jpg) · [m-20-model-providers](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/m-20-model-providers.jpg)；源码：[llm-config.ts:765](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:765) · [llm-config.ts:800](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:800) · [llm-config.ts:853](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:853) · [llm-config.ts:874](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:874) · [llm-config.ts:940](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/llm-config.ts:940)。

**已有工作关系：** 对应 UI-013；仅审阅表单布局，未保存或测试模型连接。

### VIS-09 · 主色、状态色与按钮权重的使用不够一致（中优先）

**范围：** 资源详情、筛选、平台状态、调查与治理。

**观察：** 数据库详情刷新与一键诊断采用描边；服务器详情刷新采用 primary；列表选中筛选和创建操作也使用较强填充。不同页面对类似行为的权重表达不同。

**为什么显得粗糙：** 基础中性色协调，但强调色有时标选择、有时标常规刷新，视觉焦点跟随组件实现而不是当前任务。

**改进方向：** 主操作、次要操作、选中态、状态提示分别定义样式规则；品牌色用于操作和选择，语义色表达状态，且搭配文字。保留用户自选主色，不强制改品牌色。

**视觉验收：** 每个工作区的主要操作一眼可辨；刷新等同类操作权重一致；未知不显示为健康；浅色、深色、用户强调色下状态仍可辨认。

**证据：** [fresh-db-logs](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-db-logs.jpg) · [60-server-metrics](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/60-server-metrics.jpg) · [68-dashboard](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/68-dashboard.jpg)；源码：[instance-detail.ts:332](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/instance-detail.ts:332) · [instance-detail.ts:336](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/instance-detail.ts:336) · [server-detail.ts:407](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/server-detail.ts:407) · [tokens.css:144](/Users/max/Coding/40-Slide/frontend/src/app/styles/tokens.css:144)。

**已有工作关系：** 本轮一致性结论；#6366f1 是用户主题，不是品牌违规。

### VIS-10 · 失败、未知和空结果没有形成统一的可信状态设计（高优先）

**范围：** 关注事项、通知、慢查询、观测、资源健康、登录。

**观察：** 本轮关注事项仍同时显示排序异常与“暂无关注事项”；之前通知 503 后显示空队列，慢查询无记录被解释为运行良好。部分资源页面刷新提示与真实观测时间分离不足。

**为什么显得粗糙：** 状态是运维产品的视觉核心。错误像临时文本、主区像正常空页时，界面既不完整又容易误判；额外装饰不能修复这个问题。

**改进方向：** 在主体区域区分读取失败、权限受限、成功空、未配置、未知、过期和部分完成；保留最后成功数据/观测时间及合理下一步。不能以绿色或成功文案替代证据。

**视觉验收：** 错误提示消失后仍能辨认失败；只有成功空返回才显示空状态；未知与过期不计为健康；执行完成与恢复确认分别表达。

**证据：** [fresh-attention](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-attention.jpg) · [39-event-notifications](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/39-event-notifications.jpg) · [fresh-diagnosis](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-diagnosis.jpg)；源码：[investigations.ts:150](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:150) · [investigations.ts:183](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:183) · [investigations.ts:185](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:185) · [platform-observations.ts:26](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/platform-observations.ts:26) · [login-gate.ts:19](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/login-gate.ts:19)。

**已有工作关系：** 沿用 UI-001/002/003/004/005/015/020 的根因与验收，不重复计算新缺陷。本轮只重新确认关注事项异常；其余故障不宣称全部重新复现。

### VIS-11 · 产品文案、单位与技术命名缺少一套编辑规则（中优先）

**范围：** 治理、Agent、指标、资源页签、面包屑、旧兼容页面。

**观察：** 当前面包屑出现 AI Workspace / Resource Diagnosis / Settings，而页面主体为中文；Profiles、Reservation、Run、原始指标名与完整毫秒/micro 值混排。

**为什么显得粗糙：** 语言切换与内部命名抢占视觉空间，削弱同一产品的完整感；数字没有单位层次时显得像变量值。

**改进方向：** 建立中文用户术语与保留英文术语的映射；主区用可读时间、容量、金额与千分位，精确原值放详情；按数据来源保留定义与不确定性。

**视觉验收：** 名称在导航/标题/详情中一致；界面语言统一；单位与统计口径能按需核对；金额、币种、缓存输入等含义不会因格式化改变。

**证据：** [fresh-budget](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-budget.jpg) · [fresh-usage](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-usage.jpg) · [fresh-diagnosis](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-diagnosis.jpg)；源码：[investigation-governance.ts:15](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigation-governance.ts:15) · [investigation-detail.ts:37](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigation-detail.ts:37) · [investigation-detail.ts:64](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigation-detail.ts:64)。

**已有工作关系：** 归纳 UI-012/018/019；普通对话改名和治理格式化已在 MAX-157。不能去掉必要技术字段。

### VIS-12 · 窄屏、主题与长内容适配缺少完整的视觉验收闭环（中优先）

**范围：** 全局交付；重点是宽表格、长表单、文档及详情弹窗。

**观察：** 已有六个移动截图和共享外壳收拢逻辑；工具表在 390px 首屏仅能看到前几列，长说明占较高行数。文档和多种已填充/权限/冲突状态缺少实测证据。

**为什么显得粗糙：** 能够缩小不等于窄屏有重点；用户看不到操作位置或要横向寻找核心内容时，桌面的秩序未延续。

**改进方向：** 窄屏优先保留对象/状态/主要操作，再在表格内部滚动查看次要列；长表单分组。把真实长内容、明暗主题、异常状态与键盘使用纳入逐页对照。

**视觉验收：** 按页面角色覆盖宽屏、常用桌面与 390px；明暗/用户强调色、长文本、足量列表和适用状态有截图及操作证据；无需所有数据表改成卡片。

**证据：** [m-33-tools](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/m-33-tools.jpg) · [m-20-model-providers](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/previous/m-20-model-providers.jpg) · [10-budget-light](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/prototype/10-budget-light.jpg)；源码：[settings-shell.ts:173](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/settings-shell.ts:173) · [investigations.ts:113](/Users/max/Coding/40-Slide/frontend/src/app/ui/views/investigations.ts:113) · [AGENTS.md:45](/Users/max/Coding/40-Slide/frontend/AGENTS.md:45)。

**已有工作关系：** 归纳 UI-011/017/021；本轮未新增全站移动/深色或键盘测试，不据截图宣称 WCAG 通过。

## 全产品页面族评价

下表是整体设计判断；完整路由、页签、兼容入口、弹窗范围保留在覆盖清单中。较好不表示整个业务流程已验收，受限项也不自动记为 UI 缺陷。数字为前次证据文件编号。

| 页面族 | 判断 | 主要设计处理 | 证据/限制 |
| --- | --- | --- | --- |
| 全局外壳与导航 | 需统一；已有确定修复 | 分组和选中态已有基础；顺序、归组、对话命名沿用 MAX-157，语言与操作权重需统一 | 本轮全部视图＋源码 |
| 关注事项 / 资源概览 | 概览较好；关注事项状态不足 | 风险主次可保留；关注事项异常后空态本轮复现，应先修正可信表达 | fresh-attention / fresh-dashboard；原 UI-001 |
| AI 工作空间 | 明显不足 | 空态三列缺主焦点；资源过滤依赖内部 ID；已填充调查需后续真实对照 | fresh-investigations＋源码 |
| 对话 | 证据不足 | 只有连接中断/空视图；正常对话、附件、工具输出的完整视觉体验未复核 | 03-chat＋源码；名称归 MAX-157 |
| 数据库 / 服务器 / 网络设备列表 | 需统一 | 紧凑表格方向正确；说明、状态、操作和浏览边界需一致；数据库大小说明归 MAX-157 | fresh-databases；04/05；用户截图；网络为空 |
| 数据库概览 / 指标 / 容量 / 健康 | 明显不足或实测受限 | 公共调查空区挤占；概览与指标职责重叠；容量为空、历史评分不代表当前健康 | fresh-db-metrics；45/47/49/51＋源码 |
| 数据库慢查询 / 会话 / 查询分析 | 状态需修正；填充布局证据不足 | 缺数据不能等于健康；需要保留真实采集/失败含义，再调整效率布局 | 48/50/56；UI-003 |
| 数据库日志 | 效率明显不足 | 保留筛选、局部展开、分页；压缩公共调查空区，统一日志统计/级别/时间与操作 | fresh-db-logs＋源码；当前为空 |
| 表结构 / 索引 / SQL 审核 / 诊断历史 | 需统一 | 控制长列表与技术详情；SQL 历史字段缺失和枚举需说明；完整详情尚未实测 | 52–54/57/78/79＋源码 |
| 服务器详情各页签 | 需统一；正常数据证据不足 | 指标前公共空区；多数诊断/网络/进程/服务/日志为失败态，不能评价填充质量 | 58–67＋源码 |
| 网络设备详情与备份 | 证据不足 | 无纳管设备；页签职责重复有源码证据，真实接口/关联/备份布局未验证 | 80＋源码；UI-014 |
| 跨资源诊断 / 规则 / 判断 / 恢复 | 明显不足；已有批准方案 | 结论、不确定性和下一步有正确内容基础，分区与复杂内容需按 R2 收敛 | fresh-diagnosis＋源码＋R2；未提交任何操作 |
| SQL 工作台 | 方向较好；结果态受限 | 编辑器是明确工作区，优先保留工具效率；空数据不能证明结果/历史/快捷键完整体验 | 07-sql＋源码 |
| 事件中心 / 规则与策略 | 列表基础可保留；状态需修正 | 表格清晰但严重度归一、失败与空态、规则长内容和状态文字需要统一 | 06/37–40/69–72；UI-002/004 |
| 审批与审计 | 审计列表较好；审批历史明显不足 | 审计有筛选和列表；审批 SQL/AI 长文应先摘要再详情，不全量展开 | 10/11/41/43；UI-009/018 |
| 自动化任务 / 报表 / 问题反馈 | 需统一；详情部分受限 | 字号与操作密度不同；报表长列表边界不足；反馈为空态，未验证提交流程 | 08/09/13＋源码 |
| 平台自检 / 平台观测 | 完成度不均 | 自检有汇总和失败优先；观测仍像调试输出；统一摘要、资源名称与可查详情 | 12/42＋源码；UI-015 |
| 品牌 / 外观 / 通知 / 登录安全 | 需统一 | 品牌字段拆卡；外观已有 token；通知与登录需要清晰状态和可访问标签 | fresh-branding；16/17/26/36＋源码 |
| 模型配置 / 场景 / 提示词 / 分析策略 | 长表单明显不足；其余需统一 | 基础/高级分层，提示词版本内容按需查看，评分单位统一；不评估模型质量 | fresh-providers；19/21/27/32＋源码 |
| Agent 会话 / 技能 / 工具 / 执行安全 | 技术列表明显不足；安全分组可保留 | ID/路径/JSON 下沉，状态翻译，安全规则继续保留真实只读/权限边界 | 22–24/28/33＋移动样本＋源码 |
| Profiles / 调查策略 / 有效预算 / 用量 | 明显不足；已有批准方案 | 按职责、状态、限制、结算摘要组织；未知/冻结未初始化不得伪装成零或一致 | fresh-profiles/policies/budget/usage＋R2 |
| 源码仓库 / 快照 | 明显不足；已有批准方案 | 摘要＋独立分页明细；签名/完整摘要按需查看；仍保留未验证部署一致性 | fresh-source/snapshot＋用户截图＋R2 |
| 用户 / 角色 / 权限 | 列表基础可保留；细节需统一 | 权限目录浏览边界、详情与编辑标签规则；权限修改和键盘流程未操作 | 25/34/35＋源码 |
| 文档与旧兼容路由 | 受限；存在已确认问题 | 文档截图加载不能判最终美感；/config 和 /llm-usage 空白；旧 Gateway 英文/空数据需明确定位 | 44/73–79＋源码；UI-016/017 |
| 登录 | 布局需后续复核；文案已确认问题 | 密码“可选”与必填矛盾；主要操作“连接”与登录目标不一致 | 本轮登录 DOM＋源码；UI-020；未验证认证流 |

## 如何统一而不损失效率

| 页面角色 | 首屏顺序 | 视觉重点 | 详情处理 |
| --- | --- | --- | --- |
| 概览 | 范围/时效 → 关键状态 → 优先风险 → 下一步 | 状态与优先次序；主次区有明确比重 | 证据、全量清单和技术口径按需查看 |
| 调查 | 对象/目标 → 当前结论或执行状态 → 证据/缺口 → 下一步 | 结论可信度与后续行动；空态明确起步 | 消息、原始证据、判断、恢复保留独立职责 |
| 指标/日志/SQL | 对象/时间 → 筛选/操作 → 图表/表格/编辑器 | 数据比较、扫描与连续操作；上下文紧凑 | 原值、日志全文、查询详情局部展开，不阻挡工作区 |
| 设置/治理 | 当前状态 → 按任务分组 → 关键限制 → 提交或查看 | 标签对齐、阅读宽度、基础/高级区分 | 参数、Hash、配置来源和精确值进入详情 |

美感落到可核对的设计规则：标题角色一致；主要操作稳定；外边距、组间距和组内间距各有层级；同类数字/状态/表格对齐；容器对应业务分组；语义色与文字共同表达。运营工具的识别度可以来自这些细节，而无需大幅插画、纹理背景或夸张动效。

## 建议处理顺序与验收门槛

1. **先修可信状态。** 沿用原报告高优先问题，先解决异常后空态、无数据推断健康、严重度与观测时效问题。UI 美感不能盖住错误事实。
2. **完成 MAX-157 已批准方案。** 当前运行页面尚未体现 R2。开发交付需要同版本真实数据对照，保留原型的信息层级、操作位置、详情与分页行为；主题和真实数据适配不等于另做一个字段清单。
3. **先改两个代表页。** 引导型以 AI 工作空间为空/有数据两种情况，效率型以数据库日志/指标为代表。先把主次关系、公共调查入口和工作区处理好，再推广到同族页面。
4. **再统一设置和列表细节。** 模型表单、品牌设置、Agent 清单、审批历史按任务分组；统一标题、表格列、单位、常用/低频操作规则。复用现有 token 和组件。
5. **逐页留下视觉证据。** 对照当前代码、设计版本、视口、主题和数据情况；覆盖适用的正常、空、加载、失败、权限、未知/过期/部分/冲突及长内容。先修实质偏差再标完成。

建议以“能完成任务、能辨明状态、主次稳定、细节一致、长内容与主题适配”五项判定交付。截图对照检查构图、文字角色、间距、操作位置与数据浏览；业务流验证功能；键盘与权限验证可达性。三类证据分别记录，构建或接口 200 不能替代视觉和业务验收。

## 本次没有证明的内容

本次不包括全站写操作、模型运行、SQL 执行、即时采集、配置/权限保存、通知重放或恢复确认。未测量 WCAG 对比度、Web Vitals 或动效舒适性，不给出相关通过结论。动画/加载过渡截图只用于布局并结合源码/DOM，不能作为低对比度缺陷证据。

真实已填充调查、正常对话/工具结果、网络设备详情、已填充日志/查询分析/容量趋势、各种弹窗键盘行为和全站深色/窄屏仍有覆盖缺口。R2 特殊状态是演示数据，只能验证设计基准，不能证明后端已支持或真实链路通过。前次截图上残留的通知 503 toast 不归因于后续页面。

本次仅产生审计文件和证据，没有修改产品代码、业务配置或 Multica 状态。工作区已有规则及其他未提交变更保留。后续任务应引用本报告与 R2 可访问文件，避免只依赖聊天描述。

## 交付文件

- [完整覆盖清单（101 行）](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/coverage.md)
- [结构化审计结果及当前截图尺寸](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/audit-data.json)
- [本轮浏览器证据索引](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/evidence/fresh-index.json)
- [R2 设计说明副本](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/approved-DESIGN-r2.md)
- [离线 HTML 报告](/Users/max/Coding/40-Slide/outputs/overall-ui-visual-audit-2026-10-15/report.html)（可用本地查看器打开；无需启动服务）

证据包包含前次截图/DOM、本轮截图/DOM、用户验收截图、9 张原型参考及审计标注；原型明确标为演示。无新增独立任务或 PR。
