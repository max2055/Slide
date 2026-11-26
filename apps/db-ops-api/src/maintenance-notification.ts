import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { dbConnection } from './db-connection.js';
import { manualSilenceBlocksNotification } from './alert-silence-service.js';
import { maintenanceAt } from './maintenance-intervals.js';
import { maintenanceWindowService } from './maintenance-window-service.js';

/** Rechecked immediately before transport, including replay of a saved delivery request. */
export async function notificationSuppressionReason(
  alertId: number,
  transitionAt?: string,
): Promise<'MAINTENANCE_SUPPRESSED' | 'MANUAL_SILENCE_SUPPRESSED' | null> {
 const pool=dbConnection.getPool();if(!pool)throw Error('MAINTENANCE_STATE_UNKNOWN');
 const [rows]=await pool.execute<RowDataPacket[]>('SELECT instance_id,server_id,network_device_id,source,metric_name,tags,created_at FROM alerts WHERE id=?',[alertId]);
 if(rows.length!==1)throw Error('MAINTENANCE_ALERT_UNKNOWN');
 const a=rows[0], tags=typeof a.tags==='string'?JSON.parse(a.tags):a.tags??{};
 // A recorded suppression is permanent for that opening; exit never backfills it.
 if(tags.maintenance_window || tags.maintenance_unknown || tags.maintenance?.state==='active' || tags.maintenance?.state==='unknown')return 'MAINTENANCE_SUPPRESSED';
 const ref=a.instance_id?{type:'instance' as const,id:Number(a.instance_id)}:a.server_id?{type:'server' as const,id:Number(a.server_id)}:a.network_device_id?{type:'network_device' as const,id:Number(a.network_device_id)}:null;
 if(!ref)return null;
 const windows=[...await maintenanceAt(pool as unknown as PoolConnection,ref,new Date(a.created_at).getTime()),...await maintenanceAt(pool as unknown as PoolConnection,ref,Date.now())];
 if(transitionAt)windows.push(...await maintenanceAt(pool as unknown as PoolConnection,ref,Date.parse(transitionAt)));
 if(windows.length || ref.type==='instance'&&(await maintenanceWindowService.isActiveMaintenanceWindow(ref.id)).active)return 'MAINTENANCE_SUPPRESSED';
 if(ref.type==='instance' && a.source==='template-trigger' && a.metric_name
   && (tags.manual_silence_suppressed === true
     || await manualSilenceBlocksNotification(pool, ref.id, a.metric_name, new Date(transitionAt ?? a.created_at)))) {
   return 'MANUAL_SILENCE_SUPPRESSED';
 }
 return null;
}

export async function maintenanceBlocksDelivery(alertId: number, transitionAt?: string): Promise<boolean> {
  return (await notificationSuppressionReason(alertId, transitionAt)) !== null;
}
