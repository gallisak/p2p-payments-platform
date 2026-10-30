import express from 'express';
import request from 'supertest';
import { httpTelemetry } from '../src/telemetry/http-telemetry';
import { MetricsController } from '../src/telemetry/metrics.controller';
import { registry } from '../src/telemetry/metrics';

describe('HTTP telemetry', () => {
  const app = express();
  app.use(httpTelemetry);
  app.get('/wallets/:id', (_req, res) => void res.json({}));
  app.get('/health', (_req, res) => void res.json({}));
  let lines: string[];
  let write: jest.SpyInstance;

  beforeEach(() => {
    registry.resetMetrics();
    lines = [];
    write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => write.mockRestore());

  it('counts a request by its route, not by its id, and logs it without the query', async () => {
    await request(app).get('/wallets/5e0b7a6e-0000-4000-8000-000000000001?ownerId=secret').expect(200);

    const metrics = await registry.getSingleMetricAsString('http_requests_total');
    expect(metrics).toContain('method="GET",route="/wallets/:id",status="200"');
    expect(metrics).not.toContain('5e0b7a6e');
    expect(JSON.parse(lines[0])).toMatchObject({ context: 'http', method: 'GET', status: 200 });
    expect(lines[0]).not.toContain('secret');
  });

  it('groups unknown paths together', async () => {
    await request(app).get('/wp-admin/x').expect(404);

    expect(await registry.getSingleMetricAsString('http_requests_total')).toContain('route="unmatched",status="404"');
  });

  it('ignores health checks', async () => {
    await request(app).get('/health').expect(200);

    expect(lines).toEqual([]);
    expect(await registry.getSingleMetricAsString('http_requests_total')).not.toContain('/health');
  });

  it('serves the metrics in the Prometheus format', async () => {
    const body = await new MetricsController().metrics();

    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('process_cpu_seconds_total');
  });
});
