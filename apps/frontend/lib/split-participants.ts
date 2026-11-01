import { parseAmount } from './money';

export function parseParticipants(text: string, custom: boolean) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [, email, amount] = /^([^\s,;]+)[\s,;]*(.*)$/.exec(line) as RegExpExecArray;
      return custom ? { email, amount: parseAmount(amount) } : { email };
    });
}
