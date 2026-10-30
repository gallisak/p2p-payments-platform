import { SplitBillStatus } from './entities/split-bill.entity';
import { SplitShareStatus } from './entities/split-share.entity';

export class AllocationError extends Error {}

export interface Allocation {
  shares: bigint[];
  creatorCents: bigint;
}

export function allocateEqually(totalCents: bigint, participants: number, includeCreator: boolean): Allocation {
  const parts = BigInt(participants + (includeCreator ? 1 : 0));
  if (participants < 1) {
    throw new AllocationError('At least one participant is required');
  }
  if (totalCents < parts) {
    throw new AllocationError('The amount is too small to split between all participants');
  }
  const base = totalCents / parts;
  let remainder = totalCents % parts;
  const take = () => {
    if (remainder > 0n) {
      remainder -= 1n;
      return base + 1n;
    }
    return base;
  };
  const shares = Array.from({ length: participants }, take);
  return { shares, creatorCents: includeCreator ? take() : 0n };
}

export function allocateCustom(totalCents: bigint, amounts: bigint[]): Allocation {
  if (amounts.length < 1) {
    throw new AllocationError('At least one participant is required');
  }
  if (amounts.some((a) => a <= 0n)) {
    throw new AllocationError('Each share must be greater than zero');
  }
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (sum !== totalCents) {
    throw new AllocationError('The shares must equal the bill total');
  }
  return { shares: amounts, creatorCents: 0n };
}

export function billStatus(shares: { status: SplitShareStatus }[]): SplitBillStatus {
  const paid = shares.filter((s) => s.status === 'paid').length;
  if (paid === shares.length) {
    return 'settled';
  }
  return paid > 0 ? 'partially_paid' : 'pending';
}
