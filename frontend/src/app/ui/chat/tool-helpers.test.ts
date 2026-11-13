import { expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { formatToolOutputForSidebar } from './tool-helpers.ts';

it.each([{ message: '```' }, ['```', '``````', '尾部'], { text: '普通 JSON' }])('#713 preserves JSON as one complete code block: %j', value => {
  const text = JSON.stringify(value);
  const tokens = new MarkdownIt().parse(formatToolOutputForSidebar(text), {});
  expect(tokens).toHaveLength(1);
  expect(tokens[0].type).toBe('fence');
  expect(tokens[0].info).toBe('json');
  expect(tokens[0].content).toBe(JSON.stringify(value, null, 2) + '\n');
});
it('keeps ordinary JSON formatting and plain text unchanged', () => {
  expect(formatToolOutputForSidebar('{"ok":true}')).toBe('```json\n{\n  "ok": true\n}\n```');
  for (const text of ['普通文本', '```text\n示例\n```', '{invalid']) expect(formatToolOutputForSidebar(text)).toBe(text);
});
