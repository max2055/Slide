/** Compatibility one-shot adapter. The immutable package runner is the sole metric implementation. */
import type { DatabaseInstance } from './instance-database-service.js';
import { metricConfigurationService } from './metrics/config/routes.js';
export const unifiedCollector={
  async collectInstance(instance:DatabaseInstance,_dueMetricIds?:readonly string[]){
    return metricConfigurationService.trialCurrent({userId:0,username:'instance-collection',roles:[],permissions:['instance:view','collector:manage'],instanceScopes:{[instance.id]:'read-write'},sessionVersion:0,requestId:`instance-collection:${instance.id}`},{type:'instance',id:instance.id});
  },
};
