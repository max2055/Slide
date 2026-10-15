# MAX-170 · SQL 审核历史验收

基线：已审定 main `0fc280d8f12fde274bae26570823a45fbe6fdce6`。产品与测试提交：`68a5cc734e52c262becc719a841c1edff7652dd3`。分支：`codex/MAX-170-sql-audit-history`；PR base 为 main，最终 head 见 PR。验收日期：2026-10-15。

## 范围与依据

只修改 `frontend/src/app/ui/views/sql-audit-tab.ts` 的历史显示、历史读取与详情交互，新增该视图专属测试。未改审核提交、执行、风险计算、权限、后端契约或历史数据；未修改其他任务拥有的导航、表格、外观、评分及共享语言文件。

真实接口核对：`GET /api/sql/audit/instance/:instanceId` 由 `getAuditHistory()` 返回 `ai_analysis` 列表，不保证有 `sql_text/risk_level/audit_level`；详情 `GET /api/sql/audit/:id` 才会附带关联的 `audit_record`。前端原类型错误地假设列表已包含审核记录字段。

基线组件定向浏览器复现：从 0fc280d8 提取原组件，以同一真实 Fastify / MySQL 验收环境加载，确认 SQL 预览为空、状态显示 `completed`、没有键盘详情按钮。截图 `baseline-real-missing-fields.png`；临时基线源码已移除，不进入产品构建。

## 结果与证据

| 验收 | 结果与证据 |
| --- | --- |
| 旧记录无意义空白 | 列表明确“列表未提供 SQL，请查看详情”“风险未提供”；详情没有关联 SQL、风险、分析结果时分别说明。未补造原始 SQL。`real-legacy-missing-fields.png` |
| 状态与风险分开 | `completed` 显示“审核完成”，P0/P1/P2 独立显示风险；明确“完成审核不代表 SQL 无风险”。详情保留原始状态/风险供核对。`real-joined-detail-keyboard.png` |
| 当前关联记录正常 | 实际详情返回完整 SQL、P2 与已保存分析内容，展开后列表也更新为读取到的字段。`real-joined-detail-keyboard.png` |
| 键盘详情 | SQL 输入框 Tab → 第一条详情；Enter 展开、Space 收起并保持焦点；Tab → 旧记录、Space 展开；Enter 打开“记录信息”。校验 `aria-expanded`；按钮以 `aria-controls` 关联详情单元格。 |
| 成功为空 | 真实 API 对无历史的实例返回空数组，展示“暂无审核记录”。`real-empty.png` |
| 无权限 | 真实密码登录无角色用户，历史 API 返回 403，展示明确权限提示，不冒充空历史。`real-no-permission.png` |
| 加载、失败、重试 | 受控延迟分别验证列表/详情加载；500 历史错误、404 详情不可访问、403 详情无权限均明确提示，重试可恢复空结果。`controlled-loading-*`、`controlled-detail-loading-*`、`controlled-history-failure-*`、`controlled-detail-404-*` |
| 未知/失效状态 | 受控 `unknown` 与未来枚举保持未知，不标绿、不无限转圈；未知风险保持未知；失败审核展示失败说明。`controlled-unknown-*`、`controlled-long-sql-unknown-enum-*`、`controlled-analysis-failed-*` |
| 明暗与窄屏 | 1280×900 浅色、390×900 深色；表格局部横向滚动，聚焦右侧按钮后展开详情仍在可读区域，长 SQL 换行，全页无横向溢出。浏览器校验详情左右边界并目视复核截图。 |
| 错误与并发兼容 | 25 条定向单测覆盖 HTTP/网络/JSON/畸形结构、缺失结果、未知状态、HTML 按文本显示、切换记录/实例的迟到响应、轮询完成与清理。 |

## 数据来源与环境边界

正常场景使用本次独占的 Docker MySQL 8.4、随机命名 schema、完整迁移、真实 Fastify 服务、真实密码校验/JWT/权限检查和实际 SQL 查询。预置一条缺失关联审核记录的旧历史及一条有关联 SQL/P2/已保存分析的当前结构记录；这是真实服务读取验收，数据由验收夹具预置，并非线上历史或新调用模型生成。产品组件通过专属 HTML 验收入口挂载，未改主应用路由。

特殊状态由 Playwright HTTP 拦截构造，明确为受控证据，不作为真实后端产生这些状态的证明。`unknown`、未来枚举和失败分析不发起产品模型请求。启动时配置本地模型调用守卫，结束断言模型请求计数为 0。没有共享部署、在线 binding、采集或外部 Provider 请求。测试进程、随机 schema 及专属容器已清理；截图不包含凭据，禁用浏览器 trace，不交付后端日志。

## 检查与复跑

- 前端全量 Vitest：114 文件、1002 测试通过；其中历史专项 25 条。
- 前端 typecheck、build、CSP：通过；构建保留既有分包大小/动态导入提示。
- 全仓 lint：0 errors，存在既有 warnings；最终本题 4 个 TS 文件定向 lint：0 warnings、0 errors。
- 专项 Playwright：3/3 通过；一个真实服务场景、两个受控主题/视口场景。
- `git diff --check`：通过。未变更公开契约，不需要重新生成契约。

```bash
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm exec oxlint frontend/src/app/ui/views/sql-audit-tab.ts frontend/src/app/ui/views/sql-audit-history.test.ts frontend/e2e/sql-audit-history.spec.ts frontend/playwright.sql-audit-history.config.ts
# 使用独占 MySQL 8.4；不要指向业务库。测试自行建立并删除随机 schema。
T06_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-frontend exec playwright test --config playwright.sql-audit-history.config.ts
```

19 张截图作为任务评论附件 ZIP 交付，其中基线 1 张、真实服务 4 张、受控 14 张。代码与本地验收已完成；CI、Chief 审查、合并及共享部署的集成复验分别跟踪，不将这些后续步骤描述为已通过。
