const MICRO = 1_000_000n;

export function toMicro(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid rate: ${rate}`);
  }
  return BigInt(Math.round(rate * 1_000_000));
}

export function formatMicro(micro: bigint): string {
  return `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, '0')}`;
}

export function parseMicro(rate: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rate);
  if (!match) {
    throw new Error(`Invalid rate: ${rate}`);
  }
  return BigInt(match[1]) * MICRO + BigInt((match[2] ?? '').padEnd(6, '0'));
}

export function convertCents(cents: bigint, rateMicro: bigint): bigint {
  return (cents * rateMicro + MICRO / 2n) / MICRO;
}

export function crossRate(perUsd: Record<string, number>, from: string, to: string): bigint {
  if (from === to) {
    return MICRO;
  }
  const fromRate = perUsd[from];
  const toRate = perUsd[to];
  if (fromRate === undefined || toRate === undefined) {
    throw new Error(`No rate for ${from}/${to}`);
  }
  return toMicro(toRate / fromRate);
}
