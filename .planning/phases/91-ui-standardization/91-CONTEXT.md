# Phase 91: UI Standardization - Context

**Phase:** 91-ui-standardization
**Requirements:** UI-01 (UI风格一致化), UI-02 (菜单精简)

## Locked Decisions

### D-01: CSS变量体系
- 统一 font-size: `--text-xs`(11px) / `--text-sm`(12px) / `--text-base`(13px) / `--text-md`(14px) / `--text-lg`(16px) / `--text-xl`(18px) / `--text-2xl`(22px)
- 统一 sizing: `--radius-sm` / `--radius-md` / `--radius-lg`
- 统一 spacing: `--space-xs`(4px) / `--space-sm`(8px) / `--space-md`(12px) / `--space-lg`(16px) / `--space-xl`(24px)
- 统一种子变量定义在全局 CSS 一处

### D-02: 菜单精简 - 移除项
| 菜单组 | 移除 | 保留 |
|--------|------|------|
| openclaw | sessions, usage, skills | overview, cron, agents |
| settings | config, appearance, system | users, llm-config, rbac |

### D-03: 菜单精简 - 清理项
- 移除导航类型 `Tab` union 中的对应值
- 移除 `TAB_GROUPS` 中的对应项
- 移除 `TAB_PATHS`、`PATH_TO_TAB`、`iconForTab`、`titleForTab` 中的死代码
- 移除 `app-render.ts` 中对应页面的 import 和 switch case
- 移除不再使用的 view 文件 import

### D-04: 全局样式文件
- 在 `frontend/src/openclaw/styles/` 创建共享 CSS 文件
- 统一定义 typography、spacing、radius 变量
- 各页面复用全局变量而非各自硬编码

### Claude's Discretion
- 变量命名方式
- 哪些页面先统一风格
- 是否抽取共享 Lit CSS 模板
