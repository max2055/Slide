import { afterEach, expect, it, vi } from 'vitest';
import { InvestigationSupplement } from './investigation-supplement.ts';
import './investigation-supplement.ts';
afterEach(() => document.body.replaceChildren());
async function mount() {
  const view = document.createElement('investigation-supplement') as InvestigationSupplement;
  view.investigationId = 'one'; view.resultId = 'result'; view.resultVersion = 4;
  view.gaps = ['服务是否就绪？', '同一窗口的延迟（毫秒）是多少？'];
  document.body.append(view); await view.updateComplete; return view;
}
async function select(view: InvestigationSupplement, name: string, value: string) {
  const input = view.shadowRoot!.querySelector(`[aria-label="${name}"]`) as HTMLSelectElement;
  input.value = value; input.dispatchEvent(new Event('change')); await view.updateComplete;
}
const button = (view: InvestigationSupplement) => view.shadowRoot!.querySelector('button')!;
it('allows zero-text unknown answers bound to an actual result gap, without inventing observations', async () => {
  const view = await mount(), submit = vi.fn(async () => ({ requestId: 'next' })); view.submit = submit;
  expect(button(view).disabled).toBe(true); await select(view, '补充方式', 'unknown');
  view.gaps = [...view.gaps]; await view.updateComplete;
  expect(submit).not.toHaveBeenCalled(); button(view).click(); await view.updateComplete;
  expect(submit).toHaveBeenCalledWith(expect.any(String), { resultId: 'result', resultVersion: 4,
    observation: '未提供额外描述', answer: { gapIndex: 0, kind: 'unknown' } });
});
it('numeric answers require an explicit source and retain zero as a valid measurement', async () => {
  const view = await mount(); view.submit = vi.fn(async () => true);
  await select(view, '待核实缺口', '1'); await select(view, '补充方式', 'number');
  const input = view.shadowRoot!.querySelector('input')!; input.value = '0'; input.dispatchEvent(new Event('input')); await view.updateComplete;
  expect(button(view).disabled).toBe(true); await select(view, '数值来源', 'monitoring_display');
  button(view).click(); await view.updateComplete;
  expect(view.submit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({answer: {gapIndex:1,kind:'number',value:0,source:'monitoring_display'}}));
});
it('clears stale drafts on actual result change and disables disconnected/unknown submissions', async () => {
  const view = await mount(); view.submit = vi.fn(); await select(view, '补充方式', 'unknown');
  view.disabled = true; await view.updateComplete; button(view).click(); expect(view.submit).not.toHaveBeenCalled();
  view.resultVersion = 5; view.disabled = false; await view.updateComplete;
  expect(button(view).disabled).toBe(true); expect(view.shadowRoot!.querySelector('textarea')!.value).toBe('');
});
it('sends once while pending and retains unaccepted input; equivalent parent renders preserve the selection', async () => {
  const view = await mount(); let resolve!: (value: unknown) => void;
  view.submit = vi.fn(() => new Promise(r => resolve = r)); await select(view, '补充方式', 'observed');
  button(view).click(); button(view).click(); await view.updateComplete;
  view.gaps = [...view.gaps]; await view.updateComplete; resolve(undefined); await view.updateComplete; await Promise.resolve();
  expect(view.submit).toHaveBeenCalledTimes(1);
  expect((view.shadowRoot!.querySelector('[aria-label="补充方式"]') as HTMLSelectElement).value).toBe('observed');
});
it('does not manufacture a gap when none exists', async () => {
  const view = await mount(); view.gaps = []; await view.updateComplete;
  expect(button(view).disabled).toBe(true); expect(view.shadowRoot!.querySelector('select')).toBeNull();
});
