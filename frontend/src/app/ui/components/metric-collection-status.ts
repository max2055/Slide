import { html, nothing } from 'lit';
import { statusLabel, type CollectionStatus } from './metric-api.js';
import { metricName, packageName } from './resource-metric-summary.js';

const time = (value: string | null) => value && Number.isFinite(Date.parse(value))
  ? html`<time datetime=${value}>${new Date(value).toLocaleString('zh-CN')}</time>` : '未知';
export const renderCollectionStatus = (status: CollectionStatus) => html`
  <dl class="collection-facts">
    <div><dt>模板绑定</dt><dd>${statusLabel(status.binding.state)}${status.binding.package
      ? html` · ${packageName(status.binding.package.id)} · ${status.binding.package.version}` : nothing}</dd></div>
    <div><dt>有效采集开关</dt><dd>${status.effective_enabled.enabled === null ? '未知' : status.effective_enabled.enabled ? '启用' : '停用'} · ${statusLabel(status.effective_enabled.source)}</dd></div>
    <div><dt>调度应用</dt><dd>${statusLabel(status.binding.application)}</dd></div>
    <div><dt>配置版本</dt><dd>发布 ${status.binding.published_revision ?? '—'} · 应用 ${status.binding.applied_revision ?? '—'}</dd></div>
    <div><dt>采集执行</dt><dd>${status.collection.state === 'pending' ? '等待采集' : statusLabel(status.collection.state)}</dd></div>
    <div><dt>正式数据</dt><dd>${status.formal_visibility.state === 'pending' ? '等待正式观测' : statusLabel(status.formal_visibility.state)}</dd></div>
    <div><dt>最近尝试</dt><dd>${time(status.collection.last_attempt_at)}</dd></div>
    <div><dt>最近成功</dt><dd>${time(status.collection.last_success_at)}</dd></div>
    <div><dt>最近观测</dt><dd>${time(status.formal_visibility.last_observed_at)}</dd></div>
  </dl>
  ${status.blockers.length ? html`<div role="status"><strong>采集阻塞</strong><ul>${status.blockers.map(b => html`<li>${statusLabel(b)}</li>`)}</ul></div>` : nothing}
  ${status.blockers.includes('GLOBAL_COLLECTION_DISABLED') ? html`<details><summary>全局暂停处理说明</summary><p>请平台运维核对采集服务开关和调度日志；资源配置发布不能解除全局暂停。处理后刷新采集状态。</p></details>` : nothing}
  ${status.coverage.length ? html`<details><summary>指标覆盖：${status.coverage.filter(c => c.state === 'covered').length} / ${status.coverage.length} 项</summary>
    <ul>${status.coverage.map(c => html`<li>${metricName(c.metric.id)}：${statusLabel(c.state)}</li>`)}</ul>
  </details>` : nothing}`;
export const collectionFactsStyles = `
  .collection-facts { display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:var(--space-md); }
  .collection-facts div { min-width:0; } .collection-facts dt { color:var(--muted);font-size:var(--text-sm); }
  .collection-facts dd { margin:var(--space-xs) 0 0;overflow-wrap:anywhere; }
`;
