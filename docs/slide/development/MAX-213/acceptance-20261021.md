# MAX-213 图表与报表验收（2026-10-21）

范围对应 QA-005、QA-006。PR 基线 main `d9ee65a5`，产品源码 `4affb26d`，浏览器截图等待动画完成的测试修订 `971691f3`。保留原工作区 AGENTS 与文档快照，未带入交付分支；不修改健康评分计算。

## 修复与兼容

- Canvas 绘制前在组件主题作用域解析 CSS 颜色，归一化为 RGBA；渐变透明度乘以原始 alpha。支持变量及嵌套 fallback、hex、rgb/rgba、hsl、命名色和浏览器支持的现代颜色，阈值颜色同步解析。沿用原主题监听与 ResizeObserver。
- 下载采用响应 Content-Disposition（优先 UTF-8 filename*），按 Content-Type 确认扩展名；缺失或损坏头时使用安全回退。保留中文，清理路径和控制字符，延后释放 Blob URL。
- 修复已声明 CSV 格式实际回退 HTML 的路径。CSV 固定六列：id、name、type、status、created_at、data（JSON 单元格）；按 CSV 规则引用/转义，防止公式型名称被表格执行。未知格式显式失败，不再静默返回错误标记的 HTML。
- HTML、PDF、JSON、Markdown 原导出实现保留。本次未新增 PDF 转换承诺；已有 PDF 导出经实际字节验证为 PDF。

## 本地 gate

在干净交付工作树执行；生产源码未在检查后改变，测试修订只增加截图等待条件。

| 检查 | 证据 |
| --- | --- |
| 前端全量 | 140 文件，1,221 项通过，含下载头边界单测 |
| 浏览器 focused | 8 项通过：真实 Canvas、主题切换、resize，以及各格式和文件名边界 |
| 后端相关导出/生成/调度回归 | 4 文件，26 项通过；包含真 PDF、CSV 转义/公式保护、未知格式拒绝 |
| 双方 typecheck | 通过 |
| 前端 build / CSP | 通过；既有大 chunk 提示，无构建错误 |
| contracts:check | 通过，无公开 schema 变化 |
| 改动生产文件 lint / diff check | 0 错误，4 条 reports.ts 既有未使用变量警告；diff check 通过 |

RED：旧下载实际得到 `旧报告.pdf.pdf`；旧 exporter 对 CSV 输出 HTML、对未知格式静默输出 HTML，新测试按预期失败。旧图表保留未解析的 `var(--accent)`，颜色断言失败；原 QA 附件另记录 7 次 addColorStop 异常。失败测试提交与修复提交均保留。

## 隔离集成与真实数据

组合 MAX-209 候选 `b42025e7` 与本修复，干净集成候选 `36e2eb4d`。MySQL 8.4 一次性容器，API/Vite 使用独立端口 31213/51213；已核对 PID、端口、cwd、命令、提交和日志，未重启或修改共享数据库/服务。所有 Provider 禁用，自动模型调度关闭。

只读取得平台已有 report 32（服务器巡检，原始 HTML 4,499 字节）及 60 个历史 CPU/内存样本。报告复制至隔离数据库，通过真实登录、授权、报表中心与浏览器点击下载，未 mock 报表 API。各格式核验响应头、浏览器文件名、文件头、大小和 SHA-256，详见附件 receipt.json。

| 格式 | MIME | 实际字节 | 内容核验 |
| --- | --- | ---: | --- |
| HTML | text/html | 4,499 | 与原报告逐字节相同，头为 <!DOCTYPE html> |
| PDF | application/pdf | 5,506 | %PDF-1.3，存在 PDF 尾标记 |
| JSON | application/json | 5,465 | 可解析，content 与原报告一致 |
| Markdown | text/markdown | 4,188 | Markdown 标题；通过既有 format=md 导出查询验证 |
| CSV | text/csv | 588 | 固定列 CSV，含报告数据 JSON 单元格 |

图表截图为真实历史 CPU 的 30 个点回放，未改采样时间或数值；采用实际公共 metric-chart，覆盖 1440 明暗主题及 700 宽度、切回浅色与 resize，等待动画完成后截图。颜色分别为 rgba(38,95,153,1) / rgba(96,165,250,1)，浏览器异常为零。历史数据回放不是本轮实时 SSH/数据库采集验收，也不代表整个健康评分页面或所有兄弟任务已验收。

容器、匿名卷和本次 API/Vite 子进程在 finally 中清理，receipt 记录均退出 0。产品模型新增调用为 0，MAX-208 账本仍保留原累计 4,961 token；编码代理实测 token/费用不可用。未派生子代理。

## 交付与回退

证据附件 `MAX-213-delivery-20261021.tar.gz` 包含报告下载实物、截图、receipt、日志、回放脚本和校验和。截图可见的页面明确标注真实历史回放，颜色边界自动化采用受控样本并单独标识。原始缺陷依据仍为 MAX-208 的 QA-005/QA-006 附件。

本地验证、PR/CI、合并、部署后的服务复验及 Max 最终验收是不同状态。未自动合并或部署；父任务由 Chief 协调审查。真实服务证据来自上述 MAX-209 组合隔离候选，合并后的统一服务验收仍按父任务接续。

无 schema、配置或权限变更；回退本任务修复提交即可恢复原行为。不得将 HTML 重命名为 PDF 作为回退替代。
