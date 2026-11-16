/** Browser routes only. Preserve all historical evidence bindings verbatim. */
export function canonicalWorkspaceUrl(input: URL, base = ''): URL {
  const url = new URL(input);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const legacyTab = path === (base || '/') ? url.searchParams.get('tab') : null;
  const entry = legacyTab || path.slice(base.length + 1);
  if (entry === 'attention') {
    url.pathname = `${base}/events`;
    url.searchParams.set('view', 'aggregate');
    url.searchParams.set('eventList', 'active');
  } else if (['investigations', 'operations-actions'].includes(entry)) {
    url.pathname = `${base}/workbench`;
    if (entry === 'operations-actions') url.searchParams.set('workspaceTab', 'actions');
  } else return url;
  if (legacyTab) url.searchParams.delete('tab');
  return url;
}
export function workspaceReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value)) return null;
  try {
    const u = new URL(value, location.origin);
    if (u.origin !== location.origin || !['/workbench','/investigations','/approval','/events','/operations-actions'].includes(u.pathname)) return null;
    const result = canonicalWorkspaceUrl(u);
    return result.pathname + result.search + result.hash;
  } catch { return null; }
}
