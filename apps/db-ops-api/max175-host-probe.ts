import mysql from 'mysql2/promise';
import { writeFile } from 'node:fs/promises';
import { dbConnection, encryptData } from './src/db-connection.js';
import ssh from './src/ssh-session-pool.js';
import { ServerDiagnosticService } from './src/server-diagnostic-service.js';
import { serverDatabaseService } from './src/server-database-service.js';

if(process.env.MAX175_SYSTEMD_TARGET!=='1' || !process.env.MAX175_TEST_HOST || !process.env.MAX175_TEST_PASSWORD || !process.env.MAX175_TEST_FINGERPRINT) {
  throw new Error('EXPLICIT_MAX175_TEST_HOST_REQUIRED');
}
const schema = `db_ops_ai_qualification_max175_probe_${process.pid}`;
let admin: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
for (let attempt=0;attempt<30;attempt++) {
  try { admin=await mysql.createConnection({host:'127.0.0.1',port:33175,user:'root'}); break; }
  catch { if(attempt===29)throw new Error('TASK_MYSQL_NOT_READY'); await new Promise(ok=>setTimeout(ok,500)); }
}
const calls: unknown[] = [], report: any = {calls};
try {
  await admin!.query(`CREATE DATABASE ${schema}`);
  await dbConnection.initialize({host:'127.0.0.1',port:33175,user:'root',password:'',database:schema});
  const p=dbConnection.getPool()!;
  await p.query('CREATE TABLE servers(id INT PRIMARY KEY,host VARCHAR(255),port INT,label VARCHAR(255),os_type VARCHAR(50),credential_type VARCHAR(20),credential_encrypted TEXT,host_key_fingerprint VARCHAR(255),status VARCHAR(20),last_check_at DATETIME NULL,collection_enabled INT,created_at DATETIME,updated_at DATETIME)');
  await p.query("INSERT INTO servers VALUES(1,?,22,'MAX175 probe','kylin','password',?,?,'offline',NULL,0,NOW(),NOW())",[process.env.MAX175_TEST_HOST,encryptData(JSON.stringify({username:'root',password:process.env.MAX175_TEST_PASSWORD})),process.env.MAX175_TEST_FINGERPRINT]);
  const service=new ServerDiagnosticService({serverDatabaseService,sshSessionPool:{
    getConnection:(...a)=>ssh.getConnection(...a),releaseConnection:c=>ssh.releaseConnection(c),closeConnection:c=>ssh.closeConnection(c),
    execCommands:async(c,commands,options)=>{
      try {
        const rows=await ssh.execCommands(c,commands,options);
        calls.push({commands,options,results:rows.map(r=>({exitCode:r.exitCode,stdoutBytes:Buffer.byteLength(r.stdout),stderrBytes:Buffer.byteLength(r.stderr),truncated:r.truncated}))});
        return rows;
      } catch(error:any) {calls.push({commands,options,error:error.message});throw error;}
    },
  }});
  const result=await service.collectDiagnostics(1);
  report.result={quality:result.quality,sections:Object.fromEntries(Object.entries(result.sections).map(([k,v])=>[k,{quality:v.quality,count:v.items.length,reason:v.reason}]))};
} catch(error:any) {report.error={message:error.message,code:error.code,stack:error.stack};}
finally {
  ssh.closeAll();await dbConnection.close();await admin!.query(`DROP DATABASE IF EXISTS ${schema}`);await admin!.end();
  report.cleanup=true;await writeFile(`${process.env.MAX175_OUTPUT_DIR}/service-probe.json`,JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report,null,2));
