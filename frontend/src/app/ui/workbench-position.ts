import { workspaceReturnTo } from './workbench-routing.ts';

type WorkbenchOrigin = { url: string; queueRows: HTMLElement };

/** History holds only viewport/DOM keys, never result content or authority. */
export function rememberWorkbenchPosition(key: string, origin?: WorkbenchOrigin) {
  const queue = origin ? {
    listY: origin.queueRows.scrollTop,
    mainY: document.querySelector('main.content')?.scrollTop ?? 0,
  } : undefined;
  history.replaceState({...history.state, workbenchPosition:{key,y:window.scrollY,queue}}, '', origin?.url ?? location.href);
  return location.pathname + location.search;
}

export function returnToWorkbench(event: MouseEvent, destination: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (workspaceReturnTo(destination) === destination && history.state?.workbenchOrigin === destination) {
    event.preventDefault();
    history.back();
  }
}

export function openWorkbenchRecord(event: MouseEvent, destination: string, key: string, fromQueue?: WorkbenchOrigin) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (workspaceReturnTo(destination) !== destination) return;
  event.preventDefault();
  const origin = rememberWorkbenchPosition(key, fromQueue);
  history.pushState({workbenchOrigin:origin}, '', destination);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export async function restoreWorkbenchPosition(root: ParentNode, queueRows?: HTMLElement | null) {
  await Promise.all([...root.querySelectorAll('app-data-table')].map(table=>(table as HTMLElement & {updateComplete:Promise<unknown>}).updateComplete));
  if (root instanceof Node && !root.isConnected) return;
  const position = history.state?.workbenchPosition;
  if (!position || typeof position.key !== 'string' || !Number.isFinite(position.y)) return;
  const match = [...root.querySelectorAll<HTMLElement>('[data-workbench-key]')].find(el=>el.dataset.workbenchKey===position.key);
  const disclosure = match?.closest<HTMLDetailsElement>('details[data-restore-open]');
  if (disclosure) disclosure.open = true;
  const visible = (el:HTMLElement) => {
    // Chromium can return layout rectangles for content inside closed details.
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open
        && !parent.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.matches(':disabled');
  };
  const fallback = [...root.querySelectorAll<HTMLElement>('button,a[href],h2')].find(visible);
  const target = match && visible(match) ? match : fallback;
  if (target) {
    if (target.tagName === 'H2') target.tabIndex = -1;
    target.focus({preventScroll:true});
    if (target === match) window.scrollTo(0,position.y);
    if (target === match && queueRows && Number.isFinite(position.queue?.listY) && Number.isFinite(position.queue?.mainY)) {
      queueRows.scrollTop = position.queue.listY;
      const main = document.querySelector('main.content');
      if (main) main.scrollTop = position.queue.mainY;
    } else {
      target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    }
  }
  const {workbenchPosition: _position,...state} = history.state;
  history.replaceState(state,'',location.href);
}
