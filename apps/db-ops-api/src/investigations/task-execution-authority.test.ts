import { describe, expect, it } from 'vitest';
import { MAX222_OFFLINE_EXECUTION, allocationHash, freezeExecutionAllocation, readExecutionAllocation, taskExecutionConfiguration } from './execution-allocation.js';
import { investigationBudgetConfiguration, InvestigationSessionBridge } from './session-bridge.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
const ownerRunId = '00000000-0000-0000-0000-000000000031';
const gateId = '00000000-0000-0000-0000-000000000032';
const domain = `task.max222.${ownerRunId}.${gateId}`;
const configuration: any = { ...MAX222_OFFLINE_EXECUTION, id: 'MAX-222/task-v1', authority: {
  taskId: '01a15ece-1c94-76b9-b2c0-91b83981e9ba', ownerRunId, gateId, domain, sourceHash: 'a'.repeat(64),
} };
const policy = { ...investigationBudgetConfiguration().policy, maxAutomaticTokensPerDay:1200000,maxTotalTokensPerDay:1200000 };
const binding = { requestId:'00000000-0000-0000-0000-000000000001', investigationId:'00000000-0000-0000-0000-000000000002', profile:INVESTIGATION_PROFILES.ops, domain,mode:'manual' as const };
describe('trusted formal MAX222 composition', () => {
  it('refuses missing formal identity even after startup/domain drift, while legacy identity stays optional', () => {
    for (const [persisted, trusted] of [[binding, configuration], [binding, undefined],
      [{...binding, domain:'investigation-v1', executionDomain:domain}, undefined]] as const)
      expect(()=>readExecutionAllocation(undefined,persisted,policy,trusted)).toThrow('INVESTIGATION_ALLOCATION_INVALID');
    expect(readExecutionAllocation(undefined,{...binding,domain:'investigation-v1',executionDomain:null},policy)).toBeUndefined();
    const frozen=freezeExecutionAllocation(configuration,binding,policy);
    expect(()=>readExecutionAllocation(frozen,{...binding,executionDomain:null},policy,configuration)).toThrow('INVESTIGATION_ALLOCATION_INVALID');
    expect(readExecutionAllocation(frozen,{...binding,executionDomain:domain},policy,configuration)).toEqual(frozen);
  });
  it('admits the real task domain from explicit internal composition and freezes its complete source identity', () => {
    const bridge = new InvestigationSessionBridge(()=>null, undefined, { domain,policy,taskExecution:configuration });
    expect(bridge).toBeDefined();
    const frozen=freezeExecutionAllocation(configuration,binding,policy);
    expect(frozen.configuration).toEqual(configuration);
    expect((readExecutionAllocation as any)(frozen,binding,policy,configuration)).toEqual(frozen);
    expect(Object.isFrozen(taskExecutionConfiguration(configuration,domain,policy))).toBe(true);
  });
  it('requires explicit matching startup authority when reading persisted formal allocation', () => {
    const frozen=freezeExecutionAllocation(configuration,binding,policy);
    expect(()=>readExecutionAllocation(frozen,binding,policy)).toThrow('INVESTIGATION_ALLOCATION_INVALID');
    for(const key of ['sourceHash','ownerRunId','gateId','taskId']) {
      const changed={...configuration,authority:{...configuration.authority,[key]:'changed'}};
      expect(()=>(readExecutionAllocation as any)(frozen,binding,policy,changed)).toThrow();
    }
  });
  it.each(['sourceHash','ownerRunId','gateId','domain','taskId'])('rejects rehashed SQL %s drift against startup identity', key => {
    const frozen=freezeExecutionAllocation(configuration,binding,policy);
    const changed={...frozen,configuration:{...configuration,authority:{...configuration.authority,[key]:'changed'}}};
    const {hash:_,...payload}=changed;changed.hash=allocationHash(payload);
    expect(()=>(readExecutionAllocation as any)(changed,binding,policy,configuration)).toThrow();
  });
  it('does not enable formal authority through offline regex or larger/extra configuration fields',()=>{
    expect(()=>taskExecutionConfiguration(MAX222_OFFLINE_EXECUTION,domain,policy)).toThrow();
    expect(()=>taskExecutionConfiguration(configuration,'qualification.max222.formal',policy)).toThrow();
    for(const change of [{maxToolCalls:37},{maxTotalTokens:1200001},{contextWindowTokens:294913},{extra:1}])
      expect(()=>taskExecutionConfiguration({...configuration,...change},domain,policy)).toThrow();
    expect(()=>taskExecutionConfiguration(configuration,domain,investigationBudgetConfiguration().policy)).toThrow();
  });
});
