import type { InvestigationEntryContext } from '../../../api/generated/public-api.ts';
export type { InvestigationEntryContext };
/** Public producer contract: absolute UTC endpoints, exact identity, no inferred scope. */
export function investigationEntryHref(context: InvestigationEntryContext, basePath = ''): string {
  if (basePath && basePath !== '/' && !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(basePath)) throw new Error('INVALID_BASE_PATH');
  return `${basePath.replace(/\/$/, '')}/investigations?entry=${encodeURIComponent(JSON.stringify(context))}`;
}
export function readInvestigationEntry(search: string): InvestigationEntryContext | null {
  const params = new URLSearchParams(search), raw = params.get('entry');
  if (raw === null) return null;
  if (params.getAll('entry').length !== 1 || raw.length > 32768) throw new Error('调查上下文无效，请返回来源重新选择。');
  try {
    const c = JSON.parse(raw);
    if (!c || c.schemaVersion !== 1 || !Array.isArray(c.resourceRefs) || !c.resourceRefs.length
      || typeof c.from !== 'string' || typeof c.to !== 'string' || !Array.isArray(c.sourceEventIds)
      || typeof c.returnTo !== 'string') throw new Error();
    return c;
  } catch { throw new Error('调查上下文无效，请返回来源重新选择。'); }
}
