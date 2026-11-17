# Palantir AIP 研究与 Slide V3 应用

2026-11-17；负责人 15-FrontendDev-01。本轮基准 `cae5297c20f8fb41e8a0c3fa4a2e0830909aef20`，原分支追加提交。研究和原型供 Max 确认，不实施产品，不改变 API 或权限。研究使用公开官方资料，没有登录 AIP 租户，不宣称验证了其真实业务行为。

核心判断：值得学习的是**围绕对象、证据与受控行动组织工作空间**，而非复制黑色背景。下列浅色 Analyst、深色业务应用与浅色 Logic 编辑器是不同界面；官网大字、视频包装也不能当作产品的统一设计规范。V3 是对这些具体样本的适配，不是 Palantir 官方设计系统或像素复刻。

[新版原型](concept.html) · [V2/V3 同尺寸对照](compare.html) · [来源与视频校验信息](sources.json) · [验证](VALIDATION.md)

## 实际查阅来源

| 编号与官方来源 | 实际查看的证据 | 提供的依据及边界 |
|---|---|---|
| S1 [AIP Analyst Overview](https://www.palantir.com/docs/foundry/aip-analyst/overview) | [官方汇总界面原图](https://www.palantir.com/docs/resources/foundry/aip-analyst/aip-analyst-workflow-3.png)；[本次存档](references/workflow-3.png) | 浅色操作界面。工具内容、结论、表格与就近来源入口可连续阅读；对象信息和限制说明没有被抽象成孤立大指标。不据截图推断真实权限或内部数据模型。 |
| S2 [Using AIP Analyst](https://www.palantir.com/docs/foundry/aip-analyst/using-aip-analyst) | Context、Compact view、Outline/Graph 章节；[官方 Outline 原图](https://www.palantir.com/docs/resources/foundry/aip-analyst/aip-analyst-outline.png)；[本次存档](references/outline.png) | 窄工具区、稳定上下文、可展开过程与来源追溯。采用渐进展开和对象上下文；不为 Slide 新建分析图、分支会话、工具配置器或 token 面板。文字与图像均已读取；真实浏览器打开此文档曾超时，不冒称交互试用了文档所述功能。 |
| S3 [AIP Analyst Capabilities / Actions](https://www.palantir.com/docs/foundry/aip-analyst/capabilities#actions) | 官方操作说明 | 文档区分行动元数据与执行，说明通常需批准，也存在配置自动提交的例外。Slide 沿用自己的独立审批及显式执行，不导入该例外，不把可见操作当作授权。 |
| S4 [AIP 官方产品页](https://www.palantir.com/platforms/aip/)中的 ai-app 演示 | 从页面 video.currentSrc 核对 [官方原片](https://videos.ctfassets.net/xrfr7uokpv1b/3i5t2rIzKAgpGzHP57Ifdf/a5aeadd92cfd4598019770b6656b139a/ai-app.mp4)，下载原始字节后在 Edge 检视 00:00/00:08/00:16/00:22 | 业务操作界面演示，非官网排版本身。对象列表、属性与提案操作同屏，细边界明确功能区域。未登录操作；不能由演示里的计数和按钮断言 Slide 也有这些数据或能力。 |
| S5 同一官方页中的 action-driven-logic 演示 | [官方原片](https://videos.ctfassets.net/xrfr7uokpv1b/6HuTeCsMfrno2wJ53Wj66Z/d14aa29f633d50d7a851a5c0b06430eb/action-driven-logic.mp4)，查看 00:00 并播放至约 00:06 | 浅色构建器：紧凑标题栏、细边界、局部蓝色焦点。只借鉴边界和密度，不将提示词编辑器、工作流画布和构建器能力放入运维首页。 |
| S6 [AIP 官方产品页](https://www.palantir.com/platforms/aip/)首屏 | 实际浏览并[截图](references/aip-marketing.png)；该图含网站 cookie 提示 | 官网展示依据：大尺度 AIP 字样、电影式背景和透明导航。只说明品牌展示与产品工作区不同，不把该英雄区变成 Slide 首页，不据其推导暗色主题要求。 |

图片版权归 Palantir；存档仅作为本次设计分析证据，未用作 Slide 产品素材。MP4 不进入代码仓库或原型依赖；原片链接、时长、大小与 SHA256 保存在 sources.json。

### 视频时间点：相对各原片起点

| 原片与时间 | 已查看画面 | 采用/不采用 |
|---|---|---|
| ai-app，23.857143 秒；[00:00](https://videos.ctfassets.net/xrfr7uokpv1b/3i5t2rIzKAgpGzHP57Ifdf/a5aeadd92cfd4598019770b6656b139a/ai-app.mp4#t=0) | [画面](references/ai-app-0s.png)：地图、对象列表、Review proposal，以及 Accept/Modify/Explain/Show Logic 就近呈现 | 采用对象到建议的上下文连续性；不复制地图、指标或直接接受行动 |
| 同片 [00:08](https://videos.ctfassets.net/xrfr7uokpv1b/3i5t2rIzKAgpGzHP57Ifdf/a5aeadd92cfd4598019770b6656b139a/ai-app.mp4#t=8) | [画面](references/ai-app-8s.png)：地图视野变化，列表与提案区域保持同屏 | 采用稳定区域边界；不增加可拖动多窗布局 |
| 同片 [00:16](https://videos.ctfassets.net/xrfr7uokpv1b/3i5t2rIzKAgpGzHP57Ifdf/a5aeadd92cfd4598019770b6656b139a/ai-app.mp4#t=16) | [画面](references/ai-app-16s.png)：提案属性和局部地图可见，左侧对象全局上下文仍在 | 详情保留来源、目标、有效期及流程阶段；不复制地理可视化 |
| 同片 [00:22](https://videos.ctfassets.net/xrfr7uokpv1b/3i5t2rIzKAgpGzHP57Ifdf/a5aeadd92cfd4598019770b6656b139a/ai-app.mp4#t=22) | [画面](references/ai-app-22s.png)：提案对象字段变化，操作位置稳定 | 操作依附当前对象与版本；不能从采样帧推断真实权限或操作执行结果 |
| action-driven-logic，30.021995 秒；[00:00](https://videos.ctfassets.net/xrfr7uokpv1b/6HuTeCsMfrno2wJ53Wj66Z/d14aa29f633d50d7a851a5c0b06430eb/action-driven-logic.mp4#t=0)、[约 00:06](https://videos.ctfassets.net/xrfr7uokpv1b/6HuTeCsMfrno2wJ53Wj66Z/d14aa29f633d50d7a851a5c0b06430eb/action-driven-logic.mp4#t=6) | [起点](references/action-driven-logic-0s.png)、[实播到 6.024371 秒](references/action-driven-logic-played.png)：浅色编辑器内输入内容，工具和输出配置有紧凑边界 | 证明样本存在不同浅/深界面；不引入构建器 |

以上是已观察的片段与关键帧，不声称看完整套 AIP 演示或验证其后端。第二片直接定位时间曾超时，改为从起点播放至 6 秒后截图；未把未取到的 10/15 秒画面作为依据。官网初次字体加载导致截图超时，随后成功；这些是采集环境问题，不转化为产品结论。

## 从来源到 Slide 的具体设计改动

| 维度 | 观察与推断 | V3 对应落点 | 适配取舍 |
|---|---|---|---|
| 布局密度 | S4 对象、属性、操作在稳定区域内；S5 构建器工具栏紧凑 | 首页变为对象上下文 / 结论依据建议 / 读取入口三列，顶栏从 58px 收为 46px；详情使用对象上下文栏及完整内容区 | 这些尺寸是 Slide 选择，未声称来自 Palantir CSS。保持完整详情页，不引入首页侧栏预览的第二路径 |
| 字体层级 | S1 结果与表格正文承担业务阅读，辅助工具不成为巨型标题 | 首页结论 19px，建议 14px，来源 13px、依据/时间 12px；详情结论 26px（1366 时 24px）、建议 16px | 改善 V2 的 11px 辅助字可读性；保持系统中文字体，等宽字只用于引用号，不换品牌字体 |
| 配色 | S1/S5 浅色，S4 深色，不能概括为全平台暗色 | 保留 Slide 浅色、冷蓝 --accent；中性底分区，失败红/未知棕配合明确文字 | 不复制紫色品牌、暗色、发光、地图或官网视频背景；色彩不表达不存在的严重级别 |
| 边界 | S2/S4 通过功能区边线定位，而不是每个信息都套卡 | 连续白色工作面、1px 横纵边界、小圆角操作；取消大块建议底色，建议保留冷蓝文字 | 左侧对象区是内容上下文，不是新导航，不增加装饰网格或嵌套卡片 |
| 对象上下文 | S4 审阅提案时仍能读取对象属性 | 详情固定读取来源调查、目标、影响、有效期和阶段；A2/H1 保留真实可识别的演示名称 | 不构造新 Ontology，不增加对象关系接口；仅行动用户仍不能看无权来源摘要 |
| 结论—证据—建议—行动 | S1 来源邻近结论，S2 可追溯过程，S4 提案与操作相邻 | 首页结论下新增依据摘要和 [1] 入口，定位同对象详情 #evidence；详情列出引用/来源/支持内容与限制，右侧为建议和禁用主操作 | 这是本次设计综合，不是 AIP 唯一固定流程。无可信证据时明确未知，建议补证据，不伪造报告、置信度或自动行动 |

## 继承的边界

每调查一个当前下一步，仅 open/waiting；完整调查/行动入口始终保留。A2 和关闭调查 H 的授权历史 H1 可发现，H1 过期只读；各类型独立分页，不提供全域总数、等待时长或严重级别。来源标题和“调查更新”属于调查，A=15:20；计划列表 A1/A2=15:42/15:46 属于计划，H1 无可靠时间显示未提供。

首页目标/结论/依据/建议仍是明确标记的演示摘要，最小只读摘要契约待前后端确认；不无限 N+1、不由标题/时间推断诊断。引用 [1]/[2] 是原型内的说明编号，不是已建设的引用服务或真实报告读取。正式实现须绑定调查/计划版本、哈希、执行与报告引用；不能把上一轮报告移给新动作。

仅行动权限身份保留授权行动列表降级，不发 attention、不显示无权调查摘要。原型为双权限演示；真实四身份、撤权、旧链接、安全 returnTo、审批执行和返回上下文/焦点恢复仍按前轮验收，不把布局迁移当权限变更。

V3 只交付设计原型、来源与验证证据。未连接 API、没有模型调用或发布；研究和自检不代替 Chief 安排的独立复审，也不代表 Max 已确认视觉偏好。
