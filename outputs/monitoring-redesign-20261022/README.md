# Slide 监控与运维优化 · 原型 V4

2026-10-22。用户确认的范围已写入项目规则；本目录是独立可点击设计原型，不是生产发布。

## 入口与方案

- [监控模板](http://127.0.0.1:18173/#templates) · [事件中心](http://127.0.0.1:18173/#events) · [AI 工作空间](http://127.0.0.1:18173/#workspace) · [资源概览](http://127.0.0.1:18173/#resource-overview)
- [浏览器详细方案](http://127.0.0.1:18173/plan.html) · [项目范围](http://127.0.0.1:18173/scope.html)
- [项目范围原文](../../docs/slide/requirements/current-version-scope.md)
- [详细方案原文](../../docs/superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md)
- [AI 体验设计](../../docs/superpowers/specs/2026-10-22-ai-workspace-experience-review.md) · [少输入设计](../../docs/superpowers/specs/2026-10-22-input-burden-audit.md)
- [截图集](GALLERY.md) · [验证记录](VALIDATION.md) · [总览图](OVERVIEW.png)

## V4 更新

1. 本版只做中文、浅色、当前稳定 Chrome/Edge 桌面体验；1440×900 为主，1366×768 / 1920×1080 复核。已确认排除移动/平板、深色/换肤、听读顺序及完整无障碍专项、额外浏览器矩阵、国际化、装饰动效、特殊大屏/打印、PWA/离线、多套等价交互和穷举视觉组合。保留标签、焦点、基本键盘、错误反馈和业务安全质量。
2. 无 Agent 采集，人工维护 Slide 原生模板；移除 Zabbix 上游转换/适配标签，不做文件导入、表达式兼容、Agent/Proxy、后端集成或自动同步。AI Agent 运行时不受此边界影响。
3. 模板内新增“查看采集映射”：MySQL 原始字段与派生/速率、Linux SSH 内存/负载、SNMP 接口计数器与状态；明确最终单位、维度、稳定引用及缺口。
4. 自定义草稿的新增监控项改为选择演示注册指标，名称/标识/单位和映射自动带入。未注册项禁止加入；空名称、周期非法和重复指标校验保留。不要求手写内部 ID、SQL 或命令。
5. 事件中心取消“规则与策略”，保留四标签；事件详情展示当时规则快照和模板回链。当前阈值修改不改写事件或历史曲线；通知投递只展示结果与回执，配置复用已有统一入口。
6. 延续 V3 的四资源菜单、概览四子标签、八列四操作、全部授权模板选择器、模板内发现和统一 AI 故障调查/恢复流程。

## 推荐评审路径

- 监控模板 → MySQL 生产基线 → 查看采集映射 → 切换连接使用率 / 失败连接速率，观察原始字段、转换、最终值和身份关系。
- 返回模板 → 复制并编辑 → 保存演示草稿 → 新增监控项 → 选择失败连接速率 → 不手工填写即可加入。切换未注册脏页指标时按钮禁用；重复加入被阻止。
- Linux / 华为模板 → 查看采集映射，分别检查 SSH 与 SNMP 无 Agent 数据来源。Oracle/Dameng 草稿不代表已完成采集能力。
- 事件中心 → 活动告警 → 连接使用率过高 → 触发依据、规则版本、配置修订、查看来源模板。
- 数据库 → 监控配置 → 修改当前阈值为 95%；返回历史/原事件，仍展示发生时的 90%。只修改本地演示草稿，不应用真实配置。
- 通知投递查看成功和失败回执样例；事件详情进入 AI 工作空间，沿用少输入排查和恢复验证流程。
- 顶部“版本范围”打开已确认边界；“方案文档”查看更新后的完整方案。

## 交付和验证边界

2026-10-25 详情设计澄清：三类资源列表的“详情”应保留并完善现有 Slide 完整详情及专业能力。当前原型的简化详情弹窗只是入口占位，不能作为最终设计或据此删减功能；完整页面须先盘点现状并补齐原型。详见方案 §4.3。

所有数据是本地样例。模板的“内置/发布”、已注册指标和采集实现均是设计展示，不代表生产能力注册或真实采集成功。没有产品 API、SQL/SSH/SNMP、模型、通知或远程执行；刷新重置。

本轮验证改动交互、历史快照及桌面布局；V3 的独立审批、未知回执、三种复测等未改动流程保留，先前完整检查见 archive-v3/VALIDATION.md，本版不冒充重新完整验收。容量、真实权限、数据持久化、正式通知、采集正确性和真实恢复须生产实施后验证。

新建模板以 MySQL 为代表；复制保留原类型和引擎。原型仅提供代表指标选择与映射，其余能力未展开。未接入的发布/执行不以按钮存在宣称完成。

V1/V2/V3 源码及相应索引在 archive-v1/、archive-v2/、archive-v3/；旧截图保留原目录。本轮在 screenshots-v4/，历史手机/深色截图不再构成本版验收要求。

## 运行与再生成

从仓库根目录运行，复用现有依赖：

```sh
node frontend/node_modules/vite/bin/vite.js --config outputs/monitoring-redesign-20261022/prototype/vite.config.mjs
node outputs/monitoring-redesign-20261022/prototype/render-docs.cjs
node frontend/node_modules/typescript/bin/tsc -p outputs/monitoring-redesign-20261022/prototype/tsconfig.json
node frontend/node_modules/vite/bin/vite.js build --config outputs/monitoring-redesign-20261022/prototype/vite.config.mjs
```

沿用已核对的 PID 87396、127.0.0.1:18173、当前工作区原型服务；没有重启业务服务或变更生产源码。静态构建位于 prototype/dist/。
