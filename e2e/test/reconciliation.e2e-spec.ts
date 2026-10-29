import {
  User,
  blockWallet,
  call,
  createTransfer,
  LEDGER_URL,
  NOTIFICATIONS_URL,
  openWallet,
  reconciliation,
  registerUser,
  settled,
  until,
  wallets,
} from '../src/client';

function prng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}

describe('Ledger invariants after a burst of random operations (e2e)', () => {
  it('balances every posting, matches every projection to its event log and agrees with notifications', async () => {
    const random = prng(Number(process.env.E2E_SEED ?? 20261029));
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const amount = (max: number) => Math.max(1, Math.round(random() * max * 100)) / 100;
    const currencies = ['USD', 'EUR', 'UAH'];

    const users: User[] = await Promise.all(Array.from({ length: 6 }, (_, i) => registerUser(`random-${i}`)));
    const walletIds = new Map<string, string>();
    for (const user of users) {
      for (const currency of currencies) {
        walletIds.set(`${user.userId}:${currency}`, await openWallet(user, currency, Math.round(random() * 500) + 50));
      }
    }
    const banned = users[5];
    await blockWallet(walletIds.get(`${banned.userId}:USD`) as string, 'random block');

    const transfers: { user: User; id: string }[] = [];
    const operations = Array.from({ length: 60 }, () => async () => {
      const user = pick(users.slice(0, 5));
      const currency = pick(currencies);
      const walletId = walletIds.get(`${user.userId}:${currency}`) as string;
      const roll = random();
      if (roll < 0.2) {
        await call('POST', `${LEDGER_URL}/wallets/${walletId}/deposit`, { token: user.token, body: { amount: amount(200) } });
      } else if (roll < 0.35) {
        await call('POST', `${LEDGER_URL}/wallets/${walletId}/withdraw`, { token: user.token, body: { amount: amount(400) } });
      } else {
        const recipient = random() < 0.1 ? 'nobody@example.com' : pick(users).email;
        const res = await createTransfer(user, {
          fromWalletId: walletId,
          toWalletIdentifier: recipient,
          amount: amount(300),
          currency: pick(currencies),
        });
        if (res.status === 202) transfers.push({ user, id: res.body.id });
      }
    });
    for (let i = 0; i < operations.length; i += 10) {
      await Promise.all(operations.slice(i, i + 10).map((op) => op()));
    }

    const results = await Promise.all(transfers.map((t) => settled(t.user, t.id, 60_000)));
    expect(results.length).toBeGreaterThan(20);
    expect(results.filter((t) => t.status === 'completed').length).toBeGreaterThan(0);
    expect(results.filter((t) => t.status === 'failed').length).toBeGreaterThan(0);

    const report = await reconciliation();
    expect(report.ok).toBe(true);
    expect(report.unbalancedOperations).toEqual([]);
    for (const total of report.totals) {
      expect(total.net).toBe('0.00');
    }

    for (const user of users) {
      const ledgerWallets = await wallets(user);
      for (const w of ledgerWallets) {
        expect(w.held).toBe('0.00');
        expect(w.balance.startsWith('-')).toBe(false);
      }
      await until(async () => {
        const res = await call('GET', `${NOTIFICATIONS_URL}/snapshot`, { token: user.token });
        const projected = new Map<string, string>(res.body.wallets.map((w: { walletId: string; balance: string }) => [w.walletId, w.balance]));
        return ledgerWallets.every((w) => projected.get(w.id) === w.balance) ? true : undefined;
      }, 30_000, `notifications to catch up with ledger for ${user.email}`);
    }
  });
});
