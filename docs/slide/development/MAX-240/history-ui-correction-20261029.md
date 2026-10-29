# MAX240-HISTORY-UI 连贯修正（2026-10-29）

范围：只修 Chief 复核退回的三项；不重做已通过的窗口查询，不宣称 MAX-240 整单完成。只改 `semantic-metrics.ts` 与其组件测试，未改后端、schema、writer、retention、policy/围栏、activate 谓词、必要指标名单、资源详情页或 MAX238 文件。e2e 夹具语义未变。

## 1. 三项修正

| 编号 | 缺陷 | 修正 |
|---|---|---|
| F1 | 趋势图例把 `freshness=stale` 写成断点，但 stale 且当时 good/exact 的历史值实际仍绘制。 | 图例改为“断点只用于缺失、质量未知或无效、单位不符、非标量及超出安全数值精度的桶；过期但当时 good/partial 的值照常显示”。每序列说明同样按断点条件描述，不再把过期算作断点。 |
| F2 | `renderTrend` 只要任一桶 min≠max 就提交全部 `stats.min/max`；单位不符等不可绘制桶仍画出包络。 | 包络按与曲线相同的 `chartValue` 结果逐桶门控：曲线为 null 的桶，`min`/`max` 也为 null。单位不符、非标量、超安全精度、unknown/invalid 不再出现虚线上下限；可绘制桶内的 min/max 尖峰继续保留。 |
| F3 | `bucketSummary` 把 `partial` 计入无修饰的“有效”。 | 改为分别统计“良好”和“部分覆盖”，序列说明显示 `良好 N · 部分覆盖 M` 并写明“部分覆盖不代表当前健康”；partial 点仍保留在曲线上，invalid 继续为断点。 |

## 2. 验证（绑定本分支本次提交）

| 检查 | 命令 | 结果 |
|---|---|---|
| 新增回归 RED | 对修正前 `semantic-metrics.ts` 运行 `vitest run src/app/ui/components/semantic-metrics.test.ts` | 3 个新用例失败（包络、partial 计数、stale 图例） |
| 组件回归 | 同上（修正后） | 22/22 通过 |
| 前端类型 | `tsc --noEmit`（frontend） | 退出 0 |
| 前端构建 | `vite build` + `check-csp.mjs` | 通过，CSP check 通过 |
| lint（改动文件） | `oxlint semantic-metrics.ts semantic-metrics.test.ts` | 0 warning / 0 error |
| 真实浏览器 + 真实 HTTP | `node node_modules/@playwright/test/cli.js test -c playwright.max240.config.ts` | 3/3 通过 |

浏览器证据：

- 环境：一次性 `mysql:8.4` 容器（宿主 `127.0.0.1:62391`，非 3306；本次容器已删除），测试自建 `max240_ui_<uuid>` 库并 `DROP DATABASE`；真实 `server.ts` + JWT/密码登录 + Vite；模型 guard 计数 0。
- 复用并重跑既有 harness：24h 60 秒 / 1440 桶首尾完整、缺口 null、峰值 999999 进入包络；7d 10,080 桶；自定义 8 天 120 秒桶且提示“未静默截断”；历史 stale-good 仍显示；明细默认 0 行、展开 200 行；1440×900 / 1366×768 / 1920×1080 无横向溢出；撤权后 403、旧结果清除。
- 后端 query 22/22、counter 100 组、R1 的 MySQL/HTTP 6/6 未重跑（未改查询契约）。

清理：harness 结束后停止自启后端与 Vite、删除测试库与临时 workspace；本次一次性容器已删除。未连接共享 3306、未写业务库、未部署。

公开契约未变化，未重复生成 `contracts:check`。

## 3. 未完成（整单剩余，不宣称完成）

当前状态与最近成功值的完整组合、当时阈值与事件快照、停用/解绑后的授权历史、改名与版本身份、公开原始值分页、真实采集与容量 SLO 仍属 MAX-240 其它部分。
