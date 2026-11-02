import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.js";
import "./app-card.js";
import "./app-empty-state.js";
import "./template-event-evidence.js";
import { readResourceContext } from "./resource-scope-context.js";
@customElement("resource-event-context")
export class ResourceEventContext extends LitElement {
  @state() private value: any = null;
  @state() private error = "";
  @state() private busy = false;
  @state() private offset = 0;
  private generation = 0;
  private erase = () => {
    this.generation++;
    this.value = null;
    this.busy = false;
    this.error = "权限已变更，请返回资源重新打开。";
  };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("slide-permissions-loaded", this.erase);
    window.addEventListener("slide-session-expired", this.erase);
    void this.load();
  }
  disconnectedCallback() {
    this.erase();
    window.removeEventListener("slide-permissions-loaded", this.erase);
    window.removeEventListener("slide-session-expired", this.erase);
    super.disconnectedCallback();
  }
  private async load() {
    const g = ++this.generation;
    this.value = null;
    this.error = "";
    this.busy = true;
    try {
      const c = readResourceContext();
      if (!c) throw Error("资源或观察窗口无效，请返回来源。");
      const r = await authFetch("/api/metrics/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: c.resource,
          view: "all",
          history: true,
          from: c.from,
          to: c.to,
          bucket_ms: Math.max(60000, Math.ceil((Date.parse(c.to) - Date.parse(c.from)) / 1440)),
        }),
      });
      if (!r.ok)
        throw Error(r.status === 403 ? "无权读取该资源事件" : `事件读取失败（${r.status}）`);
      const data = await r.json();
      if (g !== this.generation) return;
      if (!data.history_context || !Array.isArray(data.history_context.events))
        throw Error("事件上下文不可用，不能据此判断没有事件");
      const eventsResponse = await authFetch(
        "/api/alerts/events?" +
          new URLSearchParams({
            resource: `${c.resource.type}:${c.resource.id}`,
            from: c.from,
            to: c.to,
            limit: "50",
            offset: String(this.offset),
          }),
      );
      if (!eventsResponse.ok)
        throw Error(
          eventsResponse.status === 403
            ? "无权读取此资源事件"
            : `事件读取失败（${eventsResponse.status}），不推断没有事件`,
        );
      const events = await eventsResponse.json();
      if (g !== this.generation) return;
      if (!Array.isArray(events.items)) throw Error("事件响应无效");
      this.value = {
        ...c,
        history: data.history_context,
        events: events.items,
        total: events.total,
      };
    } catch (e) {
      if (g === this.generation) this.error = e instanceof Error ? e.message : "事件读取失败";
    } finally {
      if (g === this.generation) this.busy = false;
    }
  }
  render() {
    const v = this.value;
    return html`<style>
        ${sharedBtnStyles}:host {
          display: block;
          min-width: 0;
        }
        p {
          overflow-wrap: anywhere;
        }
        details {
          margin-block: var(--space-md);
        }</style
      ><app-card
        ><h2 slot="header">同资源窗口内事件</h2>
        ${this.busy ? html`<p role="status">正在读取事件与历史规则…</p>` : nothing}${
          this.error
            ? html`<p role="alert">${this.error}</p>
                <button class="btn btn-refresh" @click=${this.load}>重试</button>`
            : nothing
        }
        ${
          v
            ? html`<p>${v.resource.type}:${v.resource.id} · ${v.from} → ${v.to}</p>
                <p>
                  按同一资源和时间窗读取已有事件；模板规则保留发生时快照，不以当前阈值改写历史。
                </p>
                ${
                  !v.history.events_readable
                    ? html`<p role="alert">没有事件查看权限；未显示数量或旧事件。</p>`
                    : v.events.length
                      ? html`<p>共 ${v.total} 项，本页 ${v.events.length} 项。</p>
                          ${v.events.map(
                            (e: any) =>
                              html`<details>
                                <summary>事件 ${e.id} · ${e.title} · ${e.status}</summary>
                                <p>
                                  发生于 ${e.created_at} · ${e.resolved_at || "尚未恢复"} ·
                                  ${e.description || "未提供说明"}
                                </p>
                                ${v.history.events.some((h: any) => h.event_id === e.id) ? html`<template-event-evidence .eventId=${e.id}></template-event-evidence>` : html`<p>此记录未关联模板规则快照；不使用当前规则回填。</p>`}
                              </details>`,
                          )}`
                      : html`<app-empty-state
                          title="窗口内未返回事件"
                          description="保留资源与观察范围；这不等于没有异常。"
                        ></app-empty-state>`
                }
                <p>
                  <button
                    class="btn"
                    ?disabled=${this.busy || this.offset === 0}
                    @click=${() => {
                      this.offset = Math.max(0, this.offset - 50);
                      void this.load();
                    }}
                  >
                    上一页</button
                  ><span>第 ${Math.floor(this.offset / 50) + 1} 页</span
                  ><button
                    class="btn"
                    ?disabled=${this.busy || this.offset + 50 >= v.total}
                    @click=${() => {
                      this.offset += 50;
                      void this.load();
                    }}
                  >
                    下一页
                  </button>
                </p>
                <a class="btn" href=${v.returnTo}>返回资源详情</a>`
            : nothing
        }</app-card
      >`;
  }
}
