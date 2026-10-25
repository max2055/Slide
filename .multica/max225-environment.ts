import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(new URL('../apps/db-ops-api/package.json',import.meta.url));
const mysql=require('mysql2/promise');
const env=require('dotenv').parse(readFileSync('/Users/max/Coding/40-Slide/apps/db-ops-api/.env'));
const pool=mysql.createPool({host:env.DB_HOST,port:Number(env.DB_PORT??3306),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME});
try {
 for (const table of ['servers','database_instances','network_devices','llm_providers']) {
  const [rows]=await pool.query(`SELECT * FROM ${table} LIMIT 20`);
  console.log(JSON.stringify({table,rows:rows.map((r:any)=>({id:r.id,name:r.label??r.name,status:r.status,collectionEnabled:r.collection_enabled,enabled:r.enabled,hasCredential:!!r.credential_encrypted,providerType:r.provider_type,model:r.default_model}))}));
 }
 const [rows]=await pool.query("SELECT config_key, config_value FROM system_config WHERE config_key='auto_analysis_config'");console.log(JSON.stringify(rows));
} catch(e) {console.log(JSON.stringify({error:(e as any).code}));process.exitCode=1;} finally {await pool.end();}
