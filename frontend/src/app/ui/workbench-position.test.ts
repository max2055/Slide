import {afterEach,expect,it,vi} from 'vitest';
import {restoreWorkbenchPosition} from './workbench-position.ts';
afterEach(()=>{document.body.replaceChildren();history.replaceState({},'','/');vi.restoreAllMocks();});
it('skips hidden or disabled controls when the original row disappears',async()=>{
 const root=document.createElement('section');
 root.innerHTML='<button hidden>hidden</button><button disabled>disabled</button><h2>没有匹配记录</h2>';
 document.body.append(root);
 const heading=root.querySelector('h2')!;
 vi.spyOn(heading,'getClientRects').mockReturnValue([{width:100,height:20}] as unknown as DOMRectList);
 heading.scrollIntoView=vi.fn();
 history.replaceState({workbenchPosition:{key:'gone',y:900}},'','/');
 await restoreWorkbenchPosition(root);
 expect(document.activeElement).toBe(heading);
 expect(heading.scrollIntoView).toHaveBeenCalled();
 expect(history.state.workbenchPosition).toBeUndefined();
});
