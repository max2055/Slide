import { resourceDetailUrl } from '../components/resource-investigation-links.ts';
import { html, nothing } from 'lit';
import { investigationMessages, type InvestigationsController } from '../controllers/investigations.ts';
import { messagePartsRenderRows, messagePartsToolOutputs } from '../chat/message-normalizer.ts';
import { renderMessageGroup } from '../chat/grouped-render.ts';
import { apiClient } from '../../../api/index.ts';
import '../components/investigation-context.ts';
import '../components/investigation-feedback.ts';

export const executionLabels: Record<string, string> = {
  queued: '排队中', running: '运行中', completed: '执行完成', failed: '执行失败', cancelled: '已取消',
  timed_out: '执行超时', partial: '部分完成', unknown: '结果未知',
};
const lifecycleLabels = { open: '开放', waiting: '等待处理', closed: '已关闭', archived: '已归档' };
const problemLabels = { unconfirmed: '未确认', in_progress: '处理中', resolved: '已验证恢复', not_applicable: '不适用' };
export function renderInvestigationDetail(controller: InvestigationsController, options: {
  draft: string; onDraft: (value: string) => void; onContinue: () => void; onEvidence: () => void;
}) {
  const detail = controller.detail;
  if (controller.detailLoading) return html`<p role="status">正在加载调查…</p>`;
  if (!detail) return html`<app-empty-state title=${controller.forbidden ? '无访问权限' : '选择一个调查'} description="从列表打开已有调查或创建手动调查。"></app-empty-state>`;
  const currentRun = detail.activeRequestId ? controller.snapshot?.runs.find(r => r.requestId === detail.activeRequestId) : undefined;
  const execution = currentRun ? currentRun.resolution === 'outcome_unknown' ? 'unknown' : currentRun.state : detail.derivedRunState;
  const active = !!detail.activeRequestId;
  const messages = investigationMessages(controller.snapshot, controller.history);
  const tools = messagePartsToolOutputs(messages);
  const result = controller.results.items.reduce<(typeof controller.results.items)[number] | undefined>((latest, item) =>
    !latest || item.version > latest.version ? item : latest, undefined);
  return html`
    <app-card><span slot="header">${detail.title}</span>
      <p>${detail.goal}</p>
      <dl class="investigation-states">
        <div><dt>本次执行</dt><dd><app-badge variant=${execution === 'unknown' ? 'warn' : 'info'}>${execution ? executionLabels[execution] ?? '状态未知' : '尚未执行'}</app-badge></dd></div>
        <div><dt>调查进度</dt><dd><app-badge>${lifecycleLabels[detail.lifecycle]}</app-badge></dd></div>
        <div><dt>业务问题</dt><dd><app-badge>${problemLabels[detail.problemStatus]}</app-badge></dd></div>
      </dl>
      <p class="muted">${detail.profileId === 'system' ? 'System' : 'Ops'} · 只读调查 · ${detail.resources.map(r => `${r.type}:${r.id}`).join('、') || '平台'} · ${detail.sessionId}</p>
      <p class="investigation-resource-links">${detail.resources.map(ref => html`<a href=${resourceDetailUrl(ref.type, ref.id)}>返回原资源 ${ref.type}:${ref.id}</a> `)}</p>
      ${detail.legacyAnalysis ? html`<p>历史 Analysis #${detail.legacyAnalysis.analysisId} · 只读兼容结果 · ${executionLabels[detail.legacyAnalysis.status] ?? detail.legacyAnalysis.status}</p>
        <p class="muted">原结果不补跑；根因与恢复尚未验证。</p><pre class="legacy-analysis-result" style="white-space:pre-wrap;overflow-wrap:anywhere">${detail.legacyAnalysis.view.summary}</pre>` : nothing}
      <button class="btn evidence-toggle" @click=${options.onEvidence}>查看证据与成果</button>
      <button aria-busy=${String(controller.busy)} class="btn btn-refresh" ?disabled=${controller.busy} @click=${() => void controller.select(detail.id)}>刷新调查</button>
      ${active ? html`<button class="btn" ?disabled=${controller.busy || controller.operationForbidden || controller.cancelRequested || !controller.online}
        @click=${() => void controller.cancel()}>${controller.cancelRequested ? '等待取消确认' : '取消本次执行'}</button>` : nothing}
      ${controller.cancelRequested ? html`<p role="status">取消请求已发送，等待后端确认；工具可能仍在收尾。</p>` : nothing}
    </app-card>
    <investigation-feedback .investigationId=${detail.id} .resultId=${result?.id ?? ''}
      .resultVersion=${result?.version ?? 0} .investigationVersion=${detail.version}
      .activeRequest=${active} .readonly=${controller.operationForbidden || !controller.online}
      @investigation-feedback-saved=${() => void controller.refreshFacts()}></investigation-feedback>
    <app-card><span slot="header">执行与协作</span>
      ${controller.historyBefore ? html`<button class="btn" @click=${() => void controller.loadHistory()}>加载更早消息</button>` : nothing}
      <div class="investigation-messages" aria-label="调查消息">
        ${messages.length ? messages.flatMap((message, i) => (messagePartsRenderRows(message, tools) ?? [{ partId: null, message }]).map(row =>
          renderMessageGroup({ kind: 'group', role: String(row.message.role ?? 'assistant'), key: row.partId ?? message.id ?? String(i),
            messages: [{ message: row.message, key: row.partId ?? message.id }], timestamp: 0, isStreaming: false },
          { showReasoning: false, showToolCalls: true, autoExpandToolCalls: false, assistantAttachmentAuthToken: apiClient.getToken() })))
          : html`<app-empty-state title="暂无消息"></app-empty-state>`}
      </div>
      <app-form-field label="继续调查" hint=${active ? '本次执行结束后可提交新目标；草稿会保留。' : '新请求将创建新的 Run，保留历次结果。'}>
        <textarea aria-label="继续调查" rows="3" maxlength="2000" .value=${options.draft}
          @input=${(e: Event) => options.onDraft((e.target as HTMLTextAreaElement).value)}></textarea>
      </app-form-field>
      <button class="btn-primary" ?disabled=${active || controller.busy || controller.operationForbidden || controller.acceptanceUnknown || !controller.online || !options.draft.trim() || detail.lifecycle === 'archived' || detail.lifecycle === 'closed'}
        @click=${options.onContinue}>提交新 Run</button>
      <p class="muted">操作需要调查 operator 权限，服务器实时校验。</p>
    </app-card>`;
}
