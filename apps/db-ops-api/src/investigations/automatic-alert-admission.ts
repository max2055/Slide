import { dbConnection } from '../db-connection.js';
import { assertWorkflowActive } from '../workflows/execution-context.js';
import type { AlertBridgeResponse } from './alert-bridge.js';

/** Persist observable admission facts separately from alert evaluation. A failed
 * admission must never turn a committed alert into an apparent failed INSERT. */
export async function admitPersistedAlert(alertId: number): Promise<void> {
  assertWorkflowActive();
  const pool = dbConnection.getPool();
  if (!pool) return;
  let receipt: AlertBridgeResponse;
  try {
    const { alertRCAService } = await import('../alert-rca-service.js');
    receipt = await alertRCAService.analyzeAlert(alertId, 'auto');
  } catch (error) {
    assertWorkflowActive();
    const code = (error as {code?: string}).code;
    // Do not expose SQL/provider payloads in logs or public alert metadata.
    receipt = {success:false,status:'suppressed',error:code?.startsWith('INVESTIGATION_') ? code : 'AUTO_ANALYSIS_ADMISSION_UNAVAILABLE'};
  }
  assertWorkflowActive();
  const fact = {status:receipt.status ?? (receipt.success ? 'accepted' : 'suppressed'),
    reason:receipt.error ?? receipt.disposition ?? null, investigationId:receipt.investigationId ?? null,
    analysisId:receipt.analysisId ?? null, requestId:receipt.requestId ?? null, attemptedAt:new Date().toISOString()};
  try {
    await pool.execute(`UPDATE alerts SET tags=JSON_SET(CASE WHEN JSON_TYPE(tags)='OBJECT' THEN tags ELSE JSON_OBJECT() END,
      '$.auto_analysis',CAST(? AS JSON)) WHERE id=?`, [JSON.stringify(fact),alertId]);
  } catch {
    assertWorkflowActive();
    console.warn(`[AutomaticAlertAdmission] receipt persistence unavailable for alert #${alertId}`);
  }
}

/** Alerts themselves are the durable pre-admission source. Recover a crash
 * after INSERT (including transactional callers), or after freezing an unsent
 * automatic owner. Accepted/unknown work remains owned by its original worker. */
export async function recoverAutomaticAlertAdmissions(): Promise<void> {
  const pool = dbConnection.getPool();
  if (!pool) return;
  assertWorkflowActive();
  const [rows] = await pool.query<any[]>(`SELECT a.id FROM alerts a
    LEFT JOIN investigation_alert_owners o ON o.alert_id=a.id
    WHERE a.level IN ('warning','error','critical')
      AND (a.instance_id IS NOT NULL OR a.server_id IS NOT NULL OR a.network_device_id IS NOT NULL)
      AND (JSON_UNQUOTE(JSON_EXTRACT(a.tags,'$.auto_analysis.status'))='pending'
        OR ((o.alert_id IS NULL OR (o.lane='investigation' AND o.investigation_id IS NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(o.command_snapshot,'$.trigger'))='auto'))
          AND JSON_UNQUOTE(JSON_EXTRACT(a.tags,'$.auto_analysis.reason')) IN
            ('AUTO_ANALYSIS_ADMISSION_UNAVAILABLE','INVESTIGATION_QUEUE_UNAVAILABLE','AUTO_ANALYSIS_CONFIG_UNAVAILABLE')))
    ORDER BY a.id LIMIT 100`);
  for (const row of rows) { assertWorkflowActive(); await admitPersistedAlert(Number(row.id)); }
}
