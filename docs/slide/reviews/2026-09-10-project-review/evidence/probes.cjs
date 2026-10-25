const fs=require('fs'), path=require('path'), {createRequire}=require('module'), {pathToFileURL}=require('url');
const root=process.cwd(), req=createRequire(root+'/frontend/package.json'), ts=req('typescript');
const out='/tmp/slide-project-review-20260910';
function transpile(source){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,experimentalDecorators:true,useDefineForClassFields:false}}).outputText;}
function noImports(file){const src=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);return src.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(src)).join('\n');}
(async()=>{
 const {JSDOM}=req('jsdom');const dom=new JSDOM('<button id="trigger">Open</button>',{url:'http://localhost',pretendToBeVisual:true});
 for(const key of ['window','document','customElements','HTMLElement','Element','Node','Document','CSSStyleSheet','ShadowRoot','CustomEvent','Event'])globalThis[key]=dom.window[key];
 let raf=[];globalThis.requestAnimationFrame=cb=>raf.push(cb);
 let dialogCode=transpile(fs.readFileSync(root+'/frontend/src/app/ui/components/app-dialog.ts','utf8')).replaceAll('from "lit"',`from ${JSON.stringify(pathToFileURL(req.resolve('lit')).href)}`).replaceAll('from "lit/decorators.js"',`from ${JSON.stringify(pathToFileURL(req.resolve('lit/decorators.js')).href)}`);
 fs.writeFileSync(out+'/dialog.mjs',dialogCode);await import(pathToFileURL(out+'/dialog.mjs').href);
 const trigger=document.getElementById('trigger');trigger.focus();const dialog=document.createElement('app-dialog');document.body.append(dialog);dialog.open=true;await dialog.updateComplete;raf.forEach(cb=>cb());
 console.log('dialog',JSON.stringify({hasShadowDialog:!!dialog.shadowRoot.querySelector('[role="dialog"]'),lightQueryFound:!!dialog.querySelector('[role="dialog"]'),focusRemainsOnTrigger:document.activeElement===trigger}));
 const bridgeCode=transpile(noImports(root+'/apps/db-ops-api/src/ai-agent-bridge.ts')).replace(/^export /gm,'');
 const unhandled=[];process.on('unhandledRejection',err=>unhandled.push(err.message));let failures=0;
 const db={findRecentCompleted:async()=>null,createAnalysis:async()=>({success:true,analysisId:1}),getAnalysisById:async()=>{throw new Error('PROBE_DATABASE_UNAVAILABLE')},failAnalysis:async()=>{failures++},waitForCompletion:async()=>null};
 const dispatch=new Function('aiAnalysisDatabaseService','getAgentEngine','promptManager',bridgeCode+'\nreturn dispatchOrReuse;')(db,async()=>({invoke:async()=>({stopReason:'completed'})}),{getPrompt:()=>null});
 await dispatch({type:'alert_rca',cacheKey:'probe',instanceId:1,sessionKey:'probe',userMessage:'probe'});await new Promise(r=>setTimeout(r,20));
 console.log('bridge',JSON.stringify({unhandledRejections:unhandled,outerCatchRecordedFailures:failures}));
 const providerFile=root+'/apps/db-ops-api/src/adapter/get-agent-engine.ts';const src=ts.createSourceFile(providerFile,fs.readFileSync(providerFile,'utf8'),ts.ScriptTarget.Latest,true);let fn=src.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='createLLMProvider').getText(src);
 fn=transpile(fn).replace(/^export /gm,'').replace(/await import\([^)]*\)/g,'fixtures');
 let enabled=true;const fixtures={llmDatabaseService:{getEnabledProviders:async()=>enabled?[{name:'probe',display_name:'probe',api_base_url:'https://approved-proxy.invalid',api_format:'anthropic-messages',default_model:'probe-model'}]:[],getProviderApiKey:async()=> 'dummy-probe-not-a-secret'},AnthropicProvider:class {constructor(...args){this.args=args;this.key=process.env.ANTHROPIC_API_KEY;}}};
 delete process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_MODEL;
 const create=new Function('fixtures',fn+'\nreturn createLLMProvider;')(fixtures);const first=await create();enabled=false;const fallback=await create();
 console.log('provider',JSON.stringify({constructorReceivedBaseUrl:first.args.includes('https://approved-proxy.invalid'),envWasMutated:process.env.ANTHROPIC_MODEL==='probe-model',disabledProviderKeyReused:fallback.key==='dummy-probe-not-a-secret'}));
 dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1});
