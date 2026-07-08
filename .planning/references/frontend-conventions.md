# 前端开发参考

## 共享组件清单

| 元素类型 | 共享组件/样式 |
|---------|-------------|
| Primary 按钮 | `class="btn-primary"` (shared-btn-styles.ts) |
| 次要按钮 | `class="btn"` |
| Ghost 按钮 | `class="btn-ghost"` |
| 卡片容器 | `<app-card>` |
| 弹窗/对话框 | `<app-dialog>` |
| 表单字段 | `<app-form-field>` |
| 数据表格 | `<app-data-table>` |
| 空状态 | `<app-empty-state>` |
| 徽章/标签 | `<app-badge>` |
| Toast 通知 | `showToast()` (app-toast-container) |
| 统计卡片 | `<stat-card>` |
| 加载态 | `.skeleton` 类 |

## 关键约定
- 主色调：`var(--accent)` = `#409eff`（蓝色）
- Boolean 属性绑定必须用 `.property=${value}`
- Light DOM 视图用 inline `<style>`，不用 `static styles`
- 第一次出现用自定义样式，第二次出现必须提取共享组件
