import type { Pool } from 'mysql2/promise';

/** Dry-run only. A missing legacy marker is never proof of an unsent request. */
export async function analysisRecoveryInventory(pool: Pick<Pool, 'execute'>) {
  const [rows] = await pool.execute<any[]>(`SELECT a.id, a.status, a.legacy_status, a.recovery_reason,
    a.result IS NOT NULL AS has_result, d.job_id, d.attempt_number, d.owner_id, d.fencing_token, d.current_run_id, d.request_state
    FROM ai_analysis a LEFT JOIN analysis_dispatches d ON d.analysis_id = a.id
    WHERE a.status IN ('pending','running','unknown') OR a.legacy_status IS NOT NULL ORDER BY a.id`);
  return rows.map(row => ({ ...row, resolution: row.has_result ? 'existing_result_preserved'
    : row.job_id && row.request_state === 'unsent' ? 'provably_unsent_durable_intent' : 'unknown_requires_explicit_retry' }));
}
