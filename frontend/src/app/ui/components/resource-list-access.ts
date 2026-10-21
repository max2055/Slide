import { readCachedPermissions } from '../permissions.js';

/** UI availability only; each request still passes the server's live authorization. */
export function hasListPermission(required: string): boolean {
  const permissions = readCachedPermissions();
  return Boolean(permissions?.has('*') || permissions?.has(required) || permissions?.has(`${required.split(':')[0]}:*`));
}
