import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
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
  @state() private rows: any[] = [];
  @state() private busy = false;
  @state() private error = "";
  private epoch = 0;
  private onStorage = (e: StorageEvent) => {
    if (e.key === "token") void this.load();
  };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("storage", this.onStorage);
    void this.load();
  }
  disconnectedCallback() {
    window.removeEventListener("storage", this.onStorage);
    this.epoch++;
    super.disconnectedCallback();
  }
  private async load() {
    const g = ++this.epoch,
      s = localStorage.getItem("token");
    this.rows = [];
    this.busy = true;
    this.error = "";
    try {
      const r = await authFetch("/api/notification/deliveries"),
        v = await r.json();
      if (!this.isConnected || g !== this.epoch || s !== localStorage.getItem("token")) return;
      if (!r.ok) throw Error("投递回执暂时无法查询，请重试");
      this.rows = v;
    } catch (e) {
      if (this.isConnected && g === this.epoch && s === localStorage.getItem("token"))
        this.error = (e as Error).message;
    } finally {
      if (this.isConnected && g === this.epoch && s === localStorage.getItem("token"))
        this.busy = false;
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
    return html`<h3>问题、恢复与升级投递</h3>
      <button class="btn btn-refresh" .disabled=${this.busy} @click=${this.load}>
        刷新投递回执
      </button>
      ${this.busy ? html`<p role="status">加载投递回执…</p>` : this.error ? html`<p role="alert" class="error">${this.error}</p>` : !this.rows.length ? html`<p>暂无可查看的投递记录</p>` : ""}
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
                  <td>${labels[r.phase]}</td>
                  <td>${labels[r.delivery?.state ?? r.job_state] ?? r.job_state}</td>
                  <td>
                    ${r.attempts?.length ?? 0} 次 ·
                    ${labels[r.delivery?.error_code ?? r.error_code] ?? r.delivery?.error_code ?? r.error_code ?? "—"}
                    <details>
                      <summary>查看回执</summary>
                      <p>投递身份：${r.delivery?.business_key ?? r.id}</p>
                      ${(r.attempts ?? []).map((a: any) => html`<p>${a.attempt_number} · ${labels[a.status] ?? a.status} · ${labels[a.error_code] ?? a.error_code ?? "—"}</p>`)}
                    </details>
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
  }
}
