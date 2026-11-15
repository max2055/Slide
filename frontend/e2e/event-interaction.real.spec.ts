import { test, expect } from '@playwright/test';
test.skip(process.env.EVENT_REAL_TEST !== '1', 'Requires explicitly injected disposable database configuration');
test('real application saves and permission failure preserve drafts; local filters and desktop keyboard', async ({page})=>{
 const login=await page.request.post('/api/auth/login',{data:{username:'admin',password:process.env.INITIAL_ADMIN_PASSWORD}});
 expect(login.status()).toBe(200);
 const {token}=await login.json();
 await page.goto('/');
 await page.evaluate(()=>document.querySelector('slide-app')?.remove());
 await page.evaluate(async token=>{
  localStorage.setItem('token',token);
  await import('/src/app/ui/views/event-management.ts');
  document.body.replaceChildren(document.createElement('event-management-page'));
 },token);
 await expect(page.locator('event-management-page .event-title').filter({hasText:'验收事件55'})).toBeVisible();
 await page.locator('event-management-page .event-title').filter({hasText:'验收事件55'}).click();
 const note=page.getByRole('textbox',{name:'事件备注'});
 await expect(page.getByText('基本信息',{exact:true})).toBeVisible();
 await note.fill('真实备注');
 const responsePromise = page.waitForResponse(r=>r.url().endsWith('/55/note'));
 await page.getByRole('button',{name:'添加备注',exact:true}).click();
 const saved = await responsePromise; expect(saved.status()).toBe(200);
 expect((await saved.json()).success).toBe(false);
 await expect(note).toHaveValue('真实备注');
 await page.getByRole('button',{name:'添加复盘',exact:true}).click();
 const review=page.getByRole('textbox',{name:'事件复盘'});
 await review.fill('真实复盘');
 await page.getByRole('button',{name:'提交复盘'}).click();
 await expect(review).toHaveCount(0);
 const headers={Authorization:`Bearer ${token}`};
 const logs=await (await page.request.get('/api/alerts/events/55/logs',{headers})).json();
 expect(JSON.stringify(logs)).toContain('真实复盘');
 // Existing backend handled enum mismatch prevents note persistence.
 // Real authentication rejection: no mocked HTTP responses.
 await page.evaluate(()=>localStorage.setItem('token','invalid'));
 await note.fill('失败保留备注');
 await page.getByRole('button',{name:'添加备注',exact:true}).click();
 await expect(note).toHaveValue('失败保留备注');
 await page.evaluate(token=>localStorage.setItem('token',token),token);
 await page.getByRole('button',{name:'添加备注',exact:true}).click();
 await expect(note).toHaveValue('失败保留备注');
 await page.getByRole('button',{name:'添加复盘',exact:true}).click();
 await review.fill('失败保留复盘');
 await page.evaluate(()=>localStorage.setItem('token','invalid'));
 await page.getByRole('button',{name:'提交复盘'}).click();
 await expect(review).toHaveValue('失败保留复盘');
 await page.evaluate(token=>localStorage.setItem('token',token),token);
 await page.getByRole('button',{name:'提交复盘'}).click();
 await expect(review).toHaveCount(0);
 await page.getByRole('combobox').selectOption('critical');
 await expect(page.locator('event-management-page .event-title').filter({hasText:'验收事件55'})).toBeVisible();
 await page.getByRole('button',{name:'下一页 →'}).click();
 await expect(page.getByText('第 2/2 页，共 55 条')).toBeVisible();
 await expect(page.getByText('暂无匹配的事件')).toBeVisible();
 await page.getByRole('combobox').selectOption('all');
 await page.getByRole('button',{name:'← 上一页'}).click();
 await expect(page.getByText('第 1/2 页，共 55 条')).toBeVisible();
 await page.getByRole('textbox',{name:'搜索本页事件'}).fill('不存在');
 await expect(page.getByText('暂无匹配的事件')).toBeVisible();
 await expect(page.getByText('第 1/2 页，共 55 条')).toBeVisible();
 await page.getByRole('textbox',{name:'搜索本页事件'}).fill('');
 for(const size of [{width:1366,height:768},{width:1440,height:900},{width:1920,height:1080}]){
  await page.setViewportSize(size);
  await expect(page.getByRole('textbox',{name:'搜索本页事件'})).toBeVisible();
  await note.fill("键盘草稿"); await note.focus(); await expect(note).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'添加备注',exact:true})).toBeFocused();
 }
});
