import { expect, it } from 'vitest';
import { canonicalWorkspaceUrl, workspaceReturnTo } from './workbench-routing.ts';
import { tabFromPath, TAB_GROUPS, DEFAULT_TAB_OPTIONS } from './navigation.ts';
it.each(['/investigations','/operations-actions','/?tab=operations-actions','/?tab=investigations'])('migrates %s without dropping precise bindings', path => {
  const u = new URL(path, location.origin);
  for (const [k,v] of Object.entries({plan:'p',investigation:'i',sourceInvestigation:'i',attentionPlanVersion:'3',attentionPlanHash:'old',attentionReport:'r',attentionReportVersion:'2',attentionExecution:'e',attentionVersion:'4',resultVersion:'2',targetId:'7',returnTo:'/approval?query=x',resource:'server:7'})) u.searchParams.set(k,v);
  const out = canonicalWorkspaceUrl(u);
  expect(out.pathname).toBe('/workbench');
  for (const [key,value] of u.searchParams) if (key !== 'tab') expect(out.searchParams.get(key)).toBe(value);
  expect(canonicalWorkspaceUrl(out).href).toBe(out.href);
});
it.each(['/attention','/?tab=attention'])('maps %s to aggregate active events', path => {
  const out=canonicalWorkspaceUrl(new URL(path,location.origin));
  expect(out.pathname+out.search).toBe('/events?view=aggregate&eventList=active');
});
it('supports base paths and keeps menu compatibility separate',()=>{
  expect(canonicalWorkspaceUrl(new URL('/slide/investigations?investigation=i',location.origin),'/slide').pathname).toBe('/slide/workbench');
  expect(tabFromPath('/workbench')).toBe('investigations');
  expect(tabFromPath('/investigations')).toBe('investigations');
  expect(TAB_GROUPS.flatMap(g=>[...g.tabs])).not.toContain('attention');
  expect(TAB_GROUPS.flatMap(g=>[...g.tabs])).not.toContain('operations-actions');
  expect(DEFAULT_TAB_OPTIONS).not.toContain('attention');
});
it.each(['https://evil.test','//evil.test','/\\evil.test','/approval%2f%2fevil','/unknown','/approval\n'])('rejects unsafe return %s',value=>expect(workspaceReturnTo(value)).toBeNull());
it('canonicalizes allowed historical return with position',()=>expect(workspaceReturnTo('/investigations?investigation=i&attentionVersion=3')).toBe('/workbench?investigation=i&attentionVersion=3'));

it.each([['attention','events','/events?view=aggregate&eventList=active'],['operations-actions','investigations','/workbench?workspaceTab=actions']])('resolves saved default %s through the same route adapter',async(legacy,tab,expected)=>{
  const {setTabFromRoute,syncUrlWithTab}=await import('./app-settings.ts');
  history.replaceState({},'','/');
  const host={basePath:'',connected:false,tab:'dashboard',settings:{}} as any;
  setTabFromRoute(host,legacy as any);syncUrlWithTab(host,host.tab,true);
  expect(host.tab).toBe(tab);expect(location.pathname+location.search).toBe(expected);
  history.replaceState({},'','/');
});

it.each(['/investigations','/?tab=investigations'])('keeps the full list for plain historical entry %s',path=>{
 expect(canonicalWorkspaceUrl(new URL(path,location.origin)).searchParams.get('workspaceTab')).toBe('investigations');
});

it.each(['/attention','/?tab=attention'])('preserves the investigation context of %s through shell synchronization', async path => {
  const {syncTabWithLocation,syncUrlWithTab}=await import('./app-settings.ts');
  const url=new URL(path,location.origin);
  url.searchParams.set('eventId','72101');
  url.searchParams.set('investigation','original-record');
  history.replaceState({},'',url);
  const host={basePath:'',connected:false,tab:'dashboard',settings:{}} as any;
  try {
    for(const _reload of [false,true]) {
      syncTabWithLocation(host,true);
      expect(location.pathname).toBe('/events');
      expect(new URLSearchParams(location.search).get('investigation')).toBe('original-record');
    }
    syncUrlWithTab(host,'dashboard',true);
    expect(new URLSearchParams(location.search).has('investigation')).toBe(false);
  } finally { history.replaceState({},'','/'); }
});
