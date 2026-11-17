async(page)=>{
 const checks=[],measurements=[];
 const root='http://127.0.0.1:18767/';
 const assert=(ok,name)=>{if(!ok)throw new Error(name);checks.push(name);};
 await page.goto(root+'v4/compare.html');
 for(const name of ['首页','计划详情','验证失败','证据不足']){
  await page.getByRole('button',{name,exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete&&i.naturalWidth===1440&&i.naturalHeight===900));
  checks.push(name+' V3/V4 原图1440x900加载');
 }
 await page.getByRole('button',{name:'首页',exact:true}).focus();
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');
 assert(await page.locator('button[aria-pressed=true]').innerText()==='计划详情','对照页 Tab/Enter切换');
 await page.setViewportSize({width:1366,height:768});
 for(const version of ['v3','v4'])for(const mode of ['approval','failed','missing']){
  await page.goto(root+version+'/concept.html?view=detail&mode='+mode);
  const sizes=await page.evaluate(()=>Object.fromEntries(['.next-pane p','.business','.detail-title','.object-context','.evidence-pane'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return[s,{width:r.width,top:r.top,bottom:r.bottom}]})));
  measurements.push({version,mode,sizes});
  if(version==='v4'){
   assert(sizes['.next-pane p'].width>700,mode+' 建议文字宽度超过700px');
   assert(sizes['.business'].bottom<=768,mode+' 主操作在1366首屏');
   await page.screenshot({path:'docs/slide/design/max683/v4/'+mode+'-1366.png'});
  }
 }
 await page.goto(root+'v4/concept.html?view=detail&mode=missing');
 // Explicit synthetic layout stress: not a product recommendation or real data.
 await page.locator('.next-pane p').evaluate(el=>{el.textContent='长文本排版样本（非业务建议）：先核对缺失的 12 个样本与采样链路，检查采样时间是否落在本次观察窗口、目标标识是否一致，以及超时和权限失败是否造成空缺；补齐证据后读取同一次执行对应的最新报告，再判断恢复。结果仍未知时保留原动作，不重复执行。';});
 await page.locator('.context-object').evaluate(el=>{el.textContent='长对象名排版样本：核心交易服务跨区域连接异常恢复采样验证报告 / slide-demo-long-service-name.service';});
 const stress=await page.evaluate(()=>{const p=document.querySelector('.next-pane p').getBoundingClientRect(),b=document.querySelector('.business').getBoundingClientRect();return {textWidth:p.width,textHeight:p.height,buttonBottom:b.bottom,overlap:p.right>b.left,overflow:document.documentElement.scrollWidth>innerWidth};});
 measurements.push({syntheticLongText:stress});
 assert(!stress.overlap&&!stress.overflow&&stress.buttonBottom<768,'长建议和长对象名自然换行，主操作无重叠且首屏可达');
 await page.screenshot({path:'docs/slide/design/max683/v4/long-text-1366.png'});
 for(const mode of ['continue','running']){
  await page.goto(root+'v4/concept.html?view=detail&mode='+mode);
  await page.locator('.raw summary').focus();await page.keyboard.press('Enter');
  const text=await page.locator('.raw').innerText();
  assert(text.includes('调查与结果版本')&&!text.includes('审批记录'),mode+' 原始资料无行动模板');
 }
 await page.setViewportSize({width:1920,height:1080});
 await page.goto(root+'v4/concept.html?view=detail');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth===1920),'1920详情无横溢');
 await page.screenshot({path:'docs/slide/design/max683/v4/detail-1920.png'});
 return {checks,passed:checks.length,measurements,scope:'静态原型；长文是临时注入的排版样本，不冒充真实业务数据'};
}
