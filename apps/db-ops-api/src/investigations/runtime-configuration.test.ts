import {afterEach,expect,it,vi} from 'vitest';
import {investigationRuntimeConfiguration, resolveInvestigationRuntime} from './runtime-configuration.js';
const capability:any={model:'deepseek-flash',contextWindowTokens:1048576,maxOutputTokens:393216,preferredOutputTokens:4096,source:'configuration',version:'fixture'};
afterEach(()=>vi.unstubAllEnvs());
it('keeps the existing default and selects a bounded task window without changing provider capabilities',()=>{
 expect(resolveInvestigationRuntime(capability)).toEqual({contextWindowTokens:16000,maxTokens:4096});
 vi.stubEnv('INVESTIGATION_CONTEXT_WINDOW_TOKENS','32768');
 vi.stubEnv('INVESTIGATION_OUTPUT_TOKENS','4096');
 expect(resolveInvestigationRuntime(capability,investigationRuntimeConfiguration())).toEqual({contextWindowTokens:32768,maxTokens:4096});
 expect(capability.contextWindowTokens).toBe(1048576);
});
it.each(['','0','-1','1.5','NaN','1000001'])('rejects invalid task window %s before any model send',value=>{
 vi.stubEnv('INVESTIGATION_CONTEXT_WINDOW_TOKENS',value);
 expect(()=>investigationRuntimeConfiguration()).toThrow('INVESTIGATION_CONTEXT_CONFIGURATION');
});
it('requires known sufficient model capacity and room for output plus margin',()=>{
 const task={contextWindowTokens:32768,maxTokens:4096};
 for(const model of [undefined,{...capability,source:'conservative-fallback'},{...capability,contextWindowTokens:16000},{...capability,maxOutputTokens:2048}])
  expect(()=>resolveInvestigationRuntime(model,task)).toThrow('INVESTIGATION_CONTEXT_CAPABILITY');
 expect(()=>resolveInvestigationRuntime(capability,{contextWindowTokens:5000,maxTokens:4096})).toThrow('INVESTIGATION_CONTEXT_CONFIGURATION');
});
it('recovers the persisted context allocation despite changed deployment defaults and revalidates capability',()=>{
 const saved=resolveInvestigationRuntime(capability,{contextWindowTokens:32768,maxTokens:4096});
 expect(resolveInvestigationRuntime(capability,{contextWindowTokens:65536,maxTokens:2048},saved)).toEqual(saved);
 expect(()=>resolveInvestigationRuntime({...capability,contextWindowTokens:16000},{},saved)).toThrow('INVESTIGATION_CONTEXT_CAPABILITY');
 expect(()=>resolveInvestigationRuntime(capability,{}, {...saved,maxTokens:0})).toThrow('INVESTIGATION_CONTEXT_CONFIGURATION');
});
