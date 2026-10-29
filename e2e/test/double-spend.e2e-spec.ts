import { runDoubleSpend } from '../src/double-spend';

describe('Concurrent transfers from one wallet (e2e)', () => {
  it('never spends more than the balance, however many transfers race for it', async () => {
    const result = await runDoubleSpend({ balance: 100, amount: 10, transfers: 40 });

    expect(result.accepted).toBe(40);
    expect(result.completed).toBe(10);
    expect(result.failedByReason).toEqual({ insufficient_funds: 30 });
    expect(result.finalBalance).toBe('0.00');
    expect(result.finalHeld).toBe('0.00');
    expect(result.expectedCompleted).toBe(10);
    expect(result.recipientBalance).toBe(result.expectedRecipientBalance);
    expect(result.recipientBalance).toBe('100.00');
    expect(result.reconciliationOk).toBe(true);
  });
});
