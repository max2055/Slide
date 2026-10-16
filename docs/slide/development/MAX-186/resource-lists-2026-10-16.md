# MAX-186：三类资源列表反馈

## 当前范围与行为

对应 Max 评论 `01a144db-48fb-78bf-b9cd-b26d2c3da9fa` 的四项反馈，沿 PR196 原分支实现，基于默认蓝已整合的 `57a593cc`。

- 数据库、服务器、网络设备各保留搜索工具栏的一个“刷新”：先读取原资源列表端点，成功更新列表后通过刷新版本统一重读当前筛选/分页需要的 Metrics V2 存储及采集历史。资源 ID 和元数据不变也重读；不触发目标采集、连接测试或模型调用。列表和指标阶段共享加载/禁用状态，指标失败仍有行内重试及原状态区分。
- 列设置迁至搜索/筛选所在工具栏，移除表格上方额外操作行；窄屏沿共享 flex 规则换行。继续使用既有列偏好及原生弹窗焦点/Esc机制。服务器和网络设备刷新保留现有表格实例，避免丢失工具栏/列设置上下文。
- 网络设备名称复用数据库/服务器的 `btn-ghost`，默认文字色、hover、焦点及定制 palette 同源；不修改默认强调色或全局颜色策略。
- 主机标签为空、纯空白或与地址相同时，只显示地址；标签不同时保留标签＋地址。三类资源首列固定为“序号”，筛选后的结果从 1 连续编号，跨页延续，搜索变化返回第一页。序号是展示位置，不是资源 ID。

## 验证与交付边界

单测覆盖三页面统一刷新、未变列表仍重读指标、加载禁用与表格保留、按钮所在工具栏、主机去重、序号分页/搜索及固定列。浏览器验收使用任务自有 MySQL 33186、正式 Fastify 路由及真实登录/JWT，持久化合成资源，不伪造共享业务数据。检查列选择/恢复默认、键盘/Esc/焦点恢复、真实列表与指标请求、默认名称色、明暗/窄屏及无整页横向溢出。

正式服务夹具隔离并清理；Provider、binding、共享会话/数据库、SSH与目标采集均无新增操作，产品模型新增 0，原批次账本连续。

## 共享 5173 切换预览

本轮不自行切共享前端。只读核验：前端 PID66229、5173，cwd `/Users/max/Coding/40-Slide-max186-acceptance/frontend`，启动命令 `/opt/homebrew/bin/node .../frontend/node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173 --strictPort`，父 PID1，验收树干净，当前 HEAD `7c0f214d00932f616aff518668aa6cba31af5395`。既有 launchd 标识 `gui/501/com.slide.dev.frontend`，日志 `outputs/MAX-186/acceptance-runtime/frontend.log`；操作前仍须重新核验完整进程/日志身份及脏改。

拟更新范围只有该前端验收树与其既有服务，保留原树、日志和 plist；后端及数据不变。Chief 核定确切新 head 和既有授权后再切换；若出现脏改则先保护。最小回退为用同一服务句柄停止候选、干净树切回上述 7c0f214d、原 plist 启动。真实账号操作与业务验收由 Max 本人完成。PR 保持 draft、任务 in_review，不合并/done。


## 本轮结果

产品实现提交 `565c92ec`；后续交付文档不改变产品源码，受测文件哈希随附件。

- 前端全量 131 文件 / 1145 项通过（含本轮新增 4 项）；类型检查、build/CSP、contracts:check 及 lint 0 error 通过，lint 254 条既有 warning。
- 正式隔离服务浏览器测试 1 项通过，三页 × 四明暗/视口组合共 12 组（1920 浅、1440 暗、390 浅/暗）。实测三页名称均为共享 ghost 颜色、桌面列设置与搜索同行，三页仅一个刷新；逐组实际触发原列表端点与 Metrics V2 查询，未产生采集/测试/模型写请求。列选择、恢复默认、键盘 Enter/Esc 与焦点返回通过。
- 人工查看三页桌面原图及 390 暗色服务器原图：新增序号、名称色、主机去重及紧凑布局符合反馈。窄屏保留表格局部横向滚动，无整页溢出。分页/筛选重编号由共享组件 25 行 DOM 单测覆盖。
- 首轮全量仅两项旧源码测试因属性顺序失败：保留原资源类型属性顺序后全量通过，未削弱测试。首轮浏览器脚本以 native dialog 为祖先查找 slot 内容超时，改为通过 app-dialog host 查找，产品交互不变；最终完整 12 组通过。失败日志保留。
- 测试 API/Vite 进程退出 0，独立 schema 查询确认无残留，任务 MySQL 容器已移除。共享 5173/3000 未改动。上一 head 57a593cc 的实际完整 CI 已核 14/14（包括 release-artifact/ci-gate），不能继承为本轮新 head 结论。

复现：`pnpm --filter slide-frontend test`，`pnpm --filter slide-frontend typecheck`，`pnpm --filter slide-frontend build`，`pnpm contracts:check`，`pnpm lint`。任务自有 MySQL 33186 就绪后：`MAX186_ISOLATED_MYSQL=1 MAX186_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs/MAX-186/resource-feedback/service pnpm --filter slide-frontend exec playwright test --config playwright.max186.config.ts -g 'resource feedback'`。未变共享配色/全控件矩阵沿用上轮有效证据。
