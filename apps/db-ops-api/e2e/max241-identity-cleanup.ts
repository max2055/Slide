import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import mysql from 'mysql2/promise';
import {dropOwnedDatabase} from '../src/testing/owned-fixture.js';
const directory=resolve(process.argv[2]),handle=JSON.parse(readFileSync(directory+'/lifecycle.json','utf8'));
if(!handle.port||handle.port===3306)throw Error('owned non3306 port required');
const root=await mysql.createConnection({host:'127.0.0.1',port:handle.port,user:'root',password:''});
try{await dropOwnedDatabase(root as any,{nonce:handle.nonce,purpose:'identity',handleDir:directory});}finally{await root.end();}
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8'}).trim();
if(docker('inspect','--format','{{index .Config.Labels "slide.max241.nonce"}}',handle.container)!==handle.nonce)throw Error('owner mismatch');
docker('stop',handle.container);
writeFileSync(directory+'/recovery.json',JSON.stringify({failure:'fixture used unsupported disabled enum; original child terminated after pending HTTP prevented close',cleanup:'verified owned schema dropped; nonce-matching container stopped; exact child stopped'},null,2));
