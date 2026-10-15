# MAX-175 R4：F1/F2 定向返工

继续 `codex/max-175-resource-layout` / 草稿 [PR189](https://github.com/max2055/Slide/pull/189)。本报告更正 R2 的容量迟到保护与诊断入口限制，不覆盖历史报告，也不宣布在线服务器/网络业务验收齐备。

## 版本与范围

产品与测试验收提交：`70db61975e5e88830020758be7566a6d4e469aa7`，接续 R3 `1edf0eb3ccc9d89b08f2acd7037821d03e8a59f1`，审定 base `main / 3bf58f08e5f2507fb0c7e2b7de2739e95045d4c0`。后续只追加本报告；六产品文件 SHA256 和各证据 JSON 的 head 见附件 `source-manifest.json`。

本轮仅修改 `instance-detail.ts`、`server-detail.ts`，新增专属回归并更新受影响的浏览器/旧静态契约测试；其余四个已锁产品文件未改。原工作树 AGENTS.md 保留。不改后端、共享主题/导航/i18n、Provider 或 binding，不连接在线 SSH/SNMP、不执行采集，产品模型调用0。

## 返工结果

| 项目 | 修复与验证 |
| --- | --- |
| F1 容量 JSON body 迟到 | 先在局部变量解析容量与历史；等待响应头、容量 body、历史 body 后分别检查对象 ID 与 contextVersion，最后提交。旧对象、撤权及断开后的 body 均不能回填。6项组合覆盖两种 body 边界 × 三种失效方式，另保留有效结果用例。 |
| F2 自动诊断 GET | 删除进入/切页签/切资源时的诊断请求；顶部刷新也继续不发该 GET。无证据明确显示当前页面尚未取得证据、不能判断运行状态，并说明显式采集的副作用和管理权限。页面重开不会自动取服务端缓存；此时不声称服务端从未采集过。 |
| 显式采集 | 保留 `/collect-diagnostics` POST 及后端既有 `servers:manage` 权限；直接消费现有 `{success, diagnostics}` 返回，检查对象和每个异步边界，不再跟随可能再次采集的 GET。测试覆盖成功、403无fallback，以及 body迟到后的切对象/撤权/断开。实际SSH采集未执行。 |
| 同类触达路径 | 服务器详情/托管实例读取补对象ID检查，并补 body迟到的三种失效回归。复核实例详情/概览/查询、日志、语义指标和网络接口的 body后提交保护；不扩为全站改造。 |

新增19项回归。修改前运行13项初版用例，9失败/4通过，确实复现容量回填及自动诊断请求；最终19项通过。旧 `server-workbench.test.ts` 静态要求存在 GET 的断言按新契约更正，保留显式采集和页签断言，没有给产品添加无效字符串来迎合旧测试。

## 正式服务与视觉证据

最终产品提交重新运行正式完整 Fastify、JWT、独占 MySQL 8.4 与 Vite。三份请求/交互证据 JSON 的 head 均为 `70db6197`；截图、视口、主题和数据来源由 manifest 对应。

- 数据库概览/指标/日志：1440/768/390 × 明暗；六组均首批50、次批5，ID不重复，固定查询窗口、范围/级别回首页、全文键盘和受控迟到清理通过。R1.1职责与原R2三页并排设计证据可复用，容量修复不改变布局。
- 服务器改用支持的 `rhel`，两个真实持久化对象，诊断缓存来自新API进程、未预热。六组明暗/视口下检查进入、全部诊断类页签、顶部刷新、切换对象：诊断 GET 与采集 POST 的请求集合为 **空**。测试对这些路由设拦截保险，一旦回归发请求立即阻断在SSH前并使零请求断言失败；正常路径未触发拦截。不是422，也不是只检查无POST。
- 服务器日志新空证据说明及显式按钮在390px可见，无页面溢出；`MAX-175-R4-server-logs-comparison.png` 对照R2真实422与R4支持OS下不自动请求的页面。共享组件的英文空态保持既有契约，本轮未越锁改动。
- 网络继续读取真实保存的两个接口，名称/状态筛选、局部键盘横滚及备份缺凭据门禁通过。服务器/网络正常采集与流量没有新验收结论。
- 特殊状态、正常受控趋势和交互仍使用命名为 `controlled-*` 的夹具，正式服务指标真实未配置。176张PNG包含上述截图与一张服务器新旧并排图；不将预置日志/库存/接口冒充在线观测。

## 验证与复现

- 完整前端：122文件 / **1077项通过**；typecheck、生产构建/CSP通过。
- MAX-175正式服务/受控浏览器：**5/5通过**。
- MAX-163/165正式查询、权限与观测时间兼容：**9/9通过**。
- 通用浏览器审计：最终 **192/192通过**。首次191通过/1失败：`resource-diagnosis.spec.ts:126` 在1440px未找到恢复策略checkbox；相关产品/测试相对R3未改，单独复验1/1通过，随后完整复验192/192。未修改该路径或放宽断言，保留首次日志/trace；未复现的偶发失败不等于根因已修复。

```bash
pnpm --filter slide-frontend test
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
MAX175_ISOLATED_MYSQL=1 MAX175_OUTPUT_DIR=<独占输出目录> pnpm --filter slide-frontend exec playwright test --config playwright.max175.config.ts
MAX163_TEST_MYSQL_PORT=33175 pnpm --filter slide-frontend exec playwright test --config playwright.instance-query.config.ts
pnpm --filter slide-frontend test:browser
```

运行前核实容器 `slide-max175-mysql` 与任务端口归属，不能指向共享数据库。每轮API/Vite子进程均由测试afterAll前台回收；MySQL结束后停止。构建大chunk警告、审计模拟环境配置代理连接失败及正式服务遥测429保留，不能声称所有请求均2xx。证据包不包含可能携带登录数据的API原始日志。

## 未完成项与交接

无在线SSH/SNMP目标，正常服务器/网络采集、日志与流量仍未业务验收；正式指标未配置，受控趋势不替代正常流。人工读屏、性能及共享新版运行态未新增验收。F1/F2修复交Chief仅审影响差异，其他有效R2/R3证据复用；PR继续草稿、不得自动合并。当前head的完整CI必须另行核实，不能沿用旧head结果或用本地通过代替。
