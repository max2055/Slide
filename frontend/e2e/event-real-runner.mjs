import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import mysql from '../../apps/db-ops-api/node_modules/mysql2/promise.js';
import bcrypt from '../../apps/db-ops-api/node_modules/bcrypt/bcrypt.js';
const profile = JSON.parse(readFileSync(process.env.EVENT_TEST_PROFILES, 'utf8'))['mysql-test'];
const schema = `slide_max584_${process.pid}`;
const dir = 'outputs/max584-real-runtime'; mkdirSync(dir, { recursive: true });
const env = { ...process.env, EVENT_REAL_TEST: '1', DB_HOST: profile.host, DB_PORT: String(profile.port), DB_USER: profile.user || profile.username, DB_PASSWORD: profile.password, DB_NAME: schema,
 ENCRYPTION_KEY: randomBytes(32).toString('hex'), JWT_SECRET_KEY: randomBytes(32).toString('hex'), INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: randomBytes(20).toString('hex'),
 PORT: '3584', AGENT_WS_PORT: '29584', PROMPT_HOT_RELOAD: 'false', VITE_API_PROXY_TARGET: 'http://127.0.0.1:3584' };
const children = [];
const start = (args, cwd, log) => { const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', openSync(`${dir}/${log}`, 'a'), openSync(`${dir}/${log}`, 'a')] }); children.push(child); return child; };
const wait = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`child exit ${code}`))); });
let db;
try {
 db = await mysql.createConnection({host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD});
 await wait(start(['--import', 'tsx', 'init-db.ts'], 'apps/db-ops-api', 'init.log'));
 await db.query(`USE ${schema}`);
 await db.execute("UPDATE users SET password_hash=? WHERE username='admin'",[await bcrypt.hash(env.INITIAL_ADMIN_PASSWORD,12)]);
 await db.query("INSERT INTO database_instances(name,host,port,username,password_encrypted,status) VALUES('max584','127.0.0.1',1,'fixture','unused','inactive')");
 for(let i=1;i<=55;i++) await db.execute('INSERT INTO alert_events(event_id,title,severity,status,instance_id,created_at) VALUES(?,?,?,?,1,DATE_ADD(NOW(),INTERVAL ? SECOND))', [`max584-${i}`, `验收事件${i}`, i===55?'critical':'warning','open',i]);
 await wait(start(['--import','tsx','../../scripts/qualification/configure-cancellable-provider.ts'], 'apps/db-ops-api', 'provider.log'));
 const api = start(['--import','tsx','server.ts'], 'apps/db-ops-api','api.log');
 writeFileSync(`${dir}/ownership.json`,JSON.stringify({task:'MAX-584',schema,apiPid:api.pid,port:3584,cwd:process.cwd(),logs:dir}));
 let ready=false;
 for(let i=0;i<90;i++){if(api.exitCode!==null)throw Error('API exited before readiness');try{if((await fetch('http://127.0.0.1:3584/api/health/ready')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,500));}
 if(!ready)throw Error('API readiness timeout');
 await wait(start(['frontend/node_modules/@playwright/test/cli.js','test','--config','frontend/playwright.event-real.config.ts'], '.', 'browser.log'));
 console.log('real application acceptance passed');
} catch(e) { console.error(e.message); process.exitCode=1; }
finally {
 for(const child of children.reverse()) if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,8000))]);}
 if(db){await db.query(`DROP DATABASE IF EXISTS ${schema}`);await db.end();console.log('task schema cleaned');}
}
