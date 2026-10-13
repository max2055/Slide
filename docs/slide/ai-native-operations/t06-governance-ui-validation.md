# T06 策略、有效预算与持久用量只读设置验收

## 当前增量与边界

MAX-148 v1.2.14，复用 PR159；托管起始 `4591bf47` 保留，正常合入 main `fc7f2c9c`，未 switch/reset/force。父已核验的 PR161/162 是消费基线，旧 HTTP-only 草稿修复和 Profiles 交付保留。本增量仅修改 frontend、直接浏览器夹具/配置和本模块文档；不修改后端、公开契约注册、schema、auth、ledger、executor、Run writer 或生产触发。不新增 Issue、子代理或外部模型请求；原 T04 5/6 成功停发不转授。实际 Agent token/费用遥测不可用，无硬预算。

新增深链为 `/settings/ai/policies`、`/settings/ai/budget`、`/settings/ai/usage`。复用 settings-shell 和共享卡片、空状态、按钮及主题 token，保留旧设置深链。策略需要 ai:view；预算和用量另需 config:manage，admin/通配符保持既有管理语义，未知权限不先读取。调用正式 authFetch 与 generated public API types，cache=no-store，只发 GET。

策略呈现当前生产组合的真实“尚未配置/尚未接入”。预算分别展示当前加载器、正式冻结 policy、未初始化/匹配/冲突、UTC 准入窗口与每执行保留成本；不把 Profile 上限或日额度当作余额。用量显示 all_history 的 reservation总数和状态、known/unknown/pending、已知 Token 小计；cachedInput 包含在 input 中。成本逐币种显示历史预留、当前保留和配置费率结算估算，unknown、待返回和缺费率不能冒充零费用或供应商实收。items 按 currency/state/mode 分组，按 groupCount/nextOffset 分页，total 不用于分组页长度；页大小5/20/50。跨请求并发结算仍遵循后端当前非快照分页语义。

刷新、分页、权限变化、切页与销毁清空事实并推进 generation；每个异步边界校验 generation/isConnected/kind。Lit willUpdate 在切页渲染前清空，避免将旧用量按新策略类型渲染。401/403 清缓存，503/连接失败显示不可用；新403、权限撤销、更新请求或销毁后，迟到旧200不能恢复敏感内容。页面只观察事实，不轮询制造结果。

## 真实验收

`frontend/e2e/investigation-governance.spec.ts` 使用 run-owned mysql:8.4（隔离容器 `t06-governance-789ef89b`）和独立 `t06_workspace_*` schema，正式 MigrationRunner、真实 ledger reserve/markSent/settle/cancelUnsent、JWT/live SQL authorization、TCP HTTP及Chromium。新场景每项独立准备数据，不依赖先前场景或重试。治理查询未调用 Provider、目标工具、Workflow 或 executor；afterAll 验证 providerCalls=0/toolCalls=0、workerErrors=[]、observationErrors=[]。存储503通过正式store的pool不可用状态触发；延迟响应用 route.fetch 读取真实HTTP200再受控延迟交付，未伪造业务事实。

| 验收 | 证据 |
|---|---|
| 尚未配置策略、未初始化预算、空持久用量 | 正式GET事实及逐表完整SQL快照相等，读取不初始化domain、不写账本或业务表 |
| 五种state、缺费率与双币种 | 7条reservation、6组；已知3、未知1、pending1；USD settled两条中一条缺费率，输入200含cached80，输出100；USD/EUR各164micro配置估算独立，USD保留6000micro不当作已知零费 |
| 分组分页与刷新 | 页大小5：第一页5组、第二页1组；总数始终7、groupCount6，nextOffset为5；刷新持久恢复，与读前SQL完整行值一致 |
| 有效冻结预算 | matching真实冻结事实；直接SQL改冻结hash触发conflict，展示两份配置且明确不可视为可准入，随后恢复测试hash |
| 权限交集和深链 | 缺两权、仅ai:view、仅config:manage三组反例对预算/用量零GET；ai:view仍可读策略 |
| 同JWT实时撤权 | SQL撤销ai:view或config:manage，真实HTTP403清缓存；SQL恢复后显式重读才恢复 |
| Session/503 | SQL递增Session version后真实401擦除展示；pool不可用真实503清旧成本，恢复后显式GET恢复 |
| 迟到HTTP200 | SQL权限事件、新HTTP403、刷新后的503、设置切换、组件销毁和分页新响应六种确定性边界；等待原load Promise结束后验证旧事实未恢复 |
| 响应式/键盘 | 1600/1024/390，三个页面document和组件均无横向溢出，刷新可聚焦并Enter触发真实200；截图人工查看移动与桌面布局 |

`playwright.investigation.config.ts` 纳入两个spec，原 `.github/workflows/ci.yml` recovery-qualification 命令自动执行新场景。本地同命令 **44 passed（旧24＋新增20），0skip/0retries/0observationErrors**。旧创建→工具→取消→新Run→历史、Chat转换SQL同Session/原message IDs不复制与刷新/重连、证据过期410/tombstone、成果分页、HTTP-only草稿撤权和Profiles均实际执行；本次日志不是历史head日志。

## 模块与安全检查

| 检查 | 当前结果 |
|---|---|
| 前端完整Vitest | 100文件、808 passed、0failed/0skip；新增10项生命周期/权限/错误反例 |
| 既有前端browser audit | 120 passed；mock兼容回归不能替代上述真实SQL验收。夹具无通用API时存在既有代理ECONNREFUSED噪声，未作为新模块真实事实 |
| security:agent | 17文件、187 passed、0skip |
| 前端typecheck/build/CSP | 通过；2个生产脚本CSP通过，既有大chunk提示保留 |
| contracts:check / qualification:matrix / security:scan | 通过，37/37 finding映射；未声称A1–A8或T12完整gate完成 |
| lint / focused lint / diff --check | 全仓266 warnings、0errors；本次7个源码/测试/配置文件0warnings/0errors；diff通过 |

首轮真实失败为测试数据未包含Ops Profile必需资源，正式ledger拒绝BUDGET_REQUEST_INVALID；Playwright重建schema后的后续缺数据为连带失败。按正式契约补资源并使每项数据独立，未放宽产品授权或账本校验。新增导航最初复用已有图标触发全仓唯一图标约束，改用现有未占用bookmark/gauge/chart图标后808项通过。单测初始RED为缺实现导入失败，未冒称行为RED。完整44项在所有修正后统一执行一次。

## 交付门禁

产品PR不包含私有.multica、用户AGENTS及托管历史无关文件；保持原PR159产品head与最新main的父历史，准确源码SHA256与head CI另附机器可读证据。新head CI、父完整PR独立Review、正常merge/main包含和完整T06出口仍由父核验；本实现交付后停in_review，不能自行合并、标done或放行stage8–10/T12。测试HTTP/WS/Vite/Worker由finally关闭、独立schema删除，run-owned容器安全停止；不停止其他工作树服务。
