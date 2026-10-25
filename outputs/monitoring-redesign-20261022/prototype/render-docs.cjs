const fs=require('node:fs');
const path=require('node:path');
const MarkdownIt=require('../../../frontend/node_modules/markdown-it');
const md=new MarkdownIt({html:false,linkify:true});
const root=path.resolve(__dirname,'../../..');
const entries=[
 ['plan.html','详细方案','docs/superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md'],
 ['scope.html','项目范围','docs/slide/requirements/current-version-scope.md'],
 ['workspace-design.html','AI 工作空间设计','docs/superpowers/specs/2026-10-22-ai-workspace-experience-review.md'],
 ['input-audit.html','少输入设计','docs/superpowers/specs/2026-10-22-input-burden-audit.md']
];
const rewrite={
 '../../slide/requirements/current-version-scope.md':'scope.html',
 '../../superpowers/specs/2026-10-22-monitoring-operations-optimization-design.md':'plan.html',
 '../../superpowers/specs/2026-10-22-ai-workspace-experience-review.md':'workspace-design.html',
 '2026-10-22-ai-workspace-experience-review.md':'workspace-design.html',
 '2026-10-22-input-burden-audit.md':'input-audit.html'
};
for(const [file,title,source] of entries){
 let body=md.render(fs.readFileSync(path.join(root,source),'utf8'));
 for(const [from,to] of Object.entries(rewrite))body=body.split(`href="${from}"`).join(`href="${to}"`);
 // Historical/source references remain text here; canonical Markdown preserves filesystem links.
 body=body.replace(/<a href="((?:\.\.\/|\.\/)[^"]+)">([^]*?)<\/a>/g,'<span title="原始材料见仓库 Markdown">$2</span>');
 const nav=entries.map(([f,t])=>`<a href="./${f}"${f===file?' aria-current="page"':''}>${t}</a>`).join('');
 fs.writeFileSync(path.join(__dirname,'public',file),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slide V4 · ${title}</title><style>body{margin:0;background:#f6f8fb;color:#26364a;font:14px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}header{padding:18px 32px;background:white;border-bottom:1px solid #dae2ec;display:flex;gap:24px;align-items:center;flex-wrap:wrap}nav{display:flex;gap:24px}a{color:#315f91;text-decoration:none}a[aria-current]{font-weight:700;text-decoration:underline}main{max-width:1140px;margin:32px auto;background:white;padding:36px;border:1px solid #dae2ec;border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow:auto}th,td{border:1px solid #dae2ec;padding:10px 14px;text-align:left;vertical-align:top}th{background:#f3f6fa}h1,h2,h3,h4{line-height:1.5;color:#172d46}h2{margin-top:36px;padding-bottom:8px;border-bottom:1px solid #e5eaf0}code{background:#f1f4f8;padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#f1f4f8}pre code{padding:0}p,li{overflow-wrap:anywhere}.notice{background:#edf4fb;border-left:3px solid #315f91;padding:12px 18px;margin-bottom:24px;font-size:13px}footer{font-size:12px;color:#607186;margin-top:32px}</style></head><body><header><strong>Slide · V4 设计评审</strong><nav>${nav}<a href="./#templates">返回原型 ↗</a></nav></header><main><div class="notice">已确认范围：中文浅色桌面 · 无 Agent 原生采集 · 不做 Zabbix 模板兼容。本页是详细方案，拟建能力不代表已实现。</div>${body}<footer>来源：${source}。历史材料和源码引用请查阅仓库原始 Markdown。</footer></main></body></html>`);
}
console.log(`Rendered ${entries.length} V4 review pages`);
