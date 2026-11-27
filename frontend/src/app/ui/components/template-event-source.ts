import type { TemplateEventEvidence } from '../../../api/generated/public-api.js';

type Availability = NonNullable<TemplateEventEvidence['source_availability']>['opening'];

const labels: Record<Availability, string> = {
  available: '原始采样来源可用',
  expired: '有原始采样来源已过期，事件证据仍保留',
  unknown: '原始采样来源状态未知',
};

export const templateEventSourceLabel = (status: Availability | undefined) =>
  labels[status === 'available' || status === 'expired' ? status : 'unknown'];
