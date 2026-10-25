import {html} from 'lit';

export interface NativeMetricProfile {
 id:string; name:string; key:string; unit:string; method:string; implementation:string;
 outputs:Array<{field:string;value:string;unit:string}>;
 formula:string; result:string; dimensions:string; meaning:string; available:boolean;
}
const mysql:NativeMetricProfile[]=[
 {id:'mysql-connections',name:'连接使用率',key:'mysql.connections.usage',unit:'%',method:'SQL · MySQL 只读连接',implementation:'mysql.connections.snapshot · v1（设计样例）',outputs:[{field:'Threads_connected · SHOW GLOBAL STATUS',value:'924',unit:'个'},{field:'max_connections · @@GLOBAL.max_connections',value:'1000',unit:'个'}],formula:'Threads_connected ÷ max_connections × 100',result:'92.4',dimensions:'实例；无额外维度',meaning:'当前打开连接数占配置上限的比例，包含监控连接；两个来源须在同一允许时间窗口内有效。缺字段或上限为 0 时保持未知。',available:true},
 {id:'mysql-aborted-rate',name:'失败连接速率',key:'mysql.aborted_connects.rate',unit:'次/秒',method:'SQL · MySQL 只读连接',implementation:'mysql.status.counters · v1（设计样例）',outputs:[{field:'Aborted_connects · 10:41:08',value:'120',unit:'累计次'},{field:'Aborted_connects · 10:42:08',value:'132',unit:'累计次'},{field:'启动/重置证据',value:'同一连续计数周期',unit:'状态'}],formula:'(132 − 120) ÷ 实际间隔 60 秒；只计算一次速率',result:'0.2',dimensions:'实例；计数连续性单独记录',meaning:'首次采样、重启、计数回退或连续性不明时显示未知，不补 0。采集器保留累计值，由指定变换层计算速率。',available:true},
 {id:'mysql-dirty-unregistered',name:'缓冲池脏页比例 · 尚无注册实现',key:'mysql.buffer_pool.dirty_ratio',unit:'%',method:'待注册',implementation:'尚无注册采集实现',outputs:[],formula:'不生成计算结果',result:'—',dimensions:'待定义',meaning:'仅为能力缺口示例。输入名称不会创建采集能力，不能加入可发布模板。',available:false}
];
const linux:NativeMetricProfile[]=[
 {id:'linux-memory',name:'可用内存比例',key:'linux.memory.available.pct',unit:'%',method:'SSH · Linux 受控只读采集',implementation:'linux.meminfo.snapshot · v1（设计样例）',outputs:[{field:'/proc/meminfo · MemAvailable',value:'8388608',unit:'kB'},{field:'/proc/meminfo · MemTotal',value:'16777216',unit:'kB'}],formula:'统一 kB 到字节后 MemAvailable ÷ MemTotal × 100',result:'50.0',dimensions:'服务器；无额外维度',meaning:'可用内存口径为 MemAvailable，不用 MemFree 冒充。使用该服务器已有 SSH 凭据引用，不安装监控代理。',available:true},
 {id:'linux-load',name:'负载 1 分钟',key:'linux.load.avg1',unit:'无量纲',method:'SSH · Linux 受控只读采集',implementation:'linux.loadavg.snapshot · v1（设计样例）',outputs:[{field:'/proc/loadavg · 第一个字段',value:'1.24',unit:'无量纲'}],formula:'解析第一个字段，不转换成 CPU 百分比',result:'1.24',dimensions:'服务器；无额外维度',meaning:'系统一分钟平均负载，含义不同于 CPU 利用率；阈值需要结合核心数和业务条件。',available:true}
];
const network:NativeMetricProfile[]=[
 {id:'snmp-in',name:'接口入流量',key:'network.interface.in_bps',unit:'bit/s',method:'SNMP · GET / WALK',implementation:'snmp.interfaces.counters · v1（设计样例）',outputs:[{field:'ifHCInOctets.7 · 10:41:08',value:'1000000000',unit:'累计字节 uint64'},{field:'ifHCInOctets.7 · 10:42:08',value:'1060000000',unit:'累计字节 uint64'},{field:'sysUpTime / ifCounterDiscontinuityTime',value:'同一设备与连续计数周期',unit:'连续性证据'}],formula:'(1060000000 − 1000000000) ÷ 60 × 8',result:'8000000',dimensions:'if_index=7；interface_epoch=demo-epoch-7',meaning:'按接口身份和连续性计算速率。ifIndex 复用、设备重启或计数中断不跨越求差；不能把 bit/s 当作端口利用率。',available:true},
 {id:'snmp-oper',name:'接口运行状态',key:'network.interface.oper_state',unit:'状态码',method:'SNMP · GET',implementation:'snmp.interfaces.state · v1（设计样例）',outputs:[{field:'ifOperStatus.7',value:'1',unit:'原始状态码'}],formula:'保留状态字典：1=up，2=down，其他值按定义解释',result:'1 · up',dimensions:'if_index=7；interface_epoch=demo-epoch-7',meaning:'触发器引用相同状态字典，不把原始 1/2 与其他层的 1/0 混用。',available:true}
];
const pg:NativeMetricProfile[]=[
 {id:'pg-activity',name:'后端会话数',key:'postgresql.activity.count',unit:'个',method:'SQL · PostgreSQL 只读连接',implementation:'postgresql.activity.snapshot · v1（设计样例）',outputs:[{field:'SELECT COUNT(*) FROM pg_stat_activity',value:'128',unit:'行'}],formula:'读取计数，不替代 MySQL Threads_connected',result:'128',dimensions:'集群；无额外维度',meaning:'pg_stat_activity 后端行数包含后台和空闲后端，不能直接称为客户端连接利用率。实际可见范围须经权限测试。',available:true}
];
export function nativeMetricProfiles(t:{kind:string;engine:string}):NativeMetricProfile[]{
 if(t.kind==='服务器')return linux;
 if(t.kind==='网络设备')return network;
 return t.engine==='mysql'?mysql:t.engine==='postgresql'?pg:[];
}
export function mappingPreview(p:NativeMetricProfile|undefined){
 if(!p)return html`<app-empty-state title="此模板尚无映射演示" description="先登记原生采集实现并完成真实验证，再开放可选指标。当前页面不生成 SQL 或命令。"></app-empty-state>`;
 return html`<div class="mapping-flow"><span>原始输出</span><b>→</b><span>规范化与转换</span><b>→</b><span>指标定义</span><b>→</b><span>模板监控项</span><b>→</b><span>资源序列 / 触发器</span></div>
 <div class="split"><div class="stack"><app-card><span slot="header">原始输出 · 固定演示样本</span>${p.available?html`<div class="table-scroll"><app-data-table .columns=${[{key:'field',label:'输出字段 / 来源'},{key:'value',label:'值'},{key:'unit',label:'原始单位'}]} .rows=${p.outputs}></app-data-table></div>`:html`<app-empty-state title="尚无采集实现" description="不能测试或加入可发布模板。"></app-empty-state>`}<p class="micro section-gap">未执行真实采集；样例用于说明字段与指标的明确对应关系。</p></app-card>
 <app-card><span slot="header">转换与最终值</span><p class="preview-code">${p.formula}</p><div class="metric-value"><strong>${p.result}</strong><span>${p.unit}</span></div><p class="micro section-gap">${p.meaning}</p></app-card></div>
 <aside class="stack"><app-card><span slot="header">映射与身份</span><dl class="kv"><dt>采集协议</dt><dd>${p.method}</dd><dt>实现版本</dt><dd class="mono">${p.implementation}</dd><dt>指标标识</dt><dd class="mono">${p.key}</dd><dt>语义版本</dt><dd>${p.available?'1.0.0 · 演示':'待定义'}</dd><dt>最终单位</dt><dd>${p.unit}</dd><dt>维度</dt><dd>${p.dimensions}</dd><dt>序列关联</dt><dd>资源 + 稳定监控项身份 + 规范化维度</dd><dt>凭据</dt><dd>绑定资源时引用，不写进模板</dd></dl></app-card><div class="note">监控项和触发器按稳定引用关联；改显示名称不会改变历史身份。新发布版本不会改写历史事件的规则快照。</div></aside></div>`;
}
