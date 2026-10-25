import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../ai-analysis-config-service.js';
import { automaticAlertConfigurationSuppression } from './automatic-alert-policy.js';
const alert = {id:1, instance_id:1, level:'critical', title:'CPU', message:'CPU', metric_name:'cpu_usage',created_at:new Date()};
describe('automatic alert time and resource policy', () => {
  it.each([
    ['08:00','18:00',7,59,false], ['08:00','18:00',8,0,true], ['08:00','18:00',18,0,true], ['08:00','18:00',18,1,false],
    ['22:00','06:00',23,0,true], ['22:00','06:00',5,59,true], ['22:00','06:00',12,0,false],
    ['00:00','23:59',23,59,true],
  ])('%s–%s at %i:%i allows=%s', (start,end,hour,minute,allowed) => {
    const now = new Date(2026,9,26,hour,minute);
    expect(automaticAlertConfigurationSuppression({...DEFAULT_CONFIG,timeWindowStart:start,timeWindowEnd:end},alert,now))
      .toBe(allowed ? undefined : 'AUTO_ANALYSIS_OUTSIDE_WINDOW');
  });
  it('database numeric whitelist never accidentally authorizes other resource classes', () => {
    expect(automaticAlertConfigurationSuppression({...DEFAULT_CONFIG,instanceWhitelist:[999]}, {...alert,instance_id:null,server_id:1},new Date())).toBeUndefined();
  });
});
