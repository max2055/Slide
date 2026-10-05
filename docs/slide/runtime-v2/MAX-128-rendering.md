# MAX-128 流式渲染验收记录

2026-10-05；范围 v1 产品要求及 v2 PR/CI 续修契约保持不变。基线 `c0af889557cb47205b620d43a47c781148fca5ed`，包含 S3 已验收 head `f2841e1b29600d4b780a6554d8db0b90176892bf`。实施分支 `codex/MAX-128-streaming-render`；最终 head 以 PR 和交付附件 `candidate.json` 为准，附件另附源码 SHA-256 清单对应实测代码。

## 交付与验收矩阵

| 要求 | 证据及结果 |
| --- | --- |
| accepted → 实际状态 ≤100ms | 真实 authenticated WS 的同端 `performance.now()`：accepted → waiting_model **1.708ms**；受控 provider 保持未输出时没有提前 generating。该时延测试 admission/completion storage 为 mock，不计为真实 MySQL 验证。 |
| 正文/工具到 DOM paint P95 ≤100ms | 下表 15 组全部通过；100 工具 apply P95 **3.8ms**、paint P95 **33.8ms**、accepted → 状态 paint **18.9ms**。工具浏览器输入通过实际 gateway event handler 注入，单独验证 UI；不把 fixture 当完整网络链路。 |
| 增量 parse/apply P95 ≤16ms、无该路径 >50ms long task | 15 组全部通过，最大值见下表；原始样本和 CDP trace 交付。 |
| Markdown 语义、安全、碎片和 reset | 新 parser 逐字符对照全量 markdown-it+DOMPurify，包含 SQL 围栏、setext、列表/loose/嵌套列表、表格、晚到引用、任务列表、HTML/XSS、CR/CRLF 换行、reset；保留 140k 截断提示。 |
| 阅读/完成/窄屏 | Playwright：近底部上翻暂停追尾、显式恢复最新、文字 selection、JSON details 展开和 DOM identity、完成后 scrollTop 不变；390px 无横向溢出，附截图。 |
| 真实 phase/Stop/未知结算 | provider 请求、首个真实 output、工具批次、真实审批结果产生阶段；保持 retry/reset 和 save/terminal；Stop pending 禁止重复发送，socket 未送达不显示已发送；未知结算显示待确认。 |
| 重连/重试/后台 | 真实 WS 故障注入和 gateway/reducer 覆盖旧订阅、重复/gap、重连 snapshot；后台 rAF 暂停时 reset/terminal 逻辑收口；retry phase 和内容回撤覆盖。 |
| 真实存储与当前 UI | 独立 MySQL 8.4 + JWT + DirectAdapter WS + 当前 Vite UI + 本地受控 OpenAI provider：5/5 passed，覆盖保存失败恢复、length 续写、拒绝无安全答案、Stop 取消持久化、附件拒绝。 |
| 共享组件、兼容与门禁 | 复用现有聊天/工具模板及 token、Lit property binding；TypeScript Agent Core、DirectAdapter、权限/审批、intent/settlement、completion 事务、16ms 正文/80ms 工具批处理保留。当前 head 的八项 GitHub CI 仍须独立核验。 |

## 环境与测量口径

Apple M5，10 核，24 GiB；darwin 27.0.0；Chromium **148.0.7778.96**；浏览器 UA 为 Playwright Desktop Chrome 模拟 Windows，实际主机为上述 macOS。UA 原文、硬件及全部 samples 存于 `MAX-128-browser-metrics.json`。

正文场景 mixed/plain/fence/list/table × 20k/40k/100k 字符。mixed 包含中英文、SQL、引用、表格、列表，parser 100 字符一批（100k 约 1000 批，末尾另追加真实引用定义）；其他长单块 parser 1000 字符一批。DOM apply 统一 1000 字符一批。parse 和 apply 分开记录；apply 包含该轮 parsing/sanitizing/Lit DOM commit。此证据界定固定样本及批次，未承诺任意输入/硬件/每字符 DOM commit 同样达标。

paint 使用同一浏览器时钟及两个 rAF，作为经过中间 paint 的保守上界；没有跨机器或 Node/浏览器时钟相减。LongTask 通过 PerformanceObserver 与本次 parse/apply 运行区间关联；CDP `devtools.timeline,v8.execute,blink.user_timing` 与 user timing 标记便于复核。旧基线完整保留 40k 纯文本 fallback，>40k 的较快值是语义退化路径，不宣称语义等价性能提升；新正文保留 Markdown 至 140k。

服务端独立度量：publish → writer 排队（合并帧最后一条 operation 起计，为下界口径）1103 样本 P95 **0.259ms**；writer send callback 1113 样本 P95 **0.476ms**。legacy send → first phase **1.728ms**，该协议没有 accepted receipt，因此不标为 accepted 时延。各项原始时间保存在 `MAX-128-server-metrics.json`。

| 样本 | 字符 | 旧全量解析 P95 ms | 新增量解析 P95 ms | 新 DOM 应用 P95 ms | paint P95 ms | 路径 long task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed | 20000 | 6.4 | 0.6 | 2.9 | 35.0 | 0 |
| mixed | 40000 | 10.8 | 1.9 | 5.8 | 34.4 | 0 |
| mixed | 100000 | 10.2 | 2.4 | 5.8 | 35.2 | 0 |
| plain | 20000 | 0.5 | 1.2 | 1.2 | 34.4 | 0 |
| plain | 40000 | 1.3 | 2.5 | 1.2 | 33.4 | 0 |
| plain | 100000 | 2.3 | 5.1 | 2.2 | 34.8 | 0 |
| fence | 20000 | 0.4 | 1.2 | 1.8 | 33.6 | 0 |
| fence | 40000 | 3.4 | 2.8 | 2.1 | 36.3 | 0 |
| fence | 100000 | 1.8 | 5.4 | 3.6 | 35.3 | 0 |
| list | 20000 | 4.9 | 3.8 | 5.5 | 33.5 | 0 |
| list | 40000 | 7.8 | 4.1 | 6.7 | 35.3 | 0 |
| list | 100000 | 2.2 | 7.0 | 10.4 | 35.3 | 0 |
| table | 20000 | 8.4 | 4.2 | 6.7 | 33.4 | 0 |
| table | 40000 | 14.9 | 4.9 | 7.4 | 35.2 | 0 |
| table | 100000 | 2.2 | 7.5 | 10.3 | 34.4 | 0 |

## 实现与修复

Lit directive 每个 part 独立保存缓存；用 markdown-it token map 确定稳定顶层边界，保留最后两个块可变，不按空行永久冻结。晚到引用定义只失效相关缓存，同源依赖共用重解析结果。大表格和列表按 balanced row/item 缓存净化 HTML 和稳定 DOM，tight/loose token 结构改变也会失效。完成和历史复用 `part:<partId>` 与同一模板，保留 selection、展开和阅读位置。工具结果仍按需展开；实际 thinking 仅在用户显示策略允许时展示。

开发中 giant 表格首次 parse P95 36.7ms 未达标，已通过 row/item 缓存修复；晚到引用触发 56ms long task，已通过同源解析复用修复。首轮 workspace gate 的两个相关失败（admission 状态 predicate、工具并发 phase 顺序）均已定位并修复，API/Core 模块复验通过。terminal 曾重新开启 chatStream，已修复为只保留展示 projection。补充 CR-only 输入逐字符测试发现 token map 与原始换行 offset 不一致，已修复 lineStarts 并覆盖 CR/CRLF。取消连接瞬时失配追加 focused 测试，失败发送恢复可重试状态且不关闭运行。

## 验证命令与实际结果

- `pnpm -r test` 首轮发现上述两项相关失败；修复后 `pnpm --filter slide-api test`：3039 passed /251 existing skipped；Core：675 passed；sandbox 首轮 22 passed /4 existing skipped。既有 skipped 不算通过覆盖。
- `pnpm --filter slide-frontend test`：604 passed（87 files）；取消和 gateway/工具 focused checks：68/68 passed；Markdown/工具 focused checks此前 14/14 passed；最终前端模块包含新增 CR/CRLF 两项回归。
- `pnpm --filter slide-frontend exec playwright test --config playwright.streaming.config.ts`（全套及分文件复验）：完整 streaming suite 7/7 passed；未知结算文案更新后非性能 6/6 passed；最终按 streaming-render.spec.ts 复验 3/3 passed（含性能）并保存 trace；message-parts/tool-stream 另行复验 4/4。CR/CRLF offset 修复后按最终代码复验性能及功能场景。
- `pnpm --filter slide-frontend test:browser`：59/59 passed。
- `PLAYWRIGHT_MANAGED_ENV=1 QUALIFICATION_CANCELLATION_E2E=1 pnpm --filter slide-frontend exec playwright test agent-runtime.spec.ts agent-cancellation.spec.ts --workers=1`：隔离环境 5/5 passed；取消发送失败修复后按当前代码复验，新增 unit tests 覆盖拒发/throw/重复/成功。容器只用于本 run，已清理。
- API/Core/frontend/sandbox 四模块 typecheck 通过；最终 frontend typecheck 通过；frontend build+CSP 通过，有既有 chunk size warning。
- `pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、`pnpm security:scan`、`pnpm security:audit` 通过。
- `pnpm lint`：262 warnings /0 errors（既有 warnings）；`git diff --check` 通过。

隔离存储验证使用唯一容器 `max128-qualification-82fa`（mysql:8.4）、独立端口 MySQL 13318 /API 13018 /WS 28898 /Vite 5199 /fixture provider 28918，启动脚本 `scripts/qualification/serve-e2e.sh`，当前分支代码。只清空该新容器内部 qualification schema；未使用现有 MySQL、生产数据或付费模型。runtime 恢复测试对失败点实施受控故障注入；正常事务和最终落库仍为真实 MySQL。

## 交付、兼容和回滚

本 PR 由父 MAX-124 审查、核验精确 head 八项 SUCCESS 后合并；子任务只置 in_review。CI 条件规则 `01a10a16-03f1-7158-acde-1e35eaa19262`，continuous，max-fires 1000，有效至 2026-10-12T03:22:57.389625Z。每次推送前和退出前核验；pending 交规则续跑，不能把本地通过当 CI 成功。

回滚整个提交恢复旧 Markdown renderer 和 phase/UI 接线，数据结构没有迁移；已有 `SLIDE_PARTS_STREAM_ENABLED=false` 仅作协议回退，不能关闭新 Markdown。DOMPurify、链接协议白名单、140k 资源上限保持。性能结论限固定环境；真实付费 provider、多机器传输和任意大型文档未测，不承诺 LLM 首 token 100ms。

附件证据包提供 CDP trace（Chrome DevTools Performance 导入）、Playwright traces（`playwright show-trace`）、截图、原始 metrics、验收报告、相关门禁日志、源码 hashes 与 candidate SHA。压缩包实际大小和 SHA-256 随交付，trace 不加入 Git。

资源硬预算未设定；子代理 0、最大深度 0、并发代理峰值 1。raw input/cached input/output/实际费用遥测不可用，标准化实际吞吐也不可用；未用内部计数代替实测。
