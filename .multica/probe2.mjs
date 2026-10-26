import { spawn } from 'node:child_process';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9335;
const profile=`/tmp/max241-probe2-${process.pid}`;
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--window-size=1100,800','about:blank'],{stdio:'ignore'});
async function wait(){for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);const t=await r.json();const p=t.find(x=>x.type==='page');if(p)return p.webSocketDebuggerUrl;}catch{}await new Promise(r=>setTimeout(r,200));}throw new Error('no');}
const ws=new WebSocket(await wait()); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let id=0;const pending=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const{res,rej}=pending.get(m.id);pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}};
const send=(method,params={})=>{const i=++id;ws.send(JSON.stringify({id:i,method,params}));return new Promise((res,rej)=>pending.set(i,{res,rej}));};
await send('Runtime.enable');await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
const loaded=new Promise(r=>{const h=(ev)=>{const m=JSON.parse(ev.data);if(m.method==='Page.loadEventFired'){ws.removeEventListener('message',h);r();}};ws.addEventListener('message',h);});
await send('Page.navigate',{url:process.argv[2]});await loaded;await new Promise(r=>setTimeout(r,800));
const out=await send('Runtime.evaluate',{expression:`(() => {
 const s=document.querySelector('.list-table'); const t=s.querySelector('app-data-table'); const tbl=t.querySelector('table');
 const cs=getComputedStyle(t); const card=s.closest('app-card'); const inner=document.querySelector('.content-inner');
 return { sClient:s.clientWidth, sScroll:s.scrollWidth, tWidth:t.getBoundingClientRect().width, tMin:cs.minWidth, tableWidth:tbl.getBoundingClientRect().width, cardWidth:card?.getBoundingClientRect().width, innerWidth:inner.getBoundingClientRect().width, contentWidth:document.querySelector('.content').getBoundingClientRect().width };
})()`,returnByValue:true});
console.log(JSON.stringify(out.result.value,null,2));
ws.close();chrome.kill('SIGTERM');process.exit(0);
