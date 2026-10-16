import type {FastifyInstance} from 'fastify';

/** Remove after MAX-190 and external clients adopt /api/metrics, no later than 2026-11-15.
 * This aliases the same handler/authentication hooks; there is no second execution or store. */
export function installHistoricalMetricRoutes(app: FastifyInstance): void {
  app.addHook('onRoute', route => {
    if (!/^\/api\/metrics\/(config|policy|rollout|query|discover|inventory|evaluate)(\/|$)/.test(route.url) || route.method === 'HEAD') return;
    app.route({...route, url:route.url.replace('/api/metrics/','/api/metrics-v2/'),
      onSend:[...([] as NonNullable<typeof route.onSend>[]).concat(route.onSend ?? []).flat(), async (_request,reply,payload)=>{
        reply.header('Deprecation','true');reply.header('Sunset','Sun, 15 Nov 2026 00:00:00 GMT');
        return payload;
      }]});
  });
}
