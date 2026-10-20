import {afterEach,expect,it,vi} from 'vitest';
import {authFetch} from '../../../api/index.ts';
import {watchCase} from './operations-api.ts';
vi.mock('../../../api/index.ts',()=>({authFetch:vi.fn()}));
const api=vi.mocked(authFetch);
const stops:Array<()=>void>=[];
afterEach(()=>{stops.splice(0).forEach(stop=>stop());vi.useRealTimers();api.mockReset();});
const tick=()=>new Promise<void>(r=>queueMicrotask(r));
it('consumes live snapshots, clears on invalidation and ignores late frames after object switch',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;
  api.mockResolvedValue({ok:true,body:new ReadableStream({start(c){stream=c;}})} as Response);
  const receive=vi.fn();const stop=watchCase('one',receive);stops.push(stop);await tick();
  const send=(v:unknown)=>stream.enqueue(new TextEncoder().encode(JSON.stringify(v)+'\n'));
  send({type:'operations.case.snapshot',case:{id:'one',tombstone:false,validUntil:new Date(Date.now()+60000).toISOString(),content:{title:'source'}}});await tick();await tick();
  expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({id:'one'}));
  send({type:'operations.case.invalidated'});await tick();await tick();expect(receive).toHaveBeenLastCalledWith(null);
  stop();const n=receive.mock.calls.length;
  send({type:'operations.case.snapshot',case:{id:'one',tombstone:false,validUntil:new Date(Date.now()+60000).toISOString()}});await tick();expect(receive).toHaveBeenCalledTimes(n);
  expect(api).toHaveBeenCalledTimes(1);
});
it('expires an already displayed snapshot and treats transport loss as invalidation',async()=>{
  vi.useFakeTimers();let stream!:ReadableStreamDefaultController<Uint8Array>;
  api.mockResolvedValue({ok:true,body:new ReadableStream({start(c){stream=c;}})} as Response);
  const receive=vi.fn();stops.push(watchCase('one',receive));await tick();
  stream.enqueue(new TextEncoder().encode(JSON.stringify({type:'operations.case.snapshot',case:{id:'one',tombstone:false,validUntil:new Date(Date.now()+100).toISOString()}})+'\n'));
  await tick();await tick();await vi.advanceTimersByTimeAsync(101);expect(receive).toHaveBeenLastCalledWith(null);
  stream.close();await tick();await tick();expect(receive).toHaveBeenLastCalledWith(null);expect(api).toHaveBeenCalledTimes(1);
});
