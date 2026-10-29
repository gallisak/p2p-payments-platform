import { Socket } from 'socket.io-client';
import { call, connect, createTransfer, nextEvent, NOTIFICATIONS_URL, openWallet, registerUser, settled, until, waitFor } from '../src/client';

describe('Real-time updates through notifications-service (e2e)', () => {
  const sockets: Socket[] = [];
  afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));

  const open = (user: Parameters<typeof connect>[0]) => {
    const socket = connect(user);
    sockets.push(socket);
    return socket;
  };

  it('streams the sender’s saga progress and the recipient’s new balance as they happen', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const from = await openWallet(alice, 'USD', 80);
    const aliceSocket = open(alice);
    const bobSocket = open(bob);
    await Promise.all([nextEvent(aliceSocket, 'snapshot'), nextEvent(bobSocket, 'snapshot')]);
    const statuses: string[] = [];
    aliceSocket.on('transfer.updated', (t: { status: string }) => statuses.push(t.status));

    const completed = waitFor(aliceSocket, 'transfer.updated', (t: { status: string }) => t.status === 'completed');
    const aliceBalance = waitFor(aliceSocket, 'wallet.updated', (w: { walletId: string; balance: string }) => w.walletId === from && w.balance === '55.00');
    const bobBalance = waitFor(bobSocket, 'wallet.updated', (w: { balance: string; currency: string }) => w.balance === '25.00' && w.currency === 'USD');
    const bobActivity = waitFor(bobSocket, 'activity.created', (a: { type: string }) => a.type === 'transfer_received');
    const created = await createTransfer(alice, { fromWalletId: from, toWalletIdentifier: bob.email, amount: 25, currency: 'USD' });

    const [transfer] = await Promise.all([completed, aliceBalance, bobBalance]);
    expect(transfer).toMatchObject({ transferId: created.body.id, status: 'completed' });
    expect([...new Set(statuses)]).toEqual(['pending', 'checked', 'funds_held', 'confirmed', 'completed']);
    expect(await bobActivity).toMatchObject({ data: { amount: '25.00', fromWalletId: from } });
  });

  it('brings a client that was offline up to date when it reconnects', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const from = await openWallet(alice, 'USD', 50);
    const first = open(alice);
    await nextEvent(first, 'snapshot');
    first.disconnect();

    const created = await createTransfer(alice, { fromWalletId: from, toWalletIdentifier: bob.email, amount: 20, currency: 'USD' });
    await settled(alice, created.body.id);
    const snapshot = await until(async () => {
      const res = await call('GET', `${NOTIFICATIONS_URL}/snapshot`, { token: alice.token });
      const done = res.body.transfers.find((t: { transferId: string; status: string }) => t.transferId === created.body.id && t.status === 'completed');
      const wallet = res.body.wallets.find((w: { walletId: string; balance: string }) => w.walletId === from && w.balance === '30.00');
      return done && wallet ? res.body : undefined;
    }, 20_000, 'notifications to project the transfer');
    expect(snapshot.activity.map((a: { type: string }) => a.type)).toEqual(['transfer_sent', 'deposit']);

    const again = open(alice);
    const fresh = await nextEvent(again, 'snapshot');

    expect(fresh.wallets).toEqual([expect.objectContaining({ walletId: from, balance: '30.00', held: '0.00' })]);
    expect(fresh.transfers).toEqual([expect.objectContaining({ transferId: created.body.id, status: 'completed' })]);
    expect(fresh.activity.map((a: { type: string }) => a.type)).toEqual(['transfer_sent', 'deposit']);
  });
});
