# MAX-163：慢查询与会话读取状态验收

基线：main `3ca5c6fb9357b8e2eb1adb9aed9e266db825839c`。分支：`codex/MAX-163-read-states`。仅修改实例详情慢查询、会话及直接读取路径，不调整指标、日志布局。

## 实现与兼容

- 默认空数组不再代表成功。分别展示未读取、加载、失败、无权限、来源不可用及过期；成功空列表仅说明本次未返回记录，不判断数据库健康。
- 仅为激活的标签读取一次，移除后台重复慢查询请求。失败、撤权、过期时隐藏旧列表和计数；请求序号与实例 ID 防止旧响应覆盖新结果；详情刷新失败也使列表失效。
- 显示来源、时间范围和读取时间。慢查询是数据库当前保留的累计统计/日志，窗口起止与最近采集时间未由原接口提供，明确标记未知，不虚构固定时间段；会话是读取时快照（最多 50 条）。
- 读取超过 60 秒标为过期（默认刷新间隔 30 秒）；这是页面读取结果的时效，不是数据库采集时间。
- MySQL 保留 performance_schema → slow_log 的成功回退；两种来源都失败、PostgreSQL 缺失扩展/时间列、各数据库慢查询异常、Oracle 会话异常和缺失/不支持的会话来源不再转换为空数组。
- 成功响应保留数组，原有 null → HTTP 404 兼容行为不变。成功慢查询通过 `x-slide-query-source` 返回实际来源；旧后端缺少该头时展示来源未提供。
- 两条既有路由移入 `instance-query-routes.ts`，使生产 server 和真实服务验收复用，保留 JWT → instance:view → 实例只读权限链。CI 在已有 qualification MySQL 服务后加入本次浏览器检查。

## 验证

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| RED 复现 | 前端 11 项、后端 7 项因原错误语义失败 | 提交 `6298ae70` |
| 后端全量（单进程） | 354 文件、3436 项通过；43 文件/633 项跳过 | `vitest run --maxWorkers=1`；`frontend/test-results/max163-backend-serial.log`。跳过项不宣称验收通过。 |
| 前端完整单测 | 105 文件、867 项通过，含 16 项读取状态/兼容/竞态用例 | `frontend/test-results/max163-unit.log` |
| 后端定向回归 | 8 文件、73 项通过 | 适配器、路由、实例权限、EXPLAIN 安全边界、达梦连接与指标；`frontend/test-results/max163-backend.log` |
| 兼容回归 | 3 文件、47 项通过 | 达梦缺失连接语义、指标路由源码边界及文档目录规范 |
| Lint | 0 errors、270 warnings | `pnpm lint`；本题新增文件无诊断 |
| 类型检查 | 前后端通过 | `slide-api typecheck`、`slide-frontend typecheck` |
| 构建/CSP | 通过 | `slide-frontend build`；保留既有体积/导入提示 |
| 契约 | 通过 | `pnpm contracts:check` |
| Chromium | 5 项通过 | 以下真实服务流程及两种查询的受控状态矩阵 |

### 真实服务流程

隔离 MySQL 8.4 容器、独立随机 schema；实际迁移、ActorContextService、JWT、实时 SQL 权限校验、生产查询路由及 DatabaseService。使用真实 `instance-detail-page` 的隔离入口，未经过整站导航壳。详情接口从隔离 schema 读取；目标连接仅注入该测试容器 pool，未创建共享平台在线绑定。

1. 清空测试容器摘要，空结果显示 performance_schema 来源及未知窗口边界。
2. 执行 `SELECT SLEEP(1.1)`，刷新显示真实慢 SQL。
3. 独立连接执行 4 秒查询，会话列表显示真实活跃会话。
4. 切换到测试容器的临时受限数据库账号，两种慢查询来源均被 MySQL 拒绝，页面显示不可用并清除旧列表。
5. 删除隔离 schema 中的实例权限记录，原 JWT 再次读取时由生产权限链返回 403，页面显示无权并清除旧 SQL；随后恢复和清理。

### 受控状态与视觉/键盘

Playwright 控制特殊响应，不作为数据库业务成功证据。慢查询、会话各覆盖 1280×900 深色与 390×900 浅色：加载、成功空、500、403、404、格式异常、网络失败及过期。焦点 + Enter 激活标签；无页面级异常及横向页面溢出。已检查主题、文案、焦点及窄屏截图。

截图目录 `frontend/test-results/instance-query-acceptance/`：`real-*` 为真实服务流程，`controlled-*` 为受控状态。评论附代表截图；本地路径本身不是跨机器交付链接。

默认并发全量尝试曾导致多个 MySQL 容器同时启动，本次专用容器经 Docker inspect 确认 OOMKilled=true、exit 137。已停止该批测试并降低并发重跑，上表是最终串行结果，不将 OOM 失败计为通过。

## 重跑与边界

仅对隔离 MySQL 设置环境 `MAX163_TEST_MYSQL_PORT`、`MAX163_TEST_MYSQL_PASSWORD`，运行：

```bash
pnpm --filter slide-frontend exec playwright test --config playwright.instance-query.config.ts
```

测试创建/删除随机 schema、临时账号，并清空测试目标 performance_schema 摘要，禁止指向生产或共享业务数据库。本次专用容器在验证后清理。

PostgreSQL、Oracle、达梦的错误与兼容由单测覆盖，未做这些数据库的实机验收。RED 包含可执行单测复现；另通过只在 Vite 内存中载入 main `3ca5c6fb` 原组件完成基线浏览器定向复现，受控 200 空列表、HTTP 500 均出现原健康结论（`baseline-controlled-*` 截图）。未回退或修改工作分支源码；基线复现单独标注，不作为新实现的业务成功证据。未部署/合并，未触发产品模型调用；编码 token/费用实测遥测不可用，未使用内部预算计数代替。
