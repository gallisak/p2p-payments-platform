import { InvalidEnvelopeError, parseEnvelope } from '../src/events/envelope';
import { ledgerEnvelope, paymentsEnvelope } from './support/envelopes';

describe('parseEnvelope', () => {
  it('parses a ledger envelope with its wallet snapshot', () => {
    const raw = ledgerEnvelope({ type: 'MoneyDeposited', streamVersion: 3, wallet: { balance: '12.50' } });

    const e = parseEnvelope('ledger', JSON.stringify(raw));

    expect(e).toMatchObject({
      eventId: raw.eventId,
      type: 'MoneyDeposited',
      streamId: raw.streamId,
      streamVersion: 3,
      ownerId: raw.ownerId,
      recipientId: null,
      wallet: { currency: 'USD', balance: '12.50', held: '0.00', blocked: false },
    });
    expect(e.occurredAt).toEqual(new Date(raw.occurredAt));
  });

  it('keeps the trace context of the producer', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const raw = { ...ledgerEnvelope({ type: 'MoneyDeposited' }), metadata: { traceparent } };

    expect(parseEnvelope('ledger', JSON.stringify(raw)).traceparent).toBe(traceparent);
  });

  it('parses a payments envelope without a wallet snapshot', () => {
    const raw = paymentsEnvelope({ type: 'TransferInitiated', recipientId: '22222222-2222-4222-8222-222222222222' });

    const e = parseEnvelope('payments', JSON.stringify(raw));

    expect(e.wallet).toBeNull();
    expect(e.recipientId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('normalizes ids to lowercase', () => {
    const raw = ledgerEnvelope({ type: 'WalletOpened' });
    const upper = { ...raw, ownerId: raw.ownerId.toUpperCase(), streamId: raw.streamId.toUpperCase() };

    const e = parseEnvelope('ledger', JSON.stringify(upper));

    expect(e.ownerId).toBe(raw.ownerId);
    expect(e.streamId).toBe(raw.streamId);
  });

  const valid = ledgerEnvelope({ type: 'MoneyDeposited' });

  it.each([
    ['not JSON', 'nope'],
    ['missing', undefined],
    ['an array', '[]'],
    ['without a type', JSON.stringify({ ...valid, type: '' })],
    ['with a non-UUID event id', JSON.stringify({ ...valid, eventId: 'e-1' })],
    ['with a non-UUID owner', JSON.stringify({ ...valid, ownerId: 42 })],
    ['with a zero stream version', JSON.stringify({ ...valid, streamVersion: 0 })],
    ['with a fractional stream version', JSON.stringify({ ...valid, streamVersion: 1.5 })],
    ['with a bad schema version', JSON.stringify({ ...valid, schemaVersion: 'v1' })],
    ['with a bad date', JSON.stringify({ ...valid, occurredAt: 'yesterday' })],
    ['without a payload', JSON.stringify({ ...valid, payload: null })],
    ['without a wallet snapshot', JSON.stringify({ ...valid, wallet: undefined })],
    ['with a malformed balance', JSON.stringify({ ...valid, wallet: { ...valid.wallet, balance: '1e3' } })],
    ['with a non-boolean blocked flag', JSON.stringify({ ...valid, wallet: { ...valid.wallet, blocked: 'no' } })],
  ])('rejects a ledger envelope that is %s', (_name, raw) => {
    expect(() => parseEnvelope('ledger', raw)).toThrow(InvalidEnvelopeError);
  });

  it('rejects a payments envelope with a malformed recipient', () => {
    const raw = paymentsEnvelope({ type: 'TransferInitiated' });
    expect(() => parseEnvelope('payments', JSON.stringify({ ...raw, recipientId: 'bob' }))).toThrow(
      InvalidEnvelopeError,
    );
  });
});
