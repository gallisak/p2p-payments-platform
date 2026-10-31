import { randomUUID } from 'crypto';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { OutboxMessage } from '../src/outbox/outbox-message.entity';
import { Wallet } from '../src/wallets/entities/wallet.entity';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

describe('Reconciliation cross-checks on Postgres (integration)', () => {
  let ctx: IntegrationApp;
  let admin: string;

  beforeEach(async () => {
    ctx = await createIntegrationApp({ relay: false });
    admin = await ctx.adminToken();
  });

  afterEach(async () => {
    await ctx.close();
  });

  const asAdmin = (method: 'get' | 'post', path: string) =>
    ctx.http()[method](`/admin${path}`).set('Authorization', `Bearer ${admin}`);

  async function funded(amount: number) {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token, 'USD');
    await ctx
      .http()
      .post(`/wallets/${walletId}/deposit`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount })
      .expect(201);
    return { ...user, walletId };
  }

  const post = (operationId: string, accountId: string, amount: number) =>
    ctx.dataSource.query(
      `INSERT INTO ledger_entries ("operationId", "eventId", "accountId", currency, amount)
       VALUES ($1, $2, $3, 'USD', $4)`,
      [operationId, randomUUID(), accountId, amount],
    );

  it('fails on two unbalanced operations even though they cancel out in the totals', async () => {
    const [one, two] = [randomUUID(), randomUUID()];
    await post(one, 'external:USD', 7.5);
    await post(two, 'external:USD', -7.5);

    const { body } = await asAdmin('get', '/reconciliation').expect(200);

    expect(body.totals.every((t: { net: string }) => t.net === '0.00')).toBe(true);
    expect(body.unbalancedOperations).toHaveLength(2);
    expect(body.projections.mismatches).toEqual([]);
    expect(body.ok).toBe(false);
  });

  it('detects a balanced operation that never went through the event log', async () => {
    const { walletId } = await funded(100);
    const operationId = randomUUID();
    await post(operationId, walletId, 50);
    await post(operationId, 'external:USD', -50);
    const issue = 'balance in the event log differs from the ledger entries';

    const { body } = await asAdmin('get', '/reconciliation').expect(200);

    expect(body.ok).toBe(false);
    expect(body.unbalancedOperations).toEqual([]);
    expect(body.projections.mismatches).toEqual([
      expect.objectContaining({ walletId, issues: [issue] }),
    ]);

    const rebuilt = await asAdmin('post', '/projections/rebuild').expect(201);
    expect(rebuilt.body).toEqual({ rebuilt: [], skipped: [{ walletId, issues: [issue] }] });
    expect((await ctx.dataSource.getRepository(Wallet).findOneByOrFail({ id: walletId })).version).toBe(2);
  });

  it('detects ledger entries of an account that has no event stream', async () => {
    const stray = randomUUID();
    const operationId = randomUUID();
    await post(operationId, stray, 5);
    await post(operationId, 'external:USD', -5);

    const { body } = await asAdmin('get', '/reconciliation').expect(200);

    expect(body.ok).toBe(false);
    expect(body.projections.mismatches).toEqual([
      expect.objectContaining({
        walletId: stray,
        issues: ['ledger entries point to an account with no events'],
      }),
    ]);
  });

  it('reports a hold mismatch as unresolved instead of claiming a rebuild', async () => {
    const user = await funded(100);
    const holdId = randomUUID();
    await ctx
      .internal('post', '/holds', { holdId, walletId: user.walletId, ownerId: user.userId, amount: 10 })
      .expect(201);
    await ctx.dataSource.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);

    const { body } = await asAdmin('post', '/projections/rebuild').expect(201);

    expect(body).toEqual({
      rebuilt: [],
      skipped: [
        {
          walletId: user.walletId,
          issues: ['held in the event log differs from the sum of placed holds'],
        },
      ],
    });
  });

  it('records a rebuild in the event log and tells the other services about it', async () => {
    const { walletId } = await funded(100);
    await ctx.dataSource.query('UPDATE wallets SET balance = balance + 5 WHERE id = $1', [walletId]);

    await asAdmin('post', '/projections/rebuild').expect(201);

    const last = await ctx.dataSource
      .getRepository(LedgerEvent)
      .findOneOrFail({ where: { streamId: walletId }, order: { streamVersion: 'DESC' } });
    expect(last).toMatchObject({
      type: 'ProjectionRebuilt',
      streamVersion: 3,
      payload: { issues: ['balance differs from the event log'] },
    });
    const message = await ctx.dataSource
      .getRepository(OutboxMessage)
      .findOneByOrFail({ eventId: last.eventId });
    expect(message.envelope).toMatchObject({
      streamVersion: 3,
      wallet: { balance: '100.00' },
    });
  });

  it('shows old events in their current schema in the admin log', async () => {
    const { walletId } = await funded(10);
    await ctx.dataSource.query(
      `INSERT INTO ledger_events ("eventId", "streamId", "streamVersion", type, "schemaVersion", payload)
       VALUES ($1, $2, 3, 'MoneyDeposited', 1,
               '{"operationId": "x", "amount": "1.00", "currency": "USD",
                 "postings": [{"accountId": "a", "amount": "1.00"}]}')`,
      [randomUUID(), walletId],
    );

    const { body } = await asAdmin('get', `/wallets/${walletId}/events`).expect(200);

    expect(body[2]).toMatchObject({
      schemaVersion: 1,
      payload: { postings: [{ accountId: 'a', amount: '1.00', currency: 'USD' }] },
    });
  });
});
