/** Deployment-only narrowing for the isolated formal-source process. Never
 * selected by an HTTP caller, request snapshot, model or investigation role. */
export const sourceReadTools: readonly string[] = Object.freeze([
  'get_server_metrics', 'get_server_alerts', 'get_resource_observations', 'get_resource_relations',
]);
export const sourceToolCeilingMode = 'server-read-v1';
export function sourceToolCeiling(env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const mode = env.INVESTIGATION_SOURCE_TOOL_CEILING;
  if (mode === undefined) return undefined;
  if (mode !== sourceToolCeilingMode) throw new Error('INVESTIGATION_SOURCE_TOOL_CEILING_INVALID');
  return sourceReadTools;
}
