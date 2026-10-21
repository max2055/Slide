# MAX-222 遗留修复与业务核验

日期：2026-10-21。开发基线为最新 `origin/main` 的 `45fe437b7ccafa1c29060c9691bc2e20b326a00c`，独立分支 `codex/max-222-reacceptance`。当前交付为代码候选及准确阻塞，不能判定六项业务验收全部闭环。最终修复 SHA、PR、检查快照与证据附件见 MAX-222 交付评论；未合并、未部署。

## 逐项结果

| 验收项 | 结果与证据边界 |
| --- | --- |
| 1 趋势选择回显 | 已修复并通过单测及真实 Chromium 交互。原生 select 在异步移除 option 后重置，Lit 对未变化的 value 不会再写入；修复在 option 提交完成后同步选择状态，并保留所选 ID 的临时选项。当前窗口缺少该定义时明确提示，不展示为全部指标。覆盖切换 6h、加载中、刷新、全部指标、无 series、缺失定义与未知 ID。API 延续 `view:all`，指标筛选在本地，时间窗仍由查询请求决定。浏览器回执为受控 HTTP 响应，不冒充真实采集。 |
| 2 模板平板布局 | 从视口媒体查询改为组件可用宽度的 container query；正文不超过 960px 时纵向展示现有表格行，覆盖、兼容、详情按钮无需横滑。保留原家族、其他/历史版本、精确 pin 和详情行为。真实应用壳与生产不可变目录在 1440/1280/768/375、明暗主题通过；数据接口为受控响应。 |
| 3 中文名称与时间 | MySQL 诊断指标、主机扩展指标使用保留累计/快照/作用域含义的中文名称；技术 ID 可展开、完整选取或复制。两项已审扩展包分别命名会话数与慢查询快照；未知指标/模板保留真实 ID。趋势轴按浏览器本地时区显示短时间，跨日期保留日期，原始 ISO 时间数据和 tooltip 保留；显示时区说明，不改查询窗口。独立 `metric-display.ts` 避免触碰列表子任务共享文件。 |
| 4 中文下载名与 IPv6 | 下载名的 ASCII-only 替换已从当前源码及原回执确认；新增安全 ASCII fallback 与 RFC 5987 UTF-8 filename*，处理路径、控制字符、分隔符、Unicode 长度。真实存储 report32 经原导出器生成 html/pdf/json/md/csv，记录 MIME/字节/哈希与候选 header；完整 JWT 下载路由仍未验。server3 真实 SSH 固定命令返回 `[::]:22`；将相同实际输出交给旧解析逻辑得到 `::]`，候选服务得到 address=`::`、port=22；IPv4 保持正确。另有括号/裸 IPv6、scope ID、IPv4 单测。未把历史报告未复现的描述冒充当时已复现。 |
| 5 MAX-212 真实分析 | **未完成**。只读核验原调查、run 和 result：version1，facts/claims/hypotheses/recommendations 均 0，modelVersion/promptVersion 为 unavailable，Run 为 partial/INVESTIGATION_RUNTIME_PARTIAL。历史不可追加恢复原因，未改写。正常产品登录缺少有效凭据；真实新运行还缺 MAX-208 协调者登记的预算预留。未发模型请求，未用受控测试代替真实成果。 |
| 6 MAX-214 指定资源 | **未完成**。当前只读核验 instance:1 为 mysql-basic@2.0.0 revision2/applied2/generation2；server:3 为 linux-basic@1.0.0 revision2/applied2/generation1，正式源仅数据库 uptime、主机 uptime/load。instance1 已与原报告 revision1 不同，本任务未改绑定，不推断变更来源。仍无诊断覆盖；未通过内部写库或伪造身份完成激活。正常 JWT 兼容预览→试采→激活及至少三个诊断正式周期等待有效产品登录。 |

## 验证

- 先新增趋势回归在旧实现得到 RED：时间窗切换后 select.value 为 `''`，预期 `mysql.key_cache.used_percent`。IPv6 回归在旧实现得到 RED：`[::]:22` 解析为 `::]`。随后修复并验证 GREEN。
- 最终前端 focused：7 文件 **80 通过**；后端相关导出、诊断、HTTP 安全：5 文件 **36 通过**。
- Chromium：**19 通过**，覆盖模板目录/搜索/历史版本/详情/失败空态，以及三种视口明暗主题下趋势状态、复制、无 series、缺失定义、未知 ID、真零值与质量断点。生成布局宽度、完整查询参数、渲染指标与原始图表数据 JSON。
- 两端 typecheck、前端生产 build/CSP、contracts:check 通过。构建仅有现有大 chunk 提示。前端测试首次夹具错用 Lit attribute 名导致无资源请求，修正夹具为 `resourceid` 后通过；并非产品修复。一次浏览器重跑遇测试端口短暂占用，未停止不明进程，改用独立 53222 后通过。
- 本轮只读 SSH 使用平台现有凭据与 host-key 检查，调用固定诊断命令；无任意命令输入、资产/绑定/告警/通知修改。report32 导出是只读调用导出器，不是 JWT 下载路由通过。
- 没有新增公开 JSON 契约或数据库迁移，没有修改三类列表、resource-metrics-table、resource-metric-summary，也没有修改已有用户 AGENTS.md 变更。

## 真实验收前置与接续

现有主服务 PID71545/5173、PID71556/3000及28888 属 `/Users/max/Coding/40-Slide` 的 main 工作树，启动日志为原 round2 目录。未重启或终止它们。候选使用独立 5222/3022；3022 明确为 API-only standby，未争夺 Worker；其运行不能证明候选后台调度通过。Playwright 自管 53222。交付前停止本任务调试进程，进程身份/日志/停止回执随附件保存。

任务提供的受控调试凭据用于 admin 产品登录得到 401；没有继续猜测密码、改用户密码、签发绕过登录的 JWT，或把 SSH 凭据当产品账号。已请求有效产品登录凭据的受保护引用。获得后应重新读取实时权限、绑定及配置 CAS，沿资源详情/采集策略的正常兼容预览→试采→激活；目标包为兼容性证据允许的 mysql-diagnostics@1.1.0 与 linux-host@1.1.0 精确 pin，不以版本号判断兼容。保留现有覆盖并保存冲突/回退依据，至少三个正式周期记录 applied revision、generation、freshness、时间桶、quality 与 lineage，trial 不计正式周期。

原 MAX-214 迁移文档继续有效：connections 与 slow_queries 的已审组合包不等同自动迁移告警；qps 缺可信 counter epoch，disk_usage 字段/固定容量分母不成立，CPU/memory/TPS 等宏不能套用异资源或不同单位。当前 MySQL 与接口 counter 证据缺口继续如实为 unknown，不能伪造 epoch/零值；本轮没有在尚未配置目标资源时扩大实现这些能力。

MAX-208 的唯一账本本轮回读为 input4122/output839（cached1536是输入子集），合计4961，reserved0。协调者单写，已请求一次正常调查现有上限32000 token 的预留或单笔代登记授权；未获得预留前不得调用。随后从产品正常调查入口运行一次，保留模型/提示版本、证据引用、真实成果或真实停止原因、usage 和状态；未知发送不重放，按实测结算同一账本。本轮新增产品调用/用量均0，未写账本。编码代理 token/费用实际遥测不可用，子代理0。

## 证据与回退

原 round2 附件中的截图20、27–30、34，以及 metric-window-filter/template-layout/exports 等 JSON 为**复用的修复前证据**；保留原日期、main SHA，不重新标注为本轮采集。候选截图及回执为**新增证据**，每张在 captures.json 标记主题、视口、时间、最终候选 SHA 与受控数据边界。真实 SSH、report32 只读导出、实时绑定/历史结果检查、预算回读另有独立 JSON；文件在 MAX-222 评论附件交付，不依赖本地路径。

回退为撤销本任务代码提交。没有本任务业务配置修改、数据迁移或新增真实调查需要回退；保留所有历史证据。代码候选可供 Chief 独立审查，任务整体仍因上述真实验收前置阻塞，不能据单测、截图、in_review 或 CI 宣称业务全部通过。
