import { afterEach, describe, expect, it } from 'vitest';
import './settings-shell.js';

describe('settings security navigation', () => {
  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  async function renderWith(permissions: string[]): Promise<HTMLElement> {
    localStorage.setItem('permissions', JSON.stringify(permissions));
    const element = document.createElement('settings-shell') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await element.updateComplete;
    return element;
  }

  it('shows policy configuration without exposing audit views to ai-only users', async () => {
    const element = await renderWith(['ai:view']);
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Agent 安全');
    expect(text).not.toContain('Agent 审计');
    expect(text).not.toContain('Agent 沙箱');
  });

  it('shows all security views to a wildcard administrator', async () => {
    const element = await renderWith(['*']);
    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Agent 安全');
    expect(text).toContain('Agent 审计');
    expect(text).toContain('Agent 沙箱');
  });
});
