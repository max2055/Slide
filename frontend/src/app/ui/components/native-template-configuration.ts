import { sharedFieldStyles } from '../../styles/shared-field-styles.ts';
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { sharedBtnStyles } from '../../styles/shared-btn-styles.js';
import './app-card.js';
import './app-data-table.js';
import './app-form-field.js';
import './app-badge.js';
import './app-dialog.js';
import './metric-policy-fields.js';
import { metricName } from './resource-metric-summary.js';
import { renderCollectionStatus, collectionFactsStyles } from './metric-collection-status.js';
import { collectionLayoutStyles } from './collection-layout-styles.js';
import { showToast } from './app-toast-container.js';
import {
  applyTemplateBinding, collectTemplateBindingNow, getMetricTemplateVersion, listMetricTemplates, metricError, metricRequest,
  probeTemplateBinding, previewTemplateBinding, readCollectionStatus, readTemplateBinding, readTemplateCollectTask,
  readTemplateOperation,
  repinMetricTemplate, statusLabel, trialTemplateBinding, MetricRequestError,
  type CollectionStatus, type PolicyGroup, type TemplateApplyResult, type TemplateBindingStatus,
  type TemplateCatalogPage, type TemplateCollectResult, type TemplatePin, type TemplatePreview, type TemplateRepinResult,
  type TemplateSummary,
  type TemplateTrial, type TemplateTrialSample, type TemplateVersionDetail,
} from './metric-api.js';
import { type Overrides } from './metric-policy-fields.js';

const labels: Record<string, string> = {
  collect: '采集', derive: '派生', disabled: '已停用', unsupported: '不支持', capability_unknown: '能力待验证',
  supported: '支持', unknown: '待验证', published: '已发布', retired: '已退役',
  draft: '草稿', active: '启用', deprecated: '已弃用', archived: '已归档',
  settings_disabled: '采集开关已停用', metric_disabled: '指标已停用',
  capability_unsupported: '当前版本能力不支持',
  default: '模板默认', override: '本资源覆盖', target_version_incompatible: '目标版本不兼容',
};
const label = (value: string | undefined) => value ? labels[value] ?? '待确认' : '未知';
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const record = value as { value?: unknown };
    if ('value' in record) return String(record.value);
    return JSON.stringify(value);
  }
  return String(value);
};
const pinKey = (pin: TemplatePin) => `${pin.template_id}@${pin.version}`;
const itemKey = (item: { template_id: string; item_id: string; item_version: number }) =>
  `${item.template_id}/${item.item_id}@${item.item_version}`;
const samePin = (left: TemplatePin[], right: TemplatePin[]) => pinKeySort(left) === pinKeySort(right);
const pinKeySort = (pins: TemplatePin[]) => pins.map(pinKey).sort().join('|');
const overridesEmpty = (value: Record<string, unknown>) => Object.keys(value).length === 0;
/** Key order is not part of an intent; two renderings of one configuration must compare equal. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]))
    : value;
/** One apply intent per exact configuration; `pending` means its outcome is unconfirmed. */
interface IntentRecord { key: string; intent: string; pending: boolean }

/**
 * Apply intents written during this page load. `sessionStorage` may reject a
 * write (quota, privacy mode); the exact key must still be queryable in this
 * tab, so memory is the fallback. It does not survive a browser restart, which
 * is an explicit recoverable boundary rather than a silent forget.
 */
const intentMemory = new Map<string, IntentRecord[]>();
const intentStorageMessage = '发布意图无法写入会话存储，只能在当前标签页内查询；刷新浏览器页面后无法恢复，请勿重复发布。';
/** Without a durable copy there is no safe recovery, so the write is never sent. */
const intentStorageRefusal = '无法把发布意图写入会话存储，已在发送前拒绝本次发布，未写入任何配置；修改仍保留在页面中。请恢复浏览器存储后重试。';
const intentCorruptMessage = '已存储的发布意图记录损坏，无法安全判断上次发布结果；已停止发送写请求。请清理该资源的本地会话记录或换用新标签页后重试。';
/** Without a signed session there is no stable principal an intent could be recovered for. */
const intentPrincipalMessage = '无法确认当前登录主体，已在发送前拒绝本次发布，未写入任何配置；修改仍保留在页面中。请重新登录后重试。';
/** One browser tab owns this map; a suite that simulates many tabs resets it per case. */
export function resetIntentMemory() { intentMemory.clear(); }

/* --- immediate collection ------------------------------------------------- */

export const collectStateLabels: Record<string, string> = {
  accepted: '已受理，等待执行', running: '执行中', completed: '任务已完成',
  failed: '任务失败', cancelled: '已取消', unknown: '结果未知', absent: '没有该请求的记录',
};
export const collectOutcomeLabels: Record<string, string> = {
  sampled: '已写入本次正式样本', no_samples: '任务完成但本次没有样本',
  failed: '未产生正式样本', cancelled: '已取消', unknown: '结果未知，不能当作成功',
};
const collectTerminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
/** The key is written before the request; without that record an unknown outcome is unrecoverable. */
const collectStorageKey = (principal: string, refKey: string) => `slide.metric-collect.v1:${principal}:${refKey}`;
const collectStorageRefusal = '无法把采集请求写入会话存储，已在发送前拒绝本次采集，未创建任何任务；请恢复浏览器存储或换用新标签页后重试。';
const collectPrincipalMessage = '无法确认当前登录主体，已在发送前拒绝本次采集；请重新登录后重试。';
const collectCorruptMessage = '已存储的采集请求记录损坏，无法安全判断上次请求的结果；已停止发送新的采集请求。请清理该资源的本地会话记录后重试。';

/**
 * The principal of the signed session, from the access token the server issued.
 * The cached `user` profile is not used: it can be missing or corrupt while the
 * session is still valid, and a per-instance random token would silently change
 * the recovery key on every remount. `null` means no reliable identity.
 */
function sessionPrincipal(): string | null {
  let token: string | null;
  try { token = localStorage.getItem('token'); } catch { return null; }
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as { userId?: unknown };
    return typeof payload.userId === 'number' && Number.isSafeInteger(payload.userId) && payload.userId > 0
      ? `user-${payload.userId}` : null;
  } catch { return null; }
}

/**
 * Per-rejection messages. The server answers with one stable code and, for a
 * conflict, the exact item/setting; nothing here re-derives a decision the
 * backend did not make.
 */
export function nativeError(error: unknown): string {
  if (error instanceof MetricRequestError) {
    const codes: Record<string, string> = {
      PREFLIGHT_CANONICAL_CONFLICT: '多个模板提供同一指标，不能由后选择的模板覆盖；请取消其中一个模板后再检查。',
      RESOLVE_SETTING_CONFLICT: '所选模板的默认采集设置不一致，请显式设置冲突项后再检查。',
      PREFLIGHT_VERSION_MISSING: '固定版本不存在，请重新选择。',
      PREFLIGHT_VERSION_RETIRED: '固定版本已退役，请选择已发布版本。',
      PREFLIGHT_CONTENT_HASH_MISMATCH: '版本内容与固定校验值不一致，请重新选择版本。',
      CANDIDATE_RELEASE_UNAVAILABLE: '该版本引用的采集实现未安装，不能应用。',
      CANDIDATE_IMPLEMENTATION_UNAVAILABLE: '该版本缺少可用的采集实现，不能应用。',
      CANDIDATE_TEMPLATE_NOT_EXECUTABLE: '该模板版本不适用于当前对象，请选择支持当前版本的模板。',
      CANDIDATE_UNIT_MISMATCH: '模板指标单位与采集实现不一致，不能应用。',
      CANDIDATE_DIMENSION_INVALID: '模板指标维度与采集实现不一致，不能应用。',
      CANDIDATE_METRIC_UNDEFINED: '模板引用了未定义的指标，不能应用。',
      RESOLVE_PARAMETER_TYPE: '参数类型不正确，请检查覆盖值。',
      RESOLVE_PARAMETER_RANGE: '参数超出允许范围，请检查覆盖值。',
      RESOLVE_PARAMETER_UNKNOWN: '参数不属于所选模板，请重新选择模板。',
      TEMPLATE_BINDING_NOT_EXECUTABLE: '当前固定版本不适用于此对象，不能试采或应用。',
      TEMPLATE_BINDING_BUSY: '此资源正在试采，请稍后再试。',
      TEMPLATE_BINDING_ALREADY_BOUND: '此对象已建立配置绑定，请重新加载后继续。',
      TEMPLATE_BINDING_PROBE_FAILED: '无法从当前对象取得采集能力证据，未写入任何配置；请检查连接与权限后重试。',
      CAPABILITY_EVIDENCE_EXPIRED: '对象的采集能力证据已过期，请重新检查配置。',
      CAPABILITY_EVIDENCE_INVALID: '已存储的采集能力证据无效，不能用于启用；请重新检查配置。',
      CAPABILITY_EVIDENCE_UNAVAILABLE: '暂时无法读取采集能力证据，请稍后重新检查。',
      TEMPLATE_BINDING_RECEIPT_INVALID: '试采凭证已失效或已被使用，请重新检查并试采。',
      TEMPLATE_BINDING_LEGACY_CANDIDATE: '当前配置是旧版单包绑定，原生模板流程不接管；请在旧版配置中操作。',
      TEMPLATE_BINDING_RESOURCE_NOT_FOUND: '资源不存在或已被删除。',
      TRANSACTION_BINDING_MISSING: '此资源尚无已发布的基础配置，原生模板应用需要先建立资源绑定；未写入任何变更。',
      TRANSACTION_REVISION_CONFLICT: '配置版本已被他人更新，请重新加载后再次检查。',
      TRANSACTION_OPERATION_CONFLICT: '操作键已被另一个意图使用，请重新检查生成新的操作。',
      TRANSACTION_DEPENDENCY_CHANGED: '资源、权限或配置依赖已变化，请重新加载并检查、试采。',
      TRANSACTION_CANCELLED: '操作已取消，未写入变更。',
      TRANSACTION_RECEIPT_EXPIRED: '试采凭证已过期，请重新检查并试采。',
      TRANSACTION_RECEIPT_NOT_FOUND: '找不到对应的试采凭证，请重新试采。',
      TRANSACTION_RECEIPT_INVALID: '试采凭证无效，请重新试采。',
      TRANSACTION_RECEIPT_MISMATCH: '试采凭证与本次固定版本不一致，请重新试采。',
      TRANSACTION_RECEIPT_ITEMS_INVALID: '试采凭证的必要项与所选模板不一致，请重新试采。',
      TRANSACTION_RECEIPT_TIME_INVALID: '试采时间不合法，请重新试采。',
      TRANSACTION_BINDING_UNAVAILABLE: '资源绑定暂时不可读，请重新加载后重试。',
      TRANSACTION_BINDING_INVALID: '资源绑定数据无效，未写入任何变更。',
      TRANSACTION_BINDING_IDENTITY: '请求的资源与绑定不一致，未写入任何变更。',
      TEMPLATE_OPERATION_FAILED: '无法确认发布结果，请稍后查询发布结果；不要直接重复发布。',
      REPIN_TEMPLATE_NOT_FOUND: '模板不存在或已不可读取。',
      REPIN_VERSION_NOT_FOUND: '模板没有可升级的当前版本。',
      REPIN_NO_COMPATIBLE_RELEASE: '没有已安装且适用于此对象的采集实现，不能发布兼容版本。',
      REPIN_SEMANTICS_MISMATCH: '兼容升级会改变指标语义（指标、单位或维度），已拒绝；未发布新版本。',
      REPIN_PUBLISH_FAILED: '发布兼容版本失败，未写入新版本。',
    };
    if (error.code && codes[error.code]) return codes[error.code];
    if (error.code && error.code.startsWith('CANDIDATE_')) return '所选固定版本无法在当前对象执行，请检查版本与采集实现。';
    if (error.code && error.code.startsWith('PREFLIGHT_')) return '所选固定版本校验未通过，请重新选择版本。';
    if (error.code && error.code.startsWith('RESOLVE_')) return '参数或模板设置无法解析，请检查覆盖和冲突项。';
  }
  return metricError(error);
}
const goodSample = (sample: TemplateTrialSample) => sample.value != null
  && (!sample.quality || sample.quality.status === undefined || sample.quality.status === 'good');
/** Every non-excluded item needs read/transform/unit and a real value; optional exclusions are explicit. */
export function nativeTrialPassed(trial: TemplateTrial | null): boolean {
  if (!trial || trial.decision !== 'attempted') return false;
  const optional = new Set(trial.optional_exclusions.map(itemKey));
  const mandatory = trial.items.filter(item => !optional.has(itemKey(item)));
  return mandatory.length > 0 && mandatory.every(item => item.phases.read && item.phases.transform && item.phases.unit
    && trial.samples.some(sample => itemKey(sample) === itemKey(item) && goodSample(sample)));
}

@customElement('native-template-configuration')
export class NativeTemplateConfiguration extends LitElement {
  @property() resourceType = 'instance';
  @property({ type: Number }) resourceId = 0;
  @property({ type: Boolean }) connectionPending = false;

  @state() private binding: TemplateBindingStatus | null = null;
  @state() private collection: CollectionStatus | null = null;
  @state() private canManage = false;
  @state() private loaded = false;
  @state() private busy = false;
  @state() private error = '';
  @state() private statusError = '';
  @state() private polling = false;
  @state() private pollLimitReached = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollCount = 0;
  private generation = 0;
  /**
   * Changes with every edit, discard, repin, resource load and access event. A
   * response is projected only onto the exact draft version that asked for it;
   * an edit during an in-flight preview/trial/apply makes that answer stale,
   * including `previewStale=false` and `trialReady=true` transitions.
   */
  private draftVersion = 0;

  // Catalog: the full authorized catalog is paged, never truncated to one page.
  @state() private templates: TemplateSummary[] = [];
  @state() private nextCursor: string | null = null;
  @state() private catalogQuery = '';
  @state() private catalogStatus = '';
  @state() private catalogError = '';
  @state() private catalogLoading = false;
  private catalogTimer?: ReturnType<typeof setTimeout>;
  private catalogGeneration = 0;

  // One exact pin per selected template; versions are published/retired only.
  @state() private selected: TemplatePin[] = [];
  @state() private names: Record<string, string> = {};
  @state() private details: Record<string, TemplateVersionDetail> = {};
  @state() private detailError = '';

  // The resource-level override set sent as `overrides`; parameters are per template.
  @state() private settings: Overrides = {};
  @state() private parameters: Record<string, Record<string, number | string | boolean>> = {};
  @state() private metricToggles: Record<string, 'inherit' | 'enable' | 'disable'> = {};
  @state() private groups: PolicyGroup[] = [];
  @state() private groupId = '';
  @state() private groupSearch = '';
  @state() private groupError = '';
  private groupTimer?: ReturnType<typeof setTimeout>;
  private groupVersion = 0;

  @state() private preview: TemplatePreview | null = null;
  @state() private previewStale = false;
  @state() private previewIssue: { code: string; message: string; details: Record<string, unknown> } | null = null;
  @state() private trial: TemplateTrial | null = null;
  @state() private step = 0;
  @state() private dirty = false;
  @state() private applyResult: { revision: number; replayed: boolean } | null = null;
  @state() private discardPending = false;
  @state() private repinTarget: { template_id: string; name: string } | null = null;
  @state() private repinResult: TemplateRepinResult | null = null;
  @state() private repinBusy = false;
  private afterDiscard: (() => void) | null = null;

  /**
   * Apply intents whose outcome was never confirmed. They are tracked per exact
   * intent (never per button state), survive an edit, a reload or a resource
   * switch, and are only released by a journal answer: committed, or absent
   * (which proves nothing was recorded). A new edit is a new intent and leaves
   * the old one pending under its own key.
   */
  @state() private unresolved: IntentRecord[] = [];
  /** A storage write failed: the key is tracked in this tab only (never silently forgotten). */
  @state() private intentStorageLimited = false;
  /** Stored intent records are unreadable: no write may be sent without safe tracking. */
  @state() private intentStorageError = '';

  /** The last queryable manual-collection task for this resource. */
  @state() private collectResult: TemplateCollectResult | null = null;
  @state() private collectBusy = false;
  @state() private collectError = '';
  /** A request key whose outcome is not terminal yet; every query/retry uses exactly this key. */
  @state() private collectPendingKey: string | null = null;
  @state() private collectStorageError = '';
  private collectTimer?: ReturnType<typeof setTimeout>;
  private collectPolls = 0;
  private collectGeneration = 0;

  private readonly accessChanged = () => {
    clearTimeout(this.catalogTimer); clearTimeout(this.groupTimer);
    this.catalogGeneration++; this.groupVersion++; this.generation++; this.draftVersion++; this.stopPolling();
    this.stopCollectPolling(); this.collectPendingKey = null; this.collectResult = null; this.collectBusy = false;
    this.binding = null; this.collection = null; this.canManage = false; this.busy = false;
    this.preview = null; this.trial = null; this.selected = [];
    // Intents are keyed by the current principal + resource: a session switch
    // reads the new principal's records and never projects the old one's.
    this.unresolved = this.storedIntents();
    this.loaded = false; this.dirty = false; this.error = '权限或登录状态已变更，请重新打开资源后读取配置';
  };
  private readonly navigate = (event: Event) => {
    if (!this.dirty) return;
    event.stopImmediatePropagation(); event.preventDefault();
    const detail = (event as CustomEvent).detail;
    this.confirmDiscard(() => window.dispatchEvent(new CustomEvent('slide-navigate', { detail })));
  };
  private readonly beforeUnload = (event: BeforeUnloadEvent) => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('beforeunload', this.beforeUnload);
    window.addEventListener('slide-navigate', this.navigate, true);
    window.addEventListener('slide-permissions-loaded', this.accessChanged);
    window.addEventListener('slide-session-expired', this.accessChanged);
  }
  override disconnectedCallback() {
    this.stopPolling(); this.stopCollectPolling(); clearTimeout(this.catalogTimer); clearTimeout(this.groupTimer);
    this.catalogGeneration++; this.groupVersion++; this.generation++;
    window.removeEventListener('beforeunload', this.beforeUnload);
    window.removeEventListener('slide-navigate', this.navigate, true);
    window.removeEventListener('slide-permissions-loaded', this.accessChanged);
    window.removeEventListener('slide-session-expired', this.accessChanged);
    super.disconnectedCallback();
  }
  override willUpdate(changes: Map<string, unknown>) {
    if (changes.has('connectionPending') && this.connectionPending) {
      const dirty = this.dirty; this.invalidate(false); this.dirty = dirty;
    }
    if (changes.has('resourceId') || changes.has('resourceType')) void this.load();
  }

  static componentStyles = [sharedBtnStyles, css`
    :host{display:block;min-width:0;color:var(--text)}
    .actions{display:flex;flex-wrap:wrap;gap:var(--space-sm);margin-block:var(--space-md)}
    .scroll{overflow:auto;max-width:100%} app-data-table{min-width:36rem}
    .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:var(--space-md)}
    input,select{box-sizing:border-box;width:100%;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-sm)}
    .error{color:var(--danger)} p{overflow-wrap:anywhere} pre{white-space:pre-wrap;overflow-wrap:anywhere}
    .template-row{display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:flex-start;padding-block:var(--space-sm);border-bottom:1px solid var(--border)}
    .template-row:last-child{border-bottom:0}.template-row .grow{flex:1 1 16rem;min-width:0}
    .chips{display:flex;flex-wrap:wrap;gap:var(--space-xs);margin-block:var(--space-sm)}
    .chip{display:inline-flex;gap:var(--space-xs);align-items:center;border:1px solid var(--border);border-radius:var(--radius-full);padding:2px 8px}
    .steps{display:flex;flex-wrap:wrap;gap:var(--space-sm);padding:0;list-style:none}
    .steps li{border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-xs) var(--space-sm)}
    .steps li.current{border-color:var(--accent);color:var(--accent)}.steps li.done{border-color:var(--border-strong);color:var(--muted)}
    .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:var(--space-md)}
    .facts div{min-width:0}.facts dt{color:var(--muted);font-size:var(--text-sm)}.facts dd{margin:0}
    .metric-list{list-style:none;padding:0;margin:0}.metric-list li{display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:center;justify-content:space-between;padding-block:var(--space-xs);border-bottom:1px solid var(--border)}
    .metric-list select{width:auto;min-width:8rem}
    .parameter-list{display:grid;gap:var(--space-xs)}.parameter-row{display:grid;grid-template-columns:minmax(8rem,1.2fr) repeat(4,minmax(5rem,1fr));gap:var(--space-sm);align-items:center;padding-block:var(--space-xs);border-bottom:1px solid var(--border)}
    @media (max-width:720px){.parameter-row{grid-template-columns:1fr 1fr}}
  `];

  private root() { return `${this.resourceType}/${this.resourceId}`; }
  private refKey() { return `${this.resourceType}:${this.resourceId}`; }
  private baseRevision() { return this.binding?.revision ?? 0; }
  private canWrite() { return this.canManage && !this.connectionPending; }
  /** The exact intent the current draft would apply; 0 is an unbound resource. */
  private firstBinding() { return this.binding?.source === 'unbound'; }
  private currentPending() { return this.pendingFor(this.intentIdentity()); }

  private async load() {
    this.stopPolling();
    this.clearTimeoutSearch();
    const generation = ++this.generation;
    this.draftVersion++;
    this.binding = null; this.collection = null; this.canManage = false; this.loaded = false;
    this.preview = null; this.previewStale = false; this.previewIssue = null; this.trial = null;
    this.selected = []; this.settings = {}; this.parameters = {}; this.metricToggles = {}; this.groupId = '';
    this.detailError = ''; this.error = ''; this.statusError = ''; this.step = 0; this.dirty = false;
    // A resource switch closes the re-pin dialog: its result belongs to the old resource.
    this.repinTarget = null; this.repinResult = null; this.repinBusy = false; this.details = {};
    this.applyResult = null; this.busy = false;
    this.stopCollectPolling();
    this.collectResult = null; this.collectBusy = false; this.collectError = '';
    this.collectStorageError = ''; this.collectPendingKey = null; this.collectPolls = 0;
    this.unresolved = this.storedIntents();
    if (!Number.isSafeInteger(this.resourceId) || this.resourceId <= 0) return;
    this.busy = true;
    try {
      const [binding, status, groups, page] = await Promise.all([
        readTemplateBinding(this.resourceType, this.resourceId),
        readCollectionStatus(this.resourceType, this.resourceId),
        metricRequest<{ groups: PolicyGroup[] }>('policy/groups'),
        listMetricTemplates({ limit: 10 }),
      ]);
      if (generation !== this.generation) return;
      this.binding = binding; this.collection = status; this.canManage = status.can_manage;
      this.groups = groups.groups;
      this.templates = page.templates; this.nextCursor = page.next_cursor;
      this.names = Object.fromEntries(page.templates.map(entry => [entry.template_id, entry.name]));
      this.seedFromBinding(binding);
      this.loaded = true;
      // Background recovery lookups never block the editor: a user edit made
      // while one is in flight must be possible and must survive its answer.
      this.busy = false;
      await this.restorePending(generation);
      if (generation !== this.generation) return;
      // A stored manual-collection key is queried, never re-sent.
      await this.restoreCollect(generation);
      if (generation !== this.generation) return;
      if (binding.source === 'template' && !this.terminal(status)) this.startPolling();
    } catch (error) {
      if (generation === this.generation) this.error = nativeError(error);
    } finally { if (generation === this.generation) this.busy = false; }
  }
  /**
   * Seed the editor from the stored per-resource choice. It is the only
   * lossless source: the resolved plan cannot say which value was inherited
   * from a template and which the operator set on this resource, so seeding
   * from it would silently drop explicit values on the next save.
   */
  private seedFromBinding(binding: TemplateBindingStatus) {
    this.selected = binding.template_pins.map(pin => ({ ...pin }));
    const overrides = binding.configuration?.overrides ?? {};
    const { metrics, template_parameters: parameters, ...settings } = overrides as {
      metrics?: unknown; template_parameters?: unknown; [key: string]: unknown;
    };
    this.settings = settings as Overrides;
    this.metricToggles = (metrics && typeof metrics === 'object' ? structuredClone(metrics) : {}) as
      Record<string, 'inherit' | 'enable' | 'disable'>;
    this.parameters = (parameters && typeof parameters === 'object' ? structuredClone(parameters) : {}) as
      Record<string, Record<string, number | string | boolean>>;
    this.groupId = binding.configuration?.group_id ?? '';
  }
  private clearTimeoutSearch() {
    clearTimeout(this.catalogTimer); clearTimeout(this.groupTimer);
    this.catalogGeneration++; this.groupVersion++;
  }
  private terminal(status: CollectionStatus) {
    return status.effective_enabled.enabled === false || status.binding.application === 'failed'
      || ['ready', 'available', 'failed'].includes(status.formal_visibility.state);
  }
  private stopPolling() { clearTimeout(this.pollTimer); this.pollTimer = undefined; this.polling = false; }
  private startPolling() { this.stopPolling(); this.pollCount = 0; this.pollLimitReached = false; this.polling = true; this.schedulePoll(); }
  private schedulePoll() { this.pollTimer = setTimeout(() => void this.refreshStatus(), 2000); }
  private async refreshStatus() {
    const generation = this.generation;
    this.statusError = '';
    try {
      const status = await readCollectionStatus(this.resourceType, this.resourceId);
      if (generation !== this.generation || !this.isConnected) return;
      this.collection = status;
      if (this.terminal(status)) { this.stopPolling(); return; }
      if (++this.pollCount >= 15) { this.pollLimitReached = true; this.stopPolling(); return; }
      if (this.polling) this.schedulePoll();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof MetricRequestError && [401, 403, 404].includes(error.status)) this.accessChanged();
      this.statusError = nativeError(error); this.stopPolling();
    }
  }

  /* --- catalog ------------------------------------------------------------ */

  private searchCatalog(value: string) {
    this.catalogQuery = value; this.catalogError = '';
    clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => void this.loadCatalog(true), 300);
  }
  private filterStatus(value: string) {
    this.catalogStatus = value; clearTimeout(this.catalogTimer); void this.loadCatalog(true);
  }
  private async loadCatalog(reset: boolean) {
    const generation = ++this.catalogGeneration;
    this.catalogLoading = true; this.catalogError = '';
    try {
      const page: TemplateCatalogPage = await listMetricTemplates({ query: this.catalogQuery.trim() || undefined,
        status: this.catalogStatus || undefined, cursor: reset ? undefined : this.nextCursor ?? undefined, limit: 10 });
      if (generation !== this.catalogGeneration) return;
      const merged = reset ? page.templates : [...this.templates,
        ...page.templates.filter(entry => !this.templates.some(existing => existing.template_id === entry.template_id))];
      this.templates = merged; this.nextCursor = page.next_cursor;
      this.names = { ...this.names, ...Object.fromEntries(page.templates.map(entry => [entry.template_id, entry.name])) };
    } catch (error) {
      if (generation === this.catalogGeneration) {
        if (error instanceof MetricRequestError && [401, 403].includes(error.status)) this.accessChanged();
        this.catalogError = nativeError(error);
      }
    } finally { if (generation === this.catalogGeneration) this.catalogLoading = false; }
  }

  private selectedPin(templateId: string) { return this.selected.find(pin => pin.template_id === templateId) ?? null; }
  private publishedVersions(template: TemplateSummary) { return template.versions.filter(version => version.status === 'published'); }
  private versionDisabled(template: TemplateSummary, version: TemplateSummary['versions'][number]): string | null {
    if (template.status === 'draft') return '模板为草稿，未发布';
    if (version.status === 'retired') return '版本已退役';
    return null;
  }
  private toggleTemplate(template: TemplateSummary, checked: boolean) {
    if (!checked) { this.selected = this.selected.filter(pin => pin.template_id !== template.template_id); this.invalidate(false); return; }
    const versions = this.publishedVersions(template);
    if (!versions.length) { this.error = '该模板没有已发布版本，不能选择。'; return; }
    // The template's own current pointer is the data-driven default, never the
    // first row of the list.
    const current = versions.find(version => version.version === template.current_published_version) ?? versions[versions.length - 1];
    this.selected = [...this.selected.filter(pin => pin.template_id !== template.template_id),
      { template_id: template.template_id, version: current.version, content_hash: current.content_hash }];
    this.names = { ...this.names, [template.template_id]: template.name };
    this.error = '';
    void this.ensureDetail(this.selectedPin(template.template_id)!);
    this.invalidate(false);
  }
  private changeVersion(template: TemplateSummary, version: number) {
    const chosen = template.versions.find(entry => entry.version === version);
    if (!chosen) return;
    this.selected = this.selected.map(pin => pin.template_id === template.template_id
      ? { template_id: template.template_id, version: chosen.version, content_hash: chosen.content_hash } : pin);
    void this.ensureDetail(this.selectedPin(template.template_id)!);
    this.invalidate(false);
  }
  private async ensureDetail(pin: TemplatePin) {
    const key = pinKey(pin);
    if (this.details[key]) return;
    const generation = this.generation;
    try {
      const detail = await getMetricTemplateVersion(pin.template_id, pin.version);
      // A late answer for a resource the user already left never lands here.
      if (generation !== this.generation) return;
      this.details = { ...this.details, [key]: detail };
    } catch (error) { if (generation === this.generation) this.detailError = nativeError(error); }
  }

  /**
   * An explicit compatible upgrade. It is offered only for a selected template
   * whose exact version cannot run on this target, and it never happens
   * implicitly: the user confirms a new immutable version that keeps the old
   * one. No other resource, pin or current pointer is touched.
   *
   * The request publishes a global template version, so its answer is projected
   * only onto the resource and dialog that asked for it: a delayed response
   * after a resource switch, a close or a second request is dropped.
   */
  private repinOffered(templateId: string) {
    if (!this.canWrite() || this.repinBusy || !this.selectedPin(templateId)) return false;
    return (!!this.preview && !this.preview.executable)
      || (!!this.previewIssue && /^(CANDIDATE_|PREFLIGHT_|RESOLVE_)/.test(this.previewIssue.code));
  }
  private openRepin(template: TemplateSummary) {
    this.repinTarget = { template_id: template.template_id, name: template.name };
    this.repinResult = null; this.error = '';
  }
  private closeRepin() { this.repinTarget = null; this.repinResult = null; }
  private async runRepin() {
    const target = this.repinTarget;
    if (!target || this.repinBusy) return;
    const generation = this.generation;
    const resource = this.refKey();
    const current = () => generation === this.generation && this.refKey() === resource
      && this.repinTarget?.template_id === target.template_id;
    this.repinBusy = true; this.error = '';
    try {
      const result = await repinMetricTemplate(target.template_id, { type: this.resourceType, id: this.resourceId });
      if (!current()) return;
      this.repinResult = result;
      if (!result.unchanged) {
        const changed = result as Extract<TemplateRepinResult, { unchanged: false }>;
        this.selected = this.selected.map(pin => pin.template_id === target.template_id ? { ...changed.pin } : pin);
        this.names = { ...this.names, [target.template_id]: target.name };
        this.details = {};
        void this.ensureDetail(changed.pin);
        await this.loadCatalog(true);
        if (!current()) return;
        // The new version must be checked again; the old trial/pin is invalid.
        this.invalidate(false);
        showToast(`已为该模板发布兼容版本 v${changed.to_version}，请重新检查`, 'success');
      } else {
        showToast('该模板当前版本已适用于此对象，无需发布新版本', 'info');
      }
    } catch (error) { if (current()) this.error = nativeError(error); }
    finally { if (current()) this.repinBusy = false; }
  }

  /* --- overrides ---------------------------------------------------------- */

  private overrides(): Record<string, unknown> {
    const overrides: Record<string, unknown> = { ...this.settings };
    const metrics = Object.fromEntries(Object.entries(this.metricToggles).filter(([, value]) => value !== 'inherit'));
    if (Object.keys(metrics).length) overrides.metrics = metrics;
    const parameters = Object.fromEntries(Object.entries(this.parameters)
      .map(([templateId, values]) => [templateId, { ...values }])
      .filter(([, values]) => Object.keys(values as Record<string, unknown>).length));
    if (Object.keys(parameters).length) overrides.template_parameters = parameters;
    return overrides;
  }
  private requestBody() {
    return { expected_revision: this.baseRevision(), template_pins: this.selected.map(pin => ({ ...pin })),
      overrides: this.overrides(), group_id: this.groupId || null };
  }
  private invalidate(keepPreview: boolean) {
    this.draftVersion++;
    this.trial = null; this.step = 0; this.applyResult = null; this.dirty = true; this.error = '';
    if (!keepPreview) { this.preview = null; this.previewStale = false; this.previewIssue = null; }
    else if (this.preview) this.previewStale = true;
    // An unconfirmed application is not a draft: editing, discarding or reloading
    // never clears it. Only a journal answer does (see `lookup`).
  }
  private changeSettings(overrides: Overrides) {
    this.settings = overrides;
    // The fields component spreads its own keys; keep parameters/metric toggles.
    this.invalidate(true);
  }
  private changeParameter(templateId: string, name: string, value: string, type: string) {
    const parsed = type === 'boolean' ? value === 'true'
      : type === 'number' || type === 'integer' ? (value === '' ? null : Number(value)) : value;
    const current = { ...(this.parameters[templateId] ?? {}) };
    if (parsed === null || (typeof parsed === 'number' && !Number.isFinite(parsed)) || value === '') delete current[name];
    else current[name] = parsed as number | string | boolean;
    this.parameters = { ...this.parameters, [templateId]: current };
    this.invalidate(true);
  }
  private toggleMetric(key: string, value: string) {
    this.metricToggles = { ...this.metricToggles, [key]: value as 'inherit' | 'enable' | 'disable' };
    this.invalidate(true);
  }
  private searchGroups(value: string) {
    this.groupSearch = value; this.groupError = '';
    clearTimeout(this.groupTimer);
    const version = ++this.groupVersion, generation = this.generation;
    this.groupTimer = setTimeout(async () => {
      try {
        const result = await metricRequest<{ groups: PolicyGroup[] }>(`policy/groups?query=${encodeURIComponent(value.trim())}`);
        if (version !== this.groupVersion || generation !== this.generation) return;
        const selected = this.groups.find(group => group.id === this.groupId);
        this.groups = selected && !result.groups.some(group => group.id === selected.id) ? [selected, ...result.groups] : result.groups;
      } catch (error) {
        if (version === this.groupVersion && generation === this.generation) {
          if (error instanceof MetricRequestError && [401, 403].includes(error.status)) this.accessChanged();
          this.groupError = nativeError(error);
        }
      }
    }, 250);
  }

  /* --- flow --------------------------------------------------------------- */

  private flowError(error: unknown) {
    const details = error instanceof MetricRequestError ? error.details : {};
    this.previewIssue = error instanceof MetricRequestError && error.code && error.status === 422
      ? { code: error.code, message: nativeError(error), details } : null;
    this.preview = null; this.previewStale = false; this.trial = null; this.step = 0;
    this.error = nativeError(error);
  }
  private async previewFlow() {
    if (this.busy || !this.canWrite() || !this.selected.length) return;
    const generation = this.generation;
    const draft = this.draftVersion;
    // Every answer belongs to the exact draft that asked for it. A late response
    // for an older edit must not clear the stale marker or re-enable the trial.
    const current = () => generation === this.generation && draft === this.draftVersion;
    this.busy = true; this.error = ''; this.previewIssue = null;
    let probeFailure: unknown = null;
    try {
      // An unbound resource has no capability facts yet; acquire them through a
      // real bounded read-only probe before asking for the preview. Save-only
      // (explicitly disabled) needs no capability evidence.
      if (this.firstBinding() && this.settings.enabled !== 'disable') {
        try {
          await probeTemplateBinding(this.resourceType, this.resourceId, this.requestBody());
        } catch (error) {
          // Losing the bootstrap race is not a failure: the preview reads the
          // now-published binding capabilities instead. Any other probe failure
          // is reported when the preview itself cannot become executable.
          if (!(error instanceof MetricRequestError && error.code === 'TEMPLATE_BINDING_ALREADY_BOUND')) probeFailure = error;
        }
        if (!current()) return;
      }
      const preview = await previewTemplateBinding(this.resourceType, this.resourceId, this.requestBody());
      if (!current()) return;
      this.preview = preview; this.previewStale = false; this.trial = null; this.step = 1;
      this.dirty = true;
      if (!preview.executable) this.error = probeFailure
        ? nativeError(probeFailure)
        : '当前固定版本对此外对象的采集不可执行；请解决下方标记的不兼容项。';
    } catch (error) {
      if (current()) this.flowError(error);
    } finally { if (generation === this.generation) this.busy = false; }
  }
  private trialReady() { return !!this.preview && this.preview.executable && !this.previewStale && !this.busy; }
  private trialPassed() { return nativeTrialPassed(this.trial); }
  private saveOnly() { return !!this.preview && this.preview.settings.enabled === false; }
  private applyReady() { return !!this.trial && !this.previewStale && (this.trialPassed() || this.saveOnly()); }
  private async runTrial() {
    if (!this.trialReady()) return;
    const generation = this.generation;
    const draft = this.draftVersion;
    this.busy = true; this.error = '';
    try {
      // The trial is read-only; a lost response never changed the configuration,
      // so a new attempt reads fresh evidence rather than resuming an old one.
      const receiptId = `trial-${this.resourceType}-${this.resourceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const trial = await trialTemplateBinding(this.resourceType, this.resourceId, { ...this.requestBody(), receipt_id: receiptId });
      if (generation !== this.generation || draft !== this.draftVersion) return;
      this.trial = trial; this.step = this.applyReady() ? 2 : 1;
      this.dirty = true;
    } catch (error) {
      if (generation === this.generation && draft === this.draftVersion) { this.error = nativeError(error); this.trial = null; this.step = 1; }
    } finally { if (generation === this.generation) this.busy = false; }
  }

  /* --- unresolved apply intents ------------------------------------------- */

  private intentStorageKey(resource = this.refKey()): string | null {
    const principal = sessionPrincipal();
    // No signed session means no stable recovery identity: a per-instance key
    // would look like recovery while losing the record on the next remount.
    return principal ? `slide.metric.native.apply.${principal}.${resource}` : null;
  }
  private validIntents(value: unknown): IntentRecord[] | null {
    if (!Array.isArray(value)) return null;
    // One bad entry makes the whole record unreadable. Silently filtering it out
    // would turn a corrupt record into "nothing was pending" and could release a
    // key whose write is still unconfirmed.
    const valid = value.every((entry): entry is IntentRecord => !!entry
      && typeof (entry as { key?: unknown }).key === 'string'
      && typeof (entry as { intent?: unknown }).intent === 'string'
      && typeof (entry as { pending?: unknown }).pending === 'boolean');
    return valid ? value as IntentRecord[] : null;
  }
  /**
   * The exact intents known for this principal + resource. Session storage is the
   * durable copy; the in-memory map is the same-tab copy and wins for an entry it
   * already holds (including a `pending` flag a failed write could not persist).
   * An unreadable record is an explicit error, never "absent".
   */
  private storedIntents(resource = this.refKey()): IntentRecord[] {
    const storageKey = this.intentStorageKey(resource);
    if (!storageKey) {
      this.intentStorageError = intentPrincipalMessage;
      return [];
    }
    const memory = intentMemory.get(storageKey);
    let stored: IntentRecord[] | null;
    let unreadable = false;
    try {
      const raw = sessionStorage.getItem(storageKey);
      stored = raw === null ? [] : this.validIntents(JSON.parse(raw) as unknown);
    } catch {
      stored = null; unreadable = true;
    }
    if (stored === null) {
      this.intentStorageError = unreadable
        ? '无法读取此前的发布意图记录；为避免重复发布，本次未发送任何写请求。请刷新页面后重试。'
        : intentCorruptMessage;
      return memory ? memory.map(entry => ({ ...entry })) : [];
    }
    this.intentStorageError = '';
    const merged = new Map<string, IntentRecord>();
    for (const entry of stored) merged.set(entry.key, entry);
    for (const entry of memory ?? []) merged.set(entry.key, entry);
    const result = [...merged.values()];
    intentMemory.set(storageKey, result.map(entry => ({ ...entry })));
    return result.map(entry => ({ ...entry }));
  }
  /**
   * Persist the intent set. Returns whether the durable copy was written; a
   * new write intent is only allowed to be sent on `true`. Memory is updated
   * either way so a same-tab reload can still query what it does hold, but it
   * is never presented as surviving a page refresh.
   */
  private persistIntents(next: IntentRecord[], resource = this.refKey()): boolean {
    const storageKey = this.intentStorageKey(resource);
    if (!storageKey) { this.intentStorageError = intentPrincipalMessage; return false; }
    let durable = true;
    try {
      if (next.length) sessionStorage.setItem(storageKey, JSON.stringify(next));
      else sessionStorage.removeItem(storageKey);
      this.intentStorageLimited = false;
    } catch {
      // The exact key stays in memory and is still queryable in this tab; a
      // browser restart cannot recover it, so say so instead of pretending.
      durable = false;
      if (next.length) this.intentStorageLimited = true;
    }
    this.unresolved = next.filter(entry => entry.pending);
    intentMemory.set(storageKey, next.map(entry => ({ ...entry })));
    return durable;
  }
  private allIntents(resource = this.refKey()) { return this.storedIntents(resource); }
  /**
   * The identity of one user intent: the resource and the exact configuration
   * to apply. The trial receipt is deliberately excluded — re-trialling for the
   * same configuration is the same intent, so it keeps the same operation key
   * instead of becoming a second write under a different key.
   */
  private intentIdentity() { return JSON.stringify(canonical({ resource: this.refKey(), body: this.requestBody() })); }
  private pendingFor(intent: string) { return this.unresolved.find(entry => entry.intent === intent) ?? null; }
  /** One key per intent for the whole session, whether or not it is still open. */
  private intentKey(intent: string) {
    const known = this.allIntents().find(entry => entry.intent === intent);
    if (known) return known.key;
    return `apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  /**
   * Record the exact intent and key *before* the write it authorizes. The write
   * is not sent unless this returns true: without a durable record there is no
   * recovery after a lost response or a page refresh, so the request is refused
   * and the draft is preserved.
   */
  private rememberIntent(key: string, intent: string): boolean {
    const rest = this.allIntents().filter(entry => entry.intent !== intent);
    // A corrupt/unreadable store was already reported; do not overwrite it with a
    // record that would hide a still-unconfirmed write.
    if (this.intentStorageError) return false;
    const next: IntentRecord[] = [...rest, { key, intent, pending: true }];
    // Keep the key map bounded; settled intents are the only ones ever dropped.
    const settled = next.filter(entry => !entry.pending);
    const bounded = next.length > 20
      ? [...next.filter(entry => entry.pending), ...settled.slice(-Math.max(0, 20 - next.filter(entry => entry.pending).length))]
      : next;
    // The durable write must succeed before the in-memory/UI copy exists: a
    // record here would advertise a recovery for a request that was never sent.
    const storageKey = this.intentStorageKey();
    if (!storageKey) { this.intentStorageError = intentPrincipalMessage; return false; }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(bounded));
      this.intentStorageLimited = false;
    } catch {
      this.intentStorageLimited = true;
      return false;
    }
    intentMemory.set(storageKey, bounded.map(entry => ({ ...entry })));
    this.unresolved = bounded.filter(entry => entry.pending);
    return true;
  }
  /** A journal answer settles the intent; its key is kept so the same intent can never wander. */
  private settleIntent(key: string) {
    const entries = this.allIntents();
    if (!entries.some(entry => entry.key === key && entry.pending)) return;
    this.persistIntents(entries.map(entry => entry.key === key ? { ...entry, pending: false } : entry));
  }
  /**
   * Whether the current draft is still exactly the recorded intent. The intent
   * string carries the resource and the whole request body (pins, settings,
   * metric decisions, parameters, group, base revision), so it stays comparable
   * across a component remount. A per-instance edit counter can reset and
   * collide, which would let an old answer settle a newer draft.
   */
  private intentStillCurrent(key: string): boolean {
    const entry = this.allIntents().find(candidate => candidate.key === key);
    return !!entry && entry.intent === this.intentIdentity();
  }
  /**
   * Query the journal for one exact intent. The association is the original
   * principal + resource (the storage key) + key + intent, and a committed
   * answer only settles *that* intent: it never clears a draft, settings, dirty
   * state or preview that belongs to a newer edit — whether the edit happened
   * before this query started or while it was in flight.
   */
  private async lookup(key: string, generation: number, failure: unknown | null,
    reload = true): Promise<void> {
    let state;
    try { state = await readTemplateOperation(this.resourceType, this.resourceId, key); }
    catch {
      if (generation !== this.generation) return;
      if (this.intentStillCurrent(key)) this.error = '无法确认上次发布结果，请稍后查询发布结果；不要直接重复发布。';
      return;
    }
    if (generation !== this.generation) return;
    if (!state || !['committed', 'pending', 'absent'].includes(state.state)) {
      if (this.intentStillCurrent(key)) this.error = '无法确认上次发布结果，请稍后查询发布结果；不要直接重复发布。';
      return;
    }
    if (state.state === 'committed') {
      this.settleIntent(key);
      this.error = '';
      showToast('已确认上次发布已提交', 'success');
      if (!this.intentStillCurrent(key)) {
        // Recovery stays separate from the current edit: only the old intent is
        // settled. The newer draft, its settings and its preview are untouched;
        // the old revision is not projected onto the new intent.
        return;
      }
      this.dirty = false;
      this.trial = null; this.preview = null; this.previewStale = false;
      if (reload) {
        const revision = state.operation?.target_revision ?? 0;
        const resource = this.refKey();
        await this.load();
        // Keep the projection only for the same resource: a switch during the
        // reload owns its own state and must not receive this result.
        if (this.refKey() !== resource || !this.loaded) return;
        this.applyResult = { revision, replayed: true }; this.step = 3;
      }
      return;
    }
    if (state.state === 'pending') { this.error = ''; return; }
    // Absent proves the intent was never recorded: it is settled, and a retry of
    // the same configuration still keeps this key.
    this.settleIntent(key);
    this.error = failure ? nativeError(failure) : '未发现此前的发布记录，可以重新应用。';
  }
  private async applyFlow() {
    if (this.busy || !this.canWrite()) return;
    // Without readable intent tracking a mutation could become untrackable:
    // refuse instead of sending a write whose key cannot be recovered.
    if (this.intentStorageError) { this.error = this.intentStorageError; return; }
    const generation = this.generation;
    const draft = this.draftVersion;
    const intent = this.intentIdentity();
    const pending = this.pendingFor(intent);
    // The same intent is never resent: an unconfirmed outcome is looked up.
    if (pending) { await this.lookup(pending.key, generation, null, true); return; }
    if (!this.applyReady() || !this.trial) return;
    const body = this.requestBody();
    const payload = { ...body, receipt_id: this.trial.receipt_id };
    const key = this.intentKey(intent);
    // A write request may only leave the page once this principal + resource +
    // exact intent + key has a durable record. Without it a lost response cannot
    // be recovered and a refresh would forget the request entirely.
    if (!this.rememberIntent(key, intent)) {
      this.error = this.intentStorageError || intentStorageRefusal;
      return;
    }
    this.busy = true; this.error = '';
    try {
      const result = await applyTemplateBinding(this.resourceType, this.resourceId, { ...payload, caller_key: key });
      if (generation !== this.generation || draft !== this.draftVersion) { this.restorePendingLater(); return; }
      await this.handleApplyResult(result, key, generation);
    } catch (error) {
      // Never resend a mutation whose outcome is unknown: query the same key first.
      if (generation === this.generation) await this.lookup(key, generation, error, true);
    } finally { if (generation === this.generation) this.busy = false; }
  }
  private async handleApplyResult(result: TemplateApplyResult, key: string, generation: number) {
    if (result.kind === 'committed' || result.kind === 'replay') {
      const revision = result.kind === 'committed' ? result.revision : result.target_revision;
      this.settleIntent(key);
      this.dirty = false;
      this.trial = null; this.preview = null; this.previewStale = false;
      showToast(result.kind === 'committed' ? '配置已发布，正在确认应用与正式数据状态' : '上次发布已提交，未重复执行', 'success');
      const resource = this.refKey();
      await this.load();
      if (this.refKey() !== resource || !this.loaded) return;
      this.applyResult = { revision, replayed: result.kind === 'replay' }; this.step = 3;
      return;
    }
    if (result.kind === 'operation_lookup_required' || result.kind === 'commit_unknown') {
      await this.lookup(key, generation, null, true); return;
    }
    if (result.kind === 'rejected' || result.kind === 'rolled_back') {
      // A rejection is a terminal answer: nothing was written under this key.
      this.settleIntent(key);
      this.error = nativeError(new MetricRequestError(409, result.code));
      this.trial = null; this.step = 1;
      return;
    }
    this.settleIntent(key);
    this.error = '此资源使用旧版单包配置，原生模板流程未接管，未写入任何变更。';
  }
  /** A response for a resource the user has already left is only restored by the next load. */
  private restorePendingLater() { this.unresolved = this.storedIntents(); }
  private async restorePending(generation: number) {
    const stored = this.storedIntents();
    this.unresolved = stored;
    if (!stored.length) return;
    for (const entry of stored) {
      if (generation !== this.generation) return;
      await this.lookup(entry.key, generation, null, false);
    }
  }

  /* --- immediate collection --------------------------------------------- */

  private storedCollect(principal: string): { key: string; revision: number } | null | 'corrupt' {
    try {
      const raw = sessionStorage.getItem(collectStorageKey(principal, this.refKey()));
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as { key?: unknown; revision?: unknown };
      if (typeof parsed?.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed.key)
        || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision)) return 'corrupt';
      return { key: parsed.key, revision: parsed.revision };
    } catch { return 'corrupt'; }
  }
  /** Written before the request: an unconfirmed outcome is only recoverable through this key. */
  private persistCollect(principal: string, key: string, revision: number): boolean {
    try {
      sessionStorage.setItem(collectStorageKey(principal, this.refKey()), JSON.stringify({ key, revision }));
      return true;
    } catch { return false; }
  }
  private clearStoredCollect(principal: string, key: string) {
    try {
      const stored = this.storedCollect(principal);
      if (stored && stored !== 'corrupt' && stored.key === key) sessionStorage.removeItem(collectStorageKey(principal, this.refKey()));
    } catch { /* leave the durable record for recovery */ }
  }
  private stopCollectPolling() { clearTimeout(this.collectTimer); this.collectTimer = undefined; }
  private collectTerminal(state?: string): boolean { return !!state && collectTerminal(state); }
  private collectContext(generation: number, principal: string, resource: string, key: string): boolean {
    return generation === this.generation && sessionPrincipal() === principal
      && this.refKey() === resource && this.collectPendingKey === key;
  }
  private scheduleCollectPoll(generation: number, key: string, principal: string) {
    this.stopCollectPolling();
    if (this.collectPolls >= 20) return;
    this.collectTimer = setTimeout(() => {
      this.collectPolls++;
      void this.queryCollect(generation, key, principal);
    }, 1500);
  }
  /** Query the exact key; a refresh, remount or resource return uses this path, never a new request. */
  private async queryCollect(generation: number, key: string, principal: string, schedule = true) {
    const resource = this.refKey();
    if (!this.collectContext(generation, principal, resource, key)) return;
    this.collectResult = null;
    try {
      const result = await readTemplateCollectTask(this.resourceType, this.resourceId, key);
      if (!this.collectContext(generation, principal, resource, key)) return;
      this.collectResult = result;
      this.collectPendingKey = this.collectTerminal(result.state) ? null : key;
      if (this.collectTerminal(result.state)) { this.clearStoredCollect(principal, key); this.stopCollectPolling(); }
      else if (schedule && result.state !== 'absent' && result.state !== 'unknown') this.scheduleCollectPoll(generation, key, principal);
    } catch (error) {
      if (!this.collectContext(generation, principal, resource, key)) return;
      if (error instanceof MetricRequestError && [401, 403, 404].includes(error.status)) { this.accessChanged(); return; }
      this.collectError = nativeError(error);
    }
  }
  private async restoreCollect(generation: number) {
    this.stopCollectPolling();
    this.collectStorageError = '';
    this.collectPendingKey = null;
    const principal = sessionPrincipal();
    if (!principal) return;
    const stored = this.storedCollect(principal);
    if (stored === 'corrupt') { this.collectStorageError = collectCorruptMessage; return; }
    if (!stored) return;
    this.collectPendingKey = stored.key;
    await this.queryCollect(generation, stored.key, principal);
  }
  /**
   * Start one collection from the published plan. A stored key is reused verbatim
   * (a retry of the same request), and a fresh action persists its key before the
   * request is sent; without that record no request is sent.
   */
  private async collectNow() {
    if (!this.canWrite() || this.dirty || this.binding?.source !== 'template' || this.collectBusy) return;
    const revision = this.binding?.revision;
    if (!revision) return;
    const principal = sessionPrincipal();
    if (!principal) { this.collectError = collectPrincipalMessage; return; }
    const stored = this.storedCollect(principal);
    if (stored === 'corrupt') { this.collectStorageError = collectCorruptMessage; return; }
    if (!stored && this.collectPendingKey) { this.collectStorageError = collectCorruptMessage; return; }
    if (stored && (this.collectPendingKey !== stored.key || this.collectResult?.caller_key !== stored.key
      || this.collectResult.state !== 'absent')) {
      this.collectPendingKey = stored.key;
      await this.queryCollect(this.generation, stored.key, principal, false);
      return;
    }
    const key = this.collectPendingKey ?? stored?.key
      ?? `collect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!stored && !this.collectPendingKey && !this.persistCollect(principal, key, revision)) {
      this.collectError = collectStorageRefusal;
      return;
    }
    const generation = this.generation;
    const resource = this.refKey();
    this.collectPendingKey = key; this.collectBusy = true; this.collectError = ''; this.collectPolls = 0;
    try {
      const result = await collectTemplateBindingNow(this.resourceType, this.resourceId,
        { caller_key: key, expected_revision: stored?.revision ?? revision });
      if (!this.collectContext(generation, principal, resource, key)) return;
      this.collectResult = result;
      if (this.collectTerminal(result.state)) { this.collectPendingKey = null; this.clearStoredCollect(principal, key); }
      else this.scheduleCollectPoll(generation, key, principal);
    } catch (error) {
      if (!this.collectContext(generation, principal, resource, key)) return;
      this.collectError = nativeError(error);
      // Never treat an API failure as "absent": query the original key first.
      await this.queryCollect(generation, key, principal, false);
      if (!this.collectContext(generation, principal, resource, key)) return;
      if (!this.collectResult || this.collectResult.state === 'absent') this.collectPendingKey = key;
    } finally {
      if (generation === this.generation && sessionPrincipal() === principal && this.refKey() === resource
        && (this.collectPendingKey === key || this.collectPendingKey === null)) this.collectBusy = false;
    }
  }
  private queryPendingCollect() {
    const key = this.collectPendingKey;
    const principal = sessionPrincipal();
    if (!key || !principal) return;
    this.collectBusy = true;
    const generation = this.generation;
    const resource = this.refKey();
    void this.queryCollect(generation, key, principal).finally(() => {
      if (generation === this.generation && sessionPrincipal() === principal && this.refKey() === resource
        && (this.collectPendingKey === key || this.collectPendingKey === null)) this.collectBusy = false;
    });
  }

  confirmDiscard(action: () => void) {
    if (!this.dirty) { action(); return; }
    this.afterDiscard = action; this.discardPending = true;
  }
  /**
   * Return to the published configuration. The editor is re-seeded from the
   * stored binding (pins, overrides, group, parameters), never blanked — a
   * discard must not turn an explicit setting into an empty override. An
   * unconfirmed application is deliberately untouched: it is not a draft.
   */
  private discardChanges() {
    this.draftVersion++;
    if (this.binding) this.seedFromBinding(this.binding);
    else { this.selected = []; this.settings = {}; this.parameters = {}; this.metricToggles = {}; this.groupId = ''; }
    this.preview = null; this.previewStale = false; this.previewIssue = null; this.trial = null;
    this.step = 0; this.dirty = false; this.error = ''; this.applyResult = null;
  }
  private async reloadAll() { this.discardChanges(); await this.load(); }

  private metricRows() {
    const seen = new Map<string, { key: string; id: string }>();
    for (const item of this.preview?.items ?? []) {
      const key = `${item.canonical_metric.id}@${item.canonical_metric.semantic_version}`;
      seen.set(key, { key, id: item.canonical_metric.id });
    }
    return [...seen.values()];
  }
  private conflictRows() {
    const values = this.previewIssue?.details.conflicts;
    return Array.isArray(values) ? values as Array<Record<string, unknown>> : [];
  }

  private renderCatalog() {
    const selectedIds = new Set(this.selected.map(pin => pin.template_id));
    return html`<app-card><div class="section-title"><div><span class="eyebrow">固定版本模板</span><h2>选择适合此对象的模板</h2></div>
      <app-badge variant=${this.selected.length ? 'ok' : 'muted'}>${this.selected.length ? `已选 ${this.selected.length} 个` : '未选择'}</app-badge></div>
      <p class="muted">从全部已授权模板中搜索并固定到已发布版本；草稿与已退役版本不能应用。模板内容与对象能力由服务端重新校验。</p>
      <div class="fields">
        <app-form-field label="搜索模板名称"><input type="search" aria-label="搜索模板名称" placeholder="输入模板名称" .value=${this.catalogQuery} .disabled=${!this.loaded || this.busy}
          @input=${(event: Event) => this.searchCatalog((event.target as HTMLInputElement).value)}></app-form-field>
        <app-form-field label="模板状态"><select aria-label="模板状态筛选" .value=${this.catalogStatus} .disabled=${!this.loaded || this.busy}
          @change=${(event: Event) => this.filterStatus((event.target as HTMLSelectElement).value)}>
          <option value="">全部状态</option><option value="active">启用</option><option value="deprecated">已弃用</option>
          <option value="draft">草稿</option><option value="archived">已归档</option></select></app-form-field>
      </div>
      ${this.catalogError ? html`<p class="error" role="alert">${this.catalogError}</p>` : nothing}
      ${this.catalogLoading ? html`<p class="muted" role="status">正在读取模板目录…</p>` : nothing}
      ${!this.catalogLoading && !this.templates.length ? html`<p class="muted" role="status">没有匹配的模板。</p>` : nothing}
      <div aria-label="模板列表">${this.templates.map(template => {
        const pin = this.selectedPin(template.template_id);
        const versions = this.publishedVersions(template);
        const draft = template.status === 'draft';
        return html`<div class="template-row">
          <label><input type="checkbox" aria-label=${`选择模板 ${template.name}`} .checked=${selectedIds.has(template.template_id)}
            .disabled=${!this.canWrite() || draft || !versions.length}
            @change=${(event: Event) => this.toggleTemplate(template, (event.target as HTMLInputElement).checked)}></label>
          <div class="grow"><strong>${template.name}</strong><p class="muted">${template.template_id} · ${label(template.status)} · ${versions.length} 个已发布版本</p>
            ${draft ? html`<p class="muted">模板为草稿，未发布，不能应用。</p>` : !versions.length ? html`<p class="muted">模板没有已发布版本，不能应用。</p>` : nothing}</div>
          ${versions.length ? html`<div class="grow"><app-form-field label=${`已发布版本 · ${template.name}`}>
            <select aria-label=${`模板版本 ${template.name}`} .value=${String(pin?.version ?? '')} .disabled=${!this.canWrite() || draft}
              @change=${(event: Event) => this.changeVersion(template, Number((event.target as HTMLSelectElement).value))}>
              <option value="">选择已发布版本</option>${versions.map(version => html`<option value=${version.version}
                ?disabled=${version.status !== 'published'} .selected=${pin?.version === version.version}>${version.version} · ${label(version.status)} · ${version.content_hash.slice(0, 19)}…</option>`)}
            </select></app-form-field></div>` : nothing}
          ${pin && this.repinOffered(template.template_id) ? html`<div class="grow"><button class="btn btn-sm" .disabled=${this.busy || this.repinBusy}
            @click=${() => this.openRepin(template)}>为当前对象生成兼容版本</button><p class="muted">只把不适用于当前对象的项目重新固定到已安装实现；旧版本保留。</p></div>` : nothing}
        </div>`;
      })}</div>
      ${this.nextCursor ? html`<div class="actions"><button class="btn" .disabled=${this.catalogLoading} @click=${() => void this.loadCatalog(false)}>加载更多模板</button></div>` : nothing}
      ${this.selected.length ? html`<div class="chips" aria-label="已选择的模板版本">${this.selected.map(pin => html`<span class="chip">${this.names[pin.template_id] ?? pin.template_id} · v${pin.version} · ${pin.content_hash.slice(0, 15)}…
        <button class="btn btn-sm btn-ghost" .disabled=${!this.canWrite()} aria-label=${`移除 ${this.names[pin.template_id] ?? pin.template_id}`}
          @click=${() => { this.selected = this.selected.filter(entry => pinKey(entry) !== pinKey(pin)); this.invalidate(false); }}>移除</button></span>`)}</div>` : nothing}
      ${this.detailError ? html`<p class="error" role="alert">${this.detailError}</p>` : nothing}
      ${this.selected.map(pin => {
        const detail = this.details[pinKey(pin)];
        return detail ? html`<details><summary>${this.names[pin.template_id] ?? pin.template_id} v${pin.version} 的指标与参数</summary>
          <div class="scroll"><app-data-table .columns=${[{ key: 'metric', label: '指标' }, { key: 'unit', label: '单位' }, { key: 'release', label: '采集实现' }]}
            .rows=${detail.items.map(item => ({ metric: `${metricName(item.canonical_metric.id)}（${item.item_id}@${item.version}）`,
              unit: item.unit, release: `${item.collector_ref.package_release} · ${item.collector_ref.implementation_id}` }))}></app-data-table></div>
          <p class="muted">参数：${Object.keys(detail.parameters.schema).length ? Object.entries(detail.parameters.schema).map(([name, spec]) =>
            `${name}（${label(spec.type)}）`).join('、') : '无'} · 内容校验 ${detail.content_hash}</p></details>` : nothing;
      })}
    </app-card>`;
  }

  private renderOverrides() {
    const settings = this.preview?.settings ?? this.binding?.pending?.plan.settings ?? {};
    return html`<app-card><div class="section-title"><h2>采集设置与参数</h2><app-badge variant=${this.previewStale ? 'warn' : 'muted'}>${this.previewStale ? '修改后需重新检查' : '来自当前检查'}</app-badge></div>
      <metric-policy-fields .compact=${true} .overrides=${this.settings} .values=${settings} .sources=${{}}
        .disabled=${!this.canWrite() || this.busy} @policy-change=${(event: CustomEvent<Overrides>) => this.changeSettings(event.detail)}>
        <div slot="group" class="group-picker"><app-form-field label="策略组（可选）" .error=${this.groupError}>
          <input type="search" aria-label="搜索策略组" placeholder="搜索或选择策略组" ?disabled=${!this.loaded} .value=${this.groupSearch}
            @input=${(event: Event) => this.searchGroups((event.target as HTMLInputElement).value)}>
          <select aria-label="策略组" .value=${this.groupId} ?disabled=${!this.canWrite() || this.busy}
            @change=${(event: Event) => { this.groupId = (event.target as HTMLSelectElement).value; this.invalidate(true); }}>
            <option value="">不继承策略组</option>${this.groupId && !this.groups.some(group => group.id === this.groupId) ? html`<option value=${this.groupId}>已有策略组（当前不可见）</option>` : nothing}
            ${this.groups.filter(group => group.id === this.groupId || `${group.label ?? ''} ${group.id}`.toLowerCase().includes(this.groupSearch.trim().toLowerCase()))
              .map(group => html`<option value=${group.id} .selected=${group.id === this.groupId}>${group.label || group.id}</option>`)}</select>
        </app-form-field></div>
      </metric-policy-fields>
      <p class="muted">对象停用设置优先；修改模板、版本、参数或设置后，之前的试采失效，需要重新检查。</p>
      ${this.metricRows().length ? html`<h3>组合监控项</h3><ul class="metric-list" aria-label="组合监控项">${this.metricRows().map(row => html`<li>
        <strong>${metricName(row.id)}</strong>
        <select aria-label=${`${metricName(row.id)} 覆盖`} .value=${this.metricToggles[row.key] ?? 'inherit'} .disabled=${!this.canWrite() || this.busy}
          @change=${(event: Event) => this.toggleMetric(row.key, (event.target as HTMLSelectElement).value)}>
          <option value="inherit">继承模板</option><option value="enable">启用</option><option value="disable">停用</option></select>
      </li>`)}</ul>` : nothing}
      ${this.preview ? html`<h3>参数：默认、覆盖与最终值</h3><div class="parameter-list" aria-label="模板参数">${this.preview.parameters.flatMap(entry =>
        entry.parameters.map(parameter => {
          const value = this.parameters[entry.pin.template_id]?.[parameter.name] ?? '';
          return html`<div class="parameter-row">
            <span><strong>${this.names[entry.pin.template_id] ?? entry.pin.template_id} v${entry.pin.version}</strong><br>${parameter.name}</span>
            <span>默认 ${String(parameter.default)}</span><span>来源 ${label(parameter.source)}</span><span>最终 ${String(parameter.effective)}</span>
            <span>${parameter.type === 'boolean'
              ? html`<select aria-label=${`覆盖参数 ${parameter.name}`} .value=${value === '' ? '' : String(value)} .disabled=${!this.canWrite() || this.busy}
                  @change=${(event: Event) => this.changeParameter(entry.pin.template_id, parameter.name, (event.target as HTMLSelectElement).value, parameter.type)}>
                  <option value="">继承</option><option value="true">true</option><option value="false">false</option></select>`
              : html`<input type=${parameter.type === 'string' ? 'text' : 'number'} aria-label=${`覆盖参数 ${parameter.name}`}
                  .value=${value === '' ? '' : String(value)} .disabled=${!this.canWrite() || this.busy}
                  placeholder=${`继承 ${String(parameter.default)}`}
                  @change=${(event: Event) => this.changeParameter(entry.pin.template_id, parameter.name, (event.target as HTMLInputElement).value, parameter.type)}>`}</span>
          </div>`;
        }))}</div>` : nothing}
    </app-card>`;
  }

  private renderPreview() {
    return html`<app-card><div class="section-title"><h2>检查：组合项、兼容性与冲突</h2>
      ${this.preview ? html`<app-badge variant=${this.preview.executable && !this.previewStale ? 'ok' : 'warn'}>${this.previewStale ? '需重新检查' : this.preview.executable ? '可试采' : '不可执行'}</app-badge>` : nothing}</div>
      ${this.previewIssue ? html`<div class="notice error" role="alert"><p>${this.previewIssue.message}</p><p class="muted">错误码：${this.previewIssue.code}</p>
        ${this.previewIssue.code === 'PREFLIGHT_CANONICAL_CONFLICT' ? html`<ul>${this.conflictRows().map(conflict => html`<li>${String((conflict.canonical_metric as { id?: string })?.id ?? '指标')} 同时由
          ${((conflict.providers as Array<{ template_id: string; item_id: string }>) ?? []).map(provider => `${provider.template_id}/${provider.item_id}`).join('、')} 提供；请取消其中一个模板。</li>`)}</ul>` : nothing}
        ${this.previewIssue.code === 'RESOLVE_SETTING_CONFLICT' ? html`<div>${this.conflictRows().map(conflict => html`<p>设置 ${String(conflict.field)} 在各模板默认值不一致：
          ${((conflict.values as Array<{ release: { id: string; version: string }; value: number | boolean }>) ?? []).map(value => `${value.release.id}@${value.release.version}=${String(value.value)}`).join('、')}
          ${this.conflictOverride(conflict)}</p>`)}</div>` : nothing}
      </div>` : nothing}
      ${this.error ? html`<p class="notice error" role="alert">${this.error}</p>` : nothing}
      ${!this.preview && !this.previewIssue ? html`<p class="muted">选择固定版本后执行“检查配置”，这里会显示每个监控项、单位、采集实现与兼容结论。</p>` : nothing}
      ${this.preview ? html`
        <p role="status">${this.preview.executable ? '所选固定版本对当前对象可执行；试采仍会重新验证连接、权限和样本。' : '所选固定版本不可执行；请处理不兼容项后重新检查。'}
          预计每小时逻辑读取 ${this.preview.budget.requests_per_hour_estimate} 次，序列上限 ${this.preview.budget.estimated_series_upper_bound}。</p>
        <h3>监控项</h3><div class="scroll"><app-data-table .columns=${[
          { key: 'template', label: '模板' }, { key: 'metric', label: '指标' }, { key: 'unit', label: '单位' },
          { key: 'decision', label: '决策' }, { key: 'capability', label: '能力' }, { key: 'release', label: '来源链' }]}
          .rows=${this.preview.items.map(item => ({ template: `${this.names[item.template_id] ?? item.template_id} v${item.item_version}`,
            metric: metricName(item.canonical_metric.id), unit: item.unit, decision: label(item.decision), capability: label(item.capability),
            release: `${item.release.id}@${item.release.version} · ${item.collector_id} · ${item.release_ref.split('#')[1]?.slice(0, 12) ?? ''}…` }))}></app-data-table></div>
        ${this.preview.excluded.length ? html`<h3>排除项（显式）</h3><ul aria-label="排除项">${this.preview.excluded.map(item => html`<li>
          ${this.names[item.template_id] ?? item.template_id} v${item.item_version} · ${metricName(item.metric.id)}：${label(item.reason)}${item.blocking ? '（阻塞应用）' : '（可选排除）'}</li>`)}</ul>` : html`<p class="muted">没有被排除的组合项。</p>`}
        <h3>版本来源</h3><ul>${this.preview.releases.map(release => html`<li>${release.release.id}@${release.release.version} ·
          ${release.collector_ids.join('、')} · ${release.metric_keys.length} 个指标 · 每 ${release.interval_ms / 1000} 秒</li>`)}</ul>
        ${this.preview.releases.some(release => release.applicability.some(check => check.status !== 'supported')) ? html`<div role="status"><strong>兼容性说明</strong>
          <ul>${this.preview.releases.flatMap(release => release.applicability.filter(check => check.status !== 'supported').map(check => html`<li>
            ${check.attribute}：当前 ${String(check.value ?? '未知')}，支持 ${check.supported_values.join(' / ')}（${label(check.status)}）</li>`))}</ul></div>` : nothing}
      ` : nothing}
    </app-card>`;
  }
  private conflictOverride(conflict: Record<string, unknown>) {
    const field = String(conflict.field ?? '');
    if (!field) return nothing;
    const override = this.settings[field as keyof Overrides] as { mode?: string; value?: number } | undefined;
    return html`<span>· 显式覆盖：<input type="number" aria-label=${`覆盖设置 ${field}`} .value=${override?.mode === 'set' ? String(override.value) : ''}
      .disabled=${!this.canWrite() || this.busy} @change=${(event: Event) => {
        const raw = (event.target as HTMLInputElement).value;
        const next = { ...this.settings };
        if (raw === '') delete next[field as keyof Overrides];
        else (next as Record<string, unknown>)[field] = { mode: 'set', value: Number(raw) };
        this.changeSettings(next);
      }}></span>`;
  }

  private renderTrial() {
    return html`<app-card><div class="section-title"><h2>试采：逐项读取、转换、单位与样本</h2>
      ${this.trial ? html`<app-badge variant=${this.trialPassed() ? 'ok' : 'warn'}>${this.trialPassed() ? '试采通过' : label(this.trial.decision)}</app-badge>` : nothing}</div>
      ${!this.trial ? html`<p class="muted">检查通过后执行试采；试采直接读取目标，只写试用凭证，不写正式历史、事件或通知。</p>` : html`
        <p role="status">${this.trial.decision === 'disabled' ? '已按停用配置验证，不执行采集。' : this.trialPassed()
          ? '有效样本门禁通过；正式数据仍需等待应用后的真实采集。'
          : '试采未满足启用门禁：必要项必须读取、转换、单位校验全部通过并返回有效值；可选项排除见下。'}</p>
        <ul aria-label="逐项试采结果">${this.trial.items.map(item => {
          const optional = this.trial!.optional_exclusions.some(exclusion => itemKey(exclusion) === itemKey(item));
          const sample = this.trial!.samples.find(entry => itemKey(entry) === itemKey(item));
          return html`<li>${this.names[item.template_id] ?? item.template_id} v${item.item_version} · ${metricName(sample?.metric.id ?? item.item_id)}：
            读取 ${item.phases.read ? '✓' : '✗'} · 转换 ${item.phases.transform ? '✓' : '✗'} · 单位 ${item.phases.unit ? '✓' : '✗'}
            ${optional ? ' · 可选排除' : ''}${sample ? ` · 值 ${formatValue(sample.value)} ${sample.unit} · ${sample.observed_at}` : ''}</li>`;
        })}</ul>
        ${this.trial.attempts.some(attempt => attempt.error) ? html`<div role="alert"><strong>采集尝试错误</strong><ul>${this.trial.attempts.filter(attempt => attempt.error)
          .map(attempt => html`<li>${attempt.collector_id ?? '采集器'}：${attempt.error}</li>`)}</ul></div>` : nothing}
        <p>试用凭证 ${this.trial.receipt_id} · 有效至 ${this.trial.expires_at} · 本次返回 ${this.trial.samples.length} 个样本</p>
        <details><summary>高级诊断与样本</summary><pre>${JSON.stringify(this.trial, null, 2)}</pre></details>`}
    </app-card>`;
  }

  private renderCollect() {
    const isTemplate = this.binding?.source === 'template';
    const state = this.collectResult?.state;
    const task = this.collectResult?.task;
    const samples = this.collectResult?.samples ?? [];
    const pending = this.collectPendingKey;
    const sampled = state === 'completed' && task?.outcome === 'sampled';
    return html`<app-card><div class="section-title"><h2>立即采集（本次任务与样本）</h2>
      ${state ? html`<app-badge variant=${sampled ? 'ok' : state === 'failed' || state === 'unknown' ? 'warn' : 'muted'}>
        ${collectStateLabels[state] ?? state}</app-badge>` : nothing}</div>
      <p class="muted">立即采集只执行当前已发布的固定模板配置；任务受理、任务完成与样本成功分别显示。结果里的样本只属于这一次任务，不会用其他采集的最新值代替。</p>
      ${!isTemplate ? html`<p class="muted">尚未建立原生模板配置，不能立即采集。</p>` : nothing}
      ${isTemplate && this.dirty ? html`<p class="notice" role="status">有未发布的修改：立即采集不会执行这些草稿，只采集当前已发布配置。请先放弃或应用修改。</p>` : nothing}
      ${this.collectStorageError ? html`<p class="notice error" role="alert">${this.collectStorageError}</p>` : nothing}
      ${this.collectError ? html`<p class="notice error" role="alert">${this.collectError}</p>` : nothing}
      <div class="actions">
        <button class="btn-primary" .disabled=${this.busy || this.collectBusy || !this.canWrite() || this.dirty || !isTemplate || !!pending}
          @click=${() => void this.collectNow()}>${this.collectBusy ? '采集中…' : '立即采集'}</button>
        ${pending ? html`<button class="btn" .disabled=${this.collectBusy}
          @click=${() => this.queryPendingCollect()}>查询本次任务</button>` : nothing}
        ${pending ? html`<button class="btn" .disabled=${this.collectBusy}
          @click=${() => void this.collectNow()}>重试同一请求</button>` : nothing}
      </div>
      ${task ? html`<dl class="facts">
        <div><dt>任务</dt><dd>${task.id.slice(0, 8)} · ${collectStateLabels[task.state] ?? task.state}</dd></div>
        <div><dt>目标版本</dt><dd>${task.revision}</dd></div>
        <div><dt>受理时间</dt><dd>${new Date(task.created_at).toLocaleString('zh-CN')}</dd></div>
        <div><dt>开始执行</dt><dd>${task.started_at ? new Date(task.started_at).toLocaleString('zh-CN') : '尚未开始'}</dd></div>
        <div><dt>结束</dt><dd>${task.finished_at ? new Date(task.finished_at).toLocaleString('zh-CN') : '未结束'}</dd></div>
        <div><dt>采集结果</dt><dd>${task.outcome ? collectOutcomeLabels[task.outcome] : '未产生结果'}${task.error_code ? ` · ${task.error_code}` : ''}</dd></div>
      </dl>` : (state === 'absent' ? html`<p role="status">没有找到该采集请求的记录；可以用同一请求重试，服务端不会重复执行。</p>` : nothing)}
      ${samples.length ? html`<h3>本次样本</h3><div class="scroll"><app-data-table .columns=${[
        { key: 'metric', label: '指标' }, { key: 'value', label: '值' }, { key: 'observed_at', label: '观测时间' },
        { key: 'quality', label: '质量' }]}
        .rows=${samples.map(sample => ({ metric: metricName(sample.metric.id),
          value: `${formatValue(sample.value)} ${sample.unit}`, observed_at: sample.observed_at,
          quality: String((sample.quality as { status?: string } | null)?.status ?? '—') }))}></app-data-table></div>
        <details><summary>样本身份（不可变 ID）</summary><pre>${JSON.stringify(samples, null, 2)}</pre></details>`
        : (task ? html`<p role="status">本次任务没有写入任何正式样本，不能视为采集成功。</p>` : nothing)}
      ${this.collectResult?.attempts.length ? html`<h3>尝试</h3><ul aria-label="采集尝试">${this.collectResult.attempts.map(attempt => html`<li>
        ${attempt.collector_id ?? '采集器'} · ${attempt.status} · ${attempt.id}</li>`)}</ul>` : nothing}
    </app-card>`;
  }

  private renderStatus() {    const status = this.collection;
    const binding = this.binding;
    const application = binding?.application;
    const pending = binding?.pending;
    return html`<app-card class="state-card"><span class="eyebrow">当前权威状态</span>
      ${status ? html`<app-badge variant=${status.formal_visibility.state === 'available' ? 'ok' : 'muted'}>
        ${status.formal_visibility.state === 'pending' ? '等待正式数据' : statusLabel(status.formal_visibility.state)}</app-badge>` : nothing}
      <dl class="facts">
        <div><dt>配置来源</dt><dd>${binding ? (binding.source === 'template' ? '原生固定版本模板' : binding.source === 'package' ? '旧版单包' : '未绑定') : '未知'}</dd></div>
        <div><dt>保存</dt><dd>${this.dirty ? '有未保存修改' : '无未保存修改'}</dd></div>
        <div><dt>发布（已提交）</dt><dd>${binding?.revision ?? '—'}${binding?.published_at ? html` · ${new Date(binding.published_at).toLocaleString('zh-CN')}` : nothing}</dd></div>
        <div><dt>等待应用</dt><dd>${pending ? `目标版本 ${pending.target_revision} · ${new Date(pending.decided_at).toLocaleString('zh-CN')}` : '无待应用版本'}</dd></div>
        <div><dt>调度应用</dt><dd>${application ? `${statusLabel(application.status)} · 已应用 ${application.applied_revision ?? '—'}` : '未知'}</dd></div>
        <div><dt>首样本</dt><dd>${status?.formal_visibility.last_observed_at ? new Date(status.formal_visibility.last_observed_at).toLocaleString('zh-CN') : '尚未收到正式首样本'}</dd></div>
        <div><dt>正式采集</dt><dd>${status ? statusLabel(status.formal_visibility.state) : '未知'}${status?.formal_visibility.generation ? ` · 第 ${status.formal_visibility.generation} 代` : ''}</dd></div>
      </dl>
      <p class="muted">已发布、等待应用、已应用、等待首样本与正式采集分别确认；配置发布成功或 API 返回 200 不代表健康。</p>
      ${status ? renderCollectionStatus(status) : html`<p>采集状态未知</p>`}
      ${this.applyResult ? html`<p role="status">${this.applyResult.replayed ? '已确认上次发布提交' : '配置已提交'}，目标版本 ${this.applyResult.revision}；应用与正式数据状态以左侧事实为准。</p>` : nothing}
      ${this.unresolved.length ? html`<p class="notice" role="status">上次发布结果尚未确认：请求可能仍在处理或结果未知。请查询发布结果，确认前不要重复发布。
        未确认的意图会保留，编辑、放弃或重新加载都不会清掉它。</p>` : nothing}
      ${this.intentStorageError ? html`<p class="notice error" role="alert">${this.intentStorageError}</p>` : nothing}
      ${this.intentStorageLimited ? html`<p class="notice" role="status">${intentStorageMessage}</p>` : nothing}
      <div class="actions"><button class="btn btn-refresh" .disabled=${this.busy} @click=${() => void this.refreshStatus()}>刷新状态</button></div>
      ${this.statusError ? html`<p role="alert">${this.statusError}</p>` : nothing}
      ${this.polling ? html`<p role="status">正在确认：发布 → 应用 → 首样本 → 正式可见（最多刷新 15 次）</p>` : nothing}
      ${this.pollLimitReached ? html`<p role="status">本次自动刷新已结束，尚未确认正式可见。</p>` : nothing}
    </app-card>`;
  }

  render() {
    const repin = this.repinResult && this.repinResult.unchanged === false
      ? this.repinResult as Extract<TemplateRepinResult, { unchanged: false }> : null;
    return html`<style>${sharedFieldStyles}${collectionFactsStyles}${collectionLayoutStyles}${NativeTemplateConfiguration.componentStyles.map(style => style.cssText).join('')}</style>
      ${!this.loaded && !this.error ? html`<div class="notice" role="status">正在读取采集配置…</div>` : nothing}
      ${this.loaded && !this.canManage ? html`<p class="notice">只读：未获得此资源的管理权限。</p>` : nothing}
      ${this.connectionPending ? html`<p class="notice" role="status">连接信息尚未保存，请先保存连接后再检查或应用采集配置。</p>` : nothing}
      ${this.error && !this.previewIssue ? html`<p class="notice error" role="alert">${this.error}</p>` : nothing}
      ${this.loaded ? html`
        ${this.renderCatalog()}
        ${this.selected.length ? this.renderOverrides() : nothing}
        <div class="actions">
          <button class="btn" .disabled=${this.busy || !this.canWrite() || !this.selected.length}
            @click=${() => void this.previewFlow()}>检查配置</button>
          <button class="btn" .disabled=${this.busy || !this.canWrite() || !this.trialReady()} @click=${() => void this.runTrial()}>试采</button>
          <button class="btn-primary" .disabled=${this.busy || !this.canWrite() || (!this.currentPending() && !this.applyReady())}
            @click=${() => void this.applyFlow()}>${this.currentPending() ? '查询发布结果' : this.firstBinding() ? '首次绑定并启用' : '应用并启用'}</button>
          <button class="btn" .disabled=${this.busy || !this.dirty} @click=${() => this.confirmDiscard(() => void this.reloadAll())}>放弃修改</button>
          <button class="btn btn-refresh" .disabled=${this.busy} @click=${() => this.confirmDiscard(() => void this.reloadAll())}>重新加载配置</button>
        </div>
        <ol class="steps" aria-label="配置流程">${['选择固定版本', '检查兼容性', '试采', '应用并确认'].map((text, index) => html`<li class=${index < this.step ? 'done' : index === this.step ? 'current' : ''}>${text}</li>`)}</ol>
        ${this.renderPreview()}
        ${this.trial || this.preview ? this.renderTrial() : nothing}
        ${this.renderStatus()}
        ${this.renderCollect()}` : nothing}
      <app-dialog .open=${!!this.repinTarget} title="发布兼容模板版本？" @app-dialog-close=${(event: Event) => { event.stopPropagation(); this.closeRepin(); }}>
        <p>将为模板 ${this.repinTarget?.name ?? ''} 发布一个<strong>新的不可变版本</strong>，只把不适用于当前对象的项目重新固定到已安装且适用于此对象的采集实现。</p>
        <p class="muted">旧版本保留，不修改已发布版本；不会自动改变本资源或任何其他资源的当前配置。发布后需要重新检查和试采。</p>
        ${repin ? html`<div role="status"><h3>新版本 ${repin.from_version} → ${repin.to_version}</h3>
          <p>内容校验 ${repin.content_hash}</p>
          ${repin.changes.length ? html`<ul>${repin.changes.map(change => html`<li>${change.item_id}：${change.from.release} → ${change.to.release}（${label(change.reason)}）</li>`)}</ul>` : nothing}</div>` : nothing}
        ${this.repinResult && this.repinResult.unchanged ? html`<p role="status">该模板当前版本已适用于此对象，没有发布新版本。</p>` : nothing}
        <div slot="footer"><button class="btn" @click=${() => this.closeRepin()}>${this.repinResult ? '关闭' : '取消'}</button>
          ${this.repinResult ? nothing : html`<button class="btn-primary" .disabled=${this.repinBusy} @click=${() => void this.runRepin()}>${this.repinBusy ? '发布中…' : '确认发布新版本'}</button>`}</div>
      </app-dialog>
      <app-dialog .open=${this.discardPending} title="放弃未发布的修改？" @app-dialog-close=${(event: Event) => { event.stopPropagation(); this.discardPending = false; this.afterDiscard = null; }}>
        <p>放弃后回到当前已发布的配置；未提交的模板、参数和试采不会写入。</p>
        <div slot="footer"><button class="btn" @click=${() => { this.discardPending = false; this.afterDiscard = null; }}>继续编辑</button>
          <button class="btn-primary" @click=${() => { this.discardPending = false; const action = this.afterDiscard; this.afterDiscard = null; action?.(); }}>放弃修改并继续</button></div>
      </app-dialog>`;
  }
}
