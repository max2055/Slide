const fs=require('fs'),path=require('path');const ts=require(process.cwd()+'/frontend/node_modules/typescript');
function body(file){const s=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);return s.statements.filter(n=>!ts.isImportDeclaration(n)).map(n=>n.getText(s)).join('\n');}
function js(s){return ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace(/^export /gm,'');}
(async()=>{
 let state='running',now=0,sql='';
 const pool={execute:async query=>{sql=query;if(query.includes("status = 'failed'"))state='failed';return [{affectedRows:1}];}};
 const code=js(body('apps/db-ops-api/src/ai-analysis-database-service.ts'));
 const service=new Function('dbConnection','validateAnalysisEnvelope','Date','setTimeout',code+'\nreturn aiAnalysisDatabaseService;')({getPool:()=>pool},()=>({ok:false}),{now:()=>now},cb=>{state='completed';now=2001;cb();});
 service.getAnalysisById=async()=>({status:state});const result=await service.waitForCompletion(1,1);
 console.log(JSON.stringify({scenario:'completion between last poll and timeout write',finalState:result.status,failedUpdateGuardsPreviousState:/WHERE[^]*status/.test(sql)}));
 const file='packages/agent-core/src/runner.ts';const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='withTimeout').getText(ast);
 let retained=0;const timeout=new Function('setTimeout','clearTimeout','TimeoutError',js(fn)+'\nreturn withTimeout;')(()=>{retained++;return 1},()=>{retained--},Error);
 await timeout(Promise.resolve('done'),300);console.log(JSON.stringify({scenario:'successful model request',remainingTimeouts:retained}));
})().catch(e=>{console.error(e);process.exitCode=1});
