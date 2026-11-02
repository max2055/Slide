import { expect, it, vi } from 'vitest';
import { systemEventOn } from './system-event-workflow.js';
import { prepareSystemFailure } from './system-event-bridge.js';
import { stableHash } from './trigger-policy.js';
const eventId = '11111111-1111-4111-8111-111111111111';
const prepared = prepareSystemFailure({ component:'api',sourceEventId:'one',correlationId:'one',occurredAt:'2026-11-01T00:00:00.000Z',stableErrorCode:'HTTP_503',callsite:'api:GET:/failure',origin:'user_operation' });
function setup() {
  const fact={...prepared,contentHash:stableHash(prepared)};
  const row={id:eventId,source:Buffer.from(fact.source),source_event_id:Buffer.from('one'),fact};
  const c={execute:vi.fn().mockResolvedValue([[row],[]])}; const authorization={authorize:vi.fn().mockResolvedValue({})};
  return {fact,row,c,authorization};
}
it('MAX243 real VARBINARY source identities are compared by bytes-as-UTF8, not JS object identity',async()=>{
  const f=setup();expect((await systemEventOn(f.c as never,{userId:1} as never,eventId,f.authorization as never)).fact).toEqual(f.fact);
});
it.each(['source','source_event_id'])('fails closed when durable %s disagrees with original fact',async key=>{
  const f=setup();(f.row as any)[key]=Buffer.from('other');
  await expect(systemEventOn(f.c as never,{userId:1} as never,eventId,f.authorization as never)).rejects.toThrow('INVESTIGATION_QUEUE_UNAVAILABLE');
});
it('rechecks live System authority before touching original content',async()=>{
  const f=setup();f.authorization.authorize.mockRejectedValue(new Error('revoked'));
  await expect(systemEventOn(f.c as never,{userId:1} as never,eventId,f.authorization as never)).rejects.toThrow('revoked');expect(f.c.execute).not.toHaveBeenCalled();
});
