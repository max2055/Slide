import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { apiClient, authFetch, SESSION_EXPIRED_EVENT } from "../../../api/index.js";
import type { NotificationDeliveryList } from "../../../api/generated/public-api.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";

type Receipt = NotificationDeliveryList[number];
type Attempt = Receipt["attempts"][number];
type ReceiptRow = Pick<Receipt, "id" | "phase" | "job_state"> & {
  alert_id: number | string;
  channel_id: number | string;
  error_code?: Receipt["error_code"];
  delivery?: Pick<NonNullable<Receipt["delivery"]>, "business_key" | "state"> & { error_code?: Receipt["error_code"] } | null;
  attempts?: (Pick<Attempt, "attempt_number" | "status"> & { error_code?: Attempt["error_code"] })[] | null;
};

const invalidReceipt = "投递回执格式异常，请稍后重试。";
const expiredSession = "登录已失效（HTTP 401），请重新登录后重试。";
const changedSession = "登录状态已变化，请刷新投递回执。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReceiptReference(value: unknown): value is number | string {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

function isOptionalErrorCode(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isReceiptRow(row: unknown): row is ReceiptRow {
  if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()
    || !isReceiptReference(row.alert_id) || !isReceiptReference(row.channel_id)
    || (row.phase !== "problem" && row.phase !== "recovery" && row.phase !== "escalation")
    || typeof row.job_state !== "string" || !row.job_state.trim()
    || !isOptionalErrorCode(row.error_code)) return false;

  // Historical receipts can omit delivery details or attempt history.
  if (row.delivery != null && (!isRecord(row.delivery) || typeof row.delivery.business_key !== "string"
    || typeof row.delivery.state !== "string" || !isOptionalErrorCode(row.delivery.error_code))) return false;

  return row.attempts == null || (Array.isArray(row.attempts) && row.attempts.every((attempt: unknown) =>
    isRecord(attempt) && Number.isSafeInteger(attempt.attempt_number) && typeof attempt.status === "string"
    && isOptionalErrorCode(attempt.error_code)));
}

@customElement("notification-deliveries")
export class NotificationDeliveries extends LitElement {
  static styles = [
    sharedBtnStyles,
    css`
      :host {
        display: block;
      }
      .scroll {
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      td,
      th {
        padding: var(--space-md);
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .error {
        color: var(--danger);
      }
    `,
  ];
  @state() private rows: ReceiptRow[] = [];
  @state() private busy = true;
  @state() private error = "";
  private read?: { controller: AbortController; timeout: ReturnType<typeof setTimeout> };

  private readonly onStorage = (event: StorageEvent) => {
    if (event.key !== "token" && event.key !== null) return;
    if (apiClient.getToken()) void this.load();
    else this.onSessionExpired();
  };

  private readonly onSessionExpired = () => {
    this.cancelRead();
    this.rows = [];
    this.busy = false;
    this.error = expiredSession;
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("storage", this.onStorage);
    window.addEventListener(SESSION_EXPIRED_EVENT, this.onSessionExpired);
    void this.load();
  }

  override disconnectedCallback() {
    window.removeEventListener("storage", this.onStorage);
    window.removeEventListener(SESSION_EXPIRED_EVENT, this.onSessionExpired);
    this.cancelRead();
    this.rows = [];
    super.disconnectedCallback();
  }

  private cancelRead(): void {
    const read = this.read;
    if (!read) return;
    this.read = undefined;
    clearTimeout(read.timeout);
    read.controller.abort();
  }

  private async load(): Promise<void> {
    this.cancelRead();
    const controller = new AbortController();
    const session = apiClient.getSessionContext();
    const isCurrent = () => this.read?.controller === controller && this.isConnected;
    const ownsSession = () => session === apiClient.getSessionContext();
    this.rows = [];
    this.busy = true;
    this.error = "";

    const timeout = setTimeout(() => {
      if (!isCurrent()) return;
      // A shared auth refresh may still be pending after aborting this read.
      this.cancelRead();
      this.busy = false;
      this.error = ownsSession() ? "加载投递回执超时，请重试。" : changedSession;
    }, 15_000);
    this.read = { controller, timeout };

    try {
      const response = await authFetch("/api/notification/deliveries", { cache: "no-store", signal: controller.signal });
      if (!isCurrent() || !ownsSession()) return;
      if (!response.ok) {
        if (response.status === 401) this.error = expiredSession;
        else if (response.status === 403) this.error = "无权查看投递回执（HTTP 403），请联系管理员确认权限后重试。";
        else this.error = `投递回执暂时无法查询（HTTP ${response.status}），请重试。`;
        return;
      }
      const body = await response.text();
      if (!isCurrent() || !ownsSession()) return;
      const rows: unknown = JSON.parse(body);
      if (!Array.isArray(rows) || !rows.every(isReceiptRow)) {
        this.error = invalidReceipt;
        return;
      }
      this.rows = rows;
    } catch (error) {
      if (isCurrent()) this.error = error instanceof SyntaxError ? invalidReceipt : "网络异常，无法加载投递回执，请检查连接后重试。";
    } finally {
      if (isCurrent()) {
        clearTimeout(timeout);
        this.read = undefined;
        this.busy = false;
        if (!ownsSession()) this.error = changedSession;
      }
    }
  }
  render() {
    const labels: Record<string, string> = {
      problem: "问题",
      recovery: "恢复",
      escalation: "升级",
      sent: "已确认发送",
      unknown: "结果未知，请核对",
      retryable: "可重试",
      sending: "发送中",
      skipped: "已抑制",
      failed: "已终止",
      ready: "等待发送",
      queued: "排队中",
      dead_letter: "重试已耗尽",
      completed: "处理完成",
      MAINTENANCE_SUPPRESSED: "维护期间抑制",
      ROLLOUT_ALERT_STALE: "配置版本已变化",
      DELIVERY_OUTCOME_UNCERTAIN: "投递结果未知",
      LEGACY_DELIVERY: "已有投递记录，未重复发送",
    };
    const label = (code: string | null | undefined) => code == null ? "—" : Object.hasOwn(labels, code) ? labels[code] : code;
    return html`<h3>投递回执</h3>
      <button class="btn btn-refresh" .disabled=${this.busy} @click=${this.load}>
        刷新投递回执
      </button>
      ${this.busy ? html`<p role="status">加载投递回执…</p>` : this.error ? html`<p role="alert" class="error">${this.error}</p>` : !this.rows.length ? html`<p>暂无可查看的投递回执</p>` : ""}
      <p>未知结果需先核对原投递。重放沿用原投递身份；维护抑制的历史消息不补发。</p>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>问题 / 渠道</th>
              <th>阶段</th>
              <th>结果</th>
              <th>尝试与原因</th>
            </tr>
          </thead>
          <tbody>
            ${this.rows.map(
              (r) =>
                html`<tr>
                  <td>${r.alert_id} / ${r.channel_id}</td>
                  <td>${label(r.phase)}</td>
                  <td>${label(r.delivery?.state ?? r.job_state)}</td>
                  <td>
                    ${r.attempts?.length ?? 0} 次 ·
                    ${label(r.delivery?.error_code ?? r.error_code)}
                    <details>
                      <summary>查看回执</summary>
                      <p>投递身份：${r.delivery?.business_key ?? r.id}</p>
                      ${(r.attempts ?? []).map((a) => html`<p>${a.attempt_number} · ${label(a.status)} · ${label(a.error_code)}</p>`)}
                    </details>
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
  }
}
