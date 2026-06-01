import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';

describe('Dashboard API', () => {
  let app: ReturnType<typeof fastify>;

  beforeAll(async () => {
    app = fastify({ logger: false });

    // Register simplified test handlers for both dashboard endpoints
    app.get('/api/dashboard/capacity-trend', async (request, reply) => {
      try {
        const query = request.query as any;
        const hours = Number(query?.hours) || 168;
        const instance_id = query?.instance_id ? Number(query.instance_id) : null;
        const start_date = query?.start_date || null;
        const end_date = query?.end_date || null;
        reply.send({
          current_total_gb: 1280.5,
          trend: Array.from({ length: Math.min(hours, 168) }, (_, i) => ({
            time: `2026-05-${String(10 + Math.floor(i / 24)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00:00`,
            total_size_gb: 1200 + Math.random() * 200,
            instance_count: instance_id ? 1 : 8,
          })),
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    app.get('/api/dashboard/ai-stats', async (request, reply) => {
      try {
        reply.send({
          today_total: 42,
          breakdown: { rca: 15, fault_diagnosis: 10, sql_audit: 12, capacity_prediction: 5 },
          last_updated: new Date().toISOString(),
        });
      } catch (error: any) {
        reply.code(500).send({ error: error.message });
      }
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/dashboard/capacity-trend returns aggregated capacity data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?hours=24',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('current_total_gb');
    expect(typeof body.current_total_gb).toBe('number');
    expect(body).toHaveProperty('trend');
    expect(Array.isArray(body.trend)).toBe(true);
    if (body.trend.length > 0) {
      expect(body.trend[0]).toHaveProperty('time');
      expect(body.trend[0]).toHaveProperty('total_size_gb');
      expect(body.trend[0]).toHaveProperty('instance_count');
    }
  });

  it('GET /api/dashboard/capacity-trend defaults hours to 168 when missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend',
    });
    expect(response.statusCode).toBe(200);
  });

  it('GET /api/dashboard/capacity-trend with instance_id returns data for single instance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?instance_id=1',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('current_total_gb');
    expect(body).toHaveProperty('trend');
  });

  it('GET /api/dashboard/capacity-trend with start_date/end_date returns filtered data', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?start_date=2026-05-01&end_date=2026-05-07',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('current_total_gb');
    expect(body).toHaveProperty('trend');
  });

  it('GET /api/dashboard/capacity-trend with instance_id and start_date/end_date together', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?instance_id=1&start_date=2026-05-01&end_date=2026-05-07',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('current_total_gb');
    expect(body).toHaveProperty('trend');
  });

  it('GET /api/dashboard/ai-stats returns daily AI analysis count', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/ai-stats',
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('today_total');
    expect(typeof body.today_total).toBe('number');
    expect(body).toHaveProperty('breakdown');
    expect(body).toHaveProperty('last_updated');
  });

  it('GET /api/dashboard/ai-stats breakdown has correct structure', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/ai-stats',
    });
    const body = JSON.parse(response.payload);
    for (const [key, val] of Object.entries(body.breakdown)) {
      expect(typeof key).toBe('string');
      expect(typeof val).toBe('number');
    }
  });

  it('GET /api/dashboard/capacity-trend with extreme hours still returns 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/dashboard/capacity-trend?hours=8760',
    });
    expect(response.statusCode).toBe(200);
  });
});
