# 原型浏览器验证记录

日期：2026-10-26｜对象：[prototype/](prototype/) 独立原型（演示数据，不连后端）｜结论：45/45 自动化检查通过；生产详情页未修改，生产回归仍待实施后执行。

## 1. 环境

| 项 | 值 |
|---|---|
| 系统 | macOS 27.0.1（Darwin 27.0.0），Apple Silicon |
| 浏览器 | Google Chrome 155.0.8059.85（headless new） |
| 驱动 | Node v24.18.0 + Chrome DevTools Protocol（零第三方依赖） |
| 原型服务 | `python3 -m http.server 8971 --bind 127.0.0.1`，仅本机 |
| 视口 | 1440×900（主验）、1366×768、1920×1080；另加 1100×800 降级检查与 1366×768 长名称 |
| 数据 | 全部为演示数据；无 API、无模型、无真实资源，不写任何后端状态 |

## 2. 复现命令

```bash
# 1) 启动原型（仓库根目录执行）
cd docs/slide/development/MAX-241/prototype && python3 -m http.server 8971 --bind 127.0.0.1

# 2) 另开终端，执行检查与截图
node docs/slide/development/MAX-241/verify/run-checks.mjs \
  http://127.0.0.1:8971 \
  /Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/screenshots
```

输出：逐项 PASS/FAIL、`checks.json`（机器可读结果）与截图。脚本只读页面，不修改产品代码。

## 3. 检查结果（45/45）

| 分组 | 检查 | 结果 |
|---|---|---|
| 列表 × 3 类 | 业务列恰好八列且名称符合 Issue 要求（数据库：序号/实例/地址/版本/观测健康/采集状态/最近成功采集/操作；服务器：主机名称/系统版本；网络设备：设备/型号） | 通过 |
| 列表 × 3 类 | 行内四操作完整展开（详情/编辑/测试/删除） | 通过 |
| 列表 × 3 类 | 1440×900 无整页横向溢出；表格具备 `role="region"` 局部横滚容器 | 通过 |
| 详情 × 3 类 | 页签集合与顺序与实现一致（13 / 10 / 6） | 通过 |
| 详情 × 3 类 | 保留关联调查 / 事件 / 审计联动行 | 通过 |
| 键盘 | `→` 从“概览”切到“监控配置”，焦点跟随且 `aria-selected` 同步 | 通过 |
| 键盘 | 页签可获得可见焦点环（`outline-style: solid`） | 通过 |
| 弹窗 | “测试连接”打开后焦点进入弹窗 | 通过 |
| 弹窗 | `Esc` 关闭并把焦点还给触发按钮 | 通过 |
| 状态 | 正常 / 无数据 / 加载中 / 加载失败 / 部分失败 / 无权限 六态均有明确呈现 | 通过（6/6） |
| 状态 | 无权限不显示采集数据，显示“无权读取…”，无缓存内容 | 通过 |
| 宽度 | 1440×900 / 1366×768 / 1920×1080 列表无整页溢出、四操作可达 | 通过 |
| 宽度 | 同三档下服务器诊断、网络设备配置备份详情无整页溢出 | 通过 |
| 长名称 | 1366×768 下 H1 换行、主操作仍可见、无整页溢出 | 通过 |
| 降级 | 1100×800 时只在表格容器内横滚，整页不溢出，滚动提示存在 | 通过 |

机器可读结果：`/Users/max/Coding/40-Slide/outputs/MAX-241-2026-10-26/checks.json`。

## 4. 截图索引（`outputs/MAX-241-2026-10-26/screenshots/`）

| 文件 | 用途 |
|---|---|
| `db-list-1440x900.png` / `server-list-1440x900.png` / `network-list-1440x900.png` | 三列表八列 + 四操作 + 局部横滚容器 |
| `db-list-1366x768.png` / `db-list-1920x1080.png` | 三档宽度列表 |
| `db-list-narrow-1100x800.png` | 窄窗口降级为表格内横滚 |
| `db-detail-overview-1440x900.png` | 详情共享框架 + 处理与治理（拟建）区块 |
| `db-detail-collection-full-1440x900.png` | 监控配置：模板、有效参数、有效触发器（拟建）、覆盖、配置事件 |
| `db-detail-topsql-full-1440x900.png` | 慢查询（来源与读取时间说明、空/错状态文案） |
| `db-detail-capacity-full-1440x900.png` | 容量 + 历史采样 |
| `server-detail-overview-1440x900.png` | 服务器共享框架 |
| `server-detail-diagnostics-1440x900.png` / `-1366x768` / `-1920x1080` | 诊断证据条、分区部分失败、唯一采集操作 |
| `server-detail-related-full-1440x900.png` | 关联资源（托管实例 + 关系摘要） |
| `network-detail-overview-1440x900.png` | 网络设备共享框架 |
| `network-detail-backups-1440x900.png` / `-1366x768` / `-1920x1080` / `-full` | 定时备份 + 配置备份列表 |
| `network-detail-interfaces-full-1440x900.png` | 接口搜索/筛选/表格与语义说明 |
| `db-detail-state-{empty,loading,error,partial,forbidden}-1440x900.png` | 六态中的五态（正常态见 overview） |
| `db-detail-focus-1440x900.png` | 键盘切页签后的焦点环 |
| `db-list-test-dialog-1440x900.png` | 测试连接弹窗（凭据不落库） |
| `db-detail-long-name-1366x768.png` | 长名称换行 |

## 5. 未覆盖与限制

- 原型为静态演示：**未连接后端**，采集、模板发布、备份、诊断、AI 均为本地演示；截图不构成生产能力证据。
- 键盘验证覆盖页签方向键、弹窗焦点进入/`Esc` 返回、焦点环；未做完整无障碍树与读屏验收（项目范围明确排除人工读读屏门禁）。
- 未验证：真实权限矩阵、真实采集/历史时槽、事件与审计过滤、通知、真实业务闭环——这些属 P1/集成阶段与 A01/A02/A05/A09 等验收项。
- 未做移动/平板、深色、多语言专项（项目范围排除）。
- 原型复用 Slide 设计语言（tokens、按钮契约、卡片/徽章/空状态外观），但不是生产 Lit 组件；生产实施时以现有 `instance-detail` / `server-detail` / `network-device-detail` 为基线修改，不复制原型代码。
