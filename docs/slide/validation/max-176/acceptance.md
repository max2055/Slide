# MAX-176 R1.1 工具代表页阶段证据（未完成全任务）

状态：工具页实现与受控验证通过；真实服务正常流阻塞；会话/技能尚未推广。不可将本报告用于声明 MAX-176 业务验收完成或批准合并。

## 基线与范围

- base：main `c102f555a2eb486de0360f5034caf4766a8e9852`，fetch 后新建独立 worktree；分支 `codex/max-176-agent-lists`。
- 本次测试对应产品代码 commit：`871e7a5a22d1c22fe789813ebf377339b682c319`。报告提交只增加证据文档。
- 仅修改 `frontend/src/app/ui/views/agent-tools.ts` 产品文件；另外两个专属视图尚未修改。共享组件、全局 token、i18n、导航、应用 render、后端产品逻辑均未触达。
- 设计：任务已确认的 R1.1 附件 `01a13e28-de2a-771b-b9d1-00ef2e1c06bb`；对照 `evidence/tools-desktop.png`、`tools-390.png`、`tools-desktop-dark.png`、`P-C-tool-detail.png`。完整包 SHA256 为任务记录的 `112502a0ad6dbadc7eea35efda027ccfb079fed756bf0ed51956ac6fd71347fe`。

## 已实现

工具与用途合并为名称/两行摘要；列表显示适用范围、只读/写入/执行/凭据/委派边界、审批策略、权限条件、仅主 Agent 与声明的风险级别。没有安全声明明确显示未知；readOnly 与 security.effect 冲突时显示冲突，以安全策略为准。注册不等于授权可执行。

Schema、完整描述、全部原始工具数据在 app-dialog 中保留；名称和长内容不扩张默认行高。详情支持键盘进入、Esc 关闭并恢复发起按钮焦点。检索全量已返回清单后分页；名称稳定排序，6/12/24 条分页，筛选重置页码，关闭详情保留上下文。

加载、失败、401/403、成功空态、检索无结果独立；重新读取清除旧事实，过期请求和登录失效后的迟到响应不回填。现有扩展管理保留在列表后，读取失败/失权时隐藏。局部清单基类保存在专属 tools 文件，供后续两页推广使用，未新增全站框架。

## 视觉与交互证据

全部工具截图来源：Playwright 路由受控响应，19 条包含 1500 字描述、复杂 Schema、安全未知与冲突的数据。**这些不是实际注册工具的真实服务正常流。** 浏览器使用真实产品应用壳、组件与样式。

| 证据 | 视口 | 主题 | 数据 | 结论 |
| --- | --- | --- | --- | --- |
| `tools-{1440,768,390}-{light,dark}-long-controlled.png` | 1440/768/390 × 1000 | 浅/深 | 受控长内容 | 名称+用途、范围、执行边界、详情；无文档级横溢；表格局部横滚 |
| `tools-detail-{1440,768,390}-{light,dark}-long-controlled.png` | 同上 | 浅/深 | 受控长内容 | 全文/Schema 可查看；Enter/Esc/焦点恢复通过 |
| `tools-{empty,loading,failed,forbidden}-390-light-controlled.png` | 390 × 950 | 浅 | 受控状态 | 四态各自独立，不将失败显示为空态 |

实测断言：默认六行、长描述首行高度 <160px；第二页详情关闭后仍为第2页；检索第19条可跨全量命中且回第1页；只读筛选得到9条；无匹配时有专用空态。截图保留在本次 Multica 评论附件压缩包中，共16张。

与原型的适配：保留已有产品侧栏及“Agent 能力 → 工具”页内导航，不移植原型导航。标题24px（窄屏22px）、正文14px、辅助12px；表格两行用途适配真实长度。安全边界比原型增加审批和权限文字，这是任务要求保留的决策必要信息。窄屏沿原型使用表格局部横滚。现有扩展新增/编辑/发布/归档组件保留，放在注册工具清单之后，不改变生命周期。

**尚缺**：真实正常流截图及与实际工具注册信息的对照；会话和技能的逐页真实/长内容/窄屏/明暗/状态验收。

## 本地 checks

- `pnpm --filter slide-frontend typecheck`：通过。
- `pnpm --filter slide-frontend test`：118 个文件、1020 项测试通过（包含本任务新增3项生命周期测试）。
- `pnpm --filter slide-frontend build`：通过；CSP 2 个生产脚本通过。现有混用动态/静态 import 和大 chunk 提示不在本任务范围。
- `pnpm --filter slide-frontend exec playwright test --config playwright.max176.config.ts --grep 'tools controlled'`：10/10 通过；1440/768/390、明暗、长内容、四态、分页检索、键盘详情与焦点恢复。
- `git diff --check`：通过。
- 无公开契约修改；未进行全后端、发布或最终集成 gate。无产品模型调用（0），无 Provider/binding/采集写入。

## 真实服务阻塞与最小待确认项

实际启动当前 main 的完整 Fastify 服务，专属端口3176、Agent WS 29776，专属 `slide_ui_max176_<PID>` MySQL 数据库、独立 AGENT_WORKSPACE、临时随机 JWT/加密密钥。数据库凭据仅从环境读取，未写入源码或证据。

迁移初始化和会话测试数据落库成功；新库迁移种子带入了启用但无密钥的 Provider。真实服务报 `LLM_CREDENTIAL_NOT_CONFIGURED`，启动失败并退出；因此真实工具正常流用例失败（ECONNREFUSED），未标为通过。它是环境初始化问题，不是本次前端引入。

任务“当前集成与文件所有权契约”要求“专属服务/数据独立，不操作共享服务、Provider、binding或采集”。已请求确认：是否允许**仅禁用本任务临时数据库中迁移自带的无密钥 Provider**，不改共享数据库/Provider、不新增密钥、不调用模型；确认前不执行此变更。当前原始实现保留，可复现失败。

清理证据：本次临时库 `slide_ui_max176_58954` 在 information_schema 查询剩余数量为0；API 已退出；3176/29776 无监听；未停止或重启任何共享服务。没有后台任务遗留。

## 复现与接续

1. 离线安装依赖：`pnpm install --frozen-lockfile --offline`。
2. 受控用例可独立运行上述 Playwright 命令；Vite 自行占用5276并在结束时退出。
3. 完整真实服务脚本：通过 `MAX176_ENV_FILE` 指向执行环境已有后端环境文件，运行 `node apps/db-ops-api/tests/max176-service.mjs`；脚本只使用其中 DB 连接值，强制分配独立数据库/端口/workspace，其它测试安全密钥随机生成。默认仍复现未配置 Provider 的启动失败；不要用历史密钥解决。
4. 获最小环境例外后补真实工具正常流与设计对照；满足代表先行门禁后才推广 `agent-sessions.ts` 和 `agent-skills.ts`。会话需修正 timestamp/结构化 content、游标完整历史与竞态；技能需保留真实启停回读、错误/失权反馈。
5. 完成三页全部门禁后再转 ready PR/in_review 交 Chief；目前仅草稿检查点，禁止作为已交付全任务合并。
