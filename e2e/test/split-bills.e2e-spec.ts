import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { PAYMENTS_URL, activity, call, openWallet, reconciliation, registerUser, settled, until, walletIn } from '../src/client';

const PAYMENTS_DB_URL = process.env.PAYMENTS_DB_URL ?? 'postgres://payments:payments@localhost:5434/payments';

describe('Split bills across payments, ledger and notifications (e2e)', () => {
  it('collects every share into the creator’s wallet, settles the bill and keeps everyone informed', async () => {
    const host = await registerUser('host');
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    await openWallet(host, 'EUR');
    const aliceWallet = await openWallet(alice, 'EUR', 100);
    const bobWallet = await openWallet(bob, 'EUR', 100);

    const created = await call('POST', `${PAYMENTS_URL}/split-bills`, {
      token: host.token,
      body: {
        title: 'Tickets',
        currency: 'EUR',
        totalAmount: 90,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        split: 'equal',
        includeCreator: true,
        participants: [{ email: alice.email }, { email: bob.email }],
      },
    });
    expect(created.status).toBe(201);
    const bill = created.body;
    const shareOf = (userId: string) => bill.shares.find((s: { participantId: string }) => s.participantId === userId);
    expect(bill).toMatchObject({ status: 'pending', creatorAmount: '30.00' });

    const invited = await until(async () => (await activity(alice, '?type=split_bill_created')).items[0], 20_000, 'alice to be invited');
    expect(invited.data).toMatchObject({ billId: bill.id, amount: '30.00', creatorEmail: host.email, title: 'Tickets' });

    for (const [user, wallet] of [[alice, aliceWallet], [bob, bobWallet]] as const) {
      const paid = await call('POST', `${PAYMENTS_URL}/split-bills/${bill.id}/shares/${shareOf(user.userId).id}/pay`, {
        token: user.token,
        body: { fromWalletId: wallet },
        headers: { 'Idempotency-Key': randomUUID() },
      });
      expect(paid.status).toBe(202);
      expect(await settled(user, paid.body.id)).toMatchObject({ status: 'completed' });
    }

    const final = (await call('GET', `${PAYMENTS_URL}/split-bills/${bill.id}`, { token: alice.token })).body;
    expect(final.status).toBe('settled');
    expect(await walletIn(host, 'EUR')).toMatchObject({ balance: '60.00', held: '0.00' });
    expect(await walletIn(alice, 'EUR')).toMatchObject({ balance: '70.00' });
    const hostFeed = await until(async () => {
      const feed = await activity(host, '?type=split_share_paid,split_bill_settled');
      return feed.items.length === 3 ? feed.items : undefined;
    }, 20_000, 'the host feed');
    expect(hostFeed.map((a) => a.type).sort()).toEqual(['split_bill_settled', 'split_share_paid', 'split_share_paid']);
    expect((await reconciliation()).ok).toBe(true);
  });

  it('reminds a participant who has not paid by the due date', async () => {
    const host = await registerUser('host');
    const late = await registerUser('late');
    await openWallet(host, 'USD');
    const created = await call('POST', `${PAYMENTS_URL}/split-bills`, {
      token: host.token,
      body: {
        title: 'Rent',
        currency: 'USD',
        totalAmount: 40,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        split: 'equal',
        participants: [{ email: late.email }],
      },
    });
    expect(created.status).toBe(201);

    const db = new Client({ connectionString: PAYMENTS_DB_URL });
    await db.connect();
    try {
      await db.query(`UPDATE split_bills SET "dueAt" = now() - interval '1 minute' WHERE id = $1`, [created.body.id]);
    } finally {
      await db.end();
    }

    const reminder = await until(async () => (await activity(late, '?type=split_share_overdue')).items[0], 20_000, 'the reminder');
    expect(reminder.data).toMatchObject({ billId: created.body.id, title: 'Rent', amount: '40.00', currency: 'USD', reminderCount: 1 });
  });
});
