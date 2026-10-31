## MAX238-NATIVE-CONFIGURATION-FLOW：原生固定版本模板配置界面已闭环

**任务分支** `agent/15coder1/max-238`（基点 `3b1a76d78`）：实现与测试 `7beba8852`、证据 `5f564e539`（只在其上追加）。真实 Lit 组件 → 真实 Fastify API → 一次性平台库（`mysql:8.4.10`，`:13352`，容器 `max238cfg-2e39d54b008108ff`）→ 真实只读目标 `mysql3306`（9.6.0）三场景通过。**MAX238 整单仍 in_progress**；未启动生产 worker、未部署、未在共享 3306 写业务数据。**GitHub HTTPS 在本运行时不可达（TLS `unexpected eof`，`gh`/`git ls-remote` 均失败），因此本包未推送、PR #567 未更新、无 CI 快照**；待推送提交即上述两个 SHA。

### 1. 用户流程（真实接口，无 route stub）
- 从现有资源的“监控与采集”入口：全授权模板目录**名称搜索/状态筛选/前向游标分页**（`GET /api/metrics/templates` 新增 `query/cursor/limit/next_cursor`），固定**已发布版本多选**；草稿、已退役、缺实现、不兼容均解释并禁用应用。
- 检查（`preview`）显示组合监控项、单位、决策/能力、release/collector 来源链、参数默认/覆盖/最终值与来源、排除项；冲突结构化显示：`PREFLIGHT_CANONICAL_CONFLICT`（同指标多提供者，需取消一个模板）、`RESOLVE_SETTING_CONFLICT`（模板默认设置不一致，显式覆盖）。
- 真实试采（`trial`）逐项读取/转换/单位与样本；编码值显示真实数值（不再 `[object Object]`）。取消选择零写入；改模板/版本/参数使旧试采失效；显式“生成兼容版本”才调用已接受 repin，展示变更且不自动改本资源/其他资源。
- 应用（`apply`）每次意图一个操作键，绑定资源/版本/digest；未知结果先查**原生操作日志**：新增 `GET /api/metrics/template-bindings/{type}/{id}/operations/{key}`，只读 `metric_policy_operations` 并在读取后重读实时授权；别的资源的键报告 absent。revision/operation 冲突 409、receipt 类 422，不再 500。
- 状态分离：保存、发布（已提交）、等待应用、已应用、首样本、正式采集分别显示；`templates-v1` 不再被强转 legacy `Published`，读取失败不假装未绑定（新增模板感知的 `config/status` 读取分支）。

### 2. 使能修复
模板调度提交成功后，在同一事务把本次真实运行的 capabilities 写回绑定行（与 legacy 路径同位置），否则下一次检查只会看到过期能力且永远无法启用新模板；未改 activate 谓词、必要名单、codec 或正式 writer。

### 3. 浏览器证据（1440×900 主验；1366/1920 关键布局）
| 场景 | 结果 |
|---|---|
| A 选择/取消/搜索/分页 + 真实检查/试采 + 响应丢失 | 绑定 pin 预填；取消期间非 GET 0；搜索只留 MySQL；首屏 10 条 + 加载更多后 12 条且草稿解释可见；试采显示 `值 92060 s · 2026-10-29T18:59:33.281Z`；apply 的 HTTP 响应被丢弃后服务器仍提交，浏览器**查询同一操作键恢复**，未重发；该键操作行 1、revision 8 audit 1；重载显示已提交 8 且无待确认提示 |
| B 并发 revision | 浏览器 base 8，另一真实 API 提交后绑定到 9；浏览器应用被 409 拒绝并显示“配置版本已被他人更新”，重载显示目标 9，无重复 operation/audit |
| C 应用时撤权 | 试采后仅移除通配角色并降为 `read-only`（状态读取仍允许）；点击应用得到真实 **403**，绑定/操作行均未变化，页面显示“没有此资源的操作权限” |

最终绑定：`templates-v1` revision 9，pin `e19c120027e04da69b130e0f6cea29fc@2`（`sha256:1f9bd562…`），application `pending` / applied 4（已接受语义，不伪造 applied）。能力证据最新 `valid_until=2026-10-29T19:01:48.775Z`、`supported`，由 revision 6/8 的真实模板运行刷新。

### 4. 门禁与清理
- 后端模块（config/templates/bindings/scheduler）：32 文件通过/31 跳过，512 passed/132 skipped；前端全量：150 文件/1340 passed；API/前端 typecheck、前端 build+CSP、`contracts:check` 全部通过。
- 清理：API PID 2191、Vite PID 2206 已停止（3001/5173 均连接失败）；`docker rm -f max238cfg-2e39d54b008108ff` 返回名称，按名称与 ID `55799d3288…` inspect 均 exit 1（no such object）；共享 3306 只读，测试管理员权限已恢复后随一次性库删除。

### 5. 边界与剩余
- 无绑定行的资源：原生依赖既有绑定，服务端返回 `TRANSACTION_BINDING_MISSING`（409），页面解释并禁用应用，未写入；本包未新增首个绑定写入者。零选择/取消路径可用且不写库。
- 能力证据遵循既有新鲜度规则，需要真实调度运行；本包补齐模板运行的写回，未放宽谓词。
- 原范围剩余：全指标 good、历史阈值、停用/解绑后历史授权、改名/版本身份、SLO/容量、服务器 3、24h、迁移演练、通知恢复与 AI 闭环。
- 未执行：PR push/update 与 CI 快照（网络阻塞）、watch/merge/deploy、生产 worker、共享 3306 业务写、停写/复制/切换/回退/解绑。

证据：`docs/slide/development/MAX-238/native-config-20261030/evidence.md` / `evidence.json`；复现脚本 `prepare.mjs`、`setup.mjs`、`browser-evidence.mjs` 同目录。截图随本评论附件。
