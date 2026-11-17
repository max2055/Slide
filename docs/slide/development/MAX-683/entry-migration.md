# MAX-683 工作台入口迁移

执行依据：Slide #581 与 Max 2026-11-16 确认。规范页面为 `/workbench`，名称“AI 工作台”，页签“调查”和“行动计划”（`workspaceTab=actions`）。内部 Tab 标识 investigations 为兼容偏好继续保留，不代表公开路径。

| 原入口/生产者 | 新入口/处理 |
|---|---|
| `/investigations`、`/?tab=investigations` | `/workbench`，原查询、resource多值、entry、investigation及全部attention版本绑定原样保留 |
| `/attention`、`/?tab=attention` | `/events?view=aggregate&eventList=active`，活动列表沿用 open/investigating/handled 与服务器分页 |
| `/operations-actions`、`/?tab=operations-actions` | `/workbench?workspaceTab=actions`，plan/sourceInvestigation/resultVersion/targetId及全部历史参数原样保留 |
| 旧默认首页 attention/operations-actions | 启动时解析至同一兼容落点；本地和服务端偏好均经过相同启动解析，不丢弃历史值。首页选择不再提供独立菜单 |
| resource-investigation-links、investigation-entryHref、system-events | 调查规范地址；时间窗口、对象与返回位置语义不变 |
| investigation-attention、handoff、operation-context | 原记录提醒、关联计划与草案链接改规范地址；保留精确版本/hash及源结果 |
| operations-actions/knowledge 的来源调查链接 | 返回同一 `/workbench?investigation=…` |
| approval-dashboard | 行动审批绑定计划版本/hash/approval跳转同一详情；保存原队列筛选与分页，returnTo返回 `/approval`；其他审批类型不迁移 |
| 返回地址 | 仅允许站内工作台、旧调查/行动、审批、事件路径；旧路径规范化，不接受站外、协议相对、反斜杠或控制字符 |
| 行动筛选与分页 | actionState/actionCursor写入浏览历史，返回/前进重新读取授权原记录；sourceInvestigation保持原过滤 |

兼容是替换浏览器地址，不创建第二套页面、状态、审批或执行。路径变换保留未知参数，避免未来或历史上下文丢失。服务端 `/api/investigations` 和行动API路径不变，业务数据不迁移。

权限：外壳按调查或行动可访问能力开放；页签分别要求 chat:view、operations:actions:view。没有调查权限的行动用户不请求调查正文/列表，计划仍由服务端原资源授权读取。权限变化、会话失效卸载敏感视图，读取控制器废弃在途旧结果。计划作者自批限制、准确版本与hash、实时授权、批准有效期和未知回执核对沿用服务端约束。

计划发现只在原授权读取成功后增加更新时间与该计划版本的报告状态；报告状态是原记录投影，不作为自动结案依据。执行成功与业务恢复分别呈现，调查内关联计划和全局列表打开同一详情。

验证入口：前端 workbench-routing.test.ts、views/workbench.test.ts、operations-actions.test.ts 与已有入口回归；后端 actions/plan-service.mysql.test.ts 包含 MAX-683 仅行动权限发现/撤权案例。真实业务端到端、三种桌面尺寸及独立复核的完成情况以交付证据为准，测试夹具不等于正式业务验收。保留键盘、焦点、控件名称与受影响自动化检查，不增加听读门禁。
