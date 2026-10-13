import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ActorContextService, type ActorContext } from '../auth/actor-context.js';
import { hasPermission } from '../auth/require-permission.js';
import { redactEvidence } from '../analysis/analysis-evidence.js';
import { InvestigationAuthorization } from './authorization.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { InvestigationStoreError, type AdmissionInvestigation } from './store.js';
import type { TransactionConnection } from '../workflows/outbox-service.js';
import { resultView } from './result-schema.js';

const decode = (value: any) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
const absent = () => new InvestigationStoreError('INVESTIGATION_NOT_FOUND');

/** Only explicit link/view reads. No dispatch, admission, invented Run or
 * historical evidence binding. Original Analysis remains the result owner. */
export class LegacyAnalysisBridge {
  constructor(private readonly pool: () => Pool | null,
    private readonly authorization = new InvestigationAuthorization(),
    private readonly bridge = new InvestigationSessionBridge(pool, authorization)) {}

  async authorizedAnalysis(c: TransactionConnection, actor: ActorContext, id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new InvestigationStoreError('INVESTIGATION_INPUT_INVALID');
    const [rows] = await c.execute(`SELECT a.*, d.request_snapshot FROM ai_analysis a
      LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id WHERE a.id = ? FOR UPDATE`, [id]) as [RowDataPacket[], unknown];
    const row = rows[0];
    if (!row || row.target_type !== 'instance' || !row.instance_id || row.server_id || row.network_device_id) throw absent();
    const request = decode(row.request_snapshot);
    if (request && (request.subject?.type !== 'instance' || Number(request.subject.id) !== Number(row.instance_id))) throw absent();
    // Manual data belongs to its original principal. Unattributed legacy
    // manual rows cannot be adopted merely by knowing their numeric id.
    if (row.trigger_type !== 'auto' && Number(request?.actor?.userId) !== actor.userId) throw absent();
    const subject: AdmissionInvestigation = { id: 'legacy-read', sessionId: 'legacy-read', profileId: 'ops', profileVersion: 1,
      scopeVersion: '', lifecycle: 'archived', version: 1, owner: { kind: actor.principalKind ?? 'user', id: actor.userId },
      resources: [{ type: 'instance', id: Number(row.instance_id), role: 'primary' }] };
    await this.authorization.authorize(c, actor, subject, 'content');
    // authorize returns a deliberately narrowed tool actor. Reload ai:view
    // independently on the same connection and keep the caller ceiling.
    const live = await new ActorContextService().loadInvestigationActorFrom(c, actor.userId, actor.principalKind ?? 'user', actor.sessionVersion);
    if (!hasPermission(new Set(actor.permissions), 'ai:view') || !hasPermission(new Set(live.permissions), 'ai:view')) throw absent();
    return row;
  }

  async link(actor: ActorContext, analysisId: number) {
    return this.bridge.storeFor(actor).transaction(async (c, append) => {
      const row = await this.authorizedAnalysis(c, actor, analysisId);
      if (!['completed', 'failed', 'unknown'].includes(row.status)) throw new InvestigationStoreError('INVESTIGATION_ACTIVE_REQUEST');
      // Lock the original row, then the unique link. Parallel first viewers
      // serialize without mutating the historical analysis result.
      await c.execute('SELECT id FROM ai_analysis WHERE id = ? FOR UPDATE', [analysisId]);
      const [links] = await c.execute('SELECT investigation_id FROM investigation_legacy_analysis_links WHERE analysis_id=?', [analysisId]) as [RowDataPacket[], unknown];
      if (links[0]) {
        await this.grantViewer(c, actor, links[0].investigation_id);
        return { id: links[0].investigation_id, investigationId: links[0].investigation_id, analysisId, legacy: true, readOnly: true };
      }
      const { investigation } = await this.bridge.createOnConnection(actor, c, append, {
        title: `历史 ${row.analysis_type} #${analysisId}`, goal: '只读查看原分析结果；不补跑，不代表根因或恢复已验证。',
        profileId: 'ops', profileVersion: 1, resources: [{ type: 'instance', id: Number(row.instance_id), role: 'primary' }],
        context: { subject: { kind: 'resource', resource: { type: 'instance', id: Number(row.instance_id) } } } });
      await c.execute("UPDATE investigations SET lifecycle='archived' WHERE id=?", [investigation.id]);
      await c.execute('INSERT INTO investigation_legacy_analysis_links (analysis_id,investigation_id) VALUES (?,?)', [analysisId, investigation.id]);
      return { id: investigation.id, investigationId: investigation.id, analysisId, legacy: true, readOnly: true };
    });
  }

  private async grantViewer(c: TransactionConnection, actor: ActorContext, id: string) {
    // Explicit source read grants viewer only, never append authority.
    const inv = await this.authorization.load(c, id);
    if (inv.owner.id !== actor.userId) await c.execute(`INSERT INTO investigation_members (investigation_id,user_id,role,granted_by)
      VALUES (?,?,'viewer',?) ON DUPLICATE KEY UPDATE user_id=user_id`, [id, actor.userId, inv.owner.id]);
    await this.authorization.authorize(c, actor, inv, 'content');
  }

  async read(actor: ActorContext, investigationId: string) {
    return this.bridge.storeFor(actor).transaction(async c => {
      const inv = await this.authorization.load(c, investigationId);
      await this.authorization.authorize(c, actor, inv, 'content');
      const [links] = await c.execute('SELECT analysis_id FROM investigation_legacy_analysis_links WHERE investigation_id=?', [investigationId]) as [RowDataPacket[], unknown];
      if (!links[0]) return null;
      const row = await this.authorizedAnalysis(c, actor, Number(links[0].analysis_id));
      const result = redactEvidence(decode(row.analysis_envelope) ?? decode(row.result));
      const markdown = typeof result === 'string' ? result : (result as { displayMarkdown?: string })?.displayMarkdown ?? JSON.stringify(result ?? '原结果不可用');
      return { analysisId: Number(row.id), status: row.status, legacy: true as const, readOnly: true as const,
        view: resultView(result, new Set(), markdown) };
    });
  }
}
