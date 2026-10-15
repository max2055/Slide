# MAX-167：字段标签与控件关联验收

日期：2026-10-15。基线 `main`：`589cab137d7c6d2339a1032fb6c7f0b85337b96b`（含 PR #176）。代码与测试候选：`7a3d0b15c3ec2d66719cf353dd8e7817da4df2eb`。分支：`codex/MAX-167-form-labels`。

## 修复与边界

`app-form-field` 的视觉标签在 Shadow DOM，原生控件在消费方树中；跨树的 `for` / IDREF 无法建立原生关联。修复在控件所在树内生成隐藏的原生 label 和说明节点，视觉标签点击聚焦该字段自己的控件。节点经独立命名插槽呈现，不移动原有标签、控件、提示、错误或表单布局。

- 每个组件实例分配独立关联 ID；保留调用方已有 ID、原生标签、`aria-label`、`aria-labelledby` 与说明 ID。
- 错误通过同树 `aria-describedby` 关联，同时设置 `aria-invalid=true`；错误消失恢复调用方原状态，重新显示提示说明。
- 插槽初次加载、嵌套容器内延迟插入和替换控件均重新关联；旧控件解除组件拥有的说明和错误状态；跳过隐藏输入及嵌套字段。
- 沿用原先的首个本层原生 input/select/textarea 约定；复合字段各子控件既有显式命名保持优先。不改写其他业务页面或重定义复合字段语义。
- 评分页面给四个滑块建立同树原生 label / 描述关联，并提供百分比 `aria-valuetext`。系统审计直接获得共享组件修复，无需修改消费页。

## 实际浏览器与真实业务

运行 `bash scripts/qualification/run-form-fields-ui.sh`：临时独立 MySQL 8.4 容器、真实 Fastify/JWT/实时权限/SQL 服务和本工作树 Vite。API 3098、Agent WS 28998、前端 5199；脚本退出回收服务及容器。与共享开发服务隔离。

API 启动要求配置 Provider；仅在临时数据库启用仓库本地测试 Provider（localhost:28999，模型 qualification-cancellable），无推理请求、无产品模型调用。没有使用历史临时密钥。

Chromium，1280×900，浅色主题，实际应用路由：

| 验收 | 证据 |
| --- | --- |
| 评分保存/刷新 | `/settings/monitoring/analysis?view=scoring`：点击“可用性”标签聚焦，方向键调整 5%，Tab 到“性能”反向补偿，PUT 200；刷新后两个实际数值保持，显示保存成功 |
| 评分可访问树 | CDP `Accessibility.getFullAXTree` 读出 slider：可用性、性能、容量、安全性，各自关联对应维度说明 |
| 系统审计有数据 | `/audit?view=system`：真实 GET 200，展示 SQL 审计记录（含评分配置 PUT）；关键字标签点击聚焦，Tab 到操作类型 |
| 审计可访问树 | 同一 CDP 树读出 searchbox“关键字”、combobox“操作类型”、DateTime“开始时间”“结束时间” |
| 系统审计成功为空 | 通过真实接口筛选不存在的关键字；响应 `{items: [], total: 0}`，显示“暂无系统审计记录”，字段名称保持 |
| 浏览器运行异常 | 本次真实业务流程 pageerror 为 0 |

实际浏览器受控场景与真实业务分开记录：

- 审计接口被 Playwright 定向延迟与返回 200 空/403/500：加载期间和请求结束后控件名称、标签聚焦保持可用；不把原页既有错误/权限文案当作本任务新增能力。
- 评分延迟加载、保存 500、保存 403、成功响应 null：加载时无伪造滑块，失败后现有控件名称保留，null 显示“无法加载配置”。
- 共享组件错误节点：CDP 实际树读出 textbox“用户名”、描述“用户名不能为空”、invalid=true；错误清除恢复提示和既有 invalid 状态。
- 同名共享字段和两个独立评分页面：标签点击定位自身控件，不跨表单；已有名称/说明保持，替换为 textarea 后关联更新。
- 键盘 Tab、评分方向键及 1280 浅色/390 深色字段截图检查通过，无页面水平溢出。未进行人工读屏软件测试。

## 检查结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter slide-frontend exec vitest run src/app/ui/components/app-form-field.test.ts src/app/ui/views/system-audit.test.ts src/app/ui/views/audit-center.test.ts src/app/ui/views/settings-shell-security.test.ts` | 16/16 |
| `pnpm --filter slide-frontend test` | 108 文件，916/916 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm lint` | 0 errors；266 warnings，未扩展清理范围 |
| `pnpm --filter slide-frontend build` | 通过，CSP 检查通过；既有大 chunk 提示保留 |
| `pnpm --filter slide-frontend exec playwright test --config playwright.form-fields.config.ts` | 12/12，受控浏览器测试 |
| `bash scripts/qualification/run-form-fields-ui.sh` | 1/1，真实服务保存/刷新、有数据/空结果和实际 AX 树 |
| `pnpm --filter slide-frontend test:browser` | 184/184（包含新增 12 项） |
| `git diff --check` | 通过 |

新受控场景已纳入 `playwright.audit.config.ts`，随现有 browser CI 执行。组件回归在隔离恢复基线源码后验证了 5 个预期失败；修复后同一目标通过。没有采集代码覆盖率百分比，不以测试数量冒充覆盖率。

PR 和 CI 状态以本子任务交付评论及关联 PR 当前 head 为准；本地检查不代表 CI 或合并完成。未修改公开 API 契约，未做部署。
