import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { dbConnection } from './db-connection.js';
import { maintenanceAt } from './maintenance-intervals.js';
import { maintenanceWindowService } from './maintenance-window-service.js';
/** Rechecked immediately before transport, including replay of a saved delivery request. */
export async function maintenanceBlocksDelivery(alertId:number):Promise<boolean>{
 const pool=dbConnection.getPool();if(!pool)throw Error('MAINTENANCE_STATE_UNKNOWN');
 const [rows]=await pool.execute<RowDataPacket[]>('SELECT instance_id,server_id,network_device_id,tags,created_at FROM alerts WHERE id=?',[alertId]);
 if(rows.length!==1)throw Error('MAINTENANCE_ALERT_UNKNOWN');
 const a=rows[0], tags=typeof a.tags==='string'?JSON.parse(a.tags):a.tags??{};
 // A recorded suppression is permanent for that opening; exit never backfills it.
 if(tags.maintenance_window || tags.maintenance_unknown || tags.maintenance?.state==='active' || tags.maintenance?.state==='unknown')return true;
 const ref=a.instance_id?{type:'instance' as const,id:Number(a.instance_id)}:a.server_id?{type:'server' as const,id:Number(a.server_id)}:a.network_device_id?{type:'network_device' as const,id:Number(a.network_device_id)}:null;
 if(!ref)return false;
 const windows=[...await maintenanceAt(pool as unknown as PoolConnection,ref,new Date(a.created_at).getTime()),...await maintenanceAt(pool as unknown as PoolConnection,ref,Date.now())];
 if(windows.length)return true;
 return ref.type==='instance'&&(await maintenanceWindowService.isActiveMaintenanceWindow(ref.id)).active;
}
