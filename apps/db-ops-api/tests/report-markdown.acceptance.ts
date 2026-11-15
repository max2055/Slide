// MAX-619 R1/R2: explicit browser acceptance; not part of default unit collection.
// Run with tsx tests/report-markdown.acceptance.ts <output-dir> and the renderer module URLs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const { reportExporter } = await import(process.env.EXPORTER_MODULE || '../src/report-exporter.js');
const { marked } = await import(process.env.REVIEW_MARKED_MODULE!);
const MarkdownIt = (await import(process.env.REVIEW_MARKDOWN_IT_MODULE!)).default;
const output = process.argv[2];
if (!output || !process.env.REVIEW_MARKED_MODULE || !process.env.REVIEW_MARKDOWN_IT_MODULE) {
  throw new Error('Provide an output directory, REVIEW_MARKED_MODULE and REVIEW_MARKDOWN_IT_MODULE for the two real renderers');
}
fs.mkdirSync(output, { recursive: true });
const base:any = {id:619,name:'普通中文报告',type:'health',format:'html',created_at:'2026-11-16',data:null,content:'<p>普通安全正文</p>'};
const names = [
  '<svg onload="window.__pwn=1"></svg>',
  '<img src="https://example.invalid/md-title" onerror="window.__attack=619">',
  '普通标题\n# injected\r\n<script>window.__pwn=1</script>',
  '*强调* [链接](javascript:alert(1)) &lt;svg&gt;',
  'https://example.invalid/a_b?q=one&v=2#anchor',
];
const bodies = [
  ['<p>https://example.invalid/x</p>', 'https://example.invalid/x', ['https://example.invalid/x']],
  ['<p>https://example.invalid/a_b?q=one&amp;v=2#anchor</p>','https://example.invalid/a_b?q=one&v=2#anchor',['https://example.invalid/a_b?q=one&v=2#anchor']],
  ['<p>(https://example.invalid/a_(b)).</p>','(https://example.invalid/a_(b)).',['https://example.invalid/a_(b)']],
  ['<p>中文 http://localhost:3000/a-b?q=CPU+12.5&amp;v=1#title</p>', '中文 http://localhost:3000/a-b?q=CPU+12.5&v=1#title', ['http://localhost:3000/a-b?q=CPU+12.5&v=1#title']],
  ['<p>*强调* _斜体_ [链接](javascript:alert(1)) ![图](https://example.invalid/x) `内联` \\ # + - | {}</p>', '*强调* _斜体_ [链接](javascript:alert(1)) ![图](https://example.invalid/x) `内联` \\ # + - | {}',['https://example.invalid/x']],
  ['<p>甲 &amp;lt;段&amp;gt; / &lt;段&gt; / &#x3C;b&#x3E; / &amp;amp;</p>','甲 &lt;段&gt; / <段> / <b> / &amp;',[]],
  ['<p>&amp;#x3c;img&amp;#x3e; &#60;IMG SRC=x onerror=1&#62;</p>','&#x3c;img&#x3e; <IMG SRC=x onerror=1>',[]],
  ['<p title="a > b">前 <b>中文</b> 后</p>','前 中文 后',[]],
  ['<script>evil()</script><style>body{}</style><template>隐藏</template><p>正文</p>','正文',[]],
  ['<p>&lt;svg/onload=window.__attack=1&gt; &lt;/p&gt;&lt;img src=x&gt;</p>','<svg/onload=window.__attack=1> </p><img src=x>',[]],
  ['<p>A&nbsp;B &copy; &#x4E2D;&#x6587; &unknown;</p>','A\u00a0B © 中文 &unknown;',[]],
  ['<p>https://example.invalid/?q=&amp;lt;</p>','https://example.invalid/?q=&lt;',['https://example.invalid/?q=&lt;']],
];
const browser = await chromium.launch({headless:true});
const results:any = {browser:browser.version(),cases:[]};
try {
 for (const [engine, render] of [['marked-gfm',(s:string)=>marked.parse(s)], ['markdown-it-linkify',(s:string)=>new MarkdownIt({html:true,linkify:true}).render(s)]] as const) {
  for (const [index,name] of names.entries()) {
   const md=await reportExporter.exportToMarkdown({...base,name});
   const page=await browser.newPage(), requests:string[]=[];
   await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
   const html=await render(md);await page.setContent('<meta charset="utf-8">'+html);await page.waitForTimeout(30);
   const o=await page.evaluate(()=>({title:document.querySelector('h1')?.textContent,bad:document.querySelectorAll('script,img,svg,iframe,math,object,embed,style').length,attack:(window as any).__attack||0,pwn:(window as any).__pwn||0}));
   const pass=o.title?.replace(/\r\n?/g,'\n')===name.replace(/\r\n?/g,'\n')&&o.bad===0&&o.attack===0&&o.pwn===0&&requests.length===0;
   results.cases.push({kind:'name',engine,index,expected:name,observation:o,requests,pass});
   fs.writeFileSync(`${output}/${engine}-name-${index}.md`,md);fs.writeFileSync(`${output}/${engine}-name-${index}.html`,html);await page.close();
  }
  for (const [index,[content,expected,urls]] of bodies.entries()) {
   const md=(await reportExporter.exportToMarkdown({...base,content})).split('## 详细内容\n\n')[1];
   const page=await browser.newPage(),requests:string[]=[];
   await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
   const html=await render(md);await page.setContent('<meta charset="utf-8">'+html);
   const o=await page.evaluate(()=>({text:document.body.textContent?.trim(),bad:document.querySelectorAll('script,img,svg,iframe,math,object,embed,style').length,links:[...document.querySelectorAll('a')].map(a=>a.href),attack:(window as any).__attack||0,pwn:(window as any).__pwn||0}));
   const expectedLinks=(urls as string[]).map(url=>new URL(url).href);
   const pass=o.text===expected&&JSON.stringify(o.links)===JSON.stringify(expectedLinks)&&o.bad===0&&o.attack===0&&o.pwn===0&&requests.length===0;
   results.cases.push({kind:'body',engine,index,expected,expectedLinks,markdown:md,html,observation:o,requests,pass});await page.close();
  }
 }
 results.success=results.cases.every((x:any)=>x.pass);
 if(!results.success) process.exitCode=1;
} finally {
 await browser.close();results.cleanup='browser closed';
 fs.writeFileSync(`${output}/render-result.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify({success:results.success,total:results.cases.length,failed:results.cases.filter((x:any)=>!x.pass)}));
}
