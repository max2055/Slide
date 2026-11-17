import { workspaceReturnTo } from './workbench-routing.ts';

/** History holds only viewport/DOM keys, never result content or authority. */
export function rememberWorkbenchPosition(key: string) {
  history.replaceState({...history.state, workbenchPosition:{key,y:window.scrollY}}, '', location.href);
  return location.pathname + location.search;
}

export function returnToWorkbench(event: MouseEvent, destination: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (workspaceReturnTo(destination) === destination && history.state?.workbenchOrigin === destination) {
    event.preventDefault();
    history.back();
  }
}

export function openWorkbenchRecord(event: MouseEvent, destination: string, key: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (workspaceReturnTo(destination) !== destination) return;
  event.preventDefault();
  const origin = rememberWorkbenchPosition(key);
  history.pushState({workbenchOrigin:origin}, '', destination);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export async function restoreWorkbenchPosition(root: ParentNode) {
  await Promise.all([...root.querySelectorAll('app-data-table')].map(table=>(table as HTMLElement & {updateComplete:Promise<unknown>}).updateComplete));
  if (root instanceof Node && !root.isConnected) return;
  const position = history.state?.workbenchPosition;
  if (!position || typeof position.key !== 'string' || !Number.isFinite(position.y)) return;
  const match = [...root.querySelectorAll<HTMLElement>('[data-workbench-key]')].find(el=>el.dataset.workbenchKey===position.key);
  const visible = (el:HTMLElement) => el.getClientRects().length > 0
    && getComputedStyle(el).visibility !== 'hidden' && !el.matches(':disabled');
  const fallback = [...root.querySelectorAll<HTMLElement>('button,a[href],h2')].find(visible);
  const target = match && visible(match) ? match : fallback;
  if (target) {
    if (target.tagName === 'H2') target.tabIndex = -1;
    target.focus({preventScroll:true});
    if (target === match) window.scrollTo(0,position.y);
    else target.scrollIntoView({block:'nearest'});
  }
  const {workbenchPosition: _position,...state} = history.state;
  history.replaceState(state,'',location.href);
}
