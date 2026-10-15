# MAX-179 品牌设置 R1.1 验收

2026-10-15。审定 base：`3f3033085a90be18b8712af6cfee4e6494c23f4a`，包含 MAX-167 merge `290592a90740d7293c84ae8e1d51d20ae219b13a`。实现/浏览器验收代码：`a755e402ee2215544838ee80a3ff49d31dfd15d8`。后续交付提交仅增加本报告，截图对应的产品源文件未变，SHA256：`8c533f227bfc5b4af42062b2987af02933933b5863d8482f137b7e0b0251d4c5`。

## 设计对照与范围

依据任务所附 R1.1 包，SHA256 `112502a0ad6dbadc7eea35efda027ccfb079fed756bf0ed51956ac6fd71347fe`，代表稿 `evidence/branding-desktop.png` / `#branding`。保留单容器、任务分组、左侧组说明/右侧字段、细分隔线、统一表单轴线和页尾主操作，页面/区块/正文/辅助字号 24（窄屏22）/16/14/12px。复用 app-card、app-form-field 和现有主题/按钮，不移植原型导航和状态开关。

基线真实品牌服务仅支持 `product_name`、`cli_name`、`env_prefix`、`state_dir` 四项，没有图标上传、登录欢迎语、副标题或页脚字段/接口。因此按“产品标识”和“命令与运行环境”适配当前字段，保留全部原字段及校验，不从原型发明上传/页脚能力。预览明确为产品名称文字预览；上传失败、长页脚和弹窗焦点不适用于当前组件。实际应用壳占用宽度与原型不同，不重建导航。

唯一产品修改：`frontend/src/app/ui/views/branding-settings.ts`。其余新增文件均为 MAX-179 专属测试、执行脚本和报告；共享组件、全局 token/i18n、后端无改动。

## 验收结果

| 验收项 | 证据与结果 |
| --- | --- |
| 按任务分组、字段/说明/错误对齐 | 一个 app-card、两个 section；四个输入在各视口具有同一左边界；设计与实现对照见交付包 `comparison.html` |
| 字段与校验 | 四项必填；CLI/前缀原正则保留；空白和非法格式阻止 PUT；错误消费 MAX-167 原生名称/帮助/错误关联，首错聚焦、标签点击与 Tab 顺序通过 |
| 保存与反馈 | 页尾列明四项整体保存范围；有修改才可保存；撤销恢复最近已读取/保存值；保存期间禁编辑/重复提交；失败保留草稿，403明确权限；网络结果未知先回读核对 |
| 真实服务闭环 | 自有一次性 MySQL 容器和当前生产 Fastify 服务；真实密码登录/JWT、GET、PUT、内存 cache getter 与浏览器 reload；先测产品组，再测CLI/前缀/目录保存回读；长产品名保存与预览一致 |
| 响应式与主题 | 实际应用壳1440×960、768×960、390×960，浅/深各一轮；正常与长名称均有首屏和页尾截图；无整页横溢，页尾操作可滚动到达 |
| 特殊状态 | HTTP受控补充：读取加载、500、403、null、部分数据；保存中、失败、403、网络结果未知、空字段与非法输入；文件名 `controlled-*` 明确区分真实服务 |
| 隔离边界 | 仅修改专属临时库；未改共享品牌/Provider、未部署/重启共享服务、未操作绑定或采集、未发产品模型；测试结束端口51897–51900无监听、MAX179容器已清理 |

正常流的产品名称长文本为约130个汉字组成的隔离样本；实际写入/刷新后核验全文。CLI、环境前缀和目录保存为 `max179`、`MAX179`、`.max179`，仅存在于该次临时库。

| 真实视口（浅/深均一致） | 四输入左边界 | 输入宽度 | 整页宽度 |
| --- | ---: | ---: | ---: |
| 1440×960 | 689px | 690px | 1440px |
| 768×960 | 245px | 502px | 768px |
| 390×960 | 21px | 348px | 390px |

截图和逐次测量位于交付包 `evidence/`：`real-default-desktop`、`representative-product-real-save-refresh`、`real-shell-*`、`real-shell-footer-*`、`real-long-shell-*`、`controlled-*`。真实正常流 pageerror 为空；原始浏览器可访问树见 `accessibility.json`。截图 metadata 记录验收 commit、源文件摘要、数据来源、视口、主题；不是完整无障碍认证或性能认证。

## 检查与复现

- `pnpm --filter slide-frontend typecheck`：通过。
- `pnpm --filter slide-frontend test`：120文件，1053测试通过。
- `pnpm --filter slide-frontend build`：通过；两项生产脚本 CSP 检查通过；现存大 chunk 提示保留。
- `pnpm lint`：0错误；256项既有警告。
- `pnpm --filter slide-frontend exec playwright test form-fields.spec.ts --config playwright.form-fields.config.ts`：20通过，覆盖消费的共享字段API。
- `bash scripts/qualification/run-MAX-179.sh`：6通过；独立一次性 MySQL、应用服务与本地不可外联的模型 fixture 配置，未发起推理。约27秒，清理完整。
- `git diff --check`：通过。

首轮浏览器测试在已完成真实保存/截图后因测试内相对定位器错误超时；已修正定位器并完整重跑6项通过。报告只使用最终代码对应证据。

本次未变更公开契约、后端或权限规则，无需新增后端/契约实现检查。完整仓库CI及Chief合并门禁仍由当前PR执行；本地前端检查与截图不替代跨任务最终集成验收。当前真实服务没有图片上传/页脚能力，其相关验收不能声称已通过；不存在此组件的未知价格、冲突、多方编辑或弹窗流程。
