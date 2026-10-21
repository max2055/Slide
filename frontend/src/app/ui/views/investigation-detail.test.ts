import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderInvestigationDetail } from './investigation-detail.ts';
vi.mock('../components/investigation-feedback.ts', () => ({}));
vi.mock('../components/investigation-operation-context.ts', () => ({}));
afterEach(() => document.body.replaceChildren());
const container = () => document.body.appendChild(document.createElement('div'));
it('shows the latest outcome before process/feedback, with Chinese status and collapsed technical details', () => {
 const c:any={ detail:{id:'one',title:'调查',goal:'很长的原始调查目标'.repeat(200),profileId:'ops',lifecycle:'waiting',problemStatus:'unconfirmed',resources:[],sessionId:'technical-session',derivedRunState:'partial'},
 results:{items:[{id:'r',version:1,runId:'run',result:{summary:'检查因时间范围超限停止，已保留5项检查。',facts:[],unresolvedQuestions:['缺少正式观测'],recommendations:[{action:'缩小时间范围后提交新调查'}],execution:{reasonCode:'INVESTIGATION_TOOL_WINDOW_LIMIT'},rootCauseVerification:{status:'unverified'},provenance:{modelVersion:'deepseek-flash',promptVersion:'ops@1',usageStatus:'available'}}}]}, history:[], snapshot:null, online:true };
 render(renderInvestigationDetail(c,{draft:'',onDraft:()=>{},onContinue:()=>{},onEvidence:()=>{}}),container());
 const first=document.querySelector('app-card')!;
 expect(first.querySelector('[aria-label="本次调查结果"]')).not.toBeNull();
 expect(first.textContent).toContain('检查请求的时间范围超出工具上限');
 expect(first.querySelector('details[aria-label="调查目标"]')?.hasAttribute('open')).toBe(false);
 expect(first.textContent!.indexOf('下一步')).toBeLessThan(first.textContent!.indexOf('很长的原始调查目标'));
 const outcome=document.querySelector('[aria-label="本次调查结果"]'); expect(outcome?.textContent).toContain('时间范围');
 expect(outcome?.textContent).toContain('缺少正式观测');
 expect(document.querySelector('details[aria-label="执行过程与技术详情"]')?.hasAttribute('open')).toBe(false);
 expect(document.body.textContent).not.toContain('· technical-session');
 expect(document.body.textContent!.indexOf('本次调查结果')).toBeLessThan(document.body.textContent!.indexOf('执行与协作'));
});

it('keeps missing stop evidence explicit and labels a saved outcome during an active run', () => {
 const c:any={ detail:{id:'one',title:'调查',goal:'原始目标',profileId:'ops',lifecycle:'waiting',problemStatus:'unconfirmed',resources:[],sessionId:'session',activeRequestId:'current',derivedRunState:'running'},
 results:{items:[{id:'old',version:1,runId:'old-run',result:{summary:'历史部分结果',facts:[],unresolvedQuestions:[],recommendations:[],provenance:{}}}]}, history:[], snapshot:{projection:{runs:{}},runs:[{requestId:'current',state:'running'}]}, online:true };
 render(renderInvestigationDetail(c,{draft:'',onDraft:()=>{},onContinue:()=>{},onEvidence:()=>{}}),container());
 const outcome=document.querySelector('[aria-label="本次调查结果"]')!;
 expect(outcome.textContent).toContain('上一份已保存结果 V1');
 expect(outcome.textContent).toContain('历史记录未保留具体停止原因');
 expect(outcome.textContent).toContain('未记录具体缺口，不代表');
 expect(outcome.textContent).toContain('最近结果的停止原因');
});
