async(page)=>{
 const checks=[];
 for(const name of ['首页','计划详情','验证失败','证据不足']){
  await page.getByRole('button',{name,exact:true}).click();
  await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete&&i.naturalWidth===1440&&i.naturalHeight===900));
  checks.push(name+' V2/V3 原图1440x900加载');
 }
 await page.getByRole('button',{name:'首页',exact:true}).focus();
 await page.keyboard.press('Tab');await page.keyboard.press('Enter');
 if(await page.locator('button[aria-pressed=true]').innerText()!=='计划详情')throw new Error('compare keyboard');
 checks.push('对照页 Tab/Enter切换');
 for(const mode of ['continue','running']){
  await page.goto('http://127.0.0.1:18766/v3/concept.html?view=detail&mode='+mode);
  await page.locator('.raw summary').focus();await page.keyboard.press('Enter');
  const text=await page.locator('.raw').innerText();
  if(!text.includes('调查与结果版本')||text.includes('审批记录'))throw new Error(mode);
  checks.push(mode+' 原始资料无行动模板');
 }
 return {checks,passed:checks.length};
}
