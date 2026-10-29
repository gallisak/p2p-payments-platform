import { AllocationError, allocateCustom, allocateEqually, billStatus } from '../src/split-bills/allocation';

describe('split bill allocation', () => {
  it('splits equally and hands out leftover cents one by one', () => {
    expect(allocateEqually(10_000n, 3, false)).toEqual({ shares: [3_334n, 3_333n, 3_333n], creatorCents: 0n });
    expect(allocateEqually(10_001n, 2, true)).toEqual({ shares: [3_334n, 3_334n], creatorCents: 3_333n });
    expect(allocateEqually(9n, 3, false)).toEqual({ shares: [3n, 3n, 3n], creatorCents: 0n });
  });

  it('always adds up to the total', () => {
    for (const [total, n, creator] of [[1n, 1, false], [99_999n, 7, true], [100n, 50, false], [12_345n, 13, true]] as const) {
      const { shares, creatorCents } = allocateEqually(total, n, creator);
      expect(shares.reduce((a, b) => a + b, 0n) + creatorCents).toBe(total);
      expect(Math.max(...shares.map(Number)) - Math.min(...shares.map(Number))).toBeLessThanOrEqual(1);
    }
  });

  it('refuses an amount too small to give everyone a cent', () => {
    expect(() => allocateEqually(2n, 2, true)).toThrow(AllocationError);
    expect(() => allocateEqually(100n, 0, false)).toThrow(AllocationError);
  });

  it('accepts custom shares only when they add up to the total', () => {
    expect(allocateCustom(5_000n, [2_000n, 3_000n])).toEqual({ shares: [2_000n, 3_000n], creatorCents: 0n });
    expect(() => allocateCustom(5_000n, [2_000n, 2_999n])).toThrow('дорівнювати');
    expect(() => allocateCustom(5_000n, [5_000n, 0n])).toThrow('більшою за нуль');
    expect(() => allocateCustom(5_000n, [])).toThrow(AllocationError);
  });

  it('derives the bill status from its shares', () => {
    expect(billStatus([{ status: 'pending' }, { status: 'paying' }])).toBe('pending');
    expect(billStatus([{ status: 'paid' }, { status: 'paying' }])).toBe('partially_paid');
    expect(billStatus([{ status: 'paid' }, { status: 'paid' }])).toBe('settled');
  });
});
