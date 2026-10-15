# MAX-166 · UI-010 长列表验收

实现基线：main `3ca5c6fb`；提交前更新到 main `cbec4bab133d26743fcabe014c42c0d2a30e55a3`，无冲突。产品代码提交 `7820f840`；后续交付提交仅补测试运行保护与本报告。日期：2026-10-15。

## 实现与边界

- 表结构、索引、旧指标目录、权限目录、报表历史复用同一轻量浏览控件：搜索、名称升降序、25/50/100 条页长、上一页/下一页、已载入/匹配/当前范围。筛选或页长变化回首页；数据缩减时页码收敛。详情在原页面展开/弹窗，搜索与既有筛选仍保留。
- 索引以表名＋索引名识别，列按 seq_in_index 排序；跨表同名 PRIMARY 不再合并，统计按真实索引数计数。未使用和冗余列表各自分页。已有表筛选与指标资源/数据库类型筛选保留。
- 任务写 users-management.ts「权限目录」，实际权限目录位于 rbac-page.ts 的 PermissionManagementTab。本次修正该目录，未修改用户列表或角色权限编辑。
- 报表复用已有 page/limit 接口，每批100条，提供「读取下一批历史」；搜索明确只覆盖已载入记录，可见总数来自现有 stats。后端权限过滤可能让某批为空，不能用空批判断全量结束。没有新增搜索后端或把首批冒充全部结果。
- 报表 SQL 增加 id DESC 作为同时间记录的次序，避免静态历史跨批漂移。并发新增/删除期间，现有 offset 接口仍不提供事务快照；可刷新重新读取。
- 读取失败/403/响应类型无效时清除旧列表并显示错误。实例切换拒收旧表/索引响应；表详情清除旧列并拒收迟到详情。
- 真实服务发现只有一次快照时 changes 是提示对象，导致原页面 changes.filter 崩溃；本页兼容既有 hint 响应，保持正常数组语义。属于表列表基本流的直接阻塞修复。
- 窄屏表格在容器内横向滚动，分页与搜索留在表格外；没有改造报表生成区、源码/R2治理/Agent清单，也未部署或调整在线采集/绑定。

## 验证证据

| 检查 | 结果 |
|---|---|
| 前端完整 Vitest（最新 main 集成后） | 106 个文件、894 项通过；包含本题10项错误/兼容回归 |
| 后端报告相关 Vitest | server-report-service、report-metric-source、report-schedule-handler 共20项通过 |
| 前端与后端 typecheck | 通过 |
| 前端 build 与 CSP | 通过；保留既有大 chunk 提示 |
| 受控 Chromium | 16项通过；无未捕获页面异常 |
| 隔离真实服务 Chromium | 1条组合业务流通过；真实密码登录/JWT、现有权限中间件、SQL路由/服务、Vite代理 |
| git diff --check | 通过 |

可复现命令：

```bash
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend build
pnpm --filter slide-api exec vitest run src/server-report-service.test.ts src/report-metric-source.test.ts src/workflows/report-schedule-handler.test.ts
pnpm --filter slide-frontend exec playwright test --config playwright.max166.config.ts
bash scripts/qualification/run-max166-ui.sh
```

受控长数据来自 Playwright HTTP 路由夹具：125张表；375个索引/750条列记录；250条未使用、250条冗余记录；125条指标/权限/历史。逐页验证名称定位、分页、筛选保留、无匹配、成功为空、加载、503、403、无效响应恢复。指标含缺省 target_type 的旧记录；历史含未知状态并保留原值。键盘 Enter 翻页通过。单测另覆盖失败后恢复、数据缩减、跨表同名索引及迟到旧实例响应。

真实服务验证使用本题临时 MySQL8.4 容器、独立资格库与3096/5197/28996/28997端口；结束后停止并移除容器与本题服务。保存的表快照与126条报告由测试SQL写入，仅作为可识别的验收数据；没有执行在线采集或调用外部模型。真实密码登录后，五个生产组件直接请求现有服务：表结构有数据/检索、索引成功为空、指标目录、权限目录、历史检索。另打开正式应用的指标旧目录、权限目录与报表路由检查控件。两批真实SQL报表包含126个不同ID，同时间历史无重复/遗漏。组件宿主页只替换document，未拦截业务API；不能把这些夹具当作线上资源采集证据。

## 视觉材料

随 Issue 交付截图包，全部截图来自本次代码，无旧审计截图充当新验收。

- `controlled/{schema-management,index-management,metric-registry,rbac-page,reports}-{1280,768,390}-{light,dark}.png`：五组件、三个视口、明暗主题，共30张；夹具数据。
- `real-service/{schema-management,index-management,metric-registry,rbac-page,reports}-real-service.png`：真实服务读取组件，共5张。
- `real-service/{metric-registry-viewer,permission-management-tab,reports-page}-app-route.png`：正式应用路由，共3张。

人工核对已载入与匹配计数、名称可读性、操作位置、分页可见性与表格局部滚动；自动检查390/768/1280视口无整页横向溢出。报表生成区属于原有布局，本题只验收历史表格与浏览控件。未做全站视觉重排或外部部署验收；合并与线上集成由父任务审查接续。
