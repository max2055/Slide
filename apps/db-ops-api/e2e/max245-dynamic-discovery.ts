/** Own disposable Linux namespace and MySQL schema. SSH is a controlled ssh2 endpoint
 * executing only the registered fixed command inside our labelled Linux container.
 * Faults are injected at that endpoint / a transparent TCP proxy, never in the collector. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import mysql from 'mysql2/promise';
import { encryptData } from '../src/db-connection.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { databaseService } from '../src/database-service.js';
import sshSessionPool from '../src/ssh-session-pool.js';
import { actorContextService } from '../src/auth/actor-context.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { FILESYSTEM_DISCOVERY_COMMAND } from '../src/metrics/packages/filesystem-discovery.js';
import { HOST_INTERFACE_SNAPSHOT_COMMAND } from '../src/metrics/config/host-interface-counter.js';

export async function runDynamicDiscovery(ctx:any) {
  const {pool,root,port,host,page,api,request,worker,jobs,directory,nonce,passed,evidence,expect,readerToken}=ctx;
  const docker=(...a:string[])=>execFileSync('docker',a,{encoding:'utf8',timeout:20000}).trim();
  const sockets=new Set<any>();let container='',ssh:InstanceType<typeof Server>|undefined,proxy:ReturnType<typeof createServer>|undefined,fsProxy:ReturnType<typeof createServer>|undefined,owned:any,target:mysql.Pool|undefined;
  const record:any={configured_os:'CentOS metadata selects the registered Linux family; kernel command fixture runs in Alpine, not a CentOS distribution certification',boundary:'controlled real SSH protocol → fixed command in own Linux namespace; native MySQL 8.4 protocol to own schema via fault proxy',checks:[],tasks:[],cleanup:false};
  let sshFault='',sqlFault='',commands=0,queries=0;
  const log=(s:string)=>{record.checks.push(s);passed(s);};
  try {
    owned=await createOwnedDatabase(root,{nonce,purpose:'dynamic',handleDir:directory});
    target=mysql.createPool({host:'127.0.0.1',port,user:'root',password:'',database:owned.database});
    await target.query('CREATE TABLE before_name(id BIGINT PRIMARY KEY, v INT) ENGINE=InnoDB');
    container=docker('run','-d','--rm','--cap-add','NET_ADMIN','--cap-add','SYS_ADMIN','--label',`slide.max245.dynamic=${nonce}`,'python@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0','sh','-c','unshare -n sleep 3600 & echo $! > /tmp/hidden.pid; exec sleep 3600');
    assert.equal(docker('inspect','--format','{{.HostConfig.NetworkMode}}',container),'bridge');record.container={id:container,network_mode:'bridge',label:nonce};
    const linux=(command:string)=>{assert.equal(docker('inspect','--format','{{index .Config.Labels "slide.max245.dynamic"}}',container),nonce);return execFileSync('docker',['exec',container,'sh','-c',command],{encoding:'utf8',timeout:10000});};
    linux('mkdir -p /mnt/before /mnt/renamed; mount -t tmpfs slide-fixture /mnt/before; dd if=/dev/zero of=/mnt/before/allocated bs=4096 count=2');
    linux('ip tunnel add before0 mode gre remote 192.0.2.1 local 192.0.2.2 && ip link set before0 up');
    const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'}),password=randomBytes(24).toString('hex');
    // Fingerprint the SSH wire public key, using the same representation as ssh2 hostVerifier.
    const parsed:any=utils.parseKey(key);assert(!(parsed instanceof Error));
    const pin='SHA256:'+createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/,'');
    ssh=new Server({hostKeys:[key]},client=>{sockets.add(client);client.on('error',()=>{}).on('close',()=>sockets.delete(client));
      client.on('authentication',c=>c.method==='password'&&c.username==='fixture'&&c.password===password?c.accept():c.reject());
      client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,reject,info)=>{
        if(![HOST_INTERFACE_SNAPSHOT_COMMAND,FILESYSTEM_DISCOVERY_COMMAND].includes(info.command))return reject();commands++;const stream=accept();if(sshFault==='timeout')return;
        try {let stdout=linux(info.command);if(sshFault==='truncate')stdout=stdout.slice(0,Math.floor(stdout.length/2));stream.write(stdout);stream.exit(0);stream.end();}
        catch{stream.stderr.write('controlled fixed command failed');stream.exit(1);stream.end();}
      })));});
    ssh.listen(0,host);await once(ssh,'listening');const sshPort=(ssh.address() as any).port;
    fsProxy=createServer(c=>{const u=connect({host,port:sshPort});sockets.add(c);sockets.add(u);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.pipe(u).pipe(c);});fsProxy.listen(0,host);await once(fsProxy,'listening');const fsPort=(fsProxy.address() as any).port;
    proxy=createServer(client=>{const upstream=connect({host:'127.0.0.1',port});sockets.add(client);sockets.add(upstream);
      const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
      client.on('data',chunk=>{if(chunk.includes(Buffer.from('INNODB_TABLES'))){queries++;if(sqlFault==='truncate'){client.write(Buffer.from([10,0,0,1,1]));close();return;}if(sqlFault==='timeout')return;}upstream.write(chunk);});upstream.on('data',chunk=>client.write(chunk));
    });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const sqlPort=(proxy.address() as any).port;assert.notEqual(sqlPort,3306);
    await pool.query("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('instance:*','测试实例权限','instance','*')");
    await pool.query("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('instance:*','servers:manage','servers:view')");
    await pool.query("INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint) VALUES(711,?,?,'动态Linux','CentOS','password',?,?)",[host,sshPort,encryptData(JSON.stringify({username:'fixture',password})),pin]);
    await pool.query("INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint) VALUES(712,?,?,'动态文件系统','CentOS','password',?,?)",[host,fsPort,encryptData(JSON.stringify({username:'fixture',password})),pin]);
    await pool.query("INSERT INTO database_instances(id,name,db_type,host,port,username,password_encrypted,database_name,db_version) VALUES(711,'动态MySQL','mysql','127.0.0.1',?,'root',?,?, '8.4')",[sqlPort,encryptData(''),owned.database]);
    assert(await databaseService.addConnection(711,'dynamic',{host:'127.0.0.1',port:sqlPort,user:'root',password:'',database:owned.database,db_type:'mysql'}));
    const access=await(await import('../src/metrics/config/access.js')).createAssetCollectorAccess().resolve({type:'server',id:711});
    const transport=await access.resolve(access.credential_ref,access.resource,'ssh');
    const diagnostic=await access.evidence.host_interfaces!.read(transport as any,5000);record.kernel=diagnostic;
    const registry=createConfigurationRegistry(),repo=new MySqlTemplateRepository(pool),templates=new MetricTemplateService(repo,registry),actor=await actorContextService.loadActiveActor(701);
    for(const kind of ['ssh','sql','fs']) {
      const isFs=kind==='fs',isSsh=kind!=='sql';
      const resource={type:isSsh?'server':'instance',id:isFs?712:711},key=`${resource.type}:${resource.id}`,name=`MAX245 动态${kind}`,metric=isFs?'linux.filesystem.discovered_used_bytes':kind==='ssh'?'linux.network.interface.present':'mysql.innodb.table.internal_columns';
      const pkg=registry.list().find(r=>r.package.id===(isFs?'linux-filesystem-discovery':kind==='ssh'?'linux-interface-discovery':'mysql-innodb-discovery'))!.package;
      const t=await templates.create(actor,{name}),id=t.template_id;
      const selected=await templates.selectMetric(actor,id,{package:{id:pkg.id,version:pkg.version,digest:pkg.digest},metric:{id:metric,semantic_version:'1.0.0'}});
      const d=(await repo.getDraft(id))!;d.aggregate.items=[{item_id:selected.item.item_id,version:1}];await templates.updateDraft(actor,id,{expected_draft_revision:d.revision,aggregate:d.aggregate});
      const initial=await templates.publish(actor,id,{expected_revision:0,expected_draft_revision:1});
      await api('POST',`/api/metrics/templates/${id}/triggers`,{expected_version:initial.version,expected_content_hash:initial.content_hash,item_id:selected.item.item_id,parameters:{schema:{},defaults:{}},
        problem:{node:'compare',select:{aggregation:'last'},operator:'>=',threshold:{kind:'constant',value:1}},recovery:{node:'compare',select:{aggregation:'last'},operator:'<',threshold:{kind:'constant',value:1}},
        quality:{accepted_quality:['good'],min_coverage:1,allow_estimated:false},clock:{stale_after_ms:1000,nodata:{enabled:true,after_ms:300000}}});
      await page.goto(new URL('/e2e/fixtures/max237-template-library.html',page.url()).href);await page.locator(`[data-template-id="${id}"]`).click();
      await page.getByRole('combobox',{name:'发现监控项原型',exact:true}).selectOption(selected.item.item_id);
      await page.getByRole('spinbutton',{name:'发现实例上限'}).fill('30');
      await page.getByRole('spinbutton',{name:'失联后禁用秒数'}).fill('1');await page.getByRole('spinbutton',{name:'失联后退役秒数'}).fill('3');
      await page.getByRole('button',{name:'添加发现规则到草稿',exact:true}).click();await page.getByRole('button',{name:'保存草稿',exact:true}).click();
      await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();await page.getByRole('button',{name:'发布不可变版本',exact:true}).click();
      await expect(page.getByRole('status').filter({hasText:'已发布不可变版本'})).toBeVisible();
      const version=(await api('GET',`/api/metrics/templates/${id}/editor`)).current;
      assert.deepEqual(version.aggregate.discovery_rules[0].identity_dimensions,[isFs?'filesystem_epoch':kind==='ssh'?'interface_epoch':'table_epoch']);
      await page.getByRole('combobox',{name:'发现授权资源',exact:true}).selectOption(key);
      const received=page.waitForResponse((r:any)=>r.url().endsWith('/discovery-preview')&&r.request().method()==='POST');
      await page.getByRole('button',{name:'只读枚举预览',exact:true}).click();const previewResult=await(await received).json();record.previews??=[];record.previews.push({kind,result:previewResult,commands,queries});console.log('DYNAMIC_PREVIEW',kind,previewResult.state);await expect(page.getByText('只读枚举完成；此结果不代表正式生效',{exact:true})).toBeVisible();
      const previewUrl=`/api/metrics/templates/${id}/discovery-preview`,preview={resource,version:version.version,operation_key:`dynamic-${kind}-repeat`};
      await api('POST',previewUrl,preview);const count=isSsh?commands:queries;await api('POST',previewUrl,preview);assert.equal(isSsh?commands:queries,count);
      assert.equal((await request('POST',previewUrl,preview,readerToken)).status,403);
      await page.getByRole('checkbox',{name:`选择模板 ${name}`,exact:true}).check();await page.getByRole('switch',{name:'启用此对象采集',exact:true}).check();
      await page.getByRole('button',{name:'检查配置',exact:true}).click();await expect(page.getByRole('button',{name:'试采',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'试采',exact:true}).click();await expect(page.getByText('试采通过',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'首次绑定并启用',exact:true}).click();await expect(page.getByRole('button',{name:'立即采集',exact:true})).toBeEnabled();
      const base=`/api/metrics/template-bindings/${resource.type}/${resource.id}`,stateUrl=`/api/metrics/discovery/${resource.type}/${resource.id}`;
      const state=()=>api('GET',stateUrl);
      const collect=async(step:string,expected:any='completed')=>{const caller_key=`dynamic-${kind}-${step}`;await api('POST',base+'/collect',{caller_key,expected_revision:1});
        for(let i=0;i<40;i++){await worker.runOnce((j:any,c:any)=>jobs.execute(j,c),Date.now());const task=await api('GET',base+'/collect/'+caller_key);
          if(['completed','failed','unknown'].includes(task.state)){assert((Array.isArray(expected)?expected:[expected]).includes(task.state),JSON.stringify(task));record.tasks.push({kind,step,task,state:await state()});return task;}await new Promise(r=>setTimeout(r,100));}throw Error('dynamic collect deadline');};
      await collect('first');let s=await state();let member=s.rows[0].state.members.find((m:any)=>m.name===(isFs?'/mnt/before':kind==='ssh'?'before0':owned.database+'/before_name'));assert(member);const original=member.id, originalDimensions=structuredClone(member.dimensions);
      const [eventsBefore]=await pool.query('SELECT event_id FROM metric_trigger_episodes WHERE resource_key=?',[key]);
      await collect('repeat');assert.equal((await state()).rows[0].state.members.filter((m:any)=>m.id===original).length,1);
      if(isFs)linux('mount --move /mnt/before /mnt/renamed');else if(kind==='ssh')linux('ip link set before0 name renamed0');else await target.query('RENAME TABLE before_name TO renamed_name');
      await collect('renamed');s=await state();member=s.rows[0].state.members.find((m:any)=>m.id===original);assert(member.name.endsWith(isFs?'/mnt/renamed':kind==='ssh'?'renamed0':'renamed_name'));assert.equal(member.dimension_history.length,2);
      const [eventsAfter]=await pool.query('SELECT event_id FROM metric_trigger_episodes WHERE resource_key=?',[key]);assert.deepEqual(eventsAfter,eventsBefore);
      for(const fault of ['truncate','timeout']) {
        const before=await state();if(isSsh)sshFault=fault;else sqlFault=fault;
        try {const result=await collect(fault,['failed','unknown']);assert.deepEqual(await state(),before);
          const reads=isSsh?commands:queries;const duplicate=await api('POST',base+'/collect',{caller_key:`dynamic-${kind}-${fault}`,expected_revision:1});
          assert.equal(duplicate.task.id,result.task.id);await worker.runOnce((j:any,c:any)=>jobs.execute(j,c),Date.now());assert.equal(isSsh?commands:queries,reads);}finally{sshFault='';sqlFault='';}
      }
      if(isFs)linux(`python3 -c 'import ctypes,time
c=ctypes.CDLL(None,use_errno=True)
fd=c.syscall(428,-100,b"/mnt/renamed",1)
assert fd>=0,ctypes.get_errno()
open("/tmp/fs-holder","w").write(str(fd))
while not __import__("os").path.exists("/tmp/fs-restore"): time.sleep(.05)
assert c.syscall(429,fd,b"",-100,b"/mnt/renamed",4)==0,ctypes.get_errno()
open("/tmp/fs-restored","w").write("ok")' >/tmp/fs-holder.log 2>&1 &`);else if(kind==='ssh')linux('ip link set renamed0 down; ip link set renamed0 name lo_hidden0');else await target.query('RENAME TABLE renamed_name TO outside_name');
      // Hide by moving the kernel link out of the namespace, or move the table out of the bound schema.
      // A physical deletion/recreation would prove a new lifetime, not reappearance.
      let other:any;
      if(isFs){linux('while [ ! -f /tmp/fs-holder ]; do sleep 0.05; done; umount -l /mnt/renamed');}else if(kind==='ssh')linux('ip link set lo_hidden0 netns $(cat /tmp/hidden.pid)');
      else {other=await createOwnedDatabase(root,{nonce,purpose:'hidden',handleDir:directory});await target.query(`RENAME TABLE outside_name TO \`${other.database}\`.outside_name`);}
      try {
        await collect('missing');assert.equal((await state()).rows[0].state.members.find((m:any)=>m.id===original).state,'waiting');
        if(isFs)linux('touch /tmp/fs-restore; for n in 1 2 3 4 5 6 7 8 9 10; do [ -f /tmp/fs-restored ] && exit 0; sleep 0.1; done; cat /tmp/fs-holder.log; exit 1');else if(kind==='ssh') {linux('nsenter -t $(cat /tmp/hidden.pid) -n ip link set lo_hidden0 netns 1; ip link set lo_hidden0 name renamed0');}
        else await target.query(`RENAME TABLE \`${other.database}\`.outside_name TO renamed_name`);
        await collect('returned');s=await state();
        // Linux namespace movement can assign a new ifindex: that is a distinct kernel identity, never forced into the old one.
        assert.equal(s.rows[0].state.members.find((m:any)=>m.id===original).state,'active');
        if(isFs)linux('umount /mnt/renamed');else if(kind==='ssh')linux('ip tunnel del renamed0');else await target.query('DROP TABLE renamed_name');
        await collect('lost');await new Promise(r=>setTimeout(r,1100));await collect('disabled');await new Promise(r=>setTimeout(r,2100));await collect('retired');
        assert.equal((await state()).rows[0].state.members.find((m:any)=>m.id===original).state,'retired');
        if(isFs)linux('mount -t tmpfs slide-recreated /mnt/renamed; dd if=/dev/zero of=/mnt/renamed/allocated bs=4096 count=2');else if(kind==='ssh')linux('ip tunnel add renamed0 mode gre remote 192.0.2.1 local 192.0.2.2');else await target.query('CREATE TABLE renamed_name(id BIGINT PRIMARY KEY) ENGINE=InnoDB');
        await collect('reused');s=await state();assert(s.rows[0].state.members.some((m:any)=>m.id!==original&&m.name.endsWith(isFs?'/mnt/renamed':kind==='ssh'?'renamed0':'renamed_name')));
      }finally{if(other)await other.drop();}
      const row=s.rows[0],active=row.state.members.find((m:any)=>m.id!==original&&m.state==='active');assert(active);
      const lock=await pool.getConnection();await lock.beginTransaction();await lock.query('SELECT payload FROM metric_policy_bindings WHERE resource_key=? FOR UPDATE',[key]);
      const stop={expected_revision:row.revision,template_id:id,rule_id:row.rule_id,instance_id:active.id,action:'disabled'};
      const pending=request('POST',stateUrl+'/stop',stop);await new Promise(r=>setTimeout(r,100));
      await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=701 AND p.code='metric:manage'");await lock.commit();lock.release();assert.equal((await pending).status,403);
      await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='metric:manage'");
      await api('POST',stateUrl+'/stop',stop);await api('POST',stateUrl+'/stop',stop);await collect('manual-stop');assert.equal((await state()).rows[0].state.members.find((m:any)=>m.id===active.id).state,'disabled');
      const [stillOpen]=await pool.query<any[]>('SELECT payload FROM metric_trigger_episodes WHERE resource_key=?',[key]);
      assert(stillOpen.every(v=>(typeof v.payload==='string'?JSON.parse(v.payload):v.payload).state==='open'));
      const [audit]=await pool.query<any[]>('SELECT COUNT(*) AS n FROM metric_discovery_audit WHERE resource_key=?',[key]);assert(audit[0].n>5);record[kind]={audit_count:audit[0].n,event_count:stillOpen.length,retired_id:original,history_dimensions:originalDimensions};
      const window={resource,from:new Date(evidence.started-60000).toISOString(),to:new Date().toISOString()};
      const history=await api('POST','/api/metrics/study/catalog',window);assert(history.metrics.some((v:any)=>v.metric.id===metric));
      const series={metric:{id:metric,semantic_version:'1.0.0'},dimensions:originalDimensions};const trend=await api('POST','/api/metrics/study/trend',{...window,metric:series.metric,dimensions:series.dimensions,tier:'5m'});assert(trend.buckets.some((b:any)=>b.count>0));
      await page.getByRole('button',{name:'刷新生命周期',exact:true}).click();await expect(page.locator('template-discovery')).toContainText('已退役');
      for(const [width,height] of [[1440,900],[1366,768],[1920,1080]]){await page.setViewportSize({width,height});await page.locator('template-discovery').getByText('已退役',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,`dynamic-${kind}-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
      await page.getByRole('button',{name:'刷新生命周期',exact:true}).focus();await page.keyboard.press('Tab');
      const focus=await page.evaluate(()=>{let e:any=document.activeElement;while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;return {tag:e?.tagName,name:e?.getAttribute('aria-label')||e?.textContent?.trim()?.slice(0,80)};});assert(['BUTTON','INPUT','SELECT','A'].includes(focus.tag));record[kind].focus=focus;
      log(`${kind} real protocol + Lit fixed template/trigger, budget/idempotent preview, formal writer/history, rename identity and sole events, unknown timeout/truncation no retirement, disappearance/reuse/retirement and manual disable with lock-wait revocation; retained history/trend readable`);
    }
    record.commands=commands;record.queries=queries;
    if(process.env.MAX245_INTEGRATED_CAPACITY==='1')await(await import('./max245-integrated-capacity.js')).integratedCapacity(ctx,sqlPort,owned.database);
  } finally {
    sshSessionPool.closeAll();await databaseService.removeConnection(711);for(const s of sockets)s.destroy?.();
    if(ssh)await new Promise<void>(r=>ssh!.close(()=>r()));if(proxy)await new Promise<void>(r=>proxy!.close(()=>r()));if(fsProxy)await new Promise<void>(r=>fsProxy!.close(()=>r()));await target?.end();if(owned)await owned.drop();
    if(container){assert.equal(docker('inspect','--format','{{index .Config.Labels "slide.max245.dynamic"}}',container),nonce);docker('stop','--time','5',container);}
    record.cleanup=true;writeFileSync(join(directory,'dynamic-discovery.json'),JSON.stringify(record,null,2));
  }
}
