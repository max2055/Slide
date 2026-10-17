# MAX-190 R1 定向视觉补证（2026-10-17）

对应 Chief 评论 `01a147c8-04f8-7b86-95ad-2ac7d0a30e0c`、`01a147cc-8532-74c9-baaa-bf6529984cee`。本次仅修取证脚本；前后端生产源码未变，复用准确组合 `290f4e036e1b1b3845280e15c324db33f2df8f98`（tree `5dae4517293f4d3abacaf5a42d3ab083f3455c41`）的完整 14 绿 CI38995496346 和已核验 Linux 包。输入 A `d36bc93e081191c95a8801c8ebdf8c82bf0108a1`、B 生产基线 `a2549a14032538bca08d8002852b2dc8fc656a77`。不重跑 gate、打包、三周期或 VM。

## 根因与处理

| 问题 | 可复核根因 | 修正后证据 |
| --- | --- | --- |
| 浅色输入仍深色 | 旧路径只写 `dataset.themeMode`；复现得到 `theme=dark / themeMode=light / colorScheme=dark`，服务器输入背景仍 `rgb(24,24,27)` | 调用真实 `slide-app.setThemeMode`，经过 `applySettings/applyResolvedTheme`；浅色输入 `rgb(255,255,255)`、深色 `rgb(24,24,27)`，三个主题字段一致 |
| 390 浅色图左侧半透明层 | 旧路径在 viewport 改变后立即截图；复现时 `shell-nav` 的 transform/opacity 动画仍 running，关闭状态的导航右边界仍 320px | 确认抽屉关闭，等待 Lit、有限动画、字体和两帧布局稳定；桌面/窄屏、明暗三类编辑器无覆盖层。未修改产品导航或主题 CSS |
| 模板详情只见滚动 JSON | 旧脚本先展开高级 JSON，且未递归复位 Shadow DOM 滚动区；产品原始 JSON 默认折叠 | 先拍默认打开顶部，确认高级 JSON 折叠，再拍适用范围/权限/发现方式/推荐周期分区，最后独立展开 JSON 核对完整 pin 和取证 |
| basic 表单局部宽度 | 定向检查服务器、网络设备原生控件的实际矩形与字段/视口边界 | 1440/390、明暗共 68 次控件检查均未溢出；局部表单无需生产修复 |

冻结 R1 与 APPROVAL.md 继续适用。新截图替代此前矩阵中主题切换不完整、viewport 未稳定和默认模板详情缺失的证据，不把旧 77 张图整体视为有效视觉结论。旧图保留作历史和修前对照。

## 验证与环境

在准确组合工作树上覆盖本次 E2E 脚本运行，生产文件完全未变。使用真实 Vite 产品、Fastify、JWT 登录、Agent WS 与隔离 MySQL 8.4 平台；资源/模板元数据来自原平台只读复制，无 HTTP mock。全局 `METRICS_COLLECTION_ENABLED=false`，服务器/网络对象另行停用采集。新增全局停用提示属于补证环境事实，不伪造正式健康状态。

运行 `MAX190_AUTHENTICATED_REAL=1 MAX190_VISUAL_REVIEW=1` 的 `playwright.max190.auth.config.ts`：**1 项通过，测试 17.8s / 总 32.5s**。28 个主矩阵组合：MySQL 编辑器、服务器 basic/编辑器、网络 basic/编辑器、模板默认/高级详情，各 1440×1000、390×1000 和明暗。另补操作区、默认说明分区与高级 JSON，共 **60 张正确取证截图**，加 **2 张旧路径复现图**；最初未受控快照不作为交付证据。模板关闭后焦点恢复通过。

真实 API 列表证据确认未发起 trial/activate/test-connection，隔离平台 `metric_publications` 为 0；本次不是正式采集验收重跑。原资源/自定义 SQL/模板/Provider/路由/服务器/网络摘要保持一致。临时 API/Vite 正常退出、容器停止移除。产品 LLM 调用 0，不登录 VM、不做 SSH/SNMP。前端 typecheck、diff whitespace 检查通过；生产未变，不重复单测/构建/完整门禁。

首轮脚本在隔离 fixture 写入不存在的 `database_instances.collection_enabled` 列而停止，已移除该假定，仅用现有全局开关；下一轮因“采集包”页签属于外层页面而非 `metric-settings` 定位超时，已按实际 DOM 修正。两次均清理完成；修正后通过，再增加旧路径复现和 JSON 定向截图后最终复验通过。

## 交付与复审

完整附件包含 `report.md`、离线 `comparison.html`、矩阵 `result.json`、`provenance.json`、准确取证脚本、逐文件 SHA256、正确截图、旧图与冻结 R1 对照。私有启动日志、登录 trace、凭据和 Provider 内容不进入附件。包和校验和在 MAX-190 原交付线程提供。

PR200 保持草稿。准确组合门禁及原实采/字段一致性证据继续有效；本次不声称获得 Chief 最终视觉批准、审定 merge SHA 或已部署。新 head 若触发独立 PR CI，仍按本 Issue、15astra、原线程维护 checks/30m/on-timeout 接续；独立 B 缺 A 的失败与组合 CI 区分，禁止合并红灯。
