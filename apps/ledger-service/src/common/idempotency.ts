import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export function optionalIdempotencyKey(
  header: string | string[] | undefined,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  if (typeof header !== 'string' || !KEY_RE.test(header)) {
    throw new BadRequestException(
      'The Idempotency-Key header must be 1–255 visible ASCII characters',
    );
  }
  return header;
}

export function requestHash(fields: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
