---
phase: 110
slug: directadapter-switch
status: draft
shadcn_initialized: false
preset: none
created: 2026-05-26
---

# Phase 110 — UI Design Contract

> 前端 WebSocket 连接从 GatewayBrowserClient 切换到 DirectGatewayClient。新增 WS 连接状态指示器、断线重连 UI、重试耗尽提示。清理 settings 中 Gateway URL 和 Gateway 连接状态的显示。

---

## Phase Type

| Property | Value |
|----------|-------|
| 阶段性质 | 连接层切换 + UI 状态指示 |
| 新组件数 | 1 (WS 连接状态指示器) |
| 新页面数 | 0 |
| 设计系统变更 | 无 — 复用所有现有 tokens |
| 受影响视图 | `views/chat.ts` (输入框禁用/占位符/重新连接按钮), `views/config.ts` (移除 Gateway URL 行) |
| 受影响控制器 | `controllers/chat.ts` (GatewayRequestError 引用 → 通用 Error) |
| 待清理 | `gateway.ts` (完全移除), `controllers/health.ts` (移除), `controllers/assistant-identity.ts` (移除) |

---

## Visual Hierarchy

**Primary focal point:** WS 连接状态指示器圆点（Chat 页面底部）。其颜色变化（绿/灰/品红）是连接状态改变时用户最先注意到的元素。正常连接时为次要信息，断开/重连时升级为视觉焦点。

**Secondary:** Chat 输入框区域。禁用状态（灰色 + placeholder 变化）为次级信号，告知用户当前无法输入。

**During normal operation:** 焦点在输入框，状态指示器退为低调的绿色圆点（`--ok`）。
**During disconnection:** 焦点移至品红色圆点（`--danger`）+ "重新连接中..." 文案。
**When exhausted:** 焦点在"重新连接"按钮——唯一的可交互元素。

---

## Design System Reference

| Property | Value | Source |
|----------|-------|--------|
| 前端框架 | Lit 3.3 Web Components | `frontend/package.json` |
| CSS 方案 | CSS 自定义属性 (变量) | `frontend/src/openclaw/styles/base.css` |
| 图标系统 | Lucide 风格内联 SVG, 在 `frontend/src/icons.ts` 中定义为 Lit `html` 模板 | Phase 102 UI 统一 |
| 引用方式 | `icons.iconName` | `import { icons } from "../../../icons.js"` |
| 字体 | `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` | `--font-body` |
| 等宽字体 | `"JetBrains Mono", ui-monospace, ...` | `--mono` |

### 已有组件 (直接复用，不改)

| 组件 | 路径 | 用途 |
|------|------|------|
| `settings-info-row` 及其子元素 | `views/config.ts` + `styles/config.css` | 移除 Gateway 行和连接状态行；保留其他行不变 |
| `settings-status-dot` | `styles/config.css:644-655` | 模式参考 — WS 状态指示器复用相同视觉语言 |
| `chat-send-btn[disabled]` | `views/chat.ts:1828` | 输入禁用时发送按钮自动灰显 — 无需额外样式 |

---

## Spacing Scale

现有 tokens (在 `base.css:91-96` 定义)，不新增：

| Token | Value | Usage |
|-------|-------|-------|
| --space-xs | 4px | 状态指示器与文字间距 |
| --space-sm | 8px | 底部状态条内边距 |
| --space-md | 12px | 重新连接按钮与提示间距 |
| --space-lg | 16px | 底部状态条容器间距 |
| --space-xl | 24px | 聊天界面底部留白 |

Exceptions: `--space-md` (12px) — existing project token preserved for button horizontal padding. Grid-aligned (12 = 3 × 4px base unit). Not newly introduced by this phase.

---

## Typography

现有 tokens (在 `base.css:82-88` 定义)，不新增：

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 14px | 400 | 1.55 |
| Status indicator | 12px (--text-sm) | 400 | 1.4 |
| "连接失败" message | 13px (--text-base) | 400 | 1.5 |
| Reconnect button | 12px (--text-sm) | 600 | 1.4 |

Font weights: 2 (400 body, 600 interactive). Status indicator reuses body weight — differentiation comes from color and dot, not weight.

Color via `var(--muted)` for status text, `var(--danger)` for error message.

---

## Color

所有颜色直接复用 `base.css` 的 CSS 自定义属性。不新增色值。

| Role | Token | Usage |
|------|-------|-------|
| Connected indicator | `var(--ok)` (#22c55e) | 绿色圆点 — WS 已连接 |
| Disconnected indicator | `var(--danger)` (#b08df5) | 品红圆点 — WS 断开 (注意: 此 token 在当前主题中为淡紫色而非红色) |
| Wait indicator | `var(--muted)` (#838387) | 灰色圆点 — 首次连接前 |
| Error message | `var(--danger)` | "连接失败" 提示文字 |
| Disabled input | 继承原生 disabled 样式 | Textarea `?disabled=${!props.connected}` 自动应用 |
| Accent | `var(--accent)` | Reconnect 按钮的 hover 态 |

> **语义注意:** `--danger` (0xHex: #b08df5) 在 dark 主题中为淡紫色，不同于传统红色。这是项目现有设计选择。如果期望红色断线指示，需在 theme tokens 中确认或使用新的 CSS 变量。建议：复用 `--danger`，因为这是项目中"断开/错误"的语义 token。

Accent reserved for: Reconnect 按钮交互态 (hover/active) 和 2px focus ring

Destructive: none — 此阶段无破坏性操作

60/30/10 split: inherited from project defaults (base.css). No new color allocations in this phase.

---

## Component: WS 连接状态指示器

### 位置
聊天页面底部，输入框与工具栏之间 (`agent-chat__input` 下方) 或聊天 `card.chat` 内部最底部。

> 根据 CONTEXT.md D-12: "底部状态指示器。绿色指示灯 = 已连接，红色 = 断开。"

### 状态矩阵

| ConnectionState | Indicator Dot | Text | 行为 |
|--------------|--------------|------|------|
| `connecting` | `var(--muted)` 灰色圆点 | "正在连接..." | 初始连接或自动重连中 |
| `connected` | `var(--ok)` 绿色圆点 + `box-shadow` 发光 | "已连接" | 无 |
| `disconnected` (重连中) | `var(--danger)` 品红圆点 | "重新连接中..." | 输入框禁用，placeholder 改变 |
| `disconnected` (重试耗尽) | `var(--danger)` 品红圆点 | "连接失败" | 显示手动"重新连接"按钮 |

### 视觉规范
```
.connection-status {
  display: flex;
  align-items: center;
  gap: var(--space-xs) 8px;
  padding: 8px 16px;
  font-size: var(--text-sm, 12px);
  color: var(--muted);
  border-top: 1px solid var(--border);
  /* 位于 Chat 页面底部 */
}
```

Indicator dot:
```css
.connection-status__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
.connection-status__dot--connected {
  background: var(--ok);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 14%, transparent);
}
.connection-status__dot--disconnected {
  background: var(--danger);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 14%, transparent);
}
.connection-status__dot--connecting {
  background: var(--muted);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--muted) 14%, transparent);
}
```

Reconnect button (exhausted state only):
```css
.connection-status__reconnect {
  margin-left: auto;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  transition: border-color 100ms ease, background 100ms ease, color 100ms ease;
}
.connection-status__reconnect:hover {
  border-color: var(--accent);
  background: var(--accent-subtle);
  color: var(--accent);
}
```

### Animations
- Status dot transitions: `transition: background 300ms var(--ease-out), box-shadow 300ms var(--ease-out)`
- No pulsing/spinning animation — clean state transitions only
- "连接失败" 出现带 `fade-in` 动画 (已定义 `base.css:596-599`)

---

## Component: Chat 输入框断线状态

### 禁用状态 (disconnected or connecting)

| Property | Current | Phase 110 |
|----------|---------|-----------|
| Placeholder | "Connect to the gateway to start chatting..." | "重新连接中..." |
| Textarea disabled | `?disabled=${!props.connected}` | 保持不变 |
| Send button disabled | `?disabled=${!props.connected \|\| props.sending}` | 保持不变 |
| Attach button disabled | `?disabled=${!props.connected}` | 保持不变 |

**变更位置:** `views/chat.ts:1344-1348`

```diff
 const placeholder = props.connected
   ? ...
-  : "Connect to the gateway to start chatting..."
+  : "重新连接中..."
```

协议: 只有 Chat 页面受断线影响。其他功能 (Dashboard、告警列表、实例列表、AI Analysis invoke) 不依赖 WS，不受影响 (CONTEXT.md D-13)。

> 注意: 当 reconnect exhausted 时，placeholder 应切换为 "连接失败，请检查网络" 而非 "重新连接中..."。

### 重试耗尽显示

当 DirectGatewayClient 重试 10 次后 (指数退避 1s→30s, 约 5 分钟)，显示:

1. Connection status: `状态指示器显示红色圆点 + "连接失败" 文字`
2. Reconnect 按钮: `<button>重新连接</button>` — 点击后调用 `client.reconnect()` 重置计数器
3. Textarea placeholder: 切换为 "连接失败，请检查网络"
4. Textarea 保持 `disabled`

**实现提示:** DirectGatewayClient 的 `onStateChange` 回调需要区分 `disconnected` (重连中) 和 `exhausted` (重试耗尽)。建议在 `ConnectionState` 联合类型中增加 `'exhausted'` 状态，或在回调中传递附加信息。

---

## Settings 页面清理

### 移除 Gateway URL 行

**文件:** `views/config.ts`

Gateway URL 行 (`settings-info-row` 包含 `<span>Gateway</span>` + gatewayUrl 值) 完全移除。

当前代码 (约 L636-639):
```html
<div class="settings-info-row">
  <span class="settings-info-row__label">Gateway</span>
  <span class="settings-info-row__value mono">${props.gatewayUrl || "-"}</span>
</div>
```

移除后，Connection section 中不再包含 Gateway 相关行。

### 移除 Gateway 连接状态行

**文件:** `views/config.ts`

Gateway 连接状态指示器 (`settings-info-row` 包含 `settings-status-dot` + connected/offline 文字) 完全移除。

当前代码 (约 L640-648):
```html
<div class="settings-info-row">
  <span class="settings-info-row__label">Status</span>
  <span class="settings-info-row__value">
    <span class="settings-status-dot ${props.connected ? "settings-status-dot--ok" : ""}"></span>
    ${props.connected ? t("common.connected") : t("common.offline")}
  </span>
</div>
```

移除后，Connection section 中内容为:

```html
<div class="settings-appearance__section">
  <h3 class="settings-appearance__heading">Connection</h3>
  <div class="settings-info-grid">
    <!-- Gateway 行已移除 -->
    <!-- 连接状态行已移除 -->
    <!-- assistantName 行保持不变 -->
    ...
  </div>
</div>
```

### 移除 gatewayUrl prop

**文件:** `views/config.ts` — `ConfigProps` 接口中的 `gatewayUrl: string` (L66) 完全移除。

### 移除 gateway 导航条目

**文件:** `views/config.ts` — L153 的 `gateway` SVG icon 模板和 L412 的 `{ key: "gateway", label: "Gateway" }` 导航条目移除。如果 `ConfigProps` 中有 `connected` prop 仅在 Gateway 状态行使用，也一并移除。

---

## Copywriting Contract

| Element | Copy | 上下文 |
|---------|------|--------|
| Status connecting | "正在连接..." | indicator dot 旁的文字 |
| Status connected | "已连接" | 绿色圆点旁 |
| Status reconnecting | "重新连接中..." | 断线后自动重连时显示 |
| Status exhausted | "连接失败" | 重试 10 次耗尽后显示 |
| Placeholder (disconnected) | "重新连接中..." | 输入框 placeholder，输入框同时 disabled |
| Placeholder (exhausted) | "连接失败，请检查网络" | 重试耗尽后的输入框 placeholder |
| Reconnect button | "重新连接" | 重试耗尽后的手动重连按钮 |
| Error message (auth) | "认证失败，请重新登录" | WS auth 4001 关闭码触发，停止自动重连 |
| Gateway 清理 | 无文案 | settings 页面 Gateway URL 行完全移除 |

### 文案变更汇总

| 位置 | 旧文案 | 新文案 |
|------|--------|--------|
| `views/chat.ts` placeholder (断线时) | "Connect to the gateway to start chatting..." | "重新连接中..." |
| `views/chat.ts` placeholder (耗尽时) | (不存在) | "连接失败，请检查网络" |

---

## Component Inventory

### 新增

| 组件 | 类型 | 说明 |
|------|------|------|
| WS 连接状态指示器 | `views/chat.ts` 内部 inline template | 聊天页面底部，+/-3 个状态点 + 文案 + 重连按钮 |

### 移除

| 文件 | 原因 |
|------|------|
| `frontend/src/openclaw/ui/gateway.ts` | GatewayBrowserClient + 16 exports (D-01) |
| Gateway URL 行 (config.ts L636-639) | 不再需要 (D-05) |
| Gateway 连接状态行 (config.ts L640-648) | 由 WS 状态指示器替代 (D-05) |
| Gateway SVG icon (config.ts L153-161) | Gateway 侧栏条目移除 |
| Gateway 导航条目 (config.ts L412) | Gateway 侧栏条目移除 |
| `controllers/health.ts` | Gateway RPC `client.request("health")` 移除 (D-04) |
| `controllers/assistant-identity.ts` | Gateway RPC `client.request("agent.identity.get")` 移除 (D-04) |
| `app-gateway.ts` GatewayHost 相关 | GatewayBrowserClient 实例化和 onHello (D-01) |

### 修改

| 文件 | 变更 |
|------|------|
| `views/chat.ts` | 新增底端状态指示器 + 更新断线 placeholder + exhausted 状态 |
| `views/config.ts` | 移除 gatewayUrl prop、Gateway 行、Status 行、Gateway 导航、Gateway icon |
| `controllers/chat.ts` | `import { GatewayRequestError } from "../gateway.ts"` → 通用 Error 处理 (D-01) |
| `connect-error.ts` | `import type { GatewayErrorInfo }` → 移除或改为通用类型 (D-01) |
| `controllers/scope-errors.ts` | `import type { GatewayErrorInfo }` → 移除或改为通用类型 (D-01) |
| `direct-gateway.ts` | 新增 auth 首帧发送 (D-09)、4001 关闭码检测 (D-10)、onStateChange 增强 (区分 exhausted) |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| none | none | not applicable |

不新增任何第三方依赖。所有变更使用现有 CSS 变量和 Lit 内置功能。

---

## Interaction Design

### WS 连接生命周期 (前端视角)

```
[页面加载]
    │
    ▼
DirectGatewayClient.connect()
    │
    ├── WS onopen → 发送 auth 帧 {type:'auth', token}
    │       │
    │       ├── auth 成功 → onStateChange('connected') → 绿色点 + "已连接"
    │       │
    │       └── WS close(4001) → 认证失败 → 停止重连 → 显示"认证失败，请重新登录"
    │
    └── WS onclose (非 4001)
            │
            └── reconnectAttempts < 10
                    │
                    ├── 是 → 指数退避重连 → onStateChange('connecting') → 灰色点 + "重新连接中..."
                    │                                  → 输入框 disabled
                    │                                  → placeholder "重新连接中..."
                    │
                    └── 否 → onStateChange('exhausted')
                              → 红色点 + "连接失败"
                              → 输入框 disabled
                              → placeholder "连接失败，请检查网络"
                              → 显示 "重新连接" 按钮
                              → 用户点击 → 重置计数器 → connect()
```

### 消息队列

断线期间用户发送的消息暂存队列。重连成功后自动发送 (D-07)。队列 UI 复用现有 `props.queue` + `chat-queue` 渲染 (已存在于 `views/chat.ts:L1705-1732`)。**此阶段仅需确保 DirectGatewayClient 在重连后 flush 队列，不需额外 UI 变更。**

### 重连后状态恢复

重连成功后自动调用 `GET /api/chat/history?sessionKey=xxx` 恢复对话上下文 (D-14)。使用现有的 chat history REST API。用户看到的和断线前一致。

### 多 Tab 互不干扰

每个浏览器 Tab 独立维护 WS 连接。一个 Tab 断线不影响其他 Tab (D-16 item 7)。此行为由 WS 连接的浏览器级隔离保证，不需前端额外处理。

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
