import { parseAmount } from './money';

export function parseParticipants(text: string, custom: boolean) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email] = line.split(/[\s,;]/, 1);
      const amount = line.slice(email.length).replace(/^[\s,;]+/, '');
      return custom ? { email, amount: parseAmount(amount) } : { email };
    });
}
