import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderInvestigationDetail } from './investigation-detail.ts';
vi.mock('../components/investigation-feedback.ts', () => ({}));
vi.mock('../components/investigation-operation-context.ts', () => ({}));
afterEach(() => document.body.replaceChildren());
it('shows the latest outcome before process/feedback, with Chinese status and collapsed technical details', () => {
 const c:any={ detail:{id:'one',title:'调查',goal:'检查',profileId:'ops',lifecycle:'waiting',problemStatus:'unconfirmed',resources:[],sessionId:'technical-session',derivedRunState:'partial'},
 results:{items:[{id:'r',version:1,runId:'run',result:{summary:'检查因时间范围超限停止，已保留5项检查。',facts:[],unresolvedQuestions:['缺少正式观测'],recommendations:[{action:'缩小时间范围后提交新调查'}],execution:{reasonCode:'INVESTIGATION_TOOL_WINDOW_LIMIT'},rootCauseVerification:{status:'unverified'},provenance:{modelVersion:'deepseek-flash',promptVersion:'ops@1',usageStatus:'available'}}}]}, history:[], snapshot:null, online:true };
 render(renderInvestigationDetail(c,{draft:'',onDraft:()=>{},onContinue:()=>{},onEvidence:()=>{}}),document.body);
 const outcome=document.querySelector('[aria-label="本次调查结果"]'); expect(outcome?.textContent).toContain('时间范围');
 expect(outcome?.textContent).toContain('缺少正式观测');
 expect(document.querySelector('details[aria-label="执行过程与技术详情"]')?.hasAttribute('open')).toBe(false);
 expect(document.body.textContent).not.toContain('· technical-session');
 expect(document.body.textContent!.indexOf('本次调查结果')).toBeLessThan(document.body.textContent!.indexOf('执行与协作'));
});
