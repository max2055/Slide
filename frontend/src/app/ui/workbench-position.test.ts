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
it('MAX-683: skips collapsed details even when Chromium reports a layout rectangle',async()=>{
 const root=document.createElement('section');
 root.innerHTML='<details><summary>高级</summary><button>隐藏读取</button></details><button id="visible">查找计划</button>';
 document.body.append(root);
 for(const button of root.querySelectorAll('button'))vi.spyOn(button,'getClientRects').mockReturnValue([{width:100,height:20}] as unknown as DOMRectList);
 const target=root.querySelector<HTMLElement>('#visible')!;target.scrollIntoView=vi.fn();
 history.replaceState({workbenchPosition:{key:'gone',y:900}},'','/');
 await restoreWorkbenchPosition(root);
 expect(document.activeElement).toBe(target);expect(target.scrollIntoView).toHaveBeenCalled();
});

it('reveals the restored row through nested scroll containers without smooth scrolling',async()=>{
 const root=document.createElement('section');
 root.innerHTML='<button data-workbench-key="row">查看调查</button>';
 document.body.append(root);
 const target=root.querySelector('button')!;
 vi.spyOn(target,'getClientRects').mockReturnValue([{width:100,height:20}] as unknown as DOMRectList);
 target.scrollIntoView=vi.fn();vi.spyOn(window,'scrollTo').mockImplementation(()=>{});
 history.replaceState({workbenchPosition:{key:'row',y:0}},'','/');
 await restoreWorkbenchPosition(root);
 expect(document.activeElement).toBe(target);
 expect(target.scrollIntoView).toHaveBeenCalledWith({block:'center',inline:'nearest',behavior:'instant'});
});
