import {writeFile} from 'node:fs/promises';
import ssh from './src/ssh-session-pool.js';
import {diagnosticCommands} from './src/server-diagnostic-service.js';
import {parseJournalJson} from './src/linux-host-evidence-service.js';

if(process.env.MAX175_SYSTEMD_TARGET!=='1' || !process.env.MAX175_TEST_HOST || !process.env.MAX175_TEST_PASSWORD || !process.env.MAX175_TEST_FINGERPRINT || !process.env.MAX175_OUTPUT_DIR)throw new Error('EXPLICIT_MAX175_TEST_HOST_REQUIRED');
const calls:unknown[]=[];
try {
  const client=await ssh.getConnection(process.env.MAX175_TEST_HOST,22,'root','password',process.env.MAX175_TEST_PASSWORD,process.env.MAX175_TEST_FINGERPRINT);
  const command=diagnosticCommands().find(c=>c.includes('journalctl'))!;
  // The single-line read proves real metadata preservation with small output.
  // It is a probe only; the production diagnostic profile remains 200 lines.
  for(const [kind,cmd] of [['production-profile',command],['small-output-probe',command.replace('--lines=200','--lines=1')]]) {
    try {
      const [result]=await ssh.execCommands(client,[cmd],{timeoutMs:15_000,maxOutputBytes:128*1024});
      const parsed=parseJournalJson(result.stdout);
      calls.push({kind,command:cmd,exitCode:result.exitCode,bytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),
        parsed:{count:parsed.entries.length,malformedLines:parsed.malformedLines,truncated:parsed.truncated,
          firstTimestamp:parsed.entries[0]?.timestamp,lastTimestamp:parsed.entries.at(-1)?.timestamp,
          allTimestampsPresent:parsed.entries.every(e=>!!e.timestamp),severities:[...new Set(parsed.entries.map(e=>e.severity))]}});
    }catch(error:any){calls.push({kind,error:error.message});}
  }
}finally {
  ssh.closeAll();
  await writeFile(`${process.env.MAX175_OUTPUT_DIR}/journal-probe.json`,JSON.stringify({calls,
    qualification:'Real pinned production SSH and parser only; no database/service/HTTP/page qualification. Small single-line probe is not the production profile.',
    sourceHead:process.env.MAX175_SOURCE_HEAD,remoteMutation:false},null,2));
}
