# MAX-241 三类完整资源详情原型

演示数据、纯前端、不连后端。用于评审[详情设计](../03-detail-design.md)、权限门控与六类状态；**不是生产验收依据**。

## 运行（需要 Vite）

原型只读复用 `frontend/src/app` 的共享组件与样式，因此用 Vite 提供服务（不是零构建的静态页）：

```bash
# 1) 安装依赖（仓库根目录；已有 node_modules 可跳过）
pnpm install --frozen-lockfile

# 2) 启动原型（仓库根目录）
frontend/node_modules/.bin/vite --config docs/slide/development/MAX-241/prototype/vite.config.mjs

# 3) 浏览器打开
# http://127.0.0.1:8971/docs/slide/development/MAX-241/prototype/index.html
```

`vite.config.mjs` 以仓库根为 `root`，让 `lit` 从 `frontend/node_modules` 解析，并允许读取 `frontend/src`。不修改产品代码，不写后端状态，不调用模型。

## 共享组件复用（对应 frontend/AGENTS.md）

| 元素 | 使用的共享实现 | 说明 |
|---|---|---|
| 卡片 | `app-card` | 页面卡片/区块，带 header slot |
| 弹窗 | `app-dialog` | 原生 `<dialog>`、焦点管理与 Esc |
| 徽章 | `app-badge` | 健康/采集/权限状态 |
| 空状态 | `app-empty-state` | 无数据/无权限/加载失败 |
| 表格 | `app-data-table` | 列表与详情表格 |
| 表单字段 | `app-form-field` | 模板/参数编辑 |
| Toast | `showToast()` + `app-toast-container` | 不适用 `alert()` |
| 按钮/主题 | `shared-btn-styles.css` + `base.css`（含 tokens） | 不重复定义 `.btn` / 颜色 |

**保留的自定义样式**（见 `styles.css`）：原型外壳（评审条、侧边导航、详情页签、布局网格）、`.table-scroll` 横滚容器、状态提示/图表占位。这些不是通用卡片/按钮/弹窗外观，均消费主题 token。没有 `.card` / `.badge` / `.dialog` / `.toast` 自定义类。

## 配置演示规则（R4/R6）

- **兼容性**：检查会比对资源引擎族与所选模板引擎（MySQL / PostgreSQL / 达梦 / Linux / Huawei / Cisco）。不一致时第一步标 ✕，给出拒绝原因，禁用试采与发布，点击也不推进流程；页头“试采”先执行同一检查，不绕过四步。修改模板或参数会令旧的检查与试采失效。
- **试采明细**：数据为 `[采集项, 结果, 说明]` 数组，逐项渲染成功、部分失败（含错误码如 `ER_TABLEACCESS_DENIED`）、待验证、模板未覆盖，并在表格后汇总未全部成功项。最近一次试采在模板变更后仍可查看，但标注“已失效、不能作为发布依据”。
- 演示状态机不等同生产 `metric-configuration` 接入；真实模板目录、兼容性判定与试采/发布接口在实施阶段验证。

## URL 参数（便于逐状态评审与截图）

| 参数 | 取值 | 说明 |
|---|---|---|
| `class` | `db` / `server` / `network` | 资源类型 |
| `view` | `list` / `detail` | 列表或完整详情 |
| `id` | 资源 id（如 `9`） | 详情绑定到该行；缺省为首行 |
| `tab` | 页签 key（`overview` / `collection` / `metrics` / `diagnostics` / `backups` …） | 详情页签 |
| `state` | `normal` / `empty` / `loading` / `error` / `partial` / `forbidden` / `module403` | 正常 / 无数据 / 加载中 / 加载失败 / 部分失败 / 页面 403 / 模块 403 |
| `perm` | `full` / `view` / `manager` / `backup` / `none` | 权限预设（见下） |
| `filter` | `all` / `healthy` / `warning` / `critical` / `unknown` | 列表筛选 |
| `long` | `1` | 长名称演示 |
| `full` | `1` | 整页截图用，允许内容区展开 |

旧深链接兼容：`?tab=instance-detail&id=9`、`?tab=server-detail&id=18`、`?tab=network-device-detail&networkDeviceId=31` 均可直接打开对应详情。

示例：`index.html?class=network&view=detail&id=30&tab=collection&perm=manager`

## 权限预设

| 预设 | 含义 | 演示点 |
|---|---|---|
| `full` | 全部权限 | 四操作、监控配置编辑、立即备份 |
| `view` | 只有 `:view` | 编辑/测试/删除禁用；监控配置只读 |
| `manager` | 有 `:manage`、无备份写、无实例 update/delete | 数据库编辑/删除禁用但监控配置可编辑；网络备份可读不可写 |
| `backup` | `view + network_devices:backup` | 备份写可用；编辑/删除仍禁用 |
| `none` | 无权限 | 页面级 403，清空资源上下文 |

预设只影响原型展示；生产以服务端实时权限为准。逐项对照见 [06-permission-gates.md](../06-permission-gates.md)。

## 交互与键盘

- 页签：`←`/`→`/`Home`/`End` 切换，焦点跟随，`aria-selected` 同步。
- 弹窗：`app-dialog` 打开聚焦、`Esc` 关闭、焦点回到触发按钮。
- 表格：`.table-scroll` 可聚焦并横向滚动；主操作在容器内滚动后可达。
- 列表“详情”按行 id 打开；返回恢复筛选、横向位置与来源按钮焦点。
- 监控配置：修改模板/参数 → 检查兼容性与权限 → 试采 → 发布并应用 → 等待正式采集；试采不写正式历史，发布不宣称全部指标可用。
- 所有写操作均为本地演示：不保存、不发请求、不写审计、不调用模型。

## 文件

| 文件 | 内容 |
|---|---|
| `index.html` | 外壳、评审批控制条、共享样式入口 |
| `vite.config.mjs` | 以仓库根为 root，只读解析 `frontend/src` 与 `lit` |
| `app.js` | 演示数据、列表/详情、权限预设、状态、配置流程、键盘与弹窗 |
| `styles.css` | 仅原型外壳/布局/横滚/页签样式，不含通用组件外观 |

验证脚本与结果见 [../05-validation.md](../05-validation.md)。
