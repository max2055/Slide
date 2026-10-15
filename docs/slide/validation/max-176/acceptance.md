# MAX-176 R1.1 三页交付验收

截至 2026-10-15，工具、会话、技能三页已完成本地功能、视觉和真实业务验收，提交 Chief 审核；未合并、未发布。旧工具检查点及当时的启动阻塞保留于 `tools-checkpoint-2026-10-15.md`，不再代表当前状态。

## 版本、范围与顺序

- base：main `c102f555a2eb486de0360f5034caf4766a8e9852`。
- 当前产品/测试提交：`723ad2e7e4565b64e87ae02116ce9836bce631a8`；工具最初实现 `871e7a5a`。后续报告提交仅增加文档，不改变受测代码。
- PR：https://github.com/max2055/Slide/pull/186 ，分支 `codex/max-176-agent-lists`。
- 产品变更仅三个专属视图：`agent-tools.ts`、`agent-sessions.ts`、`agent-skills.ts`。复用 app-card / app-data-table / app-dialog / app-badge / app-empty-state、共享按钮及主题 token。局部共用模式留在 tools 专属文件，未创建全站框架。
- 没有修改共享组件、全局样式/token、i18n、导航/render 或后端产品逻辑。另有本任务专属测试、隔离服务脚本及验收文档。
- 按代表先行执行：先在完整正式 API 上完成工具 6 组真实验收及 R1.1 视觉核对，再开始会话/技能推广；最终在全新临时库统一验收。
- 设计包为任务批准的 R1.1 附件 `01a13e28-de2a-771b-b9d1-00ef2e1c06bb`，SHA256 `112502a0ad6dbadc7eea35efda027ccfb079fed756bf0ed51956ac6fd71347fe`。

## 按验收项交付

| 验收 | 实现与证据 |
| --- | --- |
| 长描述、Schema、UUID、路径不主宰默认行高 | 工具/技能名称加两行用途摘要；会话可读名称加消息数/实际资源标识。label=key 或无标题用“未命名会话”。完整标识与原始字段在详情。受控长内容首行工具 <160px、会话/技能 <150px。 |
| 真实数据能力检索、稳定排序和分批浏览 | 三个 API 均返回完整授权清单，先全量检索/筛选/稳定排序再按6/12/24条分页。名称升降序；会话默认最近活跃，时间相同按完整key稳定排序，缺时间显示“未记录”。筛选/排序回首页；详情关闭保留筛选/页码。不存在的资源名称不伪造。 |
| 工具执行边界 | 只读/写入/执行/凭据/委派、审批、权限、ownerOnly、风险级别常显；未知和读写声明冲突单独说明。注册不代表可执行。Schema、完整描述、全部原始元数据详情可查。 |
| 完整消息 | 正式历史 API 使用 `paged=true&limit=100&before=` 游标；实际105条消息先读100、再读至105，最早消息0与最后长答复均验证。采用真实timestamp；结构化文本/思考以可读内容展示，其余结构和messageParts保留于原始字段；无 `[object Object]` / Invalid Date。失败可重试，尚有历史明确提示。 |
| 真实会话删除 | 保留确认/取消、完整URL编码、禁止重复提交、仅 `ok:true` 视作成功；浏览器实际删除后 GET 会话列表核对不存在。 |
| 技能真实启停 | 保留管理权限约束及后端权威校验；禁止重复提交，POST `ok:true` 后 GET 全量技能确认目标状态才提示成功。实际启停及独立API回读通过，随后恢复原状态。拒绝/未知回执、回读不一致、读取失败明确显示未确认；未授权不显示切换操作。路径、frontmatter、来源、digest、trusted 全文可查。 |
| 生命周期与状态 | 加载、失败、401/403、成功空态、筛选无结果独立。刷新/失权清旧数据，generation 阻止迟到回填；关闭会话清消息并使旧请求失效。加载更早历史遇失权清除旧消息/详情。技能启停遇登录失效不会再回读或恢复旧数据。 |
| 键盘及窄屏 | 三页每组视口/主题均用 Enter 打开详情，Esc 关闭并断言焦点回发起按钮。默认列表保留上下文。文档无横向溢出；表格采用局部横滚，长原始字段/路径/正文在弹窗内换行和滚动。 |

保留既有工具/技能扩展管理，在清单后方呈现；读取失败/失权时隐藏。扩展新增、编辑、发布、归档仍由原组件和服务处理，本次没有改其生命周期或重做验收范围。

## 真实环境与隔离证据

通过仓库正式 `init-db.ts` 全量迁移及正式 `server.ts` 启动完整 Fastify 服务，端口3176、Agent WS29776、前端5276，独立 AGENT_WORKSPACE。数据库连接仅从执行环境读取；不在源码/报告/截图保存真实凭据。测试 JWT/加密密钥随机生成。

脚本先独占创建 `slide_ui_max176_<PID>` 新库，再核对 `SELECT DATABASE()`；仅在该新库禁用迁移自带的6条无密钥种子 Provider。依据任务新增“隔离验收环境范围澄清”执行，未操作共享 Provider/数据库/服务，不添加真实密钥、不绕过产品启动校验。正式鉴权登录、真实权限、注册工具和加载技能均走实际 API；会话为落入临时库的14条验收fixture，其中一条105条消息，不是路由替换的假正常流。

最终运行：临时库 `slide_ui_max176_71147`，脚本PID71147 → 正式API PID71167 → 本任务 worktree `apps/db-ops-api` → 3176/29776；代码为上述产品提交。此前恢复库为 `slide_ui_max176_66587`。在停止前核对确切PID、父子关系、cwd与命令，只优雅停止本任务脚本及其子进程。

验收后脚本验证最终库已删除；独立 information_schema 查询两个本轮库均不存在。3176/29776/5276无监听，前端测试服务正常收回，没有运行中本地任务遗留。没有产品模型调用，模型预算使用量为0。

## 截图与视觉对照

最终附件包含96张PNG与 `manifest.json`；每张记录文件名、图像尺寸、视口宽度、主题、真实/受控来源、产品提交和SHA256。主题由浏览器实际 `html[data-theme-mode]` 断言，真实测试通过实际偏好 API 设置临时用户主题，避免把被服务偏好覆盖的浅色截图误标为深色。

| 文件模式 | 视口与主题 | 数据来源/核验 |
| --- | --- | --- |
| `{tools,sessions,skills}-{1440,768,390}-{light,dark}-real.png` | 各宽度 ×1000，明暗 | 完整真实服务的正常清单；工具38条，技能5条，会话初始14条 |
| `{tools,sessions,skills}-detail-{1440,768,390}-{light,dark}-real.png` | 同上 | 实际记录完整详情及键盘焦点 |
| `sessions-long-message-{1440,768,390}-{light,dark}-real.png` | 同上 | 真实存储的长答复，完整105条历史已加载 |
| `{tools,sessions,skills}-{1440,768,390}-{light,dark}-long-controlled.png` | 同上 | 明确受控的19条长数据，Schema/安全未知与冲突、长会话标题/完整key、长技能用途与路径 |
| `{tools,sessions,skills}-detail-{1440,768,390}-{light,dark}-long-controlled.png` | 同上 | 完整技术字段与长正文 |
| `skills-technical-{1440,768,390}-{light,dark}-long-controlled.png` | 同上 | 向下浏览完整长路径、来源、信任声明与digest |
| `{tools,sessions,skills}-{empty,loading,failed,forbidden}-390-light-controlled.png` | 390×950，浅色 | 受控特殊状态，明确区分无数据/读取中/503/403，不能替代真实正常流 |

逐页人工核对实际截图与批准包的 `tools-desktop.png`、`tools-390.png`、`tools-desktop-dark.png`、`P-C-tool-detail.png`、`sessions-desktop.png`、`skills-desktop.png` 以及原型 agents/agentTable/modal：

- 工具保持“名称与用途 / 适用范围 / 执行边界 / 详情”四列；真实安全信息较原型增加必要审批、权限与风险文字。
- 会话保持名称与摘要、状态、详情层级；为任务指定的最近活跃保留独立时间列，以及既有删除操作。没有把原型演示资源名称当成真实关联。
- 技能保持名称与用途、状态、详情；沿用真实启停按钮。长路径、技术配置全部下沉详情。
- 标题24px（窄屏22px）、区块16px、正文14px、辅助12px；内容密度、分页、摘要截断、明暗主题与详情行为一致。768/390px保留局部横滚，操作列可横向访问；弹窗固定在视口内，长正文内部滚动。
- 保留实际产品壳及“Agent能力 → 技能/工具”和设置会话入口，不移植原型演示侧栏、跨页标签或主题控件。主题配色由既有token决定。上述均为任务已确认的产品壳/真实内容适配，无另增功能。

## 最终本地 gate

- `pnpm --filter slide-frontend typecheck`：通过。
- `pnpm --filter slide-frontend test`：118文件 / 1026项全部通过；本任务9项覆盖全量分页检索、错误空态区分、失效竞态、历史游标/结构化内容、失权清历史、技能重复提交/回读不一致/权限与过期请求。
- `pnpm --filter slide-frontend build`：通过，生产CSP 2个脚本通过。既有大chunk/import提示保留，不扩展为无关优化。
- `pnpm --filter slide-frontend exec playwright test --config playwright.max176.config.ts`：全新临时库53/53通过（31.7秒）；每项断言没有浏览器pageerror。三页正常/长内容/三视口/明暗/四态、全文详情、检索/筛选/排序/分页/每页条数、Enter/Esc/焦点、真实消息分页/技能启停/会话删除。
- `node --check apps/db-ops-api/tests/max176-service.mjs`、`git diff --check`：通过。
- 没有公开契约或后端产品变更；未运行无关后端全量和发布/最终集成 gate。父任务仍需集成验收，不能由本地测试替代。

CI必须按最新PR head判定；旧head `028be97e`在本轮读取时完整11项通过，不能用于新head背书。最终推送后的实际CI状态和PR checks接续规则在原交付线程记录；不在本报告预先宣称新head CI通过。

## 复现

在隔离 worktree 按仓库声明的pnpm安装依赖。终端一设置 `MAX176_ENV_FILE` 指向环境已有DB配置，执行 `node apps/db-ops-api/tests/max176-service.mjs`；确认打印的临时库/PID和API就绪后，在终端二运行上述Playwright命令。测试自动管理前端5276，真实测试每批复用一次登录并通过正式偏好接口设置主题。结束后向本任务脚本确切PID发送SIGTERM，收集其退出和数据库删除验证；不要按端口强杀其他服务。特殊受控用例可独立用 `--grep controlled` 执行。

无本任务必要验收遗留项。PR交付审核，合并及部署由Chief既有门禁处理。
