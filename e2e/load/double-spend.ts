import { runDoubleSpend } from '../src/double-spend';

const numberFrom = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
};

async function main() {
  const result = await runDoubleSpend({
    balance: numberFrom('LOAD_BALANCE', 1_000),
    amount: numberFrom('LOAD_AMOUNT', 10),
    transfers: numberFrom('LOAD_TRANSFERS', 300),
  });
  const ok =
    result.accepted === result.options.transfers &&
    result.completed === result.expectedCompleted &&
    result.recipientBalance === result.expectedRecipientBalance &&
    result.finalHeld === '0.00' &&
    !result.finalBalance.startsWith('-') &&
    result.reconciliationOk;

  console.log(JSON.stringify(result, null, 2));
  console.log(
    [
      '| Metric | Value |',
      '|---|---|',
      `| Concurrent transfers | ${result.options.transfers} × ${result.options.amount} USD from a ${result.options.balance} USD wallet |`,
      `| Completed / expected | ${result.completed} / ${result.expectedCompleted} |`,
      `| Failed | ${Object.entries(result.failedByReason).map(([r, n]) => `${r}: ${n}`).join(', ') || 'none'} |`,
      `| Final sender balance / held | ${result.finalBalance} / ${result.finalHeld} |`,
      `| Recipient balance / expected | ${result.recipientBalance} / ${result.expectedRecipientBalance} |`,
      `| Reconciliation | ${result.reconciliationOk ? 'ok' : 'FAILED'} |`,
      `| Wall time | ${result.wallTimeMs} ms |`,
      `| Settled sagas per second | ${result.throughputPerSecond} |`,
      `| POST /transfers latency p50 / p95 / max | ${result.acceptLatencyMs.p50} / ${result.acceptLatencyMs.p95} / ${result.acceptLatencyMs.max} ms |`,
      `| Saga latency (completed) p50 / p95 / max | ${result.sagaLatencyMs.p50} / ${result.sagaLatencyMs.p95} / ${result.sagaLatencyMs.max} ms |`,
    ].join('\n'),
  );
  if (!ok) {
    console.error('Invariant violated: the system allowed a double spend or left funds held');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
