import { InvalidCursorError, decodeCursor, encodeCursor } from '../src/store/notifications.store';

describe('activity cursor', () => {
  it('round-trips the position of an activity', () => {
    const position = { occurredAt: new Date('2026-10-29T10:00:00.123Z'), id: '42' };

    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('accepts the largest bigint id', () => {
    const position = { occurredAt: new Date('2026-10-29T10:00:00Z'), id: '9223372036854775807' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a non-numeric id', Buffer.from(JSON.stringify(['2026-10-29T10:00:00Z', 'x'])).toString('base64url')],
    ['a bad date', Buffer.from(JSON.stringify(['soon', '1'])).toString('base64url')],
    ['an object', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['an id beyond bigint', Buffer.from(JSON.stringify(['2026-10-29T10:00:00Z', '9223372036854775808'])).toString('base64url')],
  ])('rejects %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});
