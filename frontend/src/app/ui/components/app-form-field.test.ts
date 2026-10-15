import { afterEach, describe, expect, it } from 'vitest';
import { AppFormField } from './app-form-field.js';

async function mount(markup = '<input>') {
  const field = document.createElement('app-form-field') as AppFormField;
  field.label = '用户名';
  field.innerHTML = markup;
  document.body.append(field);
  await settle(field);
  return field;
}
async function settle(field: AppFormField) {
  await field.updateComplete;
  await new Promise(resolve => setTimeout(resolve, 0));
}
afterEach(() => document.body.replaceChildren());

describe('app-form-field associations across its slot', () => {
  it('creates a native label in the control tree without changing existing IDs', async () => {
    const field = await mount('<input id="existing">');
    const input = field.querySelector('input')!;
    expect(input.id).toBe('existing');
    expect(input.labels?.[0]?.textContent).toBe('用户名');
    field.shadowRoot!.querySelector('label')!.click();
    expect(document.activeElement).toBe(input);
  });
  it('isolates same-name fields and updates translated labels', async () => {
    const first = await mount(); const second = await mount();
    const a = first.querySelector('input')!; const b = second.querySelector('input')!;
    expect(a.id).not.toBe(b.id);
    first.label = 'Username'; await settle(first);
    expect(a.labels?.[0]?.textContent).toBe('Username');
    expect(b.labels?.[0]?.textContent).toBe('用户名');
    second.shadowRoot!.querySelector('label')!.click();
    expect(document.activeElement).toBe(b);
  });
  it('associates hint/error text in the same tree and preserves caller descriptions/invalid state', async () => {
    const field = await mount('<span id="external">外部说明</span><input aria-describedby="external" aria-invalid="grammar">');
    const input = field.querySelector('input')!;
    field.hint = '请输入姓名'; await settle(field);
    const description = () => input.getAttribute('aria-describedby')!.split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ');
    expect(description()).toBe('外部说明 请输入姓名');
    field.error = '姓名不能为空'; await settle(field);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(description()).toBe('外部说明 姓名不能为空');
    field.error = ''; await settle(field);
    expect(input.getAttribute('aria-invalid')).toBe('grammar');
    expect(description()).toBe('外部说明 请输入姓名');
    field.hint = ''; await settle(field);
    expect(input.getAttribute('aria-describedby')).toBe('external');
  });
  it('supports late/replaced controls and cleans old associations', async () => {
    const field = await mount('<div></div>');
    field.error = '格式错误'; await settle(field);
    const wrapper = field.querySelector('div')!;
    const old = document.createElement('input'); wrapper.append(old); await settle(field);
    expect(old.getAttribute('aria-invalid')).toBe('true');
    const next = document.createElement('textarea'); old.replaceWith(next); await settle(field);
    expect(old.hasAttribute('aria-invalid')).toBe(false);
    expect(old.hasAttribute('aria-describedby')).toBe(false);
    expect(next.getAttribute('aria-invalid')).toBe('true');
    expect(next.labels?.[0]?.textContent).toBe('用户名');
  });
  it('keeps explicit caller names and labels usable', async () => {
    const field = await mount('<label for="caller">已有标签</label><input id="caller" aria-label="已有名称">');
    const input = field.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('已有名称');
    expect(input.labels?.[0]?.textContent).toBe('已有标签');
    field.remove(); await settle(field);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
  it('skips hidden inputs and nested fields', async () => {
    const field = await mount('<input type="hidden"><app-form-field label="子字段"><input></app-form-field><select><option>全部</option></select>');
    expect(field.querySelector('select')!.labels?.[0]?.textContent).toBe('用户名');
    expect(field.querySelector('input[type=hidden]')!.id).toBe('');
    expect(field.querySelector('app-form-field input')!.labels?.[0]?.textContent).toBe('子字段');
  });
});
