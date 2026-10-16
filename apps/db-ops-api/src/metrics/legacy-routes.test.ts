import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { installHistoricalMetricRoutes } from './legacy-routes.js';

it('aliases the exact authenticated handler once, including HEAD; preserves errors and marks only historical URLs deprecated', async () => {
  const app=Fastify();let writes=0,auth=0;
  installHistoricalMetricRoutes(app);
  const preHandler=async(request:any,reply:any)=>{auth++;if(request.headers.authorization!=='Bearer fixture')reply.code(401).send({error:'AUTH_REQUIRED'});};
  app.get('/api/metrics/config/catalog',{preHandler},async()=>({packages:[]}));
  app.post('/api/metrics/query',{preHandler},async()=>({result:++writes}));
  try {
    expect((await app.inject('/api/metrics-v2/config/catalog')).statusCode).toBe(401);
    const headers={authorization:'Bearer fixture'};
    for(const url of ['/api/metrics/config/catalog','/api/metrics-v2/config/catalog']) {
      const response=await app.inject({url,headers});expect(response.json()).toEqual({packages:[]});
      expect(Boolean(response.headers.deprecation)).toBe(url.includes('metrics-v2'));
      expect((await app.inject({method:'HEAD',url,headers})).statusCode).toBe(200);
    }
    expect((await app.inject({method:'POST',url:'/api/metrics-v2/query',headers,payload:{}})).json()).toEqual({result:1});
    expect(writes).toBe(1);expect(auth).toBe(6);
  } finally {await app.close();}
});
