import { instanceDatabaseService } from '../instance-database-service.js';

/** Preserve historical response shapes and expose the object's current lifecycle. */
export async function instanceHistoryContext(request: any, reply: any): Promise<void> {
  const instance = await instanceDatabaseService.getInstanceById(Number(request.params.id));
  reply.header('X-Instance-Lifecycle-State', instance?.lifecycle_state ?? 'unknown');
}
