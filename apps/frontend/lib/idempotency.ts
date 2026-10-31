import { createHash } from 'crypto';

export function idempotencyHeaders(form: FormData): Record<string, string> {
  const fields = [...form.entries()]
    .filter(([name]) => !name.startsWith('$ACTION'))
    .map(([name, value]) => [name, String(value)])
    .sort();
  return { 'Idempotency-Key': createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}
