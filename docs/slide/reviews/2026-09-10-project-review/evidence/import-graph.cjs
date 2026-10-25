const fs = require('fs'), path = require('path'), cp = require('child_process');
const root=process.cwd();
const ts=require(path.join(root,'frontend/node_modules/typescript'));
const paths=cp.execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split('\n').filter(p=>/\.(ts|js|mjs)$/.test(p)&&!/(\.test\.|\.spec\.|\/tests\/|\/e2e\/)/.test(p)&&fs.existsSync(p));
const set=new Set(paths), graph={};
function resolve(from,s){
 let p=s==='@slide/agent-core'?'packages/agent-core/src/index.ts':s.startsWith('.')?path.normalize(path.join(path.dirname(from),s)):null;
 if(!p)return null;
 return [p,p.replace(/\.js$/,'.ts'),p+'.ts',p+'/index.ts'].find(x=>set.has(x));
}
for(const p of paths){const src=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true);let edges=[];
 function walk(n){let s;if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))s=n.moduleSpecifier.text;
 if(ts.isCallExpression(n)&&n.arguments.length&&ts.isStringLiteral(n.arguments[0])&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(src)==='require'))s=n.arguments[0].text;
 if(s){let to=resolve(p,s);if(to)edges.push(to);}ts.forEachChild(n,walk);}walk(src);graph[p]=edges;
}
function reachable(entries){const seen=new Set();function visit(p){if(seen.has(p))return;seen.add(p);for(const e of graph[p]||[])visit(e);}entries.forEach(visit);return seen;}
for(const [prefix,entry] of [['frontend/src/','frontend/src/main.ts'],['apps/db-ops-api/src/','apps/db-ops-api/server.ts']]){
 const seen=reachable([entry]);const candidates=paths.filter(p=>p.startsWith(prefix)&&!seen.has(p)&&!p.endsWith('.d.ts'));
 console.log(prefix,'reachable', [...seen].filter(p=>p.startsWith(prefix)).length,'candidates',candidates.length);for(const p of candidates)console.log(p);
}
fs.writeFileSync('/tmp/slide-project-review-20260910/import-graph.json',JSON.stringify(graph,null,2));
