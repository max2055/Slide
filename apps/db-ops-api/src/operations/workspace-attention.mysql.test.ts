import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {startFeedbackFixture} from '../investigations/feedback-test-fixture.js';
import {createOperationsComposition} from './composition.js';
import {registerOperationsUiRoutes} from './ui-integration.js';
import {createVerifyToken} from '../auth-middleware.js';
const port=Number(process.env.MAX242_TEST_MYSQL_PORT);
describe.skipIf(!port)('workspace original-record discovery HTTP/live SQL',()=>{
 let f:Awaited<ReturnType<typeof startFeedbackFixture>>;
 let ids:string[]=[];
 beforeAll(async()=>{
  f=await startFeedbackFixture(port);
  const composition=createOperationsComposition(()=>f.pool,{jwtSecret:randomBytes(32).toString('hex')});
  await registerOperationsUiRoutes(f.app,createVerifyToken(f.secret,f.contexts),composition.ui);
  for(let i=0;i<24;i++){const s=await f.seed();ids.push(s.inv.id);}
 },120000);
 afterAll(async()=>{await f?.close();});
 const get=(query='',token?:string)=>f.app.inject({url:`/api/operations/workspace-attention${query}`,headers:{authorization:`Bearer ${token??f.tokens.owner}`}});
 it('discovers beyond one list page with stable keysets, exact originals and no global/hidden counts',async()=>{
  const first=await get('?limit=20');expect(first.statusCode).toBe(200);expect(first.headers['cache-control']).toBe('private, no-store');
  const a=first.json();expect(a.items).toHaveLength(20);expect(a).not.toHaveProperty('authorizedCounts');expect(a.nextCursor).toBeTruthy();
  const next=await get(`?limit=20&cursor=${a.nextCursor}`);expect(next.statusCode).toBe(200);
  const b=next.json();expect(b.items).toHaveLength(4);expect(b.nextCursor).toBeNull();
  expect(new Set([...a.items,...b.items].map(i=>i.investigationId))).toEqual(new Set(ids));
  for(const i of [...a.items,...b.items]){expect(i.kind).toBe('continue');expect(i.resultId).toBeTruthy();expect(i.resultVersion).toBe(1);expect(i.investigationVersion).toBeGreaterThan(0);expect(Date.parse(i.updatedAt)).toBeGreaterThan(0);}
  expect((await f.rows('SELECT COUNT(*) n FROM investigation_workflow_receipts'))[0].n).toBe(0);
 });
 it('viewer is never presented as an operator; operator sees only current membership',async()=>{
  expect((await get('',f.tokens.viewer)).json().items).toEqual([]);
  expect((await get('?limit=50',f.tokens.operator)).json().items).toHaveLength(24);
  await f.rows('UPDATE investigation_members SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE user_id=103');
  expect((await get('',f.tokens.operator)).json().items).toEqual([]);
  await f.rows('UPDATE investigation_members SET expires_at=NULL WHERE user_id=103');
 });
 it('processing, active request and closure change only original records, refresh removes them',async()=>{
  await f.rows("UPDATE investigations SET lifecycle='closed' WHERE id=?",[ids[0]]);
  await f.rows("UPDATE investigations SET problem_status='resolved' WHERE id=?",[ids[1]]);
  const [req]=await f.rows('SELECT id FROM investigation_requests WHERE investigation_id=? LIMIT 1',[ids[2]]);
  await f.rows('UPDATE investigations SET active_request_id=? WHERE id=?',[req.id,ids[2]]);
  const result=(await get('?limit=50')).json();expect(result.items).toHaveLength(21);expect(result.items.some(i=>ids.slice(0,3).includes(i.investigationId))).toBe(false);
  await f.rows("UPDATE investigations SET lifecycle='open',problem_status='unconfirmed',active_request_id=NULL WHERE id IN (?,?,?)",ids.slice(0,3));
 });
 it('cursor is authenticated, filter and principal bound; arbitrary input is rejected',async()=>{
  const first=(await get('?limit=1')).json();
  for(const query of [`?limit=2&cursor=${first.nextCursor}`,`?limit=1&cursor=${first.nextCursor.slice(0,-8)}abcdefgh`,'?limit=0','?state=open'])expect((await get(query)).statusCode).toBe(422);
  expect((await get(`?limit=1&cursor=${first.nextCursor}`,f.tokens.operator)).statusCode).toBe(422);
 });
 it('live resource revocation removes all content even with an old signed JWT',async()=>{
  await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
  const response=await get();expect(response.statusCode).toBe(200);expect(response.json().items).toEqual([]);
  await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,102,'read-only')");
 });
});
