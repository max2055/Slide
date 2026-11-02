import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {startFeedbackFixture} from './feedback-test-fixture.js';
import {registerInvestigationRoutes} from './routes.js';
import {createVerifyToken} from '../auth-middleware.js';
const port=Number(process.env.MAX242_TEST_MYSQL_PORT);
describe.skipIf(!port)('MAX242 authorized original workflow entry',()=>{
 let f:Awaited<ReturnType<typeof startFeedbackFixture>>;
 beforeAll(async()=>{f=await startFeedbackFixture(port);await registerInvestigationRoutes(f.app,createVerifyToken(f.secret,f.contexts),f.bridge);},120000);
 afterAll(async()=>{await f?.close();});
 it('reads original scope and measurement history without a model request',async()=>{
  const s=await f.seed();const before=await f.rows('SELECT id FROM investigation_requests WHERE investigation_id=?',[s.inv.id]);
  const reply=await f.app.inject({method:'GET',url:`/api/investigations/${s.inv.id}/workflow`,headers:{authorization:`Bearer ${f.tokens.owner}`}});
  expect(reply.statusCode).toBe(200);expect(reply.json().resources).toHaveLength(2);expect(reply.json().receipts).toEqual([]);
  expect(await f.rows('SELECT id FROM investigation_requests WHERE investigation_id=?',[s.inv.id])).toEqual(before);
 });
});
