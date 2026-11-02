# MAX240-LATEST-DATA 连贯修正（2026-10-29）

范围：只修 Chief 复核退回的两项；不在 `0e85eabcd` 之上的展示做其他改动，不宣称 MAX-240 整单完成。改动文件仅 `semantic-metrics.ts`、对应组件测试和本目录文档。未改后端、schema、writer、retention、policy/围栏、activate 谓词、必要指标名单、资源详情页或 MAX238 文件；公开契约未变，未重新生成。

## 1. 两项修正

| 编号 | 缺陷 | 修正 |
|---|---|---|
| F1 | `windowLatest` 先取每个序列最后一个可绘制桶，再按 `observed_at` 比较跨序列新旧。观测更晚的旧窗口桶会赢过窗口内更新的可绘制桶；序列内也可用“是否最后一桶”替代窗口位置。 | 跨当前指标全部序列、按每个桶的 `window.to` 从新到旧取第一个 `chartValue` 非空的桶；`observed_at` 只作为该桶的观测时间展示。灰化条件改为指标 `state !== available`、该桶 `freshness !== fresh`，或该桶 `window.to` 不是全部序列最新一桶的 `window.to`。单位不符、非标量、超安全整数、unknown/invalid 仍不能成为该值，无可用桶仍写暂无。 |
| F2 | status/attempts 返回 404 时清除受保护结果，但复用查询路径文案“查询暂时失败；保留上次结果…”，清除与文案相反。 | 状态条使用自己的句子：404 为“资源不存在或已不可读；受保护结果已清除。”，401/403 维持“登录已失效 / 没有此资源的查看权限”并继续清除；503 及其他非 401/403/404 失败仍只让状态条报读取失败并保留历史查询结果。查询请求自身的错误文案未改。 |

## 2. 验证（绑定本分支本次提交）

| 检查 | 命令 | 结果 |
|---|---|---|
| 新增回归 RED | 用 `0e85eabcd` 版 `semantic-metrics.ts` 跑同一测试文件 | 3 个新增判别用例失败（跨序列窗口取新、非最新桶灰化、404 文案），其余 29 通过；401 清除用例是既有无变化行为，旧实现也通过 |
| 组件回归 | `vitest run src/app/ui/components/semantic-metrics.test.ts`（修正后） | 32/32 通过（28 既有 + 4 新增） |
| 受影响前端模块 | `vitest run src/app/ui/components src/app/ui/views` | 104 文件 / 967 测试通过 |
| 前端类型 | `tsc --noEmit` | 退出 0 |
| 前端构建 | `vite build` + `check-csp.mjs` | 通过，CSP check 通过 |
| lint（改动文件） | `oxlint semantic-metrics.ts semantic-metrics.test.ts` | 0 warning / 0 error |
| 真实浏览器 + 真实 HTTP | `node node_modules/@playwright/test/cli.js test -c playwright.max240.config.ts` | 4/4 通过 |

浏览器证据：

- 环境：一次性 `mysql:8.4` 容器（8.4.10，宿主 `127.0.0.1:63931`，非 3306；容器已删除），测试自建独立库并 `DROP DATABASE`；真实 `server.ts` + JWT/密码登录 + Vite；模型 guard 计数 0。
- 复跑既有用例，确认失败采集 + 旧成功值四项同屏、24h 1,440 桶首尾完整、7d 10,080 桶、自定义 8 天 120 秒桶、缺口与峰值、撤权 403 清除均未退回；截图 `docs/slide/development/MAX-240/e2e-20261029/` 已刷新。
- 后端 query 22/22、counter 100 组、R1 的 MySQL/HTTP 6/6 未重跑（未改查询契约）。

## 3. 未关闭

整单其余项照旧保留：当时阈值和事件快照、停用解绑后的授权历史、改名与版本身份、公开原始分页、真实采集与容量 SLO。本次修正的浏览器证据来自种子正式库，不是真实采集。
