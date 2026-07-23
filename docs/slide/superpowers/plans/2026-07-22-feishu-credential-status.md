# Feishu Credential Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saved Feishu webhook and signing-secret state unmistakable without returning either credential to the browser.

**Architecture:** Keep the existing redacted notification DTO and component state. Render the existing `endpoint` and `hasStoredCredential` booleans as shared status badges, and make empty inputs explicitly represent replacement values. Update local state after successful saves while continuing to clear sensitive fields.

**Tech Stack:** Lit 3, TypeScript, Vitest, existing `<app-card>`, `<app-form-field>`, and `<app-badge>` components.

---

### Task 1: Specify Saved Credential State

**Files:**
- Modify: `frontend/src/app/ui/views/feishu-notification-settings.test.ts`

- [ ] **Step 1: Write the failing existing-channel rendering assertions**

Extend `loads an existing Feishu channel without placing its secret in the form` with:

```ts
const text = subject.shadowRoot?.textContent || '';
expect(text).toContain('Webhook 已配置');
expect(text).toContain('签名密钥已配置');
expect(text).toContain('告警通知未启用');
expect(text).toContain('替换飞书 Webhook');
expect(text).toContain('更新签名密钥');

const inputs = subject.shadowRoot?.querySelectorAll<HTMLInputElement>('input') || [];
expect(inputs[0]?.placeholder).toBe('已保存，留空不变');
expect(inputs[1]?.placeholder).toBe('已安全保存，留空不变');
expect(inputs[0]?.value).toBe('');
expect(inputs[1]?.value).toBe('');
expect(subject.shadowRoot?.innerHTML).not.toContain('/open-apis/bot/v2/hook/');
```

- [ ] **Step 2: Write the failing post-save state assertions**

Extend `saves a new Feishu webhook with the supplied signing secret and enabled state` with:

```ts
await subject.updateComplete;
expect(subject.endpoint).toBe('https://open.feishu.cn');
expect(subject.hasStoredCredential).toBe(true);
expect(subject.webhookUrl).toBe('');
expect(subject.secret).toBe('');
expect(subject.shadowRoot?.textContent).toContain('Webhook 已配置');
expect(subject.shadowRoot?.textContent).toContain('签名密钥已配置');
expect(subject.shadowRoot?.textContent).toContain('告警通知已启用');
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm --filter slide-frontend exec vitest run src/app/ui/views/feishu-notification-settings.test.ts
```

Expected: FAIL because the current page still renders `已配置通道`, `飞书 Webhook`, and empty default placeholders.

### Task 2: Render Explicit Saved State

**Files:**
- Modify: `frontend/src/app/ui/views/feishu-notification-settings.ts`
- Test: `frontend/src/app/ui/views/feishu-notification-settings.test.ts`

- [ ] **Step 1: Import the shared badge component**

Add:

```ts
import '../components/app-badge.js';
```

- [ ] **Step 2: Replace the ambiguous status row**

Render three independent badges:

```ts
<div class="status" aria-label="飞书通知配置状态">
  <app-badge variant=${this.endpoint ? 'ok' : 'muted'}>
    ${this.endpoint ? 'Webhook 已配置' : 'Webhook 未配置'}
  </app-badge>
  <app-badge variant=${this.hasStoredCredential ? 'ok' : 'muted'}>
    ${this.hasStoredCredential ? '签名密钥已配置' : '签名密钥未配置'}
  </app-badge>
  <app-badge variant=${this.enabled ? 'ok' : 'warn'}>
    ${this.enabled ? '告警通知已启用' : '告警通知未启用'}
  </app-badge>
</div>
```

Keep `.status` wrapping on narrow screens and remove the obsolete nested `strong` rule.

- [ ] **Step 3: Make inputs replacement actions**

Use state-aware labels and placeholders:

```ts
<app-form-field
  label=${this.channelId ? '替换飞书 Webhook' : '飞书 Webhook'}
  hint="仅接受 open.feishu.cn 的 HTTPS 自定义机器人地址。留空表示保留已保存地址。"
  .error=${this.error && this.error.includes('Webhook') ? this.error : ''}>
  <input
    class="field-input"
    type="url"
    autocomplete="off"
    placeholder=${this.endpoint ? '已保存，留空不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'}
    .value=${this.webhookUrl}
    @input=${(event: Event) => { this.webhookUrl = (event.target as HTMLInputElement).value; }}>
</app-form-field>
```

Use `更新签名密钥` and `已安全保存，留空不变` for the saved secret state. Keep `.value` empty after load/save.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter slide-frontend exec vitest run src/app/ui/views/feishu-notification-settings.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the focused implementation**

```bash
git add frontend/src/app/ui/views/feishu-notification-settings.ts frontend/src/app/ui/views/feishu-notification-settings.test.ts
git commit -m "fix(frontend): clarify saved Feishu credentials"
```

### Task 3: Verify Safety and Browser Behavior

**Files:**
- Modify only if a test exposes a defect: `frontend/src/app/ui/views/feishu-notification-settings.ts`
- Test: `frontend/src/app/ui/views/feishu-notification-settings.test.ts`

- [ ] **Step 1: Run frontend checks**

```bash
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend exec vitest run src/app/ui/views/feishu-notification-settings.test.ts
pnpm --filter slide-frontend build
```

Expected: typecheck, focused tests, and production build all exit zero.

- [ ] **Step 2: Verify in the running browser**

Open `http://localhost:5173`, log in as the administrator, navigate to Settings then Feishu Notifications, and assert:

```text
Webhook 已配置
签名密钥已配置
告警通知已启用
替换飞书 Webhook
更新签名密钥
```

Inspect both input values and the page DOM. Expected: both sensitive inputs are empty, and neither the webhook path nor signing secret occurs in DOM text or attributes.

- [ ] **Step 3: Exercise the existing test action**

Click `发送测试消息`. Expected: success toast `测试消息已发送，请在飞书群中确认。` and a new test alert in the configured Feishu group.

- [ ] **Step 4: Check the final diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing worktree changes remain untouched.
