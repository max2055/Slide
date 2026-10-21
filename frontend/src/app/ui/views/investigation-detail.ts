import { resourceDetailUrl } from '../components/resource-investigation-links.ts';
import { html, nothing } from 'lit';
import { investigationMessages, type InvestigationsController } from '../controllers/investigations.ts';
import { messagePartsRenderRows, messagePartsToolOutputs } from '../chat/message-normalizer.ts';
import { renderMessageGroup } from '../chat/grouped-render.ts';
import { apiClient } from '../../../api/index.ts';
import '../components/investigation-context.ts';
import '../components/investigation-feedback.ts';
import '../components/investigation-operation-context.ts';

export const executionLabels: Record<string, string> = {
  queued: '排队中', running: '运行中', completed: '执行完成', failed: '执行失败', cancelled: '已取消',
  timed_out: '执行超时', partial: '部分完成', unknown: '结果未知',
};
export const lifecycleLabels = { open: '开放', waiting: '等待处理', closed: '已关闭', archived: '已归档' };
const stopLabels: Record<string, string> = {
  INVESTIGATION_TOOL_WINDOW_LIMIT: '检查请求的时间范围超出工具上限，已停止并保留部分结果。',
  MAX_TOOL_CALLS: '已达到工具调用上限。', MAX_MODEL_STEPS: '已达到分析步骤上限。',
  RUN_DEADLINE: '已达到本次执行时限。', RECOVERY_LIMIT: '已达到恢复次数上限。',
  CANCELLED_BY_ACTOR: '用户已取消本次执行。', RUNTIME_RESPONSE_READY: '本次执行已结束；业务问题是否恢复需单独验证。',
};
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
      <dl class="investigation-states">
        <div><dt>本次执行</dt><dd><app-badge variant=${execution === 'unknown' ? 'warn' : 'info'}>${execution ? executionLabels[execution] ?? '状态未知' : '尚未执行'}</app-badge></dd></div>
        <div><dt>调查进度</dt><dd><app-badge>${lifecycleLabels[detail.lifecycle]}</app-badge></dd></div>
        <div><dt>业务问题</dt><dd><app-badge>${problemLabels[detail.problemStatus]}</app-badge></dd></div>
      </dl>
      <h3>${active && result ? '最近已保存的结果' : '本次调查结果'}</h3>
      <section aria-label="本次调查结果">
      ${result ? html`
        ${active ? html`<p role="status">当前执行仍在进行；以下为上一份已保存结果 V${result.version}。</p>` : nothing}
        <p class="investigation-result-summary">${result.result.summary}</p>
        <p class="muted">执行状态与业务问题分别记录；工具返回不代表根因或恢复已验证。</p>
        <h3>已完成的检查</h3>
        ${result.result.facts.length ? html`<ul>${result.result.facts.slice(0, 6).map(f => html`<li>${f.statement}</li>`)}</ul>`
          : html`<p>没有已绑定的检查事实。历史结果可能未整理工具记录，请查看证据与执行过程。</p>`}
        <h3>证据缺口</h3>${result.result.unresolvedQuestions.length ? result.result.unresolvedQuestions.map(q => html`<p>${q}</p>`) : html`<p>未记录具体缺口，不代表根因与恢复已验证。</p>`}
        <h3>${active ? '最近结果的停止原因' : '停止原因'}</h3>
        <p>${result.result.execution?.reasonCode ? stopLabels[result.result.execution.reasonCode] ?? '已记录停止原因码，请展开执行过程与技术详情核对原始记录。' : '历史记录未保留具体停止原因；不能据此认定检查已完整完成。'}</p>
        <h3>下一步</h3>${result.result.recommendations.length
          ? result.result.recommendations.map(r => html`<p>${r.action}</p>`)
          : html`<p>先核对已有证据与停止原因；需要时提交新的只读调查，保留原执行记录。</p>`}
        <button class="btn" @click=${options.onEvidence}>查看完整结果与证据</button>
      ` : html`<p role="status">${active ? '正在检查，尚无持久化结果。' : execution === 'cancelled' ? '执行已取消，未发布结果。可核对已保留的执行过程。' : '暂无持久化结果；可查看已保留的证据与执行过程。'}</p>`}
      </section>
      <details aria-label="调查目标"><summary>调查目标</summary><p style="white-space:pre-wrap;overflow-wrap:anywhere">${detail.goal}</p></details>
      <p class="muted">${detail.profileId === 'system' ? '平台调查' : '资源调查'} · 只读检查</p>
      <p class="investigation-resource-links">${detail.resources.map(ref => html`<a href=${resourceDetailUrl(ref.type, ref.id)}>返回原资源 ${ref.type}:${ref.id}</a> `)}</p>
      ${detail.legacyAnalysis ? html`<p>历史 Analysis #${detail.legacyAnalysis.analysisId} · 只读兼容结果 · ${executionLabels[detail.legacyAnalysis.status] ?? detail.legacyAnalysis.status}</p>
        <p class="muted">原结果不补跑；根因与恢复尚未验证。</p><pre class="legacy-analysis-result" style="white-space:pre-wrap;overflow-wrap:anywhere">${detail.legacyAnalysis.view.summary}</pre>` : nothing}
      <button class="btn evidence-toggle" @click=${options.onEvidence}>查看证据与成果</button>
      <button aria-busy=${String(controller.busy)} class="btn btn-refresh" ?disabled=${controller.busy} @click=${() => void controller.select(detail.id)}>刷新调查</button>
      ${active ? html`<button class="btn" ?disabled=${controller.busy || controller.operationForbidden || controller.cancelRequested || !controller.online}
        @click=${() => void controller.cancel()}>${controller.cancelRequested ? '等待取消确认' : '取消本次执行'}</button>` : nothing}
      ${controller.cancelRequested ? html`<p role="status">取消请求已发送，等待后端确认；工具可能仍在收尾。</p>` : nothing}
    </app-card>
    <investigation-operation-context .investigationId=${detail.id} .resultVersion=${result?.version ?? 0} .resources=${detail.resources}></investigation-operation-context>
    <investigation-feedback .investigationId=${detail.id} .resultId=${result?.id ?? ''}
      .resultVersion=${result?.version ?? 0} .investigationVersion=${detail.version}
      .activeRequest=${active} .readonly=${controller.operationForbidden || !controller.online}
      @investigation-feedback-saved=${() => void controller.refreshFacts()}></investigation-feedback>
    <app-card><span slot="header">执行与协作</span>
      <details aria-label="执行过程与技术详情"><summary>执行过程与技术详情</summary>
      <dl><dt>会话标识</dt><dd>${detail.sessionId}</dd>
        ${result ? html`<dt>运行标识</dt><dd>${result.runId}</dd><dt>停止原因码</dt><dd>${result.result.execution?.reasonCode ?? '历史记录未保留具体停止原因'}</dd>
          <dt>模型配置标识</dt><dd>${result.result.provenance.modelVersion === 'unavailable' ? '历史记录未保留' : result.result.provenance.modelVersion}</dd>
          <dt>提示词版本与哈希</dt><dd>${result.result.provenance.promptVersion === 'unavailable' ? '历史记录未保留' : result.result.provenance.promptVersion}</dd>` : nothing}
      </dl>
      ${controller.historyBefore ? html`<button class="btn" @click=${() => void controller.loadHistory()}>加载更早消息</button>` : nothing}
      <div class="investigation-messages" aria-label="调查消息">
        ${messages.length ? messages.flatMap((message, i) => (messagePartsRenderRows(message, tools) ?? [{ partId: null, message }]).map(row =>
          renderMessageGroup({ kind: 'group', role: String(row.message.role ?? 'assistant'), key: row.partId ?? message.id ?? String(i),
            messages: [{ message: row.message, key: row.partId ?? message.id }], timestamp: 0, isStreaming: false },
          { showReasoning: false, showToolCalls: true, autoExpandToolCalls: false, assistantAttachmentAuthToken: apiClient.getToken() })))
          : html`<app-empty-state title="暂无消息"></app-empty-state>`}
      </div>
      </details>
      <app-form-field label="继续调查" hint=${active ? '本次执行结束后可提交新目标；草稿会保留。' : controller.continuationUnavailable ? '当前结果尚未确认或关联信息未就绪，请刷新核对。' : execution === 'partial' ? '保留部分结果，创建关联的新 Run，不重放原执行。' : '新请求将创建新的 Run，保留历次结果。'}>
        <textarea aria-label="继续调查" rows="3" maxlength="2000" .value=${options.draft}
          @input=${(e: Event) => options.onDraft((e.target as HTMLTextAreaElement).value)}></textarea>
      </app-form-field>
      <button class="btn-primary" ?disabled=${active || controller.continuationUnavailable || controller.busy || controller.operationForbidden || controller.acceptanceUnknown || !controller.online || !options.draft.trim() || detail.lifecycle === 'archived' || detail.lifecycle === 'closed'}
        @click=${options.onContinue}>${execution === 'partial' ? '从部分结果继续' : '提交新 Run'}</button>
      <p class="muted">操作需要调查 operator 权限，服务器实时校验。</p>
    </app-card>`;
}
