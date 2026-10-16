/** Legacy lifecycle adapter: no timer or legacy metric persistence. */
import { metricConfigurationService } from './metrics/config/routes.js';
export class ServerCollector {
  start():void {}
  stop():void {}
  async collectServer(id:number){
    return metricConfigurationService.trialCurrent({userId:0,username:'server-collection',roles:[],permissions:['servers:view','servers:manage','collector:manage'],instanceScopes:{},sessionVersion:0,requestId:`server-collection:${id}`},{type:'server',id});
  }
}
export default new ServerCollector();
