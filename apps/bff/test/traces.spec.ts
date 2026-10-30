import { BffApp, createBffApp } from './support/bff-app';

const TOKEN = 'Bearer admin-token';
const TRANSFER = '6f0e1c1a-0000-4000-8000-000000000001';
const span = (operationName: string, processID: string, startTime: number, duration: number, tags: object[] = []) => ({
  operationName,
  processID,
  startTime,
  duration,
  tags,
});
const jaegerTrace = {
  traceID: 'abc123',
  processes: { p1: { serviceName: 'payments-service' }, p2: { serviceName: 'ledger-service' } },
  spans: [
    span('POST /internal/holds', 'p2', 1_700_000_000_004_000, 2_000, [{ key: 'error', value: true }]),
    span('saga.hold', 'p1', 1_700_000_000_003_000, 5_500, [
      { key: 'saga.outcome', value: 'advance' },
      { key: 'saga.attempt', value: 1 },
      { key: 'transfer.id', value: TRANSFER },
    ]),
    span('POST /transfers', 'p1', 1_700_000_000_000_000, 1_000),
  ],
};

describe('BFF admin traces', () => {
  let ctx: BffApp;

  beforeAll(async () => {
    ctx = await createBffApp();
  });

  afterEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('shows the latest transfers with the time of each saga step', async () => {
    ctx.ledger.on('GET', '/admin/me', { body: { role: 'admin' } });
    ctx.jaeger.on('GET', '/api/traces', { body: { data: [jaegerTrace] } });

    const res = await ctx.http().get('/api/admin/traces?limit=5').set('Authorization', TOKEN).expect(200);

    expect(res.body).toEqual([
      {
        traceId: 'abc123',
        startedAt: new Date(1_700_000_000_000).toISOString(),
        durationMs: 8.5,
        services: ['ledger-service', 'payments-service'],
        transferId: TRANSFER,
        steps: [{ step: 'hold', outcome: 'advance', attempt: 1, durationMs: 5.5 }],
        spans: [
          { service: 'payments-service', operation: 'POST /transfers', startOffsetMs: 0, durationMs: 1, error: false },
          { service: 'payments-service', operation: 'saga.hold', startOffsetMs: 3, durationMs: 5.5, error: false },
          { service: 'ledger-service', operation: 'POST /internal/holds', startOffsetMs: 4, durationMs: 2, error: true },
        ],
      },
    ]);
    expect(ctx.jaeger.received[0].query).toEqual({
      service: 'payments-service',
      operation: 'saga.check',
      lookback: '1h',
      limit: '5',
    });
    expect(ctx.jaeger.received[0].headers.authorization).toBeUndefined();
  });

  it('newest first', async () => {
    ctx.ledger.on('GET', '/admin/me', { body: { role: 'admin' } });
    const later = { ...jaegerTrace, traceID: 'later', spans: [span('saga.check', 'p1', 1_800_000_000_000_000, 1)] };
    ctx.jaeger.on('GET', '/api/traces', { body: { data: [jaegerTrace, later] } });

    const res = await ctx.http().get('/api/admin/traces').set('Authorization', TOKEN).expect(200);

    expect(res.body.map((t: { traceId: string }) => t.traceId)).toEqual(['later', 'abc123']);
  });

  it.each([
    [401, 'an invalid session'],
    [403, 'a user who is not an admin'],
  ])('answers %i to %s without touching Jaeger', async (status) => {
    ctx.ledger.on('GET', '/admin/me', { status, body: { message: 'no' } });

    await ctx.http().get('/api/admin/traces').set('Authorization', TOKEN).expect(status);

    expect(ctx.jaeger.received).toEqual([]);
  });

  it('has an empty list before the first transfer', async () => {
    ctx.ledger.on('GET', '/admin/me', { body: { role: 'admin' } });
    ctx.jaeger.on('GET', '/api/traces', { body: { data: null } });

    await ctx.http().get('/api/admin/traces').set('Authorization', TOKEN).expect(200, []);
  });

  it('answers 503 when Jaeger is down', async () => {
    ctx.ledger.on('GET', '/admin/me', { body: { role: 'admin' } });
    ctx.jaeger.on('GET', '/api/traces', { status: 500, body: {} });

    await ctx.http().get('/api/admin/traces').set('Authorization', TOKEN).expect(503);
  });

  it('rejects an out-of-range limit', async () => {
    await ctx.http().get('/api/admin/traces?limit=500').set('Authorization', TOKEN).expect(400);

    expect(ctx.ledger.received).toEqual([]);
  });
});
