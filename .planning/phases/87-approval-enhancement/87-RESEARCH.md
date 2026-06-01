# Phase 87: Approval Enhancement - Research

**Researched:** 2026-05-11
**Domain:** SQL Approval Workflow Enhancement (Frontend Lit + CodeMirror + Backend Fastify + Notification)
**Confidence:** HIGH

## Summary

Phase 87 extends the existing approval dashboard from a flat approve/reject list into a full-featured approval system with detail page (CodeMirror-readonly SQL viewer + metadata + timeline), batch approve/reject, optional auto-execute on approve, and notification integration.

The frontend work is entirely within the existing `approval-dashboard.ts` component (no new routes). CodeMirror 6 is already in the project dependencies and the read-only pattern is directly adapted from `sql-console.ts`. The backend needs: (1) an `execute_after_approve` parameter added to `reviewRequest`, (2) a new `POST /api/approval/batch-review` endpoint, (3) a new `approval_events` table for the full timeline, and (4) a `buildApprovalMessage()` method on NotificationService for channel-specific approval notification formats.

The audit log infrastructure (`audit-log.ts`) already defines approval event types (`approval_request`, `approval_approved`, `approval_rejected`) which can be reused to populate the timeline, but the existing `approval_requests` table only records the final status and timestamps -- it cannot represent the full event sequence (submitted -> AI reviewed -> approved -> auto-executed -> notified). A dedicated `approval_events` table is the correct approach.

**Primary recommendation:** Create `approval_events` table for timeline data, add `execute_after_approve` to existing review endpoint, create new batch-review endpoint, implement read-only CodeMirror view for detail page, implement pure Lit/CSS timeline, add `buildApprovalMessage()` to NotificationService.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| APPR-01 | Approval detail page with SQL syntax highlighting in read-only CodeMirror | CodeMirror 6 already in deps; read-only config via `EditorView.editable.of(false)`; dialect switching via instance db_type |
| APPR-02 | Full approval history timeline | New `approval_events` table needed; current `approval_requests` table cannot represent full event chain |
| APPR-03 | Batch select + approve/reject | New `POST /api/approval/batch-review` endpoint; frontend checkbox multi-select pattern |
| APPR-04 | Optional auto-execute SQL on approve | Add `execute_after_approve` param to `reviewRequest`; current behavior always auto-executes |
| APPR-05 | Reject writes comment back | Already works -- `reviewRequest` writes `review_notes` to `approval_requests` table |
| APPR-06 | Notification via existing channels | `buildApprovalMessage()` extends existing `notificationService.buildMessage()` pattern; channels via `notificationDatabaseService.getEnabledChannels()` |

## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Detail Page
- **D-01:** Component-internal sub-view switching -- approval-dashboard component internally manages list/detail two sub-views, no independent route registration, no modification to navigation.ts
- **D-02:** Full approval history timeline, including all event nodes: submit approval -> AI risk assessment -> approve/reject -> SQL auto-execution result -> notification sent
- **D-03:** Left-right split layout -- left side CodeMirror 6 read-only editor (SQL syntax highlighting, reuse sql-console.ts CodeMirror config), right side shows meta information (instance name, submitter, submit time, risk level, current status) + timeline

#### Batch Operations
- **D-04:** Each row in pending list has left checkbox for multi-select, top action bar auto-shows/hides (shown when any item checked, hidden when all unchecked)
- **D-05:** Click action bar "Approve (N)" or "Reject (N)" -- confirmation dialog appears, unified notes input before submit
- **D-06:** Unified operation -- same batch can only be all approved or all rejected, auto-filter non-pending requests from selection

#### Auto-Execute on Approve
- **D-07:** Each pending row has "execute after approval" checkbox, default checked (opt-out) -- approver unchecks items they don't want executed
- **D-08:** Backend reviewRequest accepts `execute_after_approve: boolean` parameter, replaces current hardcoded auto-execute behavior. Reject not affected by this parameter.
- **D-09:** Dual execution result display -- detail page timeline shows as "auto-execute" event node + processed list page shows execution duration and row count summary
- **D-10:** Batch approve shows independent execution results for each item that had auto-execute checked, inline in corresponding list item

#### Notification Integration
- **D-11:** Add `buildApprovalMessage()` method to notificationService (generates approval notification message per channel format), reuse existing `send()` / `sendWithRetry()` / `buildSignedUrl()` infrastructure
- **D-12:** Use system-level notification channels (`getEnabledChannels()`), no per-requestor channel configuration
- **D-13:** Both approve and reject send notifications, message includes: approval result, approver notes, SQL summary (first 100 chars), instance name, submit time

### Claude's Discretion
- Approval history timeline data source -- new audit table vs using existing approval_requests fields
- `buildApprovalMessage()` channel-specific message formats (dingtalk/wecom/feishu/webhook)
- Batch review backend API design -- new POST /api/approval/batch-review endpoint vs frontend loop calling individual review
- Detail page left panel CodeMirror config details (language mode switching MySQL/PostgreSQL based on instance type, readOnly, theme)
- Timeline component implementation (pure CSS / custom Lit component / third-party)
- Processed tab execution result display style

### Deferred Ideas (OUT OF SCOPE)
None.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SQL syntax highlighting (detail page) | Browser (Lit + CodeMirror) | -- | Read-only editor is a UI concern; CodeMirror 6 runs entirely in-browser |
| Approval history timeline | Browser (Lit + CSS) | Backend (data source) | Timeline UI is frontend rendering; the event data is fetched from backend |
| Batch multi-select + action bar | Browser (Lit) | -- | Pure UI state management (selected items set, show/hide action bar) |
| Batch approve/reject API | API / Backend | -- | New endpoint processes array of IDs with unified notes |
| Auto-execute on approve | API / Backend | Database / Storage | Backend coordinates approval+execution; execution result stored in DB |
| Execution result display | Browser (Lit) | API / Backend | Result data fetched from backend, rendered in timeline + list summary |
| Approval notification | API / Backend | External services (DingTalk/WeCom/Feishu) | NotificationService already sends to external webhooks |
| Component routing (list/detail) | Browser (Lit) | -- | Component-internal sub-view switching, no URL routing |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit | 3.3.2 | Web Components framework for all UI | Existing project standard; approval-dashboard.ts already uses LitElement |
| CodeMirror 6 | 6.0.2 (codemirror) | SQL editor with syntax highlighting | Already in project deps; sql-console.ts uses it; no additional install needed |
| @codemirror/view | 6.42.0 | CodeMirror EditorView for read-only SQL display | Already installed; provides `EditorView.editable.of(false)` for read-only |
| @codemirror/lang-sql | 6.10.0 | SQL language support + dialect switching | Already installed; provides `sql({ dialect: MySQL })` / `sql({ dialect: PostgreSQL })` |
| @codemirror/theme-one-dark | 6.1.3 | Dark theme for SQL editor | Already installed; sql-console.ts uses it |
| Fastify | 4.24.3 | Backend HTTP framework | Existing standard for db-ops-api |
| mysql2 | (existing) | MySQL database driver | Existing; approval-service.ts uses it |

**Installation:**
```bash
# No new npm packages needed -- all CodeMirror deps already installed
```

**Version verification:** CodeMirror 6 package versions verified from `frontend/package.json`. All packages are current stable releases.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| CodeMirror 6 read-only | Monaco Editor | Monaco adds 2-3MB bundle; already ruled out-of-scope in REQUIREMENTS.md |
| New approval_events table | Derive from approval_requests fields | Cannot capture notification events, AI review events, or auto-execute events as separate timeline entries |
| New batch-review endpoint | Frontend loop calling individual review | No atomicity; partial failures leave inconsistent state; more network requests |
| Pure CSS timeline | Third-party timeline library (e.g., vis-timeline) | Third-party would add unnecessary bundle weight for a simple vertical timeline; project has no existing timeline dependency |
| Pure Lit/CSS timeline | Custom timeline Lit element | Not necessary for a single-use timeline -- inline Lit template suffices |

## Architecture Patterns

### System Architecture Diagram

```
[approval-dashboard.ts LitElement]
       |
       |-- List sub-view (default)
       |      |-- Tab bar: [待审批] [已处理]
       |      |-- Batch action bar (shown when items selected)
       |      |-- Card list with checkboxes + execute checkbox
       |      |-- Card click -> switch to detail sub-view
       |
       |-- Detail sub-view (internal state switch)
       |      |-- Header: [返回列表] link + 审批详情
       |      |-- Split layout (CSS Grid, gap: 32px)
       |      |     |-- Left: CodeMirror 6 read-only SQL editor
       |      |     |-- Right: Meta card + Timeline card
       |
       |-- Batch confirm dialog (modal)
              |-- Unified notes textarea
              |-- Confirm/Cancel buttons

[Backend API]
       |
       |-- GET/POST /api/approval/pending         -> approvalService.getPendingRequests()
       |-- GET/POST /api/approval/history         -> approvalService.getProcessedRequests()
       |-- GET     /api/approval/:id              -> approvalService.getRequestById()  + approval_events
       |-- POST    /api/approval/:id/review       -> approvalService.reviewRequest()   (modified: +execute_after_approve)
       |-- POST    /api/approval/batch-review     -> NEW: approvalService.batchReview() (new)
       |-- (internal)                             -> notificationService.send()  via buildApprovalMessage()
       |-- (internal)                             -> sqlExecutor.executeSql()    via approvalService

[Data Flow]
User opens approval dashboard
  -> fetch /api/approval/pending (list of pending requests)
  -> render card list with checkboxes
User checks items, clicks batch approve/reject
  -> confirm dialog (unified notes)
  -> POST /api/approval/batch-review { ids[], action, notes, execute_after_approve[] }
  -> backend: for each id, calls reviewRequest with execute_after_approve
  -> if approved + execute_after_approve = true: sqlExecutor.executeSql()
  -> for each id: writes to approval_events table
  -> for each id: notificationService.send() via buildApprovalMessage()
  -> returns array of results
  -> frontend removes processed items from pending list
User clicks a card row
  -> switch to detail sub-view
  -> GET /api/approval/:id (request detail + events)
  -> render CodeMirror read-only + meta card + timeline card
```

### Recommended Project Structure

Changes are all within existing files. No new files needed for the frontend component. Backend additions in existing files.

```
frontend/src/openclaw/ui/views/
  approval-dashboard.ts    // MODIFIED: restructured with list/detail sub-views, batch ops, timeline, CodeMirror

apps/db-ops-api/
  sql/schema.sql           // MODIFIED: add approval_events table
  src/
    approval-service.ts    // MODIFIED: +execute_after_approve param, +batchReview(), +getApprovalEvents()
    notification-service.ts // MODIFIED: +buildApprovalMessage()
  server.ts                // MODIFIED: +POST /api/approval/batch-review endpoint, +execute_after_approve on review
```

### Pattern 1: Component-Internal Sub-View Switching

**What:** A single LitElement manages multiple views (list/detail) via a state variable. No router or URL changes.

**When to use:** When the sub-view only makes sense within the parent context and doesn't need its own URL.

**Existing pattern (from CONTEXT.md):**
```typescript
// Pattern: state-based sub-view switching
@state() private view: "list" | "detail" = "list";
@state() private selectedRequest: ApprovalRequest | null = null;

private openDetail(request: ApprovalRequest) {
  this.selectedRequest = request;
  this.view = "detail";
}

private backToList() {
  this.view = "list";
  this.selectedRequest = null;
}

override render() {
  if (this.view === "detail") {
    return this.renderDetail();
  }
  return this.renderList();
}
```
[VERIFIED: project pattern from CONTEXT.md D-01]

### Pattern 2: Read-Only CodeMirror 6 View

**What:** Creating a non-editable CodeMirror 6 EditorView for displaying SQL with syntax highlighting.

**When to use:** Detail pages where SQL must be readable but not editable.

```typescript
// Adapted from sql-console.ts (verified in codebase)
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

// Determine dialect from instance db_type
const dialect = dbType === "postgresql" ? PostgreSQL : MySQL;

const view = new EditorView({
  state: EditorState.create({
    doc: sqlText,
    extensions: [
      basicSetup,
      sql({ dialect }),
      oneDark,
      EditorView.editable.of(false),  // <-- makes it read-only
      // Remove fold gutter since user cannot edit
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { fontFamily: "var(--mono, 'JetBrains Mono', monospace)", fontSize: "13px" },
      }),
    ],
  }),
  parent: containerElement,
});
```
[CITED: frontend/src/openclaw/ui/views/sql-console.ts lines 3-8, 257-275]

### Pattern 3: Modal Dialog (Existing Project Pattern)

**What:** Reusable modal dialog pattern for confirmations.

**When to use:** For batch approve/reject confirmation, single action confirmations.

```typescript
// From rbac-page.ts / users-management.ts (verified in codebase)
html`
  <div class="modal-overlay" @click=${(e: Event) => {
    if ((e.target as HTMLElement).classList.contains('modal-overlay'))
      this._closeDialog();
  }}>
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">批量通过</span>
        <button class="modal-close" @click=${this._closeDialog}>x</button>
      </div>
      <div class="modal-body">
        <p>确认对选中的 N 项请求执行通过操作？</p>
        <textarea class="note-area" placeholder="审批备注（可选）"
          .value=${this.batchNote}
          @input=${(e) => { this.batchNote = e.target.value; }}>
        </textarea>
      </div>
      <div class="modal-footer">
        <button class="btn" @click=${this._closeDialog}>取消</button>
        <button class="btn btn-approve" @click=${this._confirmBatch}>
          确认通过
        </button>
      </div>
    </div>
  </div>`
```
[VERIFIED: sql-console.ts lines 58-65, rbac-page.ts, users-management.ts]

### Anti-Patterns to Avoid

- **Mixing list and detail render logic:** Use separate `renderList()` / `renderDetail()` methods, not conditionals scattered through one large `render()`.
- **Per-row note textarea on current implementation:** Current code has per-row textarea for reject notes. Phase 87 moves to batch-mode with unified notes in dialog.
- **Inline edit capability in CodeMirror:** Detail page CodeMirror MUST have `EditorView.editable.of(false)`. Users should not be able to modify SQL in the detail view.
- **No feedback on batch partial failure:** Each item in batch must show independent success/failure (D-10).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL syntax highlighting | Custom tokenizer | CodeMirror 6 (already installed) | Handles 100+ edge cases (comments, strings, nested parens, dialect differences) |
| Read-only editor configuration | Manual contentEditable | `EditorView.editable.of(false)` | Single extension line; handles all keyboard events, selection, copy |
| Notification channel formatting | Custom HTTP client per channel | Existing `notificationService.send()` / `sendWithRetry()` | Already handles DingTalk/WeCom/Feishu/Webhook with retry, signing, SSRF protection |
| Modal dialog | New dialog element | Existing `.modal-overlay` + `.modal` CSS pattern | Established in 3+ components; consistent look and behavior |
| Vertical timeline layout | Nested flex/grid math | Pure CSS `::before` pseudo-element for vertical line | < 50 lines of CSS, no JS library needed |

**Key insight:** The project already has all the infrastructure this phase needs. The risks are in integration and state management, not in building new primitives.

## Common Pitfalls

### Pitfall 1: CodeMirror 6 Memory Leak on Sub-View Switch

**What goes wrong:** Every time the user navigates from list to detail (or back), a new EditorView is created. If the old EditorView is not destroyed, the DOM elements accumulate and event listeners leak.

**Why it happens:** Lit re-renders replace DOM content. The `.cm-wrap` container element is re-created on each render, but the old EditorView reference still holds a reference to the detached DOM.

**How to avoid:** Always call `editorView.destroy()` before the detail sub-view unmounts. Use Lit's `disconnectedCallback()` or a manual cleanup pattern.

```typescript
private _codeMirrorView: EditorView | null = null;

private _destroyCodeMirror() {
  if (this._codeMirrorView) {
    this._codeMirrorView.destroy();
    this._codeMirrorView = null;
  }
}

// When switching back to list:
backToList() {
  this._destroyCodeMirror();
  this.view = "list";
}
```

**Warning signs:** Browser heap grows on repeated list/detail navigation. Console warnings about detached DOM elements.

### Pitfall 2: Timeline Data Derivation from approval_requests Only

**What goes wrong:** The timeline shows incomplete data because the `approval_requests` table only has `created_at` (submit time) and `updated_at` (last status change). Missing: AI review time, notification send time, auto-execute time if after approval.

**Why it happens:** The existing table schema was designed for simple approve/reject, not full event history. Deriving "AI review happened" from a stored JSON field is fragile.

**How to avoid:** Create a new `approval_events` table:

```sql
CREATE TABLE IF NOT EXISTS `approval_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` BIGINT UNSIGNED NOT NULL,
  `event_type` ENUM('submitted','ai_reviewed','approved','rejected','executed','execution_failed','notified') NOT NULL,
  `event_data` JSON DEFAULT NULL COMMENT 'Event-specific payload (e.g., risk_level for ai_reviewed, {rows,duration} for executed)',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_request_id` (`request_id`),
  INDEX `idx_event_type` (`event_type`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

This gives full-fidelity timeline data without schema changes to `approval_requests`.

### Pitfall 3: Batch Review Partial Failure with No Rollback

**What goes wrong:** In a batch of 5 approvals, item 1-4 succeed but item 5 fails. The user sees "batch completed" but doesn't realize one failed.

**Why it happens:** A frontend loop calling individual `POST /api/approval/:id/review` has no atomicity. Even a dedicated `/batch-review` endpoint needs to return per-item results.

**How to avoid:** The batch review endpoint should wrap each item's processing in try/catch and return an array of results:

```typescript
async batchReview(data: {
  items: Array<{ id: number; action: 'approve' | 'reject'; execute_after_approve: boolean }>;
  reviewed_by: number;
  notes: string;
}): Promise<Array<{ id: number; success: boolean; error?: string; execution_result?: any }>> {
  const results: Array<{...}> = [];
  for (const item of data.items) {
    try {
      const result = await this.reviewRequest(item.id, {
        action: item.action,
        reviewed_by: data.reviewed_by,
        notes: data.notes,
        execute_after_approve: item.execute_after_approve,
      });
      results.push({ id: item.id, ...result });
    } catch (e: any) {
      results.push({ id: item.id, success: false, error: e.message });
    }
  }
  return results;
}
```

**Warning signs:** Success toast appears but some items remain in pending list. User confusion about which approvals went through.

### Pitfall 4: Notification Fires Before Timeline Event Is Written (RESOLVED)

**What goes wrong:** The notification is sent successfully but the "notified" event is not recorded in the timeline.

**Why it happens:** Notification sending and event logging are sequential but not transactional. If the event write fails after notification succeeds, the timeline is incomplete.

**How to avoid (and implemented in plan 87-02):** Write the notified event AFTER the notification loop. The event write uses `writeEvent().catch(...)` so a failure to record the event does not break the notification flow. This is the chosen approach: notification delivery is the primary concern, event recording is secondary. Both review handlers log the event with `action` and `channel_count` metadata.

### Pitfall 5: CodeMirror Role Conflict: Tab vs Detail Page

**What goes wrong:** The sql-console.ts creates EditorView instances for editable tabs. The approval detail page creates a separate read-only EditorView. Both use `basicSetup` but one is editable and one is not. The `basicSetup` includes keybindings and menu items that don't make sense for a read-only view.

**How to avoid:** Use a reduced setup for the read-only view -- disable fold gutter and keybindings that are only meaningful for editing:

```typescript
extensions: [
  EditorView.editable.of(false),
  sql({ dialect: MySQL }),
  oneDark,
  lineNumbers(),          // instead of basicSetup
  EditorState.readOnly.of(true),
  // No keymap, no fold, no history -- all unnecessary for read-only
]
```

## Code Examples

### CodeMirror 6 Read-Only Mount Pattern

```typescript
// Source: sql-console.ts lines 257-275 (pattern adapted for read-only)
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

function mountReadOnlyEditor(container: HTMLElement, sqlText: string, dbType: string = 'mysql'): EditorView {
  const dialect = dbType === 'postgresql' ? PostgreSQL : MySQL;

  const view = new EditorView({
    state: EditorState.create({
      doc: sqlText,
      extensions: [
        lineNumbers(),
        sql({ dialect }),
        oneDark,
        EditorView.editable.of(false),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": {
            fontFamily: "var(--mono, 'JetBrains Mono', monospace)",
            fontSize: "13px",
            overflow: "auto",
          },
        }),
      ],
    }),
    parent: container,
  });
  return view;
}
```
[CITED: sql-console.ts, CodeMirror docs]

### Approval Event Writing Pattern

```typescript
// Source: audit-log.ts (existing approval event methods)

// In ApprovalService:
async writeApprovalEvent(requestId: number, eventType: string, eventData: any, userId?: number): Promise<void> {
  const pool = this.getPool();
  if (!pool) return;

  await pool.execute(
    `INSERT INTO approval_events (request_id, event_type, event_data, created_by, created_at)
     VALUES (?, ?, ?, ?, NOW())`,
    [requestId, eventType, eventData ? JSON.stringify(eventData) : null, userId || null]
  );
}

async getApprovalEvents(requestId: number): Promise<any[]> {
  const pool = this.getPool();
  if (!pool) return [];

  const [rows] = await pool.execute(
    'SELECT * FROM approval_events WHERE request_id = ? ORDER BY created_at ASC',
    [requestId]
  ) as any;
  return rows.map((row: any) => ({
    ...row,
    event_data: typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data,
  }));
}
```

### buildApprovalMessage() Channel Formats

```typescript
// Added to notification-service.ts (pattern matches existing buildMessage / buildEscalationMessage)
buildApprovalMessage(
  channelType: string,
  approvalData: {
    action: 'approve' | 'reject';
    notes?: string;
    sqlSummary: string;       // first 100 chars
    instanceName: string;
    submitTime: string;
    reviewerName: string;
    riskLevel: string;
  }
): any {
  const title = action === 'approve' ? '[审批通过]' : '[审批驳回]';

  switch (channelType) {
    case 'dingtalk': {
      return {
        msgtype: 'markdown',
        markdown: {
          title: `${title} ${approvalData.instanceName}`,
          text: `### ${title} ${approvalData.instanceName}\n\n` +
                `- **结果**: ${action === 'approve' ? '已通过' : '已驳回'}\n` +
                `- **审批人**: ${approvalData.reviewerName}\n` +
                `- **实例**: ${approvalData.instanceName}\n` +
                `- **风险等级**: ${approvalData.riskLevel}\n` +
                `- **提交时间**: ${approvalData.submitTime}\n` +
                (approvalData.notes ? `- **备注**: ${approvalData.notes}\n` : '') +
                `\n\`\`\`sql\n${approvalData.sqlSummary}\n\`\`\``,
        },
      };
    }
    // wecom, feishu, webhook follow same pattern as existing buildMessage()
    // See notification-service.ts lines 229-317 for established patterns
  }
}
```
[CITED: notification-service.ts buildMessage() lines 184-318, buildEscalationMessage() lines 487-592]

### Timeline Component (Pure Lit + CSS)

```typescript
// Rendered inside detail sub-view
private renderTimeline(events: ApprovalEvent[]) {
  return html`
    <div class="timeline-card">
      <div class="timeline-header">审批历程</div>
      <div class="timeline-list">
        ${events.map((event, i) => html`
          <div class="timeline-node" style="animation-delay: ${i * 50}ms">
            <div class="timeline-dot timeline-dot--${event.event_type}"></div>
            <div class="timeline-content">
              <div class="timeline-event-name">${this._eventLabel(event.event_type)}</div>
              <div class="timeline-timestamp">${new Date(event.created_at).toLocaleString("zh-CN")}</div>
              ${event.event_data ? html`
                <div class="timeline-detail">${this._eventDetail(event)}</div>
              ` : ''}
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}

private _eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'submitted': '提交审批',
    'ai_reviewed': 'AI 风险评估',
    'approved': '审批通过',
    'rejected': '审批驳回',
    'executed': '自动执行SQL',
    'execution_failed': '自动执行失败',
    'notified': '通知发送',
  };
  return labels[type] || type;
}
```

### CSS Timeline Styles

```css
.timeline-list {
  position: relative;
  padding-left: 24px;
}

/* Vertical connecting line */
.timeline-list::before {
  content: '';
  position: absolute;
  left: 11px;      /* (dot size / 2) - (line width / 2) */
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--border, #e5e5ea);
}

.timeline-node {
  display: flex;
  gap: 12px;
  padding-bottom: 20px;
  position: relative;
  animation: fade-in 0.3s ease-out both;
  animation-delay: calc(var(--index, 0) * 50ms);
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
  z-index: 1;   /* above the ::before line */
}

.timeline-dot--submitted,
.timeline-dot--notified    { background: var(--accent); }
.timeline-dot--ai_reviewed { background: var(--warn); }
.timeline-dot--approved    { background: var(--ok); }
.timeline-dot--rejected    { background: var(--destructive); }
.timeline-dot--executed    { background: var(--ok); }
.timeline-dot--execution_failed { background: var(--destructive); }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single inline approve/reject button per card | Modal dialog for all actions (batch + single) | Phase 87 | Unified UX, prevents accidental actions |
| Always auto-execute on approve | Opt-out checkbox per row | Phase 87 | Approver decides per-request |
| Flat list with SQL preview truncated at 80px | Split-panel detail view with full SQL + timeline | Phase 87 | Complete visibility for approver |
| No notification on approval outcome | Notification via existing channels | Phase 87 | Requester gets real-time feedback |

**Deprecated/outdated:**
- Current inline approve/reject pattern (buttons directly on card) is being replaced by modal dialog pattern

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SQL `execute_after_approve` defaults to `true` when not provided (backward-compatible). | D-08, Backend | If existing frontend code calls review without this param, behavior breaks. Must verify default `true` in backend. |
| A2 | The `approval_events` table does not exist. Must be created by SQL migration. | Timeline data | If table already exists (from earlier phase), migration would cause duplicate table error. |
| A3 | Channel-specific message format for approval notifications should mirror the existing `buildMessage()` alert format (DingTalk markdown, WeCom markdown, Feishu interactive card, Webhook JSON). | buildApprovalMessage() | If channels have different expectations for approval vs alert messages, the format may need adjustment. |
| A4 | Language mode switching uses `sql({ dialect: MySQL })` for MySQL/MariaDB and `sql({ dialect: PostgreSQL })` for PostgreSQL. Other DB types (Oracle, Dameng) fall back to MySQL dialect. | CodeMirror config | @codemirror/lang-sql 6.10.0 may not support all Oracle/Dameng keywords; fallback to MySQL is reasonable. |

## Open Questions (RESOLVED)

1. **When does the "notified" approval event get recorded?** (RESOLVED)
   - What we know: D-11 says notification sends via existing service. D-13 says both approve/reject notify.
   - What's unclear: Should the event be recorded BEFORE sending (best-effort notification) or only AFTER successful send?
   - Recommendation: Record event immediately before calling `send()`, with event_data showing `{ channel_ids: [...], status: 'pending' }`. Update on send success/failure. This way timeline reflects the intent even if webhook fails.
   - **Resolution:** The chosen approach writes the notified event AFTER the notification send loop (in both handlers). This ensures the timeline records only successfully-triggered notifications. The event write uses `.catch()` to make it non-blocking -- a failure to record does not break the notification flow. The fix is implemented in plan 87-02 Task 2.

2. **Processed tab loading: limit and pagination?** (RESOLVED)
   - What we know: Current `getProcessedRequests()` accepts a limit param (default 50, max 200). The frontend loads all at once.
   - What's unclear: With batch operations adding many processed requests, does the existing limit pattern suffice?
   - Recommendation: Keep existing pattern for now. The limit of 200 is adequate for Phase 87. Pagination can be added later if needed.
   - **Resolution:** Accepted. Current limit pattern (max 200) is adequate for Phase 87. No changes planned.

3. **Existing `audit-log.ts` vs new `approval_events` table -- integration?** (RESOLVED)
   - What we know: `audit-log.ts` already has `logApprovalRequest()`, `logApprovalApproved()`, `logApprovalRejected()` methods that write to an in-memory `MemoryAuditLogStore`.
   - What's unclear: Should the `approval_events` table replace the in-memory audit log for approval events, or complement it?
   - Recommendation: Keep audit-log.ts as-is (it's for the agent-tool-call audit trail). Use the new `approval_events` table specifically for the approval timeline UI. The two serve different consumers (audit compliance vs UI display).
   - **Resolution:** Accepted. audit-log.ts remains unchanged. The new `approval_events` table is the dedicated data source for the timeline UI.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Backend (db-ops-api) | Yes | v22.22.1 | -- |
| npm | Package management | Yes | 10.9.4 | -- |
| CodeMirror 6 packages | Frontend read-only SQL | Yes | (in package.json) | Already installed |

**Missing dependencies with no fallback:** None -- all required packages are already in the project.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (from `vitest.config.ts`) |
| Config file | `apps/db-ops-api/vitest.config.ts` |
| Quick run command | `npm test` (vitest run) |
| Full suite command | `npm run test:all` (smoke + deep + schema validator) |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| APPR-01 | Detail page renders CodeMirror read-only | manual (UI) | `npx vitest run` (backend only) | -- |
| APPR-02 | Timeline returns events in correct order | unit (backend) | `npx vitest run src/approval-service.test.ts -- -t "timeline"` | No -- needs Wave 0 |
| APPR-03 | Batch review processes multiple items atomically | unit (backend) | `npx vitest run src/approval-service.test.ts -- -t "batch-review"` | No -- needs Wave 0 |
| APPR-04 | execute_after_approve=false skips SQL execution | unit (backend) | `npx vitest run src/approval-service.test.ts -- -t "auto-execute"` | No -- needs Wave 0 |
| APPR-05 | Reject writes notes to approval_requests | unit (backend) | `npx vitest run src/approval-service.test.ts -- -t "reject"` | No -- needs Wave 0 |
| APPR-06 | buildApprovalMessage() generates correct per-channel format | unit (backend) | `npx vitest run src/notification-service.test.ts -- -t "approval-message"` | No -- needs Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test` (vitest run -- backend unit tests only)
- **Per wave merge:** `npm run test:all` (full smoke + deep + schema)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/db-ops-api/src/approval-service.test.ts` -- test file for the approval service (does not exist yet). Should cover: approval_events CRUD, execute_after_approve flag, batch-review logic, reject workflow.
- [ ] `apps/db-ops-api/src/notification-service.test.ts` -- test coverage for `buildApprovalMessage()` (existing test `notification-service.test.ts` may need extension).
- [ ] Shared fixtures or test helpers for approval_events table (in-memory or mocked).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | JWT auth already enforced by existing middleware `requirePermission('approval:approve')` |
| V3 Session Management | No | Existing JWT session |
| V4 Access Control | Yes | `requirePermission('approval:approve')` and `requirePermission('approval:view')` on all new endpoints and existing ones |
| V5 Input Validation | Yes | Validate `ids` array items are valid integers, `action` is 'approve' or 'reject', `execute_after_approve` is boolean |
| V6 Cryptography | No | No new encryption needed |

### Known Threat Patterns for Fastify/mysql2

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via `ids` array | Tampering | Parameterized queries (already used via `pool.execute()` with `?` placeholders) |
| Unauthorized batch approve | Elevation of Privilege | `requirePermission('approval:approve')` middleware on all review endpoints |
| IDOR -- approving someone else's request | Information Disclosure | Existing check: `SELECT ... WHERE id = ? AND status = 'pending'` -- ensures only valid pending requests can be acted on |
| Rate limiting batch review | Denial of Service | Existing project patterns (not explicitly implemented; batch size can be limited to 50 by backend) |

## Sources

### Primary (HIGH confidence)
- CodeMirror 6 docs via `frontend/package.json` -- verified all packages installed
- `apps/db-ops-api/src/approval-service.ts` -- current reviewRequest implementation, schema fields
- `apps/db-ops-api/src/notification-service.ts` -- buildMessage(), send(), sendWithRetry() patterns
- `apps/db-ops-api/sql/schema.sql` -- approval_requests, notification_channels, notification_records table schemas
- `frontend/src/openclaw/ui/views/sql-console.ts` -- CodeMirror 6 EditorView setup pattern for reuse
- `frontend/src/openclaw/ui/views/approval-dashboard.ts` -- current approval list component
- `apps/db-ops-api/src/audit/audit-log.ts` -- existing approval event types and audit infrastructure

### Secondary (MEDIUM confidence)
- `apps/db-ops-api/vitest.config.ts` -- test infrastructure verified
- `apps/db-ops-api/server.ts` lines 607-670 -- 5 existing approval endpoints

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all existing libraries, no new dependencies
- Architecture: HIGH -- directly follows CONTEXT.md decisions and established patterns
- Pitfalls: MEDIUM -- CodeMirror memory leak and timeline data derivation based on codebase analysis; batch partial failure and notification ordering based on general distributed system patterns
- Timeline data source: HIGH -- `approval_events` table approach verified against schema.sql (no such table exists) and requirements (D-02 needs full event chain)
- Notification: HIGH -- pattern directly mirrors existing `buildMessage()` / `buildEscalationMessage()`

**Research date:** 2026-05-11
**Valid until:** 2026-06-11 (stable stack, all packages are existing dependencies)
