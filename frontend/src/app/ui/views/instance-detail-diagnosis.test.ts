import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const views = resolve(import.meta.dirname, '.');
const detail = readFileSync(resolve(views, 'instance-detail.ts'), 'utf8');
const modal = readFileSync(resolve(views, '../components/instance-diagnosis-modal.ts'), 'utf8');

describe('Instance diagnosis UI contract', () => {
  it('loads bounded diagnosis history for the selected instance', () => {
    expect(detail).toContain('/api/ai/analysis/history?instance_id=${this.instanceId}');
    expect(detail).toContain('analysis_type=fault_diagnosis');
    expect(detail).toContain('limit=10');
    expect(detail).toContain('this.loadDiagnosisHistory()');
  });

  it('renders history state and opens the selected record in the diagnosis modal', () => {
    expect(detail).toContain('diagnosisHistoryLoading');
    expect(detail).toContain('AI 诊断历史');
    expect(detail).toContain('substring(0, 80)');
    expect(detail).toContain('this.activeDiagnosisRecord = r');
    expect(detail).toContain('this.showDiagnosisModal = true');
    expect(detail).toContain('<instance-diagnosis-modal');
  });

  it('preserves the polling lifecycle and passes its result to the modal', () => {
    expect(detail).toContain('_startDiagnosis');
    expect(detail).toContain('_stopDiagnosisPolling');
    expect(detail).toContain('.loading=${this.diagnosisStatus === "running"}');
    expect(detail).toContain('.diagnosisRecord=${this.activeDiagnosisRecord}');
  });

  it('uses ai-analysis-result inside the reusable diagnosis modal', () => {
    expect(modal).toContain('<ai-analysis-result');
    expect(modal).toContain('.result=${');
    expect(modal).toContain('analysisType="fault_diagnosis"');
  });
});
