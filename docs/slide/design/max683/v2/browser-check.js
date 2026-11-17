async (page) => {
 const checks=[], errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const check=async(name,fn)=>{if(!await fn())throw new Error(name);checks.push(name);};
 const contains=async(...words)=>{const t=await page.locator('body').innerText();return words.every(w=>t.includes(w));};
 const shot=async(name)=>{await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'docs/slide/design/max683/v2/'+name+'.png',scale:'css'});};
 const original='http://127.0.0.1:18764/concept.html',latest='http://127.0.0.1:18764/v2/concept.html';
 await page.setViewportSize({width:1440,height:900});
 for(const [name,query] of [['home',''],['detail','?view=detail'],['failed','?view=detail&mode=failed'],['missing','?view=detail&mode=missing']]){
  await page.goto(original+query);await shot('before-'+name+'-1440');
  await page.goto(latest+query);await shot(name+'-1440');
  await check('1440 '+name+' 无横向溢出',()=>page.evaluate(()=>document.documentElement.scrollWidth===1440));
 }
 await page.goto(latest);
 await check('首页每行一个结论、一条建议、一个主入口',async()=>await page.locator('.work').count()===4&&await page.locator('.work h3').count()===4&&await page.locator('.work .recommend').count()===4&&await page.locator('.work .row-action').count()===4);
 await check('覆盖单位及调查时间不冒充行动时间',()=>contains('每调查一个当前下一步','仅 open/waiting','非全部计划','调查更新时间：今日 15:20'));
 await page.locator('.scope summary').focus();await page.keyboard.press('Enter');
 await check('覆盖说明 Enter 展开',()=>page.locator('.scope details').evaluate(el=>el.open));
 await check('说明保留第二计划/历史发现限制',()=>contains('翻完页也不覆盖同调查其他计划或已关闭调查历史'));
 await page.keyboard.press('Enter');
 await page.getByRole('link',{name:'完整行动列表 →',exact:true}).click();
 await check('完整行动列表含两计划与历史，时间来源独立',()=>contains('A1 ·','A2 ·','H1 ·','计划更新 15:42','计划更新 15:46','未提供'));
 await shot('actions-1440');
 await page.getByRole('link',{name:'审阅 A2 →',exact:true}).click();
 await check('第二计划导航绑定正确',()=>contains('A2 · 专用服务配置核对计划','配置核对计划尚未批准','调查更新时间仍为 15:20'));
 await page.goBack();await page.getByRole('link',{name:'读取历史 →',exact:true}).click();
 await check('关闭调查历史仍可发现且过期只读',()=>contains('来源调查 H（已关闭）','计划已过期，仅可读取历史记录。'));
 await check('历史业务动作禁用',()=>page.locator('.business').isDisabled());
 await page.goto(latest);
 await page.keyboard.press('Tab');
 await check('首次 Tab 到对照入口',()=>page.evaluate(()=>document.activeElement.textContent.includes('与上一版对照')));
 await page.keyboard.press('Tab');
 await check('Tab 到完整调查列表',()=>page.evaluate(()=>document.activeElement.textContent.includes('完整调查列表')));
 await page.keyboard.press('Shift+Tab');
 await check('Shift+Tab 返回前一入口',()=>page.evaluate(()=>document.activeElement.textContent.includes('与上一版对照')));
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');await page.waitForURL('**/concept.html?view=investigations');
 await check('Enter 进入完整调查列表',async()=>page.url().includes('view=investigations'));
 await page.getByRole('link',{name:'查看运行中调查 →',exact:true}).click();
 await check('运行中只读取原请求',()=>contains('调查详情','活动请求运行中，不再派发','读取当前请求（演示）'));
 await check('运行中没有继续调查业务按钮',async()=>await page.getByRole('button',{name:'继续原调查（演示）',exact:true}).count()===0);
 await shot('running-1440');
 await page.getByRole('link',{name:'← 返回需要处理',exact:true}).click();
 await page.getByRole('link',{name:'查看调查 →',exact:true}).click();
 await check('可继续调查无活动请求，无行动模板',async()=>await contains('无活动请求，可继续','补充不同时段的状态和访问样本')&&!((await page.locator('#content').innerText()).includes('计划有效期')));
 await shot('continue-1440');
 await page.goto(latest);
 for(const [link,key,words] of [
 ['审阅计划 →','approval',['计划尚未批准','先审阅目标、影响与有效期','进入独立审批（演示）']],
 ['查看失败证据 →','failed',['执行已成功，但恢复验证未通过','不要重复执行','missingSamples：0','报告 v2']],
 ['核对缺失证据 →','missing',['无法判断业务是否恢复','补齐证据后再判断恢复','missingSamples：12','恢复结论为未知']]
 ]){
  await page.getByRole('link',{name:link,exact:true}).click();
  await check(key+' 导航结论建议一致',()=>contains(...words));
  await check(key+' 业务操作禁用',()=>page.locator('.business').isDisabled());
  await page.locator('.raw summary').focus();await page.keyboard.press('Enter');
  await check(key+' Enter 展开原始资料',()=>page.locator('.raw').evaluate(el=>el.open));
  await page.keyboard.press('Enter');
  await check(key+' Enter 收起原始资料',()=>page.locator('.raw').evaluate(el=>!el.open));
  const before=page.url();await page.keyboard.press('Escape');
  await check(key+' Escape 不派发或更改路由',async()=>page.url()===before);
  await page.setViewportSize({width:1366,height:768});
  await check(key+' 1366 首屏结论建议主操作及风险可见',()=>page.evaluate(()=>['.detail-title','.decision','.business','.facts','.risk'].every(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})));
  await check(key+' 1366 无横向溢出',()=>page.evaluate(()=>document.documentElement.scrollWidth===1366));
  if(key==='approval')await shot('detail-1366');
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('link',{name:'← 返回需要处理',exact:true}).click();
 }
 await page.setViewportSize({width:1366,height:768});await shot('home-1366');
 await check('1366 首页无横向溢出',()=>page.evaluate(()=>document.documentElement.scrollWidth===1366));
 await page.setViewportSize({width:1920,height:1080});await shot('home-1920');
 await check('1920 首页无横向溢出',()=>page.evaluate(()=>document.documentElement.scrollWidth===1920));
 await check('页面脚本错误为零',async()=>errors.length===0);
 return {checks,passed:checks.length,pageErrors:errors,scope:'静态原型导航、键盘与布局；不验证 API/权限/审批执行/返回上下文恢复'};
}
