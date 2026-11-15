import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import './alert-rule-editor.js';
import type { AlertRuleEditor } from './alert-rule-editor.js';

describe('alert rule editor #416/#417', () => {
  let editor: AlertRuleEditor;
  let save: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    editor = document.createElement('alert-rule-editor') as AlertRuleEditor;
    editor.metricRegistry = [{ id: 'mysql', db_types: ['mysql'] }, { id: 'pg', db_types: ['postgresql'] }, { id: 'all', db_types: [] }];
    editor.open = true;
    document.body.append(editor);
    await editor.updateComplete;
    await editor.updateComplete;
    (editor as any)._update('name', '测试');
    save = vi.fn(); editor.addEventListener('save', save);
  });
  afterEach(() => editor.remove());
  const update = (field: string, value: unknown) => (editor as any)._update(field, value);
  const submit = async () => { await (editor as any)._save(); return save.mock.calls[0]?.[0].detail.body; };
  it('clears a limited metric when switching to unrestricted, and replaces changed ranges', async () => {
    update('metric_name', 'mysql');
    expect((editor as any)._form.db_types).toEqual(['mysql']);
    update('metric_name', 'pg');
    expect((editor as any)._form.db_types).toEqual(['postgresql']);
    update('metric_name', 'all');
    expect((await submit()).db_types).toBeNull();
  });
  it('keeps explicit manual selection until another metric is selected', async () => {
    update('metric_name', 'all'); update('db_types', ['oracle']); update('description', 'manual');
    expect((await submit()).db_types).toEqual(['oracle']);
    update('metric_name', 'pg');
    expect((editor as any)._form.db_types).toEqual(['postgresql']);
    expect(editor.metricRegistry[1].db_types).toEqual(['postgresql']);
  });
  it('omits database filters for servers', async () => {
    update('metric_name', 'mysql'); update('target_type', 'server');
    const body = await submit();
    expect(body).not.toHaveProperty('db_types'); expect(body).not.toHaveProperty('instance_ids');
  });
  it.each([false, true])('preserves both zero values (editing=%s)', async editing => {
    if (editing) editor.rule = { id: 1 } as any;
    update('metric_name', 'all'); update('duration_seconds', '0'); update('silence_minutes', '0');
    expect(await submit()).toMatchObject({ duration_seconds: 0, silence_minutes: 0 });
  });
  for (const field of ['duration_seconds', 'silence_minutes']) {
    it.each(['', ' ', null, undefined, 'abc', NaN, Infinity, -1, 0.5, 2147483648])(`rejects ${field}=%s without emitting save`, async raw => {
      update('metric_name', 'all'); update(field, raw);
      await submit(); expect(save).not.toHaveBeenCalled(); expect((editor as any)._error).toBeTruthy();
    });
    it(`retains empty ${field} input so it cannot become zero`, async () => {
      const input = editor.shadowRoot!.querySelector<HTMLInputElement>(`app-form-field[label="${field === 'duration_seconds' ? '持续时间（秒）' : '沉默期（分钟）'}"] input`)!;
      input.value = ''; input.dispatchEvent(new Event('input'));
      expect((editor as any)._form[field]).toBe('');
    });
  }
});
