import { afterEach, describe, expect, it } from 'vitest';
import { InstanceDiagnosisModal } from './instance-diagnosis-modal.js';

afterEach(() => { document.body.replaceChildren(); });

describe('#421 diagnosis Light DOM styling', () => {
  it('injects scoped styles once across loading, error, result and reconnect', async () => {
    const outside = document.createElement('div');
    outside.className = 'empty-state';
    document.body.append(outside);
    const modal = new InstanceDiagnosisModal();
    document.body.append(modal);
    await modal.updateComplete;
    expect(modal.shadowRoot).toBeNull();
    expect(getComputedStyle(modal.querySelector('.empty-state')!).padding).toBe('40px');
    expect(getComputedStyle(outside).padding).not.toBe('40px');
    for (const state of [
      { loading: true },
      { loading: false, error: '连接超时' },
      { error: null, diagnosis: { result: '受控结果', status: 'completed' } },
    ]) {
      Object.assign(modal, state);
      await modal.updateComplete;
      expect(modal.querySelectorAll(':scope > style')).toHaveLength(1);
    }
    modal.remove();
    document.body.append(modal);
    await modal.updateComplete;
    expect(modal.querySelectorAll(':scope > style')).toHaveLength(1);
    // Local selectors must not style same-named classes inside result subcomponents.
    const result = modal.querySelector('ai-analysis-result')!;
    const nested = document.createElement('div');
    nested.className = 'empty-state';
    result.append(nested);
    expect(getComputedStyle(nested).padding).not.toBe('40px');
  });
});
