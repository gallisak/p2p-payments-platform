import { randomUUID } from 'crypto';
import { BFF_URL, JAEGER_URL, LEDGER_URL, NOTIFICATIONS_URL, PAYMENTS_URL, admin, call, openWallet, registerUser, until } from '../src/client';

interface JaegerTrace {
  spans: { operationName: string; processID: string }[];
  processes: Record<string, { serviceName: string }>;
}

describe('Observability (e2e)', () => {
  it('follows one transfer by a single trace ID through every service and the event stream', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const walletId = await openWallet(alice, 'USD', 100);
    await openWallet(bob, 'USD');

    const created = await call('POST', `${BFF_URL}/api/transfers`, {
      token: alice.token,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { fromWalletId: walletId, toWalletIdentifier: bob.email, amount: 10, currency: 'USD' },
    });
    expect(created.status).toBe(202);
    const traceId = created.headers.get('x-trace-id');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    const trace = await until(
      async () => {
        const res = await call<{ data?: JaegerTrace[] }>('GET', `${JAEGER_URL}/api/traces/${traceId}`);
        const found = res.body.data?.[0];
        const operations = found?.spans.map((s) => s.operationName) ?? [];
        const complete =
          operations.includes('saga.capture') &&
          operations.includes('consume TransferCompleted') &&
          operations.includes('consume HoldPlaced');
        return complete ? found : undefined;
      },
      20_000,
      'the whole transfer to reach Jaeger',
    );

    const services = new Set(Object.values(trace.processes).map((p) => p.serviceName));
    expect([...services].sort()).toEqual(['bff', 'ledger-service', 'notifications-service', 'payments-service']);
    const operations = trace.spans.map((s) => s.operationName);
    expect(operations).toEqual(expect.arrayContaining(['POST /api/transfers', 'POST /transfers', 'saga.check', 'saga.hold', 'saga.confirm', 'POST /internal/holds']));

    const listed = await until(
      async () => {
        const res = await call('GET', `${BFF_URL}/api/admin/traces`, { token: await admin() });
        expect(res.status).toBe(200);
        return res.body.find((t: { traceId: string }) => t.traceId === traceId);
      },
      10_000,
      'the trace to appear on the admin API',
    );
    expect(listed.transferId).toBe(created.body.id);
    expect(listed.steps.map((s: { step: string }) => s.step)).toEqual(['check', 'hold', 'confirm', 'capture']);
    expect(listed.services).toContain('notifications-service');
    expect((await call('GET', `${BFF_URL}/api/admin/traces`, { token: alice.token })).status).toBe(403);
  });

  it.each([
    ['ledger-service', LEDGER_URL, 'outbox_published_total'],
    ['payments-service', PAYMENTS_URL, 'saga_steps_total{step="capture",outcome="advance"}'],
    ['notifications-service', NOTIFICATIONS_URL, 'events_processed_total{source="payments",result="applied"}'],
    ['bff', BFF_URL, 'http_requests_total{method="POST",route="/api/transfers",status="202"}'],
  ])('exposes the metrics of %s', async (_name, url, metric) => {
    const res = await fetch(`${url}/metrics`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain(metric);
  });
});
